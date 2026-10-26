/**
 * ⚡ PASO 2 DEFINITIVO: FAST CAUSAL REPLAY (< 10s)
 * 
 * Simulación Causal Canónica de Alta Fidelidad en Tiempo Real:
 * - Paridad arquitectónica y algorítmica 100% con streaming y producción.
 * - Ingesta atómica de TrackBlockManager (Cero análisis imagen por imagen).
 * - Orquestador Causal Canónico (causal_cycle_orchestrator.js).
 * - Embudo de Cierre: validatePreConsolidationBarber, purgeStaffPhotos, validateSpatialChairAnchor.
 * - Consolidación Biocéntrica Causal (Capa 13 Incremental): Barrera de capa, veto homólogo, S-Norm adaptativo.
 * - Reporte y Hoja de Contacto modularizados (causal_report_generator.js).
 */

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
  generateProcessReport,
  generateVisualContactSheet,
  exportRepresentativeFaces,
  generateMermaidLineage,
  assertAntiChimeraPurity,
  TrackBlockManager
} from "../src/services/processes.js";

// Argumentos CLI
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

let videoName = getArg("--video");
const fromSecArg = getArg("--from");
const lastMinArg = getArg("--last");
const fromSecond = fromSecArg !== null ? parseFloat(fromSecArg) : null;
const lastMinutes = lastMinArg !== null ? parseFloat(lastMinArg) : null;
const syncFirebase = args.includes("--sync-firebase");
const targetDateArg = getArg("--target-date") || getArg("--date");

