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
import { SQLiteClient, blobToVector } from "../src/infrastructure/storage/sqlite_client.js";
import { setCustomQuadrants } from "../src/detector.js";
import {
  runProcessCycle,
  flushProcessPipeline,
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

const experimentSqliteClient = new SQLiteClient(dbPath, {
  customersTable: "experiment_customers",
  customerEmbeddingsTable: "experiment_customer_embeddings",
  appointmentsTable: "experiment_appointments"
});
const experimentCustomerService = new CustomerService({ sqliteClient: experimentSqliteClient });
await experimentCustomerService.loadProfilesIntoMemory();

const recordedUnits = [];

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

    const bestPhoto = tramoPhotos.reduce((best, p) => (p.sharpnessScore > (best?.sharpnessScore || 0) ? p : best), null);

    const durationMin = options?.durationMinutes !== undefined
      ? options.durationMinutes
      : (session?.startedAtEpoch && endedAtEpoch
        ? Math.max(1, Math.round((endedAtEpoch - session.startedAtEpoch) / 60000))
        : 1);

    recordedUnits.push({
      id: `UA_${String(recordedUnits.length + 1).padStart(2, '0')}`,
      index: recordedUnits.length + 1,
      sessionId: session?.id,
      chairId: session?.chairId,
      startedAtEpoch: session?.startedAtEpoch,
      endedAtEpoch,
      durationMinutes: durationMin,
      photosCount: tramoPhotos.length,
      embeddingsCount: tramoEmbeddings.length,
      bestScore: bestPhoto?.sharpnessScore || 0,
      bestPose: bestPhoto?.pose || "desconocido",
      hasTwoEyes: bestPhoto?.hasTwoEyes ?? false,
      oldResultApptId: result?.id || null,
      photos: tramoPhotos,
      embeddings: tramoEmbeddings
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

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(rm).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

console.log("\n=========================================================================================");
console.log(`📊 INVENTARIO DE UNIDADES DE ATENCIÓN PURAS (ZERO-DISCARD: ${recordedUnits.length} UNIDADES)`);
console.log("=========================================================================================\n");

let prevEndSec = null;
for (let i = 0; i < recordedUnits.length; i++) {
  const u = recordedUnits[i];
  const startSec = Math.max(0, Math.round((u.startedAtEpoch - baseEpoch) / 1000));
  const endSec = Math.max(startSec, Math.round((u.endedAtEpoch - baseEpoch) / 1000));
  u.startSec = startSec;
  u.endSec = endSec;

  let gapStr = "---";
  if (prevEndSec !== null) {
    const gapSec = startSec - prevEndSec;
    const gapMin = (gapSec / 60).toFixed(1);
    gapStr = `${gapMin} min (${gapSec}s)`;
  }
  prevEndSec = Math.max(prevEndSec || 0, endSec);

  const oldStatus = u.oldResultApptId ? `✅ Consolidado en ${u.oldResultApptId.slice(-4)}` : `❌ DESCARTADO anteriormente`;
  console.log(`${u.id} | ${formatSec(startSec)} - ${formatSec(endSec)} | ${String(u.durationMinutes).padStart(2, ' ')} min | Brecha previa: ${gapStr.padEnd(16, ' ')} | Fotos: ${String(u.photosCount).padStart(2, ' ')} | Score: ${u.bestScore.toFixed(0)} | ${oldStatus}`);
}

console.log("\n=========================================================================================");
console.log("🧩 AGRUPACIÓN NATURAL POR CONTINUIDAD TEMPORAL Y BIOMETRÍA (CAPA DE UNIÓN)");
console.log("=========================================================================================\n");

// Analicemos cómo se agrupan estas 24 unidades si la Capa de Unión usa reglas no destructivas:
// Regla 1: Mismo cliente si brecha < 5 min en la misma silla y biometría compatible.
// Regla 2: Separación estricta si brecha > 5 min o veto biométrico contundente.

let groups = [];
let currentGroup = null;

for (let i = 0; i < recordedUnits.length; i++) {
  const u = recordedUnits[i];
  if (!currentGroup) {
    currentGroup = {
      id: `Grupo_${groups.length + 1}`,
      units: [u],
      startSec: u.startSec,
      endSec: u.endSec,
      totalDuration: u.durationMinutes,
      photosCount: u.photosCount
    };
  } else {
    const gapSec = u.startSec - currentGroup.endSec;
    // Si la brecha es menor a 5 minutos (300s) y no hay salto temporal gigante:
    if (gapSec <= 300) {
      currentGroup.units.push(u);
      currentGroup.endSec = Math.max(currentGroup.endSec, u.endSec);
      currentGroup.totalDuration += u.durationMinutes;
      currentGroup.photosCount += u.photosCount;
    } else {
      groups.push(currentGroup);
      currentGroup = {
        id: `Grupo_${groups.length + 1}`,
        units: [u],
        startSec: u.startSec,
        endSec: u.endSec,
        totalDuration: u.durationMinutes,
        photosCount: u.photosCount
      };
    }
  }
}
if (currentGroup) {
  groups.push(currentGroup);
}

for (const g of groups) {
  const unitList = g.units.map(u => u.id).join(", ");
  console.log(`🔷 ${g.id} (${unitList})`);
  console.log(`   Rango: ${formatSec(g.startSec)} a ${formatSec(g.endSec)} | Duración acum: ${g.totalDuration} min | Fotos: ${g.photosCount}`);
}
