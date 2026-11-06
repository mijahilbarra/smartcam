import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

import { PIPELINE_CONFIG } from "../src/core/pipeline_config.js";
import { CustomerService } from "../src/services/customer_service.js";
import { VisitSessionService } from "../src/services/visit_session_service.js";
import { SQLiteClient, blobToVector, vectorToBlob } from "../src/infrastructure/storage/sqlite_client.js";
import { validateSpatialChairAnchor } from "../src/services/pipeline/closure_rules.js";
import { setCustomQuadrants } from "../src/detector.js";
import {
  runProcessCycle,
  flushProcessPipeline,
  createProcessAccumulator,
  TrackBlockManager
} from "../src/services/processes.js";

const dbPath = path.join(PROJECT_ROOT, "data", "experiments.db");
const db = new Database(dbPath, { readonly: true });

const videoName = "barberia_stream_7h";
const quadrantsPath = path.join(PROJECT_ROOT, "data", "quadrants.json");
let loadedQuadrants = [];
if (fs.existsSync(quadrantsPath)) {
  loadedQuadrants = JSON.parse(fs.readFileSync(quadrantsPath, "utf8"));
  setCustomQuadrants(loadedQuadrants);
}
const chairZone = loadedQuadrants.find(q => q.type === "barber_chair" || q.id === "silla_barbero_puesto2") || loadedQuadrants[0] || null;

// Staff
let staffEmbeddings = [];
const prodPath = path.join(PROJECT_ROOT, "data", "barberia.db");
if (fs.existsSync(prodPath)) {
  const prodDb = new Database(prodPath, { readonly: true });
  const staffRow = prodDb.prepare("SELECT * FROM customers WHERE is_staff = 1 OR id = 'staff_barbero' LIMIT 1").get();
  if (staffRow) {
    const embRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = ? ORDER BY embedding_index ASC").all(staffRow.id);
    staffEmbeddings = embRows.map(r => ({
      vector: blobToVector(r.embedding_blob),
      pose: r.pose || "frontal",
      sharpnessScore: r.sharpness_score || 0
    })).filter(e => Array.isArray(e.vector));
  }
  prodDb.close();
}

const trackedClosures = [];
const experimentSqliteClient = new SQLiteClient(dbPath, {
  customersTable: "experiment_customers",
  customerEmbeddingsTable: "experiment_customer_embeddings",
  appointmentsTable: "experiment_appointments"
});

const experimentCustomerService = new CustomerService({ sqliteClient: experimentSqliteClient });
await experimentCustomerService.loadProfilesIntoMemory();

const visitService = new VisitSessionService({
  db: null,
  bucket: null,
  sqliteClient: experimentSqliteClient,
  customerService: experimentCustomerService,
  minAppointmentMinutes: PIPELINE_CONFIG.sessions.minAppointmentMinutes,
  emptyChairTimeoutMs: PIPELINE_CONFIG.sessions.emptyChairTimeoutMs,
  staffThreshold: PIPELINE_CONFIG.staffFilter.staffExclusionThreshold,
  maxCompletedAppointments: Infinity,
  quadrants: loadedQuadrants,
  chairZone,
  onSessionClosed: ({ session, trackId, options, result, endedAtEpoch }) => {
    const tramoPhotos = (session?.photosBeforeClose && session.photosBeforeClose.length > 0)
      ? session.photosBeforeClose
      : ((session?.photos && session.photos.length > 0) ? session.photos : []);

    const tramoEmbeddings = (session?.embeddingsBeforeClose && session.embeddingsBeforeClose.length > 0)
      ? session.embeddingsBeforeClose
      : ((session?.embeddings && session.embeddings.length > 0) ? session.embeddings : []);

    const tramoBoxes = (session?.boxes && session.boxes.length > 0) ? session.boxes : [];

    const durationMin = options?.durationMinutes !== undefined
      ? options.durationMinutes
      : (session?.startedAtEpoch && endedAtEpoch
        ? Math.max(1, Math.round((endedAtEpoch - session.startedAtEpoch) / 60000))
        : 1);

    trackedClosures.push({
      index: trackedClosures.length + 1,
      sessionId: session?.id,
      chairId: session?.chairId,
      startedAtEpoch: session?.startedAtEpoch,
      endedAtEpoch,
      durationMinutes: durationMin,
      photosCount: tramoPhotos.length,
      embeddingsCount: tramoEmbeddings.length,
      boxesCount: tramoBoxes.length,
      resultApptId: result?.id || null,
      discardReason: session?._lastDiscardReason || (!result ? "Descartado por filtro de cierre / ruido" : null)
    });
  }
});

const trackBlockManager = new TrackBlockManager({
  staffProfiles: staffEmbeddings,
  staffThreshold: PIPELINE_CONFIG.staffFilter.staffExclusionThreshold || 0.46,
  quadrants: loadedQuadrants,
  width: 1280,
  height: 720
});
visitService.trackBlockManager = trackBlockManager;

const rows = db.prepare("SELECT * FROM harvested_crops WHERE video_file = ? ORDER BY video_second ASC, id ASC").all(videoName);
const baseEpoch = rows[0]?.timestamp_epoch - (rows[0]?.video_second * 1000) || 0;

let lastTimestamp = null;
for (const row of rows) {
  await runProcessCycle({
    harvestedRow: row,
    trackBlockManager,
    visitService,
    lastTimestamp
  }, {
    causalOptions: {
      staffProfiles: staffEmbeddings,
      staffThreshold: PIPELINE_CONFIG.staffFilter.staffExclusionThreshold
    }
  });
  lastTimestamp = row.timestamp_epoch;
}

await flushProcessPipeline({
  lastTimestamp,
  trackBlockManager,
  visitService
});

console.log("\n=======================================================");
console.log(`DETALLE DE LOS ${trackedClosures.length} TRAMOS EN SILLA`);
console.log("=======================================================");

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(rm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

for (const t of trackedClosures) {
  const startSec = Math.max(0, Math.round((t.startedAtEpoch - baseEpoch) / 1000));
  const endSec = Math.max(startSec, Math.round((t.endedAtEpoch - baseEpoch) / 1000));
  const status = t.resultApptId ? `✅ Aprobado -> ${t.resultApptId}` : `❌ Descartado: ${t.discardReason}`;
  console.log(`T#${String(t.index).padStart(2, '0')} | ${formatSec(startSec)} - ${formatSec(endSec)} (${String(t.durationMinutes).padStart(2, '0')}m) | Fotos: ${String(t.photosCount).padStart(3, ' ')} | Embs: ${String(t.embeddingsCount).padStart(3, ' ')} | ${status}`);
}