const dbPath = path.join(PROJECT_ROOT, "data", "experiments.db");
if (!fs.existsSync(dbPath)) {
  console.error(`❌ Base de datos no encontrada en: ${dbPath}`);
  console.error(`💡 Ejecuta primero el PASO 1: node scripts/step1_harvest_crops.js`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

if (!videoName) {
  const row = db.prepare("SELECT video_file FROM harvested_crops ORDER BY id DESC LIMIT 1").get();
  if (!row) {
    console.error(`❌ No hay recortes cosechados en 'harvested_crops'. Ejecuta primero el PASO 1.`);
    process.exit(1);
  }
  videoName = row.video_file;
} else {
  const exact = db.prepare("SELECT video_file FROM harvested_crops WHERE video_file = ? LIMIT 1").get(videoName);
  if (!exact) {
    const clean = path.basename(videoName, path.extname(videoName));
    const fuzzy = db.prepare("SELECT video_file FROM harvested_crops WHERE video_file LIKE ? LIMIT 1").get(`%${clean}%`);
    if (fuzzy) {
      videoName = fuzzy.video_file;
    }
  }
}

// Configurar tablas aisladas para el experimento
db.exec(`
  DROP TABLE IF EXISTS experiment_appointments;
  DROP TABLE IF EXISTS experiment_customer_embeddings;
  DROP TABLE IF EXISTS experiment_customers;
`);

// Limpiar auditorías transitorias previas
const auditDir = path.join(PROJECT_ROOT, "data", "audit_reports");
if (fs.existsSync(auditDir)) {
  try {
    for (const f of fs.readdirSync(auditDir)) {
      fs.unlinkSync(path.join(auditDir, f));
    }
  } catch (_) {}
}

// Instanciar cliente SQLite experimental
const experimentSqliteClient = new SQLiteClient(dbPath, {
  customersTable: "experiment_customers",
  customerEmbeddingsTable: "experiment_customer_embeddings",
  appointmentsTable: "experiment_appointments"
});

// Cargar cuadrantes espaciales de Firebase desde data/quadrants.json
const quadrantsPath = path.join(PROJECT_ROOT, "data", "quadrants.json");
let loadedQuadrants = [];
if (fs.existsSync(quadrantsPath)) {
  try {
    loadedQuadrants = JSON.parse(fs.readFileSync(quadrantsPath, "utf8"));
    setCustomQuadrants(loadedQuadrants);
    console.log(`[Quadrants] 📐 Cuadrantes de Firebase cargados desde data/quadrants.json (${loadedQuadrants.length} zonas).`);
  } catch (e) {
    console.warn(`[Quadrants] Aviso cargando data/quadrants.json:`, e.message);
  }
}
const chairZone = loadedQuadrants.find(q => q.type === "barber_chair" || q.id === "silla_barbero_puesto2") || loadedQuadrants[0] || null;

// Cargar personal (Barbero) desde data/barberia.db
let staffEmbeddings = [];
try {
  const prodPath = path.join(PROJECT_ROOT, "data", "barberia.db");
  if (fs.existsSync(prodPath)) {
    const prodDb = new Database(prodPath, { readonly: true });
    const staffRow = prodDb.prepare("SELECT * FROM customers WHERE is_staff = 1 OR id = 'staff_barbero' LIMIT 1").get();
    if (staffRow) {
      const embRows = prodDb.prepare("SELECT * FROM customer_embeddings WHERE customer_id = ? ORDER BY embedding_index ASC").all(staffRow.id);
      staffEmbeddings = embRows.map(r => ({
        vector: blobToVector(r.embedding_blob),
        pose: r.pose || "frontal",
        poseLabel: r.pose_label || "Frontal",
        sharpnessScore: r.sharpness_score || 0
      })).filter(e => Array.isArray(e.vector));

      db.prepare(`
        INSERT INTO experiment_customers (id, name, is_staff, role, photos_json, best_face_score, thumbnail_base64)
        VALUES (@id, @name, 1, 'barber', @photosJson, @bestFaceScore, @thumb)
      `).run({
        id: staffRow.id,
        name: staffRow.name || "Barbero",
        photosJson: staffRow.photos_json || "[]",
        bestFaceScore: staffRow.best_face_score || 0,
        thumb: staffRow.thumbnail_base64 || null
      });

      for (let idx = 0; idx < staffEmbeddings.length; idx++) {
        const item = staffEmbeddings[idx];
        db.prepare(`
          INSERT INTO experiment_customer_embeddings (customer_id, embedding_index, embedding_blob, sharpness_score, pose, pose_label)
          VALUES (@cid, @idx, @blob, @score, @pose, @label)
        `).run({
          cid: staffRow.id,
          idx,
          blob: vectorToBlob(item.vector),
          score: item.sharpnessScore || 0,
          pose: item.pose || "frontal",
          label: item.poseLabel || "Frontal"
        });
      }
    }
    prodDb.close();
  }
} catch (e) {
  console.warn(`[Staff] Aviso al cargar barbero:`, e.message);
}

// Configuración espacial de video dinámica
const videoWidth = Number(process.env.VIDEO_WIDTH) || 1280;
const videoHeight = Number(process.env.VIDEO_HEIGHT) || 720;

let firestoreDb = null;
let firestoreBucket = null;

if (syncFirebase) {
  process.env.USE_FIREBASE = "true";
  process.env.IS_LOCAL_SIMULATOR = "false";
  const { initFirebaseAdmin } = await import("../src/infrastructure/firebase/firebase_admin.js");
  const fb = initFirebaseAdmin({ databaseId: "test" });
  firestoreDb = fb.db;
  firestoreBucket = fb.bucket;
  console.log(`[Firestore] 🌐 Sincronización con Firebase activada [Database: test, Bucket: skip-bigotes-test]`);
} else {
  process.env.IS_LOCAL_SIMULATOR = "true";
}

// Instanciar servicios canónicos
const experimentCustomerService = new CustomerService({
  sqliteClient: experimentSqliteClient
});
await experimentCustomerService.loadProfilesIntoMemory();

// Listener de cierres para auditoría y linaje genealógico (sin monkey-patching)
const trackedClosures = [];

const visitService = new VisitSessionService({
  db: firestoreDb,
  bucket: firestoreBucket,
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

    const spatialCheck = validateSpatialChairAnchor({
      boxes: tramoBoxes,
      photos: tramoPhotos,
      chairId: session?.chairId,
      chairZone: session?.chairZone || chairZone
    }, chairZone, {
      quadrants: loadedQuadrants,
      width: videoWidth,
      height: videoHeight
    });

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
      durationMinutes: durationMin,
      photos: tramoPhotos,
      embeddings: tramoEmbeddings,
      boxes: tramoBoxes,
      thumbnailBase64: session?.thumbnailBase64 || tramoPhotos[0]?.thumbnailBase64 || null,
      spatialCheck,
      resultAppt: result
    });
  }
});

// Instanciar TrackBlockManager para ciclo de vida atómico por trackId
const trackBlockManager = new TrackBlockManager({
  staffProfiles: staffEmbeddings,
  staffThreshold: PIPELINE_CONFIG.staffFilter.staffExclusionThreshold || 0.46,
  quadrants: loadedQuadrants,
  width: videoWidth,
  height: videoHeight
});

// Cargar todas las filas cosechadas en orden cronológico puro
let query = "SELECT * FROM harvested_crops WHERE video_file = ?";
const params = [videoName];
if (fromSecond !== null && fromSecond > 0) {
  query += " AND video_second >= ?";
  params.push(fromSecond);
} else if (lastMinutes !== null && lastMinutes > 0) {
  const maxRow = db.prepare("SELECT MAX(video_second) as maxSec FROM harvested_crops WHERE video_file = ?").get(videoName);
  const startSec = Math.max(0, (maxRow?.maxSec || 0) - lastMinutes * 60);
  query += " AND video_second >= ?";
  params.push(startSec);
}
query += " ORDER BY video_second ASC, id ASC";

const rows = db.prepare(query).all(...params);

if (targetDateArg && rows.length > 0) {
  const targetEpoch = new Date(targetDateArg).getTime();
  if (!isNaN(targetEpoch)) {
    const shiftMs = targetEpoch - rows[0].timestamp_epoch;
    for (const r of rows) {
      r.timestamp_epoch += shiftMs;
    }
    console.log(`[DateShift] 📅 Fechas selladas a partir de: ${new Date(targetEpoch).toISOString()} (desplazamiento: ${(shiftMs / 3600000).toFixed(1)}h)`);
  }
}

console.log(`\n===============================================================`);
console.log(`   ⚡ PASO 2: FAST CAUSAL REPLAY (TRACKLET-CENTRIC / ZERO-BIAS)`);
console.log(`===============================================================`);
console.log(`📹 Video:             ${videoName}`);
console.log(`🌾 Cosechas en flujo: ${rows.length.toLocaleString()} frames de YOLO`);
console.log(`👤 Staff embeddings:  ${staffEmbeddings.length} vectores`);
console.log(`⏱️ Timeout de vacancia: ${PIPELINE_CONFIG.sessions.emptyChairTimeoutMs / 1000}s`);
console.log(`===============================================================\n`);

if (rows.length === 0) {
  console.log(`No hay recortes para procesar.`);
  process.exit(0);
}

const t0 = Date.now();
let lastTimestamp = null;
let processedCount = 0;

const accumulator = createProcessAccumulator();

// Ingesta unificada a través del pipeline funcional central (runProcessCycle)
for (const row of rows) {
  processedCount++;
  const cycle = await runProcessCycle({
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

  if (cycle.metrics) {
    accumulator.add(cycle.metrics);
  }

  lastTimestamp = row.timestamp_epoch;
}

// 3. Finalización ordenada de todos los bloques y sillas al término del stream
await flushProcessPipeline({
  lastTimestamp,
  trackBlockManager,
  visitService
});

// Resolución de citas definitivas
const rawCompletedAppts = visitService.completedAppointments || [];
const baseVideoEpoch = rows.length > 0 ? (rows[0].timestamp_epoch - rows[0].video_second * 1000) : 0;

const completedAppts = rawCompletedAppts.map((appt, idx) => {
  const startMs = appt.startedAtEpoch || new Date(appt.startedAt).getTime();
  const endMs = appt.endedAtEpoch || new Date(appt.endedAt).getTime();
  const startSec = Math.max(0, Math.round((startMs - baseVideoEpoch) / 1000));
  const endSec = Math.max(startSec, Math.round((endMs - baseVideoEpoch) / 1000));
  return {
    ...appt,
    clientName: `Cliente #${idx + 1}`,
    personName: `Cliente #${idx + 1}`,
    startSecond: startSec,
    endSecond: endSec
  };
});

if (experimentSqliteClient && completedAppts.length > 0) {
  try {
    db.prepare("DELETE FROM experiment_appointments").run();
    for (const a of completedAppts) {
      experimentSqliteClient.saveAppointment(a);
    }
  } catch (_) {}
}

if (firestoreDb && completedAppts.length > 0) {
  const { sanitizeForFirestore } = await import("../src/infrastructure/firebase/firestore_sanitizer.js");
  for (const a of completedAppts) {
    try {
      await firestoreDb.doc(`camera_catcher_appointments/${a.id}`).set(sanitizeForFirestore(a), { merge: true });
    } catch (e) {
      console.warn(`[Firestore] Error actualizando cita ${a.id}:`, e.message);
    }
  }
  console.log(`[Firestore] 🌐 ${completedAppts.length} citas sincronizadas en camera_catcher_appointments (test).`);
}

const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2);

const now = new Date();
const padTime = (n) => String(n).padStart(2, '0');
const timestampFile = `${now.getFullYear()}${padTime(now.getMonth()+1)}${padTime(now.getDate())}_${padTime(now.getHours())}${padTime(now.getMinutes())}${padTime(now.getSeconds())}`;

// Generación de artefactos y reportes vía Causal Report Generator
const simDirName = `simulacion_${path.basename(videoName, path.extname(videoName))}`;
const assetsDir = path.join(PROJECT_ROOT, "docs", "assets", simDirName);
const repCitasDir = path.join(assetsDir, "rep_citas");

// Limpiar artefactos visuales previos de esta simulación para evitar acumulación
if (fs.existsSync(assetsDir)) {
  const oldSheets = fs.readdirSync(assetsDir).filter(f => f.startsWith("contact_sheet_") && f.endsWith(".jpg"));
  for (const sheet of oldSheets) {
    try { fs.unlinkSync(path.join(assetsDir, sheet)); } catch (_) {}
  }
}
if (fs.existsSync(repCitasDir)) {
  try { fs.rmSync(repCitasDir, { recursive: true, force: true }); } catch (_) {}
}
fs.mkdirSync(repCitasDir, { recursive: true });

const contactSheetPath = await generateVisualContactSheet({
  completedAppts,
  outputDir: assetsDir,
  timestampFile
});

await exportRepresentativeFaces({
  completedAppts,
  trackedClosures,
  repCitasDir
});

const mermaidTree = generateMermaidLineage({
  trackedClosures,
  completedAppts,
  repCitasDir
});

const docsDir = path.join(PROJECT_ROOT, "docs");
// Rotación de reportes Markdown antiguos (conservar máximo 2 para no dejar basura)
try {
  const existingReports = fs.readdirSync(docsDir)
    .filter(f => f.startsWith("REPORTE_FUNNEL_") && f.endsWith(".md") && f !== "REPORTE_FUNNEL_LATEST.md")
    .map(f => ({ path: path.join(docsDir, f), time: fs.statSync(path.join(docsDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  for (const oldRep of existingReports.slice(2)) {
    try { fs.unlinkSync(oldRep.path); } catch (_) {}
  }
} catch (_) {}

const reportPath = path.join(docsDir, `REPORTE_FUNNEL_${timestampFile}.md`);
await generateProcessReport({
  reportPath,
  videoName,
  dbPath,
  elapsedSec,
  metrics: {
    ...accumulator.toJSON(),
    confirmedBlocksCount: (trackBlockManager.totalConfirmedBlocksCount ?? trackBlockManager.completedBlocks.length)
  },
  completedAppts,
  trackedClosures,
  mermaidTree,
  contactSheetPath,
  baseVideoEpoch
});

try {
  const latestReportPath = path.join(docsDir, "REPORTE_FUNNEL_LATEST.md");
  fs.copyFileSync(reportPath, latestReportPath);
} catch (_) {}

// Registrar corrida en experiment_runs
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiment_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_timestamp TEXT,
      video_file TEXT,
      total_crops_evaluated INTEGER,
      appointments_found INTEGER,
      clients_found INTEGER,
      barber_segments_discarded INTEGER,
      execution_time_sec REAL,
      options_json TEXT
    );
  `);
  db.prepare(`
    INSERT INTO experiment_runs (
      run_timestamp, video_file, total_crops_evaluated, appointments_found,
      clients_found, barber_segments_discarded, execution_time_sec, options_json
    ) VALUES (
      @ts, @video, @total, @appts, @clients, @barber, @sec, @opts
    )
  `).run({
    ts: timestampFile,
    video: videoName,
    total: processedCount,
    appts: completedAppts.length,
    clients: completedAppts.length,
    barber: accumulator.countStaffExcluded,
    sec: Number(elapsedSec),
    opts: JSON.stringify({ mode: "causal_replay_track_block", staffThreshold: PIPELINE_CONFIG.staffFilter.staffExclusionThreshold })
  });
} catch (_) {}

console.log(`\n===============================================================`);
console.log(`   🎉 FAST CAUSAL REPLAY COMPLETADO EN ${elapsedSec}s`);
console.log(`===============================================================`);
console.log(`⚡ Cuadros evaluados:    ${processedCount.toLocaleString()}`);
console.log(`👤 Exclusión staff/pie:  ${accumulator.countStaffExcluded.toLocaleString()} capturas`);
console.log(`✂️ Clientes aprobados:   ${accumulator.countClientPassed.toLocaleString()} capturas`);
console.log(`🧱 Bloques confirmados:  ${(trackBlockManager.totalConfirmedBlocksCount ?? trackBlockManager.completedBlocks.length)}`);
console.log(`👥 Citas finales:        ${completedAppts.length}`);
console.log(`📑 Reporte Markdown:     ${reportPath}`);
if (contactSheetPath) console.log(`🖼️ Hoja de Contacto:     ${contactSheetPath}`);
console.log(`===============================================================\n`);

// Aserciones biométricas causales (Argon 4)
const chimeraCheck = assertAntiChimeraPurity(completedAppts, PIPELINE_CONFIG.biometrics?.chimeraThreshold ?? 0.38);

console.log(`📋 DETALLE CRONOLÓGICO DE ATENCIONES FORMALIZADAS:\n`);
for (const item of chimeraCheck.results) {
  const statusIcon = item.isChimeraDetected ? "❌ [QUIMERA]" : "✅";
  console.log(`${statusIcon} [Cita #${item.index}] ${item.clientName}:`);
  console.log(`   - Duración:  ${item.durMin} min (${item.startIso} a ${item.endIso})`);
  console.log(`   - Fotos:     ${item.photosCount} fotos | Score máx: ${item.bestFaceScore}`);
  console.log(`   - Biometría: ${item.embeddingsCount} vectores | MinSim: ${item.minPairSim.toFixed(3)} | AvgSim: ${item.avgPairSim} | MaxSim: ${item.maxPairSim.toFixed(3)}`);
  console.log(``);
}

console.log(`---------------------------------------------------------------`);
console.log(`🛡️ RESULTADO DE LAS ASERCIONES CAUSALES (Argon 4):`);
if (chimeraCheck.hasChimera) {
  console.error(`❌ FALLA DE ASERCIÓN: Se detectaron quimeras intra-sesión (similitud < ${PIPELINE_CONFIG.biometrics?.chimeraThreshold ?? 0.38} entre fotos de la misma cita).`);
} else {
  console.log(`✅ ASERCIÓN ANTI-QUIMERA: Superada al 100%. Todas las citas son biométricamente puras.`);
}
console.log(`===============================================================\n`);
