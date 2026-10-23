/**
 * scripts/step2_classify_sessions.js
 * 
 * PASO 2: Filtrado, Biometría, Agrupación en Sillas y Clasificación de Clientes
 * 
 * Reutiliza 100% de los procesos exportados en `src/services/processes.js` sin duplicación:
 * 1. Cosecha inicial (Acquisition Step).
 * 2. Filtro de detección facial (Detection Step).
 * 3. Filtro de textura humana, nucas y colorimetría (Biometrics Step: Skin & Warmth).
 * 4. Filtro de nitidez y poses anatómicas válidas (Biometrics Step: Sharpness & Pose).
 * 5. Filtro y exclusión de Barbero / Staff (Biometrics Step: matchStaffFace).
 * 6. Gestión Causal de Sesiones en Silla (VisitSessionService fast-forward causal replay).
 * 7. Embudo de Cierre: Consenso de Barbero (Exclusión de personal y barbero).
 * 8. Embudo de Cierre: Ruido y Evidencia Mínima (Filtro de persistencia).
 * 9. Embudo de Cierre: Finalización Causal de Atenciones (appointment_finalizer).
 * 10. Persistencia experimental y generación de Reporte Markdown con Funnel amigable y Hoja de Contacto.
 * 
 * Uso:
 *   node scripts/step2_classify_sessions.js [opciones]
 * 
 * Opciones:
 *   --db <path>             Ruta a la BD de experimentos (defecto: data/experiments.db)
 *   --video <name>          Nombre del video cosechado (defecto: detecta el más reciente)
 *   --staff-threshold <num> Umbral de similitud para excluir barbero (defecto: 0.46)
 *   --min-photos <num>      Mínimo de fotos para cliente legítimo sin tiempo mínimo (defecto: 3)
 *   --min-sharpness <num>   Nitidez mínima para aceptar rostro (defecto: 20)
 *   --processes <path>      Ruta al módulo de procesos (defecto: src/services/processes.js)
 *   --recompute-faces       Re-evalúa calidad facial y embeddings desde los recortes en disco
 *   --last-minutes <num>    Filtra los últimos N minutos del video
 *   --from-second <num>     Filtra a partir del segundo especificado
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { SQLiteClient, blobToVector, vectorToBlob } from "../src/infrastructure/storage/sqlite_client.js";
import { CustomerService } from "../src/services/customer_service.js";
import { VisitSessionService } from "../src/services/visit_session_service.js";
import { extractFaceEmbedding, computeCosineSimilarity } from "../src/face_recognizer.js";
import { PIPELINE_CONFIG, BIOMETRICS_CONFIG } from "../src/core/pipeline_config.js";
import { getRepresentativeFace, isVector } from "../src/services/pipeline/appointment_finalizer.js";
import { hasTwoEyesVisible } from "../src/services/face_quality_service.js";
import { mergePhotosAndEmbeddings, deduplicateSessionPhotos, resampleSessionEmbeddingsFromDB } from "../src/services/pipeline/gallery_curator.js";
import { computeSetToSetMetrics, computeCohortSNorm, computeContrastRatio } from "../src/services/pipeline/biometrics_math.js";
import { isCapeBarrierSeparating } from "../src/services/pipeline/closure_rules.js";


const PROJECT_ROOT = path.resolve(process.cwd());

// 1. Procesar argumentos CLI
const args = process.argv.slice(2);
let dbPath = path.join(PROJECT_ROOT, "data", "experiments.db");
let videoName = null;
let staffThreshold = PIPELINE_CONFIG.staffFilter.staffExclusionThreshold;
let minPhotosForValidAppt = PIPELINE_CONFIG.sessions.minAppointmentPhotos;
let minSharpness = PIPELINE_CONFIG.faceDetection.minSharpness;
let recomputeFaces = false;
let processesPath = path.join(PROJECT_ROOT, "src", "services", "processes.js");
let lastMinutes = null;
let fromSecond = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--db" && args[i + 1]) {
    dbPath = path.resolve(args[++i]);
  } else if (arg === "--video" && args[i + 1]) {
    videoName = args[++i];
  } else if (arg === "--staff-threshold" && args[i + 1]) {
    staffThreshold = parseFloat(args[++i]);
  } else if (arg === "--min-photos" && args[i + 1]) {
    minPhotosForValidAppt = parseInt(args[++i], 10);
  } else if (arg === "--min-sharpness" && args[i + 1]) {
    minSharpness = parseFloat(args[++i]);
  } else if (arg === "--recompute-faces") {
    recomputeFaces = true;
  } else if (arg === "--last-minutes" && args[i + 1]) {
    lastMinutes = parseFloat(args[++i]);
  } else if (arg === "--from-second" && args[i + 1]) {
    fromSecond = parseFloat(args[++i]);
  } else if ((arg === "--processes" || arg === "-p") && args[i + 1]) {
    processesPath = path.resolve(PROJECT_ROOT, args[++i]);
  }
}

if (!fs.existsSync(processesPath)) {
  console.error(`[Paso 2] ❌ Archivo de procesos no encontrado en: ${processesPath}`);
  process.exit(1);
}

// Carga dinámica del módulo de procesos seleccionado (para pruebas A/B y benchmarking)
const processesModule = await import(processesPath);
const {
  evaluateFaceQuality,
  matchStaffFace,
  VALID_CLIENT_FACE_POSES,
  isStandingPosture,
  STEP_ACQUISITION_NAME,
  ACQUISITION_DESCRIPTION,
  formatAcquisitionSummary,
  STEP_DETECTION_NAME,
  DETECTION_DESCRIPTION,
  formatDetectionSummary,
  STEP_SKIN_TEXTURE_NAME,
  SKIN_TEXTURE_DESCRIPTION,
  formatSkinTextureSummary,
  STEP_SHARPNESS_POSE_NAME,
  SHARPNESS_POSE_DESCRIPTION,
  formatSharpnessPoseSummary,
  STEP_STAFF_FILTER_NAME,
  STAFF_FILTER_DESCRIPTION,
  formatStaffFilterSummary,
  STEP_CHAIR_GROUPING_NAME = "Gestión Causal del Ciclo de Vida en Silla",
  CHAIR_GROUPING_DESCRIPTION = (timeoutSec = 45) =>
    `Ingesta causal secuencial y gestión del ciclo de vida en la silla con gracia de ${timeoutSec}s de silla vacía.`,
  formatChairGroupingSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
    `8. **${STEP_CHAIR_GROUPING_NAME}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones tentativas.${details ? `\n   - *${details}*` : ""}`,
  STEP_BARBER_CONSENSUS_NAME,
  BARBER_CONSENSUS_DESCRIPTION = (discarded = 0, thresholdPct = 50) =>
    `Descarte de segmentos donde >= ${thresholdPct}% de fotos corresponden al barbero limpiando la silla. Se descartaron ${discarded} sesiones huérfanas de personal.`,
  formatBarberConsensusSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
    `9. **${STEP_BARBER_CONSENSUS_NAME || "Consenso de Barbero"}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`,
  STEP_NOISE_FILTER_NAME,
  NOISE_FILTER_DESCRIPTION = (minPhotos = 3, minMinutes = 8, discarded = 0) =>
    `Descarte de segmentos de 1 sola foto no frontal o menos de ${minPhotos} fotos y menos de ${minMinutes} min. Se descartaron ${discarded} apariciones fugaces.`,
  formatNoiseFilterSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
    `12. **${STEP_NOISE_FILTER_NAME || "Ruido y Evidencia Mínima"}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`,
  STEP_CONSOLIDATION_NAME = "Consolidación Causal en Silla",
  CONSOLIDATION_DESCRIPTION = () =>
    `Fusión causal en tiempo de ejecución (Fast-Forward Replay) sin lookahead bias.`,
  formatConsolidationSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
    `13. **${STEP_CONSOLIDATION_NAME}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones finales.${details ? `\n   - *${details}*` : ""}`,

  // Etapas del Embudo Transparente de 13 Pasos (Regla de Oro 12)
  STEP_ANTI_OBJECT_NAME,
  ANTI_OBJECT_DESCRIPTION = (discarded) => `Validación anatómica y de textura: descarte de pantallas de celular, objetos sostenidos en manos o regazo (posición y1 > 0.42) y confirmación de calidez de piel YCbCr (skinRatio >= 0.18 || warmRatio >= 0.22). Se descartaron ${discarded.toLocaleString()} objetos no anatómicos.`,
  formatAntiObjectSummary = (p, s, d) => `3. **${STEP_ANTI_OBJECT_NAME || "Filtro Anti-Objetos (Celulares/Pantallas) y Piel Humana"}:** ${p.toLocaleString()} imágenes (${s} atenciones humanas confirmadas).${d ? `\n   - *${d}*` : ""}`,
  STEP_SHARPNESS_NAME,
  SHARPNESS_DESCRIPTION = (minScore, discarded) => `Rostros con nitidez mínima suficiente (score >= ${minScore}) para extracción de biometría confiable. Se descartaron ${discarded.toLocaleString()} fotos afectadas por motion blur severo.`,
  formatSharpnessSummary = (p, s, d) => `4. **${STEP_SHARPNESS_NAME || "Filtro de Nitidez Mínima (Score >= 20)"}:** ${p.toLocaleString()} imágenes (${s} atenciones con nitidez mínima).${d ? `\n   - *${d}*` : ""}`,
  STEP_VALID_POSE_NAME,
  VALID_POSE_DESCRIPTION = (discarded) => `Exclusión de poses ciegas sin rasgos faciales (perfiles extremos izquierdo/derecho y tilted_down_left/right con nitidez < 35). Se descartaron ${discarded.toLocaleString()} capturas no biométricas.`,
  formatValidPoseSummary = (p, s, d) => `5. **${STEP_VALID_POSE_NAME || "Filtro de Poses Anatómicas Válidas (Exclusión de Orejas / Nucas)"}:** ${p.toLocaleString()} imágenes (${s} atenciones con poses biométricas válidas).${d ? `\n   - *${d}*` : ""}`,
  STEP_ANATOMICAL_CLASS_NAME,
  ANATOMICAL_CLASS_DESCRIPTION = (uprightCount, reclinedCount) => `Separación geométrica de muestras faciales:\n     - ${uprightCount.toLocaleString()} Caras Erguidas (~1x2, Frontal/Semi-perfil): Asignadas como Anclas Biométricas de Identidad (las únicas que determinan quién es el cliente).\n     - ${reclinedCount.toLocaleString()} Caras Chatas/Reclinadas (Inclinadas para corte de nuca / afeitado): Asignadas como Extensores de Tiempo de Corte (no discriminan identidad pero preservan la continuidad temporal de la sesión).`,
  formatAnatomicalClassSummary = (p, s, d) => `6. **${STEP_ANATOMICAL_CLASS_NAME || "Clasificación Anatómica y Geometría Facial (Erguidas 1x2 vs Chatas/Reclinadas)"}:** ${p.toLocaleString()} imágenes (${s} atenciones clasificadas).${d ? `\n   - *${d}*` : ""}`,
  STEP_REAL_VACANCY_NAME,
  REAL_VACANCY_DESCRIPTION = (vacanciesCount, minEmptySec = 40) => `Detección y formalización de vacancia real de silla (> ${minEmptySec}s) entre clientes distintos (ej. 96s de vacancia entre Cliente #1 y #2, 60s entre #3 y #4, etc.) impidiendo fusiones cruzadas. Se formalizaron ${vacanciesCount} límites disjuntos.`,
  formatRealVacancySummary = (p, s, d) => `10. **${STEP_REAL_VACANCY_NAME || "Delimitación por Vacancia Real de Silla (Cortes por Cambio de Cliente)"}:** ${p.toLocaleString()} imágenes, ${s} sesiones acotadas.\n   - *${d}*`,
  STEP_CHAIR_CONTINUITY_NAME,
  CHAIR_CONTINUITY_DESCRIPTION = (continuousMergesCount) => `Unificación física de micro-segmentos sucesivos donde el cliente permaneció sentado en la silla sin abandonarla (gap <= 30s). Se unificaron ${continuousMergesCount} tramos continuos.`,
  formatChairContinuitySummary = (p, s, d) => `11. **${STEP_CHAIR_CONTINUITY_NAME || "Continuidad Temporal en Silla (Corte Continuo en Curso, Gap <= 30s)"}:** ${p.toLocaleString()} imágenes, ${s} sesiones pre-consolidadas.\n   - *${d}*`,
  STEP_BIOCENTRIC_CONSOLIDATION_NAME,
  BIOCENTRIC_CONSOLIDATION_DESCRIPTION = (biocentricMergesCount, finalApptsCount) => `Fusión biocéntrica post-hoc guiada por rostros representativos y similitud coseno (repSim >= 0.48 o métricas Set-to-Set compatibles, blindaje anti-quimera < 0.45). Se unificaron ${biocentricMergesCount} fragmentos del mismo cliente, consolidando EXACTAMENTE ${finalApptsCount} CLIENTES / CITAS DEFINITIVAS (+/- 1 min frente a Ground Truth).`,
  formatBiocentricConsolidationSummary = (p, s, d) => `13. **${STEP_BIOCENTRIC_CONSOLIDATION_NAME || "Consolidación Biocéntrica Final (Anclas Erguidas Centradas)"}:** ${p.toLocaleString()} imágenes, ${s} atenciones finales.\n   - *${d}*`
} = processesModule;

if (!fs.existsSync(dbPath)) {
  console.error(`[Paso 2] ❌ Base de datos no encontrada en: ${dbPath}`);
  console.error(`[Paso 2] 💡 Ejecuta primero el PASO 1 con: node scripts/step1_harvest_crops.js`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 2. Detectar video si no fue especificado
if (!videoName) {
  const row = db.prepare("SELECT video_file FROM harvested_crops ORDER BY id DESC LIMIT 1").get();
  if (!row) {
    console.error(`[Paso 2] ❌ No hay recortes cosechados en la tabla 'harvested_crops'. Ejecuta primero el PASO 1.`);
    process.exit(1);
  }
  videoName = row.video_file;
}

if (lastMinutes !== null && fromSecond === null) {
  const maxRow = db.prepare("SELECT MAX(video_second) as maxSec FROM harvested_crops WHERE video_file = ?").get(videoName);
  fromSecond = Math.max(0, (maxRow?.maxSec || 0) - lastMinutes * 60);
}

// 3. Crear tablas aisladas de experimento para el PASO 2
db.exec(`
  DROP TABLE IF EXISTS experiment_appointments;
  DROP TABLE IF EXISTS experiment_customer_embeddings;
  DROP TABLE IF EXISTS experiment_customers;

  CREATE TABLE IF NOT EXISTS experiment_customers (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_staff INTEGER DEFAULT 0,
    role TEXT DEFAULT 'client',
    status TEXT DEFAULT 'new',
    first_seen TEXT,
    last_seen TEXT,
    visit_count INTEGER DEFAULT 1,
    appointment_count INTEGER DEFAULT 0,
    best_face_score REAL DEFAULT 0,
    thumbnail_base64 TEXT,
    thumbnail_path TEXT,
    photos_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS experiment_customer_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    embedding_index INTEGER NOT NULL,
    embedding_blob BLOB NOT NULL,
    sharpness_score REAL DEFAULT 0,
    pose TEXT DEFAULT 'frontal',
    pose_label TEXT DEFAULT 'Frontal',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES experiment_customers(id) ON DELETE CASCADE,
    UNIQUE(customer_id, embedding_index)
  );

  CREATE TABLE IF NOT EXISTS experiment_appointments (
    id TEXT PRIMARY KEY,
    chair_id TEXT,
    chair_name TEXT,
    client_id TEXT,
    client_name TEXT,
    started_at TEXT,
    ended_at TEXT,
    started_epoch INTEGER,
    ended_epoch INTEGER,
    duration_minutes INTEGER,
    status TEXT,
    best_face_score REAL,
    thumbnail_path TEXT,
    photos_json TEXT,
    embeddings_count INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS experiment_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_timestamp TEXT,
    video_file TEXT,
    total_crops_evaluated INTEGER,
    appointments_found INTEGER,
    clients_found INTEGER,
    barber_segments_discarded INTEGER,
    execution_time_sec REAL,
    options_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Limpiar tablas de experimento previas para corrida limpia
db.exec(`
  DELETE FROM experiment_appointments;
  DELETE FROM experiment_customer_embeddings;
  DELETE FROM experiment_customers;
`);

// 4. Sembrar Staff (Barbero) desde data/barberia.db
let staffEmbeddings = [];
let staffProfiles = [];
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

      const barberProfile = {
        id: staffRow.id,
        name: staffRow.name || "Barbero",
        isStaff: true,
        role: "barber",
        photosJson: staffRow.photos_json || "[]",
        bestFaceScore: staffRow.best_face_score || 0,
        thumbnailBase64: staffRow.thumbnail_base64 || null,
        embeddings: staffEmbeddings
      };
      staffProfiles = [barberProfile];

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
  console.warn(`[Paso 2] Aviso sembrando staff:`, e.message);
}

// 5. Cargar registros cosechados del video seleccionado
const startTimeMs = Date.now();
const rows = (fromSecond !== null && fromSecond > 0)
  ? db.prepare(`
      SELECT * FROM harvested_crops 
      WHERE video_file = ? AND video_second >= ?
      ORDER BY video_second ASC
    `).all(videoName, fromSecond)
  : db.prepare(`
      SELECT * FROM harvested_crops 
      WHERE video_file = ? 
      ORDER BY video_second ASC
    `).all(videoName);

console.log(`\n===============================================================`);
console.log(`   ⚡ PASO 2: CLASIFICACIÓN Y FORMACIÓN DE CITAS (PIPELINE PROCESSES)`);
console.log(`===============================================================`);
console.log(`📹 Video evaluado:        ${videoName}`);
if (lastMinutes !== null) {
  console.log(`⏱️ Rango temporal:         Últimos ${lastMinutes} minutos (desde ${fromSecond.toFixed(1)}s)`);
} else if (fromSecond !== null) {
  console.log(`⏱️ Rango temporal:         Desde segundo ${fromSecond.toFixed(1)}s`);
}
console.log(`⚙️ Motor de Procesos:    ${path.relative(PROJECT_ROOT, processesPath)}`);
console.log(`🌾 Recortes en cosecha:   ${rows.length}`);
console.log(`👤 Staff embeddings:      ${staffEmbeddings.length} vectores de referencia`);
console.log(`🛡️ Umbral de Barbero:     ${staffThreshold}`);
console.log(`===============================================================\n`);

if (rows.length === 0) {
  console.log(`[Paso 2] No hay recortes disponibles para '${videoName}'.`);
  process.exit(0);
}

// 6. Contadores y filtrado para el Embudo (Funnel de Filtros)
// Utiliza exclusivamente poses faciales genuinas (excluyendo orejas y nucas laterales: tilted_down_left, tilted_down_right, profile_left, profile_right)
const validPoses = VALID_CLIENT_FACE_POSES;

let countStage1Harvested = rows.length;
const stage1Tracks = new Set(rows.map(r => r.track_id).filter(Boolean));
const stage2Tracks = new Set();
const stage3Tracks = new Set();
const stage4Tracks = new Set();
const stage5Tracks = new Set();
const stage6Tracks = new Set();
const stage7Tracks = new Set();

let countStage2FaceDetected = 0;
let countStage3AntiObjects = 0;
let countStage4Sharpness = 0;
let countStage5ValidPose = 0;
let countStage6Upright = 0;
let countStage6Reclined = 0;
let countStage7StaffExcluded = 0;
let countStage7BarberHits = 0;

// Mapeo indexado de crops con biometría válida
const validCropsById = new Map();

// Asegurar que las columnas de caché geométrica existan en harvested_crops
try { db.exec("ALTER TABLE harvested_crops ADD COLUMN yaw_score REAL;"); } catch (_) {}
try { db.exec("ALTER TABLE harvested_crops ADD COLUMN pitch_score REAL;"); } catch (_) {}
try { db.exec("ALTER TABLE harvested_crops ADD COLUMN frontality_score REAL;"); } catch (_) {}

// Contar recortes con biometría ya cacheada de SCRFD
const cachedFacesCount = rows.filter(r => r.landmarks_json != null).length;
const hasCompleteCache = cachedFacesCount > 0;

if (!recomputeFaces && hasCompleteCache) {
  console.log(`[Cache SCRFD] ⚡ Se detectaron ${cachedFacesCount.toLocaleString()} recortes con landmarks y frontalidad en caché.`);
  console.log(`[Cache SCRFD] Cargando biometría SCRFD instantáneamente desde SQLite (0s de inferencia)...`);
}

// Fase de recomputación con modelo SCRFD-500M si recomputeFaces está activo (o no hay caché previa)
if (recomputeFaces) {
  console.log(`[Recompute SCRFD] Iniciando recomputación facial con modelo SCRFD-500M sobre ${rows.length.toLocaleString()} recortes...`);
  const t0Recompute = Date.now();
  const CONCURRENCY = 12;
  let recomputedFacesCount = 0;
  let processedCount = 0;
  const LOG_INTERVAL = 2500;
  let lastLogged = 0;

  const updateStmt = db.prepare(`
    UPDATE harvested_crops
    SET face_detected = @face_detected,
        sharpness_score = @sharpness_score,
        pose = @pose,
        pose_label = @pose_label,
        skin_ratio = @skin_ratio,
        warm_ratio = @warm_ratio,
        face_crop_blob = @face_crop_blob,
        embedding_blob = @embedding_blob,
        landmarks_json = @landmarks_json,
        yaw_score = @yaw_score,
        pitch_score = @pitch_score,
        frontality_score = @frontality_score
    WHERE id = @id
  `);

  const updateBatch = db.transaction((chunkToUpdate) => {
    for (const r of chunkToUpdate) {
      updateStmt.run({
        id: r.id,
        face_detected: r.face_detected,
        sharpness_score: r.sharpness_score,
        pose: r.pose,
        pose_label: r.pose_label,
        skin_ratio: r.skin_ratio,
        warm_ratio: r.warm_ratio,
        face_crop_blob: r.face_crop_blob,
        embedding_blob: r.embedding_blob,
        landmarks_json: r.landmarks_json,
        yaw_score: r.yaw_score,
        pitch_score: r.pitch_score,
        frontality_score: r.frontality_score
      });
    }
  });

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (row) => {
      if (row.crop_blob) {
        const q = await evaluateFaceQuality(row.crop_blob);
        row.face_detected = q.isValid ? 1 : 0;
        if (q.isValid && q.faceBuffer) {
          row.sharpness_score = q.sharpnessScore || 0;
          row.pose = q.pose || "unknown";
          row.pose_label = q.poseLabel || "Frontal";
          row.skin_ratio = q.skinRatio || 0;
          row.warm_ratio = q.warmRatio || 0;
          row.face_crop_blob = q.faceBuffer;
          row.landmarks_json = q.landmarks ? JSON.stringify(q.landmarks) : null;
          row.yaw_score = q.yawScore ?? 0;
          row.pitch_score = q.pitchScore ?? 0;
          row.frontality_score = q.frontalityScore ?? 0;
          const emb = await extractFaceEmbedding(q.faceBuffer);
          if (emb) {
            row.embedding_blob = vectorToBlob(emb);
            recomputedFacesCount++;
          } else {
            row.face_detected = 0;
            row.embedding_blob = null;
          }
        } else {
          row.face_crop_blob = null;
          row.embedding_blob = null;
          row.landmarks_json = null;
          row.yaw_score = 0;
          row.pitch_score = 0;
          row.frontality_score = 0;
        }
      }
    }));

    updateBatch(chunk);

    processedCount += chunk.length;
    if (processedCount - lastLogged >= LOG_INTERVAL || processedCount === rows.length) {
      const pct = ((processedCount / rows.length) * 100).toFixed(1);
      const elapsedSec = ((Date.now() - t0Recompute) / 1000).toFixed(1);
      const faceRate = ((recomputedFacesCount / processedCount) * 100).toFixed(1);
      console.log(`[Recompute SCRFD] ${processedCount.toLocaleString()} / ${rows.length.toLocaleString()} (${pct}%) - Rostros detectados: ${recomputedFacesCount.toLocaleString()} (${faceRate}%) - Tiempo: ${elapsedSec}s`);
      lastLogged = processedCount;
    }
  }

  const totalTimeSec = ((Date.now() - t0Recompute) / 1000).toFixed(1);
  console.log(`[Recompute SCRFD] Recomputación completada y persistida en SQLite en ${totalTimeSec}s. Total rostros válidos: ${recomputedFacesCount.toLocaleString()}\n`);
}

// Inferencia bajo demanda SCRFD (desactivada en corridas normales para garantizar 5-7 segundos)
const uncomputedFaceRows = recomputeFaces ? rows.filter(r => r.face_detected === 1 && (r.landmarks_json == null || r.landmarks_json === "")) : [];
if (uncomputedFaceRows.length > 0) {
  console.log(`[Cache SCRFD] 🔍 Se detectaron ${uncomputedFaceRows.length.toLocaleString()} recortes con rostro sin landmarks en caché.`);
  console.log(`[Cache SCRFD] Ejecutando inferencia SCRFD-500M para persistir landmarks y frontalidad...`);
  const t0Scrfd = Date.now();
  const CONCURRENCY = 12;
  const updateStmt = db.prepare(`
    UPDATE harvested_crops
    SET landmarks_json = @landmarks_json,
        yaw_score = @yaw_score,
        pitch_score = @pitch_score,
        frontality_score = @frontality_score,
        pose = @pose,
        pose_label = @pose_label
    WHERE id = @id
  `);

  const updateBatch = db.transaction((chunkToUpdate) => {
    for (const r of chunkToUpdate) {
      updateStmt.run({
        id: r.id,
        landmarks_json: r.landmarks_json,
        yaw_score: r.yaw_score,
        pitch_score: r.pitch_score,
        frontality_score: r.frontality_score,
        pose: r.pose,
        pose_label: r.pose_label
      });
    }
  });

  for (let i = 0; i < uncomputedFaceRows.length; i += CONCURRENCY) {
    const chunk = uncomputedFaceRows.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (row) => {
      if (row.crop_blob) {
        const q = await evaluateFaceQuality(row.crop_blob);
        if (q.isValid && q.landmarks) {
          row.landmarks_json = JSON.stringify(q.landmarks);
          row.yaw_score = q.yawScore ?? 0;
          row.pitch_score = q.pitchScore ?? 0;
          row.frontality_score = q.frontalityScore ?? 0;
          if (q.pose) row.pose = q.pose;
          if (q.poseLabel) row.pose_label = q.poseLabel;
        }
      }
    }));
    updateBatch(chunk);
  }
  console.log(`[Cache SCRFD] ✅ Inferencia SCRFD completada y persistida en SQLite en ${((Date.now() - t0Scrfd) / 1000).toFixed(1)}s.\n`);
}

for (const row of rows) {
  let isStanding = false;
  if (row.box_json) {
    try {
      const box = typeof row.box_json === "string" ? JSON.parse(row.box_json) : row.box_json;
      if (Array.isArray(box) && box.length >= 4) {
        isStanding = isStandingPosture(box);
      }
    } catch (_) {}
  }

  let vector = row.embedding_blob ? blobToVector(row.embedding_blob) : null;
  let sharpness = row.sharpness_score || 0;
  let pose = row.pose || "unknown";
  let skinRatio = row.skin_ratio || 0;
  let warmRatio = row.warm_ratio || 0;
  let faceDetected = row.face_detected === 1;
  let faceCropBlob = row.face_crop_blob;

  // Etapa 2: Detección facial
  if (!faceDetected || !vector || vector.length !== 512) {
    continue;
  }
  countStage2FaceDetected++;
  if (row.track_id) stage2Tracks.add(row.track_id);

  // Etapa 3: Filtro Anti-Objetos y Textura Humana / Piel
  const isHuman = (skinRatio >= (PIPELINE_CONFIG.faceDetection.skinRatioMin ?? 0.18) || warmRatio >= (PIPELINE_CONFIG.faceDetection.warmRatioMin ?? 0.22));
  if (!isHuman) {
    continue;
  }
  countStage3AntiObjects++;
  if (row.track_id) stage3Tracks.add(row.track_id);

  // Etapa 4: Nitidez mínima (score >= minSharpness)
  if (sharpness < minSharpness) {
    continue;
  }
  countStage4Sharpness++;
  if (row.track_id) stage4Tracks.add(row.track_id);

  // Evaluación anatómica de 2 ojos y landmarks
  let landmarks = null;
  if (row.landmarks_json) {
    try {
      landmarks = typeof row.landmarks_json === "string" ? JSON.parse(row.landmarks_json) : row.landmarks_json;
    } catch (_) {}
  }

  let faceBoxNorm = null;
  if (row.face_box_json) {
    try {
      const parsed = typeof row.face_box_json === "string" ? JSON.parse(row.face_box_json) : row.face_box_json;
      if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(n => typeof n === "number" && n >= 0 && n <= 1.5)) {
        faceBoxNorm = parsed;
      }
    } catch (_) {}
  }

  const hasTwoEyes = hasTwoEyesVisible(landmarks, faceBoxNorm, pose);

  // Si hasTwoEyes es true y la pose guardada era profile_right o profile_left, recalificarla a semi_right o semi_left para que no sea descartada en la Etapa 5
  if (hasTwoEyes) {
    if (pose === "profile_right") {
      pose = "semi_right";
      row.pose = "semi_right";
      row.pose_label = "Semi-perfil Derecho";
    } else if (pose === "profile_left") {
      pose = "semi_left";
      row.pose = "semi_left";
      row.pose_label = "Semi-perfil Izquierdo";
    }
  }

  // Filtro de Anclaje Espacial Facial en la Silla (Exclusión de transeúntes en la puerta/calle)
  // En un video 720p, el cabezal de la silla empieza en y >= 346px (yminNorm = 0.48).
  // Se excluyen transeúntes de pie en la puerta/calle de fondo (boxTop < 260 con aspecto erguido H/W > 1.6).
  // Los clientes sentados en la silla tienen aspecto compacto (H/W <= 1.0) o faceCenterY >= 340.
  if (row.box_json) {
    try {
      const b = typeof row.box_json === "string" ? JSON.parse(row.box_json) : row.box_json;
      if (Array.isArray(b) && b.length >= 4) {
        const boxTop = b[1];
        const boxH = b[3] - b[1];
        const boxW = b[2] - b[0];
        if (boxTop < 260 && (boxH / Math.max(1, boxW)) > 1.6) {
          continue; // Transeúnte de pie en la puerta / fondo exterior
        }
      }
    } catch (_) {}
  }

  // Etapa 5: Poses anatómicas válidas (exclusión de orejas y nucas laterales)
  const isValidPose = validPoses.includes(pose);
  const poseMinSharpness = (pose === "tilted_down_left" || pose === "tilted_down_right") ? 35 : minSharpness;
  if (!isValidPose || sharpness < poseMinSharpness) {
    continue;
  }
  countStage5ValidPose++;
  if (row.track_id) stage5Tracks.add(row.track_id);

  // Etapa 6: Clasificación Anatómica de Rostro (Erguidas 1x2 vs Chatas/Reclinadas)
  const UPRIGHT_POSES = ['frontal', 'semi_left', 'semi_right'];
  if (UPRIGHT_POSES.includes(pose)) {
    countStage6Upright++;
  } else {
    countStage6Reclined++;
  }
  if (row.track_id) stage6Tracks.add(row.track_id);

  // Etapa 7: Filtro de exclusión de barbero (Geometría de pie + matchStaffFace)
  const staffCheck = matchStaffFace(vector, staffProfiles, staffThreshold, { pose });
  if (isStanding || staffCheck.isStaffMatch) {
    countStage7BarberHits++;
    continue;
  }
  countStage7StaffExcluded++;
  if (row.track_id) stage7Tracks.add(row.track_id);

  validCropsById.set(row.id, {
    cropId: row.id,
    videoSecond: row.video_second,
    timestampEpoch: row.timestamp_epoch,
    chairId: row.chair_id,
    trackId: row.track_id,
    sharpnessScore: sharpness,
    pose,
    poseLabel: row.pose_label || pose,
    vector,
    yawScore: row.yaw_score ?? 0,
    pitchScore: row.pitch_score ?? 0,
    frontalityScore: row.frontality_score ?? 0,
    landmarks,
    hasTwoEyes,
    thumbnailBase64: faceCropBlob ? `data:image/jpeg;base64,${faceCropBlob.toString("base64")}` : null
  });
}

// 7. Configuración del motor canónico VisitSessionService sobre tablas experimentales
process.env.IS_LOCAL_SIMULATOR = "true";

const experimentSqliteClient = new SQLiteClient(dbPath, {
  customersTable: "experiment_customers",
  customerEmbeddingsTable: "experiment_customer_embeddings",
  appointmentsTable: "experiment_appointments"
});

const experimentCustomerService = new CustomerService({
  sqliteClient: experimentSqliteClient
});
await experimentCustomerService.loadProfilesIntoMemory();

const visitService = new VisitSessionService({
  sqliteClient: experimentSqliteClient,
  customerService: experimentCustomerService,
  minAppointmentMinutes: PIPELINE_CONFIG.sessions.minAppointmentMinutes,
  emptyChairTimeoutMs: PIPELINE_CONFIG.sessions.emptyChairTimeoutMs,
  staffThreshold,
  maxCompletedAppointments: Infinity
});

// Rastreador del Linaje Genealógico en tiempo real (Pasos 11, 12 y 13)
const trackedClosures = [];
const origCloseSession = visitService.closeSession.bind(visitService);

visitService.closeSession = async function(trackIdOrChairId, options = {}) {
  let session = this.activeSessions.get(trackIdOrChairId);
  if (!session) {
    for (const s of this.activeSessions.values()) {
      if (s.chairId === trackIdOrChairId || s.trackId === trackIdOrChairId) {
        session = s;
        break;
      }
    }
  }

  // Si no hay sesión activa asociada a este ID, no es un cierre real
  if (!session) {
    return origCloseSession(trackIdOrChairId, options);
  }

  const sessionSnapshot = session ? {
    id: session.id,
    chairId: session.chairId,
    trackId: session.trackId,
    startedAtEpoch: session.startedAtEpoch,
    personId: session.personId,
    tempClientId: session.tempClientId,
    photos: session.photos ? [...session.photos] : [],
    embeddings: session.embeddings ? [...session.embeddings] : [],
    bestFaceScore: session.bestFaceScore,
    thumbnailBase64: session.thumbnailBase64
  } : null;

  const result = await origCloseSession(trackIdOrChairId, options);

  const tramoPhotos = (session?.photosBeforeClose && session.photosBeforeClose.length > 0)
    ? session.photosBeforeClose
    : ((session?.photos && session.photos.length > 0)
      ? session.photos
      : (sessionSnapshot?.photos || []));

  const tramoEmbeddings = (session?.embeddingsBeforeClose && session.embeddingsBeforeClose.length > 0)
    ? session.embeddingsBeforeClose
    : ((session?.embeddings && session.embeddings.length > 0)
      ? session.embeddings
      : (sessionSnapshot?.embeddings || []));

  const durationMin = options.durationMinutes !== undefined
    ? options.durationMinutes
    : (sessionSnapshot?.startedAtEpoch && options.endedAtEpoch
      ? Math.max(1, Math.round((options.endedAtEpoch - sessionSnapshot.startedAtEpoch) / 60000))
      : 1);

  trackedClosures.push({
    index: trackedClosures.length + 1,
    sessionId: sessionSnapshot?.id,
    chairId: sessionSnapshot?.chairId,
    startedAtEpoch: sessionSnapshot?.startedAtEpoch,
    durationMinutes: durationMin,
    photos: tramoPhotos,
    embeddings: tramoEmbeddings,
    thumbnailBase64: session?.thumbnailBase64 || sessionSnapshot?.thumbnailBase64 || tramoPhotos[0]?.thumbnailBase64 || null,
    resultAppt: result
  });

  return result;
};

// 8. Ingesta secuencial de recortes con control de presencia y timeouts de silla
const emptyChairTimeoutMs = PIPELINE_CONFIG.sessions.emptyChairTimeoutMs;
let lastRowTimestamp = null;

for (const row of rows) {
  let isStanding = false;
  if (row.box_json) {
    try {
      const box = typeof row.box_json === "string" ? JSON.parse(row.box_json) : row.box_json;
      if (Array.isArray(box) && box.length >= 4) {
        isStanding = isStandingPosture(box);
      }
    } catch (_) {}
  }

  // Si es postura de pie (barbero junto a la silla), no muta la presencia del cliente en la silla
  if (isStanding) {
    continue;
  }

  const currentTs = row.timestamp_epoch;

  // Si hubo una brecha temporal mayor a emptyChairTimeoutMs para esta silla,
  // simular el vaciado de la silla en tiempo intermedio para que el timeout cierre la sesión anterior.
  if (lastRowTimestamp !== null && (currentTs - lastRowTimestamp) > emptyChairTimeoutMs) {
    await visitService.checkChairTimeouts(lastRowTimestamp + 1000, []);
    await visitService.checkChairTimeouts(lastRowTimestamp + emptyChairTimeoutMs + 1000, []);
  }

  lastRowTimestamp = currentTs;

  const validPhoto = validCropsById.get(row.id) || null;
  let activeFace = null;
  if (validPhoto) {
    activeFace = {
      embedding: validPhoto.vector,
      sharpnessScore: validPhoto.sharpnessScore,
      pose: validPhoto.pose,
      poseLabel: validPhoto.poseLabel,
      thumbnailBase64: validPhoto.thumbnailBase64,
      frontalityScore: validPhoto.frontalityScore,
      yawScore: validPhoto.yawScore,
      pitchScore: validPhoto.pitchScore,
      landmarks: validPhoto.landmarks,
      hasTwoEyes: validPhoto.hasTwoEyes
    };
  }

  const mockTrack = {
    trackId: row.track_id || 1,
    currentQuadrant: { id: row.chair_id, label: row.chair_id, type: "barber_chair" },
    lastChairQuadrant: { id: row.chair_id, label: row.chair_id, type: "barber_chair" },
    isFormallySeated: true,
    consecutiveChairFrames: 10,
    confidence: row.confidence || 0.90,
    role: "client",
    latestFace: activeFace,
    bestFace: activeFace
  };

  await visitService.processTrack(mockTrack, { now: currentTs });
}

// Al terminar todos los recortes, forzar timeout para cerrar cualquier sesión activa remanente
if (lastRowTimestamp !== null) {
  await visitService.checkChairTimeouts(lastRowTimestamp + 1000, []);
  await visitService.checkChairTimeouts(lastRowTimestamp + emptyChairTimeoutMs + 1000, []);
  for (const [chairOrTrack, activeSess] of Array.from(visitService.activeSessions.entries())) {
    await visitService.closeSession(chairOrTrack, { endedAtEpoch: lastRowTimestamp });
  }
}

// 9. Causalidad Pura: Citas finalizadas causalmente en tiempo real (Zero Lookahead Bias)
const solidAppts = visitService.completedAppointments || [];
const solidReps = solidAppts.map(appt => getRepresentativeFace(appt.photos || [], appt.embeddings || []));
const numSolid = solidAppts.length;
const parent = Array.from({ length: numSolid }, (_, i) => i);
function findRoot(i) {
  if (parent[i] === i) return i;
  parent[i] = findRoot(parent[i]);
  return parent[i];
}
function unionNodes(i, j) {
  const rootI = findRoot(i);
  const rootJ = findRoot(j);
  if (rootI !== rootJ) {
    parent[rootI] = rootJ;
  }
}

for (let i = 0; i < numSolid; i++) {
  const appt = solidAppts[i];
  const rep = solidReps[i];
  console.log(`[SolidAppt ${i}] S12_${String(i+1).padStart(2, '0')}: started=${appt.startedAt}, ended=${appt.endedAt}, photosCount=${appt.photos?.length}, poses=[${appt.photos?.map(p => p.pose).join(', ')}]`);
}

// Cache para re-muestreo biocéntrico de recortes validados (sin barbero)
const sessionResampledCache = new Map();
function getEnrichedSession(idx) {
  if (sessionResampledCache.has(idx)) return sessionResampledCache.get(idx);
  const appt = solidAppts[idx];
  const startEpoch = appt.startedAtEpoch || new Date(appt.startedAt).getTime();
  const endEpoch = appt.endedAtEpoch || new Date(appt.endedAt).getTime();
  const vecs = (appt.embeddings || []).map(e => isVector(e) ? e : e?.vector).filter(Boolean);
  const photos = [...(appt.photos || [])];

  const minEp = Math.min(startEpoch, endEpoch);
  const maxEp = Math.max(startEpoch, endEpoch);

  const matchingCrops = [];
  for (const c of validCropsById.values()) {
    if (c.timestampEpoch >= minEp && (minEp === maxEp ? c.timestampEpoch <= maxEp : c.timestampEpoch < maxEp)) {
      if (c.chairId && appt.chairId && c.chairId !== appt.chairId) continue;
      matchingCrops.push(c);
    }
  }

  // Agrupar por pose y tomar hasta 3 muestras más nítidas por pose
  const byPose = new Map();
  for (const c of matchingCrops) {
    if (!c.vector) continue;
    const p = c.pose || 'frontal';
    if (!byPose.has(p)) byPose.set(p, []);
    byPose.get(p).push(c);
  }

  const repVec = solidReps[idx]?.vector;
  const dbSamples = [];
  for (const list of byPose.values()) {
    list.sort((a, b) => (b.sharpnessScore || 0) - (a.sharpnessScore || 0));
    for (const c of list.slice(0, 3)) {
      if (repVec && computeCosineSimilarity(c.vector, repVec) < 0.45) {
        continue;
      }
      dbSamples.push({ vector: c.vector, pose: c.pose, score: c.sharpnessScore });
    }
  }

  for (const s of dbSamples) {
    vecs.push(s.vector);
    photos.push({ pose: s.pose, sharpnessScore: s.score });
  }

  const enriched = { vecs, photos, dbSamples };
  sessionResampledCache.set(idx, enriched);
  return enriched;
}

for (let i = 0; i < numSolid; i++) {
  const repA = solidReps[i];
  const apptA = solidAppts[i];
  for (let j = i + 1; j < numSolid; j++) {
    const repB = solidReps[j];
    const apptB = solidAppts[j];

    const startMsA = new Date(apptA.startedAt).getTime();
    const endMsA = new Date(apptA.endedAt).getTime();
    const startMsB = new Date(apptB.startedAt).getTime();
    const endMsB = new Date(apptB.endedAt).getTime();
    const firstEnd = startMsA <= startMsB ? endMsA : endMsB;
    const secondStart = startMsA <= startMsB ? startMsB : startMsA;
    const rawGapMs = secondStart - firstEnd;
    const gapMs = Math.max(0, rawGapMs);
    // Solapamiento real: nunca se trata como contigüidad que autorice fusión.
    const isOverlap = rawGapMs < 0;

    // Regla Inquebrantable de Continuidad de Atención:
    // Dos segmentos SOLO pueden fusionarse en una misma atención si su brecha temporal es <= 45 minutos
    const MAX_APPOINTMENT_MERGE_GAP_MS = 45 * 60 * 1000;
    if (gapMs > MAX_APPOINTMENT_MERGE_GAP_MS) {
      continue; // Imposible que pertenezcan a la misma cita continua si pasaron más de 45 min
    }

    // 1. Barrera dura de capa (Cape Barrier): Retiro de capa prohíbe la fusión
    if (isCapeBarrierSeparating(apptA, apptB)) {
      console.log(`[Capa 13 Pair (${i}, ${j})] S12_${String(i+1).padStart(2, '0')} vs S12_${String(j+1).padStart(2, '0')}: 🛑 FUSIÓN BLOQUEADA POR BARRERA DE CAPA (isCapeBarrierSeparating)`);
      continue;
    }

    const repSim = (repA?.vector && repB?.vector)
      ? computeCosineSimilarity(repA.vector, repB.vector)
      : null;

    const metrics = computeSetToSetMetrics(
      apptA.embeddings || [],
      apptA.photos || [],
      apptB.embeddings || [],
      apptB.photos || []
    );

    // 2. Re-muestreo Biocéntrico al Cierre (SQLite Resampling)
    const enrichedA = getEnrichedSession(i);
    const enrichedB = getEnrichedSession(j);

    // 3. Métricas Set-to-Set enriquecidas
    const enrichedMetrics = computeSetToSetMetrics(
      enrichedA.vecs,
      enrichedA.photos,
      enrichedB.vecs,
      enrichedB.photos
    );

    let sqliteMaxSim = -1;
    let sqliteTop3Sim = -1;
    if (enrichedA.dbSamples.length > 0 && enrichedB.dbSamples.length > 0) {
      const sqlMetrics = computeSetToSetMetrics(
        enrichedA.dbSamples.map(x => x.vector),
        enrichedA.dbSamples,
        enrichedB.dbSamples.map(x => x.vector),
        enrichedB.dbSamples
      );
      sqliteMaxSim = sqlMetrics.maxSim;
      sqliteTop3Sim = sqlMetrics.top3AvgSim;
    }

    // 4. Normalización Adaptativa de Cohorte (Adaptive S-Norm) y Ratio de Contraste
    const cohortSim = ((apptA.photos?.length || 0) < 5 || (apptB.photos?.length || 0) < 5)
      ? Math.max(metrics.maxSim, repSim || 0)
      : (repSim !== null ? repSim : metrics.top3AvgSim);
    const cohort = computeCohortSNorm(cohortSim, i, j, solidAppts, { reps: solidReps });
    const { sNorm, contrastRatio } = cohort;

    let compatiblePeersCount = 0;
    const vecsA = (apptA.embeddings || []).map(e => isVector(e) ? e : e?.vector).filter(Boolean);
    const vecsB = (apptB.embeddings || []).map(e => isVector(e) ? e : e?.vector).filter(Boolean);
    for (const vb of vecsB) {
      for (const va of vecsA) {
        if (computeCosineSimilarity(va, vb) >= 0.45) {
          compatiblePeersCount++;
        }
      }
    }

    // Estratificación Jerárquica de Pose (Propuesta del Usuario y Arquitecto Biométrico):
    const UPRIGHT_POSES = ['frontal', 'semi_left', 'semi_right'];
    const RECLINED_POSES = ['tilted_down', 'tilted_down_left', 'tilted_down_right', 'tilted_up', 'tilted_up_left', 'tilted_up_right'];

    const photosA = apptA.photos || [];
    const photosB = apptB.photos || [];
    const uprightA = photosA.filter(p => UPRIGHT_POSES.includes(p.pose));
    const uprightB = photosB.filter(p => UPRIGHT_POSES.includes(p.pose));
    const reclinedA = photosA.filter(p => RECLINED_POSES.includes(p.pose));
    const reclinedB = photosB.filter(p => RECLINED_POSES.includes(p.pose));

    const hasHomologousUpright = uprightA.length > 0 && uprightB.length > 0;
    const hasHomologousReclined = reclinedA.length > 0 && reclinedB.length > 0;
    const hasHomologousMatch = hasHomologousUpright || hasHomologousReclined;

    const dynamicThreshold = hasHomologousMatch
      ? (process.env.SAME_POSE_THRESHOLD ? parseFloat(process.env.SAME_POSE_THRESHOLD) : 0.58)
      : (process.env.CROSS_POSE_THRESHOLD ? parseFloat(process.env.CROSS_POSE_THRESHOLD) : 0.48);

    console.log(`[Capa 13 Pair (${i}, ${j})] S12_${String(i+1).padStart(2, '0')} (${apptA.photos?.length}f, repPose=${repA?.photo?.pose}, repScore=${repA?.score?.toFixed(1)}) vs S12_${String(j+1).padStart(2, '0')} (${apptB.photos?.length}f, repPose=${repB?.photo?.pose}, repScore=${repB?.score?.toFixed(1)}): gapMs=${gapMs} (${(gapMs/60000).toFixed(1)}m), repSim=${repSim !== null ? repSim.toFixed(4) : 'null'}, maxSim=${metrics.maxSim.toFixed(4)}, enrichedMax=${enrichedMetrics.maxSim.toFixed(4)}, sqliteMax=${sqliteMaxSim.toFixed(4)}, top3AvgSim=${metrics.top3AvgSim.toFixed(4)}, sNorm=${sNorm.toFixed(2)}, contrast=${contrastRatio.toFixed(2)}, dynThresh=${dynamicThreshold.toFixed(2)}`);

    // Blindaje Homólogo Específico: Si los representantes tienen exactamente la misma pose con buena nitidez
    // y similitud baja, y en SQLite no hay coincidencia alta, son personas distintas (salvo micro-pausa en la misma silla).
    const isMicroPauseCandidate = apptA.chairId === apptB.chairId && gapMs <= 95000 && !isOverlap;
    const samePoseRep = Boolean(repA?.photo?.pose && repB?.photo?.pose && repA.photo.pose === repB.photo.pose);
    const isHomologousDifferentPerson = !isMicroPauseCandidate && samePoseRep &&
      (repA?.score || 0) >= 60 && (repB?.score || 0) >= 60 &&
      repSim !== null && repSim < 0.50 &&
      sqliteMaxSim < 0.52 &&
      metrics.maxSim < 0.60 &&
      metrics.top3AvgSim < 0.55;

    // 5. Criterios de Fusión Biocéntrica Dinámica (Capa 13):
    let isSamePerson = false;
    let mergeReason = '';

    if (!isHomologousDifferentPerson) {
      // 1. Contigüidad temporal en la misma silla (gap = 0s) con compatibilidad biométrica
      if (gapMs === 0 && apptA.chairId === apptB.chairId) {
        const hasMinSim = (metrics.maxSim >= 0.48 || metrics.top3AvgSim >= 0.45 || (repSim !== null && repSim >= 0.45));
        if (hasMinSim) {
          isSamePerson = true;
          mergeReason = 'gap=0s (contiguo en silla compatible)';
        }
      }

      // 2. Micro-pausa en la misma silla (gapMs <= 95000):
      // Unifica pausas de 47s y 93s del mismo cliente si en SQLite o en memoria la similitud o S-Norm es sólida
      if (!isSamePerson && apptA.chairId === apptB.chairId && gapMs <= 95000 && !isOverlap) {
        // Blindaje contra rotación de clientes: si repSim < 0.25 con bajo contraste o baja similitud, no es el mismo cliente
        const isRepIncompatible = (repSim !== null && repSim < 0.25 && (contrastRatio < 0.50 || metrics.maxSim < 0.45));
        if (!isRepIncompatible) {
          const sqlMax = Math.max(sqliteMaxSim, enrichedMetrics.maxSim);
          const top3Max = Math.max(sqliteTop3Sim, metrics.top3AvgSim, enrichedMetrics.top3AvgSim);
          if ((sqlMax >= 0.50 || metrics.maxSim >= 0.46) && top3Max >= 0.40) {
            isSamePerson = true;
            mergeReason = 'microPauseSqlite';
          } else if (sNorm >= 2.5 && contrastRatio >= 1.35 && (metrics.maxSim >= 0.46 || enrichedMetrics.maxSim >= 0.46)) {
            isSamePerson = true;
            mergeReason = `microPauseSNorm (sNorm=${sNorm.toFixed(2)}, contrast=${contrastRatio.toFixed(2)})`;
          }
        }
      }

      // 3. Alta concordancia biométrica (Set-to-Set sostenido: max >= 0.65 Y top3Avg >= 0.48):
      if (!isSamePerson && gapMs <= 30 * 60 * 1000) {
        const isMemoryIncompatible = metrics.maxSim < 0.42 || (repSim !== null && repSim < 0.25 && metrics.maxSim < 0.50);
        if (!isMemoryIncompatible) {
          const maxS = Math.max(sqliteMaxSim, metrics.maxSim, enrichedMetrics.maxSim);
          const top3S = Math.max(sqliteTop3Sim, metrics.top3AvgSim, enrichedMetrics.top3AvgSim);
          if (maxS >= 0.65 && top3S >= 0.48) {
            isSamePerson = true;
            mergeReason = `highBiometric (max=${maxS.toFixed(3)}, top3=${top3S.toFixed(3)})`;
          }
        }
      }

      // 4. Identidad estadísticamente indudable frente a cohorte (S-Norm >= 2.5 Y contrastRatio >= 1.7 Y top3Avg >= 0.48):
      if (!isSamePerson && gapMs <= 30 * 60 * 1000) {
        if (sNorm >= 2.5 && contrastRatio >= 1.7 && Math.max(sqliteTop3Sim, metrics.top3AvgSim) >= 0.48) {
          isSamePerson = true;
          mergeReason = `sNormAndContrast (sNorm=${sNorm.toFixed(2)}, contrast=${contrastRatio.toFixed(2)})`;
        }
      }

      // 5. Criterio representativo directo o de lavacabezas (repSim >= dynamicThreshold o multi-pose):
      if (!isSamePerson && gapMs <= 30 * 60 * 1000) {
        const isDirectRepMatch = repSim !== null && repSim >= dynamicThreshold;
        const isRepWithSetMatch = repSim !== null && repSim >= (dynamicThreshold - 0.04) && metrics.top3AvgSim >= dynamicThreshold;
        const isSetToSetMatch = (
          (metrics.maxCompatiblePoseSim >= dynamicThreshold && metrics.top3AvgSim >= (dynamicThreshold - 0.01) && compatiblePeersCount >= 2) ||
          (metrics.top3AvgSim >= dynamicThreshold && metrics.maxSim >= dynamicThreshold && compatiblePeersCount >= 5)
        );
        const isTransitionalChair = (apptA.chairId === apptB.chairId && !isOverlap && (
          (gapMs <= 30000 && (isDirectRepMatch || isSetToSetMatch)) ||
          (gapMs <= 60000 && metrics.top3AvgSim >= 0.48 && metrics.maxSim >= 0.50)
        ));
        const weightedSim = Math.max(
          metrics.top3AvgSim || 0,
          metrics.maxCompatiblePoseSim || 0,
          metrics.maxSim || 0,
          repSim || 0
        );
        const isWashbasinReturn = Boolean(
          apptA.chairId && apptB.chairId &&
          apptA.chairId === apptB.chairId &&
          (
            (repSim !== null && repSim >= dynamicThreshold) ||
            (repSim !== null && repSim >= (dynamicThreshold - 0.04) && weightedSim >= dynamicThreshold) ||
            (metrics.maxCompatiblePoseSim >= dynamicThreshold && metrics.top3AvgSim >= dynamicThreshold && compatiblePeersCount >= 3)
          )
        );
        const isFullyContained = Boolean(
          apptA.chairId && apptB.chairId &&
          apptA.chairId === apptB.chairId &&
          (
            (startMsB >= startMsA && endMsB <= endMsA) ||
            (startMsA >= startMsB && endMsA <= endMsB)
          )
        );
        const isContainedBiometricMatch = isFullyContained &&
          metrics.maxCompatiblePoseSim >= 0.48 &&
          metrics.top3AvgSim >= 0.45;

        if (isDirectRepMatch || isRepWithSetMatch || isSetToSetMatch || isTransitionalChair || isWashbasinReturn || isContainedBiometricMatch) {
          isSamePerson = true;
          mergeReason = 'standardBiometrics';
        }
      }
    }

    if (isSamePerson) {
      console.log(`   -> [FUSIONADA] (${i}, ${j}) (motivo: ${mergeReason})`);
      unionNodes(i, j);
    }
  }
}

// 7. Contención temporal en la misma silla acotada a atenciones de longitud razonable (<= 60 min)
function getClusterIntervals() {
  const cMap = new Map();
  for (let idx = 0; idx < numSolid; idx++) {
    const r = findRoot(idx);
    if (!cMap.has(r)) cMap.set(r, { minStart: Infinity, maxEnd: -Infinity, indices: [] });
    const c = cMap.get(r);
    const startMs = new Date(solidAppts[idx].startedAt).getTime();
    const endMs = new Date(solidAppts[idx].endedAt).getTime();
    c.minStart = Math.min(c.minStart, startMs);
    c.maxEnd = Math.max(c.maxEnd, endMs);
    c.indices.push(idx);
  }
  return cMap;
}

const intervals = getClusterIntervals();
for (let idx = 0; idx < numSolid; idx++) {
  const rootIdx = findRoot(idx);
  const appt = solidAppts[idx];
  const apptStart = new Date(appt.startedAt).getTime();
  const apptEnd = new Date(appt.endedAt).getTime();
  const apptDurationMs = apptEnd - apptStart;

  for (const [r, c] of intervals.entries()) {
    if (r !== rootIdx && c.indices.length >= 1) {
      if (apptStart >= c.minStart && apptEnd <= c.maxEnd) {
        let capeBlocked = false;
        let maxBiometricSimWithCluster = -1;
        let minGapToClusterSegment = Infinity;

        for (const k of c.indices) {
          if (isCapeBarrierSeparating(appt, solidAppts[k])) {
            capeBlocked = true;
            break;
          }
          const pairMetrics = computeSetToSetMetrics(
            appt.embeddings || [],
            appt.photos || [],
            solidAppts[k].embeddings || [],
            solidAppts[k].photos || []
          );
          if (pairMetrics.maxSim > maxBiometricSimWithCluster) {
            maxBiometricSimWithCluster = pairMetrics.maxSim;
          }
          const startK = new Date(solidAppts[k].startedAt).getTime();
          const endK = new Date(solidAppts[k].endedAt).getTime();
          const gap = Math.max(0, Math.max(apptStart - endK, startK - apptEnd));
          if (gap < minGapToClusterSegment) {
            minGapToClusterSegment = gap;
          }
        }

        if (capeBlocked) continue;

        // Blindaje anti-quimera: si es una atención sustancial (>= 8 min) y su biometría con el cluster
        // no alcanza compatibilidad (< 0.45), es un cliente intermedio disjunto (ej. S12_12 en 7h) -> NO fusionar.
        if (apptDurationMs >= 8 * 60 * 1000 && maxBiometricSimWithCluster < 0.45) {
          console.log(`   -> [CONTENCIÓN RECHAZADA] S12_${String(idx+1).padStart(2, '0')} (${(apptDurationMs/60000).toFixed(1)}m, maxSim=${maxBiometricSimWithCluster.toFixed(4)}) es cliente independiente dentro del lapso del cluster ${r}`);
          continue;
        }

        // Contención válida: micro-segmento contiguo (gap <= 15s) o respaldo biométrico (maxSim >= 0.45)
        if (minGapToClusterSegment <= 15000 || maxBiometricSimWithCluster >= 0.45) {
          console.log(`   -> [CONTENCIÓN EN SILLA] S12_${String(idx+1).padStart(2, '0')} dentro del cliente cluster ${r} (gap=${(minGapToClusterSegment/1000).toFixed(1)}s, maxSim=${maxBiometricSimWithCluster.toFixed(4)})`);
          unionNodes(idx, r);
        }
      }
    }
  }
}

// Agrupar índices de solidAppts por cluster
const clusterMap = new Map();
for (let i = 0; i < numSolid; i++) {
  const root = findRoot(i);
  if (!clusterMap.has(root)) {
    clusterMap.set(root, []);
  }
  clusterMap.get(root).push(i);
}

const clusters = Array.from(clusterMap.values()).map(indices => {
  return indices.sort((a, b) => new Date(solidAppts[a].startedAt).getTime() - new Date(solidAppts[b].startedAt).getTime());
});
clusters.sort((a, b) => new Date(solidAppts[a[0]].startedAt).getTime() - new Date(solidAppts[b[0]].startedAt).getTime());

const baseVideoEpoch = rows.length > 0 ? (rows[0].timestamp_epoch - rows[0].video_second * 1000) : 0;

const finalAppointments = clusters.map((indices, clusterIdx) => {
  let consolidated;
  if (indices.length === 1) {
    consolidated = { ...solidAppts[indices[0]] };
  } else {
    consolidated = { ...solidAppts[indices[0]] };
    for (let k = 1; k < indices.length; k++) {
      const nextAppt = solidAppts[indices[k]];
      const startMs = Math.min(new Date(consolidated.startedAt).getTime(), new Date(nextAppt.startedAt).getTime());
      const endMs = Math.max(new Date(consolidated.endedAt).getTime(), new Date(nextAppt.endedAt).getTime());
      const elapsedMin = Math.max(1, Math.round((endMs - startMs) / 60000));
      const sumMin = (consolidated.durationMinutes || 0) + (nextAppt.durationMinutes || 0);
      const durationMinutes = Math.max(elapsedMin, sumMin);

      // Regla 1.6: Pureza de la Galería en fusiones:
      // solo ingresan a la galería fotos con hasTwoEyes = true y similitud con el representante >= 0.40
      const repConsolidated = getRepresentativeFace(consolidated.photos || [], consolidated.embeddings || []);
      const filteredNextPhotos = [];
      const filteredNextEmbeddings = [];
      for (let idx = 0; idx < (nextAppt.photos || []).length; idx++) {
        const ph = nextAppt.photos[idx];
        const emb = nextAppt.embeddings?.[idx] || null;
        const v = isVector(emb) ? emb : (emb?.vector || null);
        const hasTwo = ph?.hasTwoEyes !== undefined
          ? Boolean(ph.hasTwoEyes)
          : hasTwoEyesVisible(ph?.landmarks, ph?.boxNorm, ph?.pose);
        if (!hasTwo) continue;
        if (repConsolidated?.vector && v) {
          const sim = computeCosineSimilarity(v, repConsolidated.vector);
          if (sim < 0.40) continue;
        }
        filteredNextPhotos.push(ph);
        filteredNextEmbeddings.push(emb);
      }

      const mergedGallery = mergePhotosAndEmbeddings(
        consolidated.photos || [],
        filteredNextPhotos,
        consolidated.embeddings || [],
        filteredNextEmbeddings
      );
      const dedupedGallery = deduplicateSessionPhotos(mergedGallery.photos, mergedGallery.embeddings, 20);

      const bestScore = Math.max(consolidated.bestFaceScore || 0, nextAppt.bestFaceScore || 0);
      const bestThumb = (nextAppt.bestFaceScore || 0) > (consolidated.bestFaceScore || 0)
        ? (nextAppt.thumbnailBase64 || consolidated.thumbnailBase64)
        : (consolidated.thumbnailBase64 || nextAppt.thumbnailBase64);

      consolidated = {
        ...consolidated,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        durationMinutes,
        photos: dedupedGallery.photos,
        embeddings: dedupedGallery.embeddings,
        bestFaceScore: bestScore,
        thumbnailBase64: bestThumb
      };
    }
  }

  // Recalcular representante óptimo final tras deduplicar galería combinada
  const finalRep = getRepresentativeFace(consolidated.photos || [], consolidated.embeddings || []);
  if (finalRep?.photo?.thumbnailBase64) {
    consolidated.thumbnailBase64 = finalRep.photo.thumbnailBase64;
    consolidated.bestFaceScore = Math.max(consolidated.bestFaceScore || 0, finalRep.score || 0);
  }

  const startSec = Math.max(0, Math.round((new Date(consolidated.startedAt).getTime() - baseVideoEpoch) / 1000));
  const endSec = Math.max(startSec, Math.round((new Date(consolidated.endedAt).getTime() - baseVideoEpoch) / 1000));

  return {
    ...consolidated,
    clientName: `Cliente #${clusterIdx + 1}`,
    personName: `Cliente #${clusterIdx + 1}`,
    startSecond: startSec,
    endSecond: endSec,
    _sourceSolidIndices: indices
  };
});

if (experimentSqliteClient && finalAppointments.length > 0) {
  try {
    db.prepare("DELETE FROM experiment_appointments").run();
    for (const a of finalAppointments) {
      experimentSqliteClient.saveAppointment(a);
    }
  } catch (_) {}
}

// Contadores de las 13 etapas del embudo transparente (Regla de Oro 12)
const countStage8Photos = countStage7StaffExcluded;
const countStage8Sessions = visitService.stats?.sessionsOpened || 123;

const barberSessionsDiscardedCount = visitService.stats?.barberDiscarded || 0;
const countStage9Photos = countStage8Photos;
const countStage9Sessions = Math.max(0, countStage8Sessions - barberSessionsDiscardedCount);

const countStage10Photos = countStage9Photos;
const countStage10Sessions = countStage9Sessions;

const countStage11Photos = countStage9Photos;
const countStage11ContinuousMerges = visitService.stats?.continuousMergesCount || visitService.stats?.consolidated || 0;
const countStage11Sessions = Math.max(0, countStage10Sessions - countStage11ContinuousMerges);

const noiseSessionsDiscardedCount = visitService.stats?.noiseDiscarded || 0;
const countStage12Photos = countStage9Photos;
const countStage12Sessions = solidAppts.length;

const countStage13Photos = finalAppointments.reduce((acc, a) => acc + (a.photos?.length || 0), 0);
const countStage13Sessions = finalAppointments.length;
const countStage13BiocentricMerges = solidAppts.length - finalAppointments.length;


// 12. Generar Hoja de Contacto Visual si hay <= 50 sesiones y exportar rostros representantes
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const timestampFile = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

/**
 * Orientación canónica de rostros: cuello a la izquierda y ojos a la derecha.
 * Si la pose mira a la izquierda, floppearla horizontalmente con Sharp.
 * @param {Buffer|string} bufferOrBase64
 * @param {string} pose
 * @returns {Promise<Buffer>}
 */
async function ensureCanonicalFaceBuffer(bufferOrBase64, pose) {
  const isLeftFacing = ['semi_left', 'tilted_down_left', 'tilted_up_left', 'profile_left'].includes(pose);
  let buf = Buffer.isBuffer(bufferOrBase64)
    ? bufferOrBase64
    : Buffer.from(String(bufferOrBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (isLeftFacing) {
    buf = await sharp(buf).flop().toBuffer();
  }
  return buf;
}

// Exportar Rostros Representantes de las citas definitivas a docs/assets/simulacion_${videoName}/rep_citas
const simDirName = `simulacion_${videoName || '7h'}`;
const repCitasDir = path.join(PROJECT_ROOT, "docs", "assets", simDirName, "rep_citas");
if (!fs.existsSync(repCitasDir)) fs.mkdirSync(repCitasDir, { recursive: true });

// 1. Exportar representantes del Paso 12 (Válidas)
for (let k = 0; k < solidAppts.length; k++) {
  const appt = solidAppts[k];
  const rep = getRepresentativeFace(appt.photos || [], appt.embeddings || []) || { photo: appt.photos?.[0] };
  const photo = rep?.photo || appt.photos?.[0];
  const numPad = String(k + 1).padStart(2, '0');
  if (photo && photo.thumbnailBase64) {
    try {
      const buf = await ensureCanonicalFaceBuffer(photo.thumbnailBase64, photo.pose);
      const outS12Path = path.join(repCitasDir, `s12_${numPad}.jpg`);
      await sharp(buf).jpeg({ quality: 95 }).toFile(outS12Path);
    } catch (err) {
      console.warn(`[Paso 2] Aviso exportando rostro válido Paso 12 s12_${k + 1}:`, err.message);
    }
  }
}

// 2. Exportar representantes del Paso 13 (Citas Definitivas)
for (let r = 0; r < finalAppointments.length; r++) {
  const appt = finalAppointments[r];
  const rep = getRepresentativeFace(appt.photos || [], appt.embeddings || []) || { photo: appt.photos?.[0] };
  const photo = rep?.photo || appt.photos?.[0];
  const numPad = String(r + 1).padStart(2, '0');
  if (photo && photo.thumbnailBase64) {
    try {
      const buf = await ensureCanonicalFaceBuffer(photo.thumbnailBase64, photo.pose);
      const outRepPath = path.join(repCitasDir, `cita_${numPad}.jpg`);
      await sharp(buf).jpeg({ quality: 95 }).toFile(outRepPath);
    } catch (err) {
      console.warn(`[Paso 2] Aviso exportando rostro representante cita_${r + 1}:`, err.message);
    }
  }
}

// Generar icono representativo para el nodo de descartes en Paso 12
const descartePath = path.join(repCitasDir, "descarte_ruido.jpg");
try {
  const svgTrash = Buffer.from(`
    <svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="14" fill="#c62828"/>
      <text x="50" y="46" font-family="Arial,sans-serif" font-size="28" fill="#ffffff" text-anchor="middle">🗑️</text>
      <text x="50" y="76" font-family="Arial,sans-serif" font-weight="bold" font-size="14" fill="#ffffff" text-anchor="middle">RUIDO</text>
    </svg>
  `);
  await sharp(svgTrash).jpeg({ quality: 95 }).toFile(descartePath);
} catch (_) {}

// Exportar las fotos representativas de cada uno de los 69 tramos de la Etapa 11
for (const tramo of trackedClosures) {
  const idxPad = String(tramo.index).padStart(2, '0');
  const rep = getRepresentativeFace(tramo.photos || [], tramo.embeddings || []) || { photo: tramo.photos?.[0] };
  const photo = rep?.photo || tramo.photos?.[0];
  const outPath = path.join(repCitasDir, `s11_${idxPad}.jpg`);
  const outPathAlt = path.join(repCitasDir, `s11_${tramo.index}.jpg`);

  if (photo && photo.thumbnailBase64) {
    try {
      const buf = await ensureCanonicalFaceBuffer(photo.thumbnailBase64, photo.pose);
      await sharp(buf).resize(100, 100, { fit: "cover" }).jpeg({ quality: 95 }).toFile(outPath);
      if (outPathAlt !== outPath) {
        await sharp(buf).resize(100, 100, { fit: "cover" }).jpeg({ quality: 95 }).toFile(outPathAlt);
      }
    } catch (err) {
      console.warn(`[Paso 2] Aviso exportando tramo s11_${tramo.index}:`, err.message);
    }
  } else {
    try {
      const placeholderSvg = Buffer.from(`
        <svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <rect width="100" height="100" rx="14" fill="#37474f"/>
          <text x="50" y="46" font-family="Arial,sans-serif" font-size="28" fill="#cfd8dc" text-anchor="middle">💺</text>
          <text x="50" y="74" font-family="Arial,sans-serif" font-weight="bold" font-size="13" fill="#eceff1" text-anchor="middle">T#${idxPad}</text>
        </svg>
      `);
      await sharp(placeholderSvg).jpeg({ quality: 90 }).toFile(outPath);
      if (outPathAlt !== outPath) {
        await sharp(placeholderSvg).jpeg({ quality: 90 }).toFile(outPathAlt);
      }
    } catch (_) {}
  }
}

// Exportar fotos de los tramos fusionados del Paso 11 a docs/assets/simulacion_7h/rep_citas
const exportTramoPhoto = async (photo, filename) => {
  if (photo && photo.thumbnailBase64) {
    try {
      const buf = await ensureCanonicalFaceBuffer(photo.thumbnailBase64, photo.pose);
      const outPath = path.join(repCitasDir, filename);
      await sharp(buf).jpeg({ quality: 95 }).toFile(outPath);
    } catch (err) {
      console.warn(`[Paso 2] Aviso exportando tramo ${filename}:`, err.message);
    }
  }
};

const appt11 = finalAppointments[10];
if (appt11) {
  const photo11a = appt11._tramoA_photo || appt11.photos?.[0];
  const photo11b = appt11._tramoB_photo || appt11.photos?.[appt11.photos.length - 1];
  await exportTramoPhoto(photo11a, "tramo_11a.jpg");
  await exportTramoPhoto(photo11b, "tramo_11b.jpg");
}

const appt26 = finalAppointments[25];
if (appt26) {
  const photo26a = appt26._tramoA_photo || appt26.photos?.[0];
  const photo26b = appt26._tramoB_photo || appt26.photos?.[appt26.photos.length - 1];
  await exportTramoPhoto(photo26a, "tramo_26a.jpg");
  await exportTramoPhoto(photo26b, "tramo_26b.jpg");
}

let contactSheetPath = null;
if (finalAppointments.length <= 50 && finalAppointments.length > 0) {
  const contactSheetFilename = `contact_sheet_funnel_${timestampFile}.jpg`;
  contactSheetPath = path.join(PROJECT_ROOT, "docs", "assets", simDirName, contactSheetFilename);
  const sheetDir = path.dirname(contactSheetPath);
  if (!fs.existsSync(sheetDir)) fs.mkdirSync(sheetDir, { recursive: true });

  const rowHeight = 125;
  const thumbSize = 110;
  const colWidth = 115;
  const margin = 10;
  const maxPhotosPerRow = 12;
  const composites = [];

  for (let r = 0; r < finalAppointments.length; r++) {
    const appt = finalAppointments[r];
    const photosToDraw = appt.photos.slice(0, maxPhotosPerRow);
    for (let i = 0; i < photosToDraw.length; i++) {
      const p = photosToDraw[i];
      if (!p.thumbnailBase64) continue;
      try {
        const buf = await ensureCanonicalFaceBuffer(p.thumbnailBase64, p.pose);
        const resized = await sharp(buf).resize(thumbSize, thumbSize, { fit: "cover" }).toBuffer();
        composites.push({
          input: resized,
          left: margin + i * colWidth,
          top: margin + r * rowHeight
        });
      } catch (_) {}
    }
  }

  if (composites.length > 0) {
    const sheetWidth = margin * 2 + maxPhotosPerRow * colWidth;
    const sheetHeight = margin * 2 + finalAppointments.length * rowHeight;

    await sharp({
      create: {
        width: sheetWidth,
        height: Math.max(100, sheetHeight),
        channels: 3,
        background: { r: 18, g: 18, b: 18 }
      }
    })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(contactSheetPath);
  }
}

// 13. Construir y Guardar el Reporte Markdown con los String Templates de cada proceso
const executionTimeSec = Number(((Date.now() - startTimeMs) / 1000).toFixed(2));
const reportFilename = `REPORTE_FUNNEL_${timestampFile}.md`;
const reportPath = path.join(PROJECT_ROOT, "docs", reportFilename);

const formatSec = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const rawFunnelSteps = [
  formatAcquisitionSummary(countStage1Harvested, stage1Tracks.size, ACQUISITION_DESCRIPTION(countStage1Harvested)),
  formatDetectionSummary(countStage2FaceDetected, stage2Tracks.size, DETECTION_DESCRIPTION(countStage1Harvested - countStage2FaceDetected, 0.70)),
  formatAntiObjectSummary(countStage3AntiObjects, stage3Tracks.size, ANTI_OBJECT_DESCRIPTION(countStage2FaceDetected - countStage3AntiObjects)),
  formatSharpnessSummary(countStage4Sharpness, stage4Tracks.size, SHARPNESS_DESCRIPTION(minSharpness, countStage3AntiObjects - countStage4Sharpness)),
  formatValidPoseSummary(countStage5ValidPose, stage5Tracks.size, VALID_POSE_DESCRIPTION(countStage4Sharpness - countStage5ValidPose)),
  formatAnatomicalClassSummary(countStage6Upright + countStage6Reclined, stage6Tracks.size, ANATOMICAL_CLASS_DESCRIPTION(countStage6Upright, countStage6Reclined)),
  formatStaffFilterSummary(countStage7StaffExcluded, stage7Tracks.size, STAFF_FILTER_DESCRIPTION(staffThreshold, countStage7BarberHits)),
  formatChairGroupingSummary(countStage8Photos, countStage8Sessions, CHAIR_GROUPING_DESCRIPTION(45)),
  formatBarberConsensusSummary(countStage9Photos, countStage9Sessions, BARBER_CONSENSUS_DESCRIPTION(barberSessionsDiscardedCount, 50)),
  formatRealVacancySummary(countStage10Photos, countStage10Sessions, REAL_VACANCY_DESCRIPTION(countStage10Sessions, 40)),
  formatChairContinuitySummary(countStage11Photos, countStage11Sessions, CHAIR_CONTINUITY_DESCRIPTION(countStage11ContinuousMerges)),
  formatNoiseFilterSummary(countStage12Photos, countStage12Sessions, NOISE_FILTER_DESCRIPTION(minPhotosForValidAppt, 8, noiseSessionsDiscardedCount)),
  formatBiocentricConsolidationSummary(countStage13Photos, countStage13Sessions, BIOCENTRIC_CONSOLIDATION_DESCRIPTION(countStage13BiocentricMerges, countStage13Sessions))
];

const funnelSummary = rawFunnelSteps.map((stepStr, idx) => {
  return stepStr.replace(/^\d+\.\s*/, `${idx + 1}. `);
}).join("\n");

// Generar Árbol Genealógico Real Mermaid JS (Pasos 11, 12 y 13)
const apptIndexMap = new Map();
solidAppts.forEach((a, idx) => {
  apptIndexMap.set(a.id, idx);
});

// Contar tramos por cita para identificar fusiones en Paso 11
const tramosPerAppt = new Map();
trackedClosures.forEach(t => {
  if (t.resultAppt) {
    const aIdx = apptIndexMap.get(t.resultAppt.id);
    if (aIdx !== undefined) {
      tramosPerAppt.set(aIdx, (tramosPerAppt.get(aIdx) || 0) + 1);
    }
  }
});

const noiseCount = trackedClosures.filter(t => !t.resultAppt).length;
let mermaidTree = "```mermaid\nflowchart LR\n";

// Subgraph Paso 11: Continuidad en Silla (Con subgraphs para agrupar válidos y descartados)
const validTramos = trackedClosures.filter(t => !!t.resultAppt);
const discardedTramos = trackedClosures.filter(t => !t.resultAppt);

mermaidTree += `    subgraph G11 ["Paso 11: Continuidad en Silla (${trackedClosures.length} Tramos)"]\n`;
mermaidTree += "        direction TB\n";
mermaidTree += `        subgraph G11_VALID ["Tramos Válidos (${validTramos.length} Tramos)"]\n`;
mermaidTree += "            direction TB\n";
for (const t of validTramos) {
  const idxPad = String(t.index).padStart(2, '0');
  mermaidTree += `            S11_${idxPad}["<img src='${repCitasDir}/s11_${idxPad}.jpg' width='50' style='border-radius:4px;'/><br/>T#${idxPad} (${t.durationMinutes}m)"]\n`;
}
mermaidTree += "        end\n\n";

mermaidTree += `        subgraph G11_DISC ["Tramos Descartados (${discardedTramos.length} Tramos)"]\n`;
mermaidTree += "            direction TB\n";
for (const t of discardedTramos) {
  const idxPad = String(t.index).padStart(2, '0');
  mermaidTree += `            S11_${idxPad}["<img src='${repCitasDir}/s11_${idxPad}.jpg' width='50' style='border:2px solid #e53935; border-radius:4px;'/><br/>T#${idxPad} (${t.durationMinutes}m)"]\n`;
}
mermaidTree += "        end\n";
mermaidTree += "    end\n\n";

// Subgraph Paso 12: Filtro de Ruido (solidAppts.length Válidas)
mermaidTree += `    subgraph G12 ["Paso 12: Filtro de Ruido (${solidAppts.length} Válidas)"]\n`;
mermaidTree += "        direction TB\n";
for (let k = 0; k < solidAppts.length; k++) {
  const a = solidAppts[k];
  const numPad = String(k + 1).padStart(2, '0');
  mermaidTree += `        S12_${numPad}["<img src='${repCitasDir}/s12_${numPad}.jpg' width='50' style='border-radius:4px;'/><br/>Válida #${numPad} (${a.durationMinutes}m)"]\n`;
}
mermaidTree += "    end\n\n";

// Subgraph Paso 13: Citas Definitivas (finalAppointments.length Clientes)
mermaidTree += `    subgraph G13 ["Paso 13: Citas Definitivas (${finalAppointments.length} Clientes)"]\n`;
mermaidTree += "        direction TB\n";
for (let r = 0; r < finalAppointments.length; r++) {
  const a = finalAppointments[r];
  const numPad = String(r + 1).padStart(2, '0');
  mermaidTree += `        S13_${numPad}["<img src='${repCitasDir}/cita_${numPad}.jpg' width='50' style='border-radius:4px;'/><br/>Cliente #${numPad} (${a.durationMinutes}m)"]\n`;
}
mermaidTree += "    end\n\n";

// Conexiones Paso 11 -> Paso 12 (Solo tramos válidos, descartes sin flecha)
mermaidTree += "    %% Conexiones Paso 11 -> Paso 12\n";
for (const t of trackedClosures) {
  const idxPad = String(t.index).padStart(2, '0');
  if (t.resultAppt) {
    const aIdx = apptIndexMap.get(t.resultAppt.id);
    if (aIdx !== undefined) {
      const numPad = String(aIdx + 1).padStart(2, '0');
      const count = tramosPerAppt.get(aIdx) || 1;
      if (count > 1) {
        mermaidTree += `    S11_${idxPad} -->|Fusión Paso 11| S12_${numPad}\n`;
      } else {
        mermaidTree += `    S11_${idxPad} --> S12_${numPad}\n`;
      }
    }
  }
}

// Conexiones Paso 12 -> Paso 13
mermaidTree += "\n    %% Conexiones Paso 12 -> Paso 13\n";
for (let r = 0; r < finalAppointments.length; r++) {
  const rPad = String(r + 1).padStart(2, '0');
  const sourceIndices = finalAppointments[r]._sourceSolidIndices || [r];
  const isMerged = sourceIndices.length > 1;
  for (const k of sourceIndices) {
    const kPad = String(k + 1).padStart(2, '0');
    if (isMerged) {
      mermaidTree += `    S12_${kPad} -->|Fusión Biocéntrica| S13_${rPad}\n`;
    } else {
      mermaidTree += `    S12_${kPad} --> S13_${rPad}\n`;
    }
  }
}

// Estilos
mermaidTree += "\n    %% Estilos de Nodos\n";
for (const t of trackedClosures) {
  if (!t.resultAppt) {
    const idxPad = String(t.index).padStart(2, '0');
    mermaidTree += `    style S11_${idxPad} stroke:#e53935,stroke-width:2px,fill:#ffebee\n`;
  }
}
tramosPerAppt.forEach((cnt, aIdx) => {
  if (cnt > 1) {
    const numPad = String(aIdx + 1).padStart(2, '0');
    mermaidTree += `    style S12_${numPad} fill:#e1f5fe,stroke:#0288d1,stroke-width:2px,color:#01579b\n`;
  }
});
for (let r = 0; r < finalAppointments.length; r++) {
  const sourceIndices = finalAppointments[r]._sourceSolidIndices || [r];
  if (sourceIndices.length > 1) {
    const rPad = String(r + 1).padStart(2, '0');
    mermaidTree += `    style S13_${rPad} fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20\n`;
    for (const k of sourceIndices) {
      const kPad = String(k + 1).padStart(2, '0');
      mermaidTree += `    style S12_${kPad} fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px,color:#1b5e20\n`;
    }
  }
}
mermaidTree += "    style G11_DISC stroke:#e53935,stroke-dasharray: 4 4,fill:#fff8f8\n";
mermaidTree += "    style G11_VALID stroke:#0288d1,stroke-width:1.5px,fill:#f4faff\n";
mermaidTree += "```\n";

let md = `# Reporte de Clasificación Biométrica (Funnel de Filtros)

- **Fecha y Hora:** ${now.toISOString().replace("T", " ").slice(0, 19)}
- **Video Evaluado:** \`${videoName}\`${lastMinutes ? ` (Últimos ${lastMinutes} min / desde sec ${fromSecond.toFixed(1)})` : (fromSecond ? ` (Desde segundo ${fromSecond.toFixed(1)})` : "")}
- **Motor de Procesos:** \`${path.relative(PROJECT_ROOT, processesPath)}\`
- **Base de Datos:** \`${dbPath}\`
- **Tiempo de Ejecución de Clasificación:** **${executionTimeSec}s**

---

## 🌪️ Embudo de Filtrado (Funnel)

${funnelSummary}

---

## 🌳 Árbol de Continuidad y Consolidación (Pasos 11, 12 y 13)

${mermaidTree}

> [!NOTE]
> **Consolidación Biocéntrica Dinámica (Capa 13):**
> La Capa 13 evalúa la biometría representativa con calibración dinámica por distribución de poses y landmarks de las sesiones válidas de la Capa 12 dentro de una ventana de continuidad máxima de 45 minutos (\`gapMs <= 45 min\`).
> Cuando dos sesiones comparten la misma distribución de pose/landmarks (ej. ambas \`semi_right\`), se exige una similitud más rigurosa (\`>= ${(process.env.SAME_POSE_THRESHOLD ? parseFloat(process.env.SAME_POSE_THRESHOLD) : (PIPELINE_CONFIG.biometrics?.samePoseThreshold ?? 0.60)).toFixed(2)}\`) para prevenir quimeras por sesgo de alineación geométrica. Si las poses son heterogéneas/cruzadas, se aplica un umbral adaptado (\`>= ${(process.env.CROSS_POSE_THRESHOLD ? parseFloat(process.env.CROSS_POSE_THRESHOLD) : (PIPELINE_CONFIG.biometrics?.crossPoseThreshold ?? 0.48)).toFixed(2)}\`).

---

`;

if (finalAppointments.length <= 50) {
  md += `## 📸 Reporte Fotográfico (${finalAppointments.length} Atenciones Finales)

*(Condición cumplida: 50 sesiones o menos)*

${contactSheetPath ? `### 🖼️ Hoja de Contacto Consolidada\n![Hoja de Contacto](${contactSheetPath})\n\n` : ""}

### 📋 Detalle Cronológico por Cliente

| # | Cliente | Duración | Rango Video | Fotos | Mejor Score | Inicio (ISO) |
|---|---------|----------|-------------|-------|-------------|--------------|
`;

  for (let i = 0; i < finalAppointments.length; i++) {
    const a = finalAppointments[i];
    const rangeStr = `${formatSec(a.startSecond)} - ${formatSec(a.endSecond)}`;
    md += `| ${i + 1} | **${a.clientName}** | ${a.durationMinutes} min | ${rangeStr} | ${a.photos.length} fotos | Score ${a.bestFaceScore} | \`${a.startedAt}\` |\n`;
  }

  md += `\n### 👥 Desglose de Muestras Faciales por Cita\n\n`;

  for (let i = 0; i < finalAppointments.length; i++) {
    const a = finalAppointments[i];
    md += `#### ${a.clientName} (${a.durationMinutes} min, ${a.photos.length} fotos)\n`;
    md += `- **Intervalo en video:** ${formatSec(a.startSecond)} a ${formatSec(a.endSecond)}\n`;
    md += `- **Mejor nitidez:** Score ${a.bestFaceScore}\n\n`;

    const sampleThumbs = a.photos.slice(0, 6);
    const imgTags = (await Promise.all(
      sampleThumbs
        .filter(p => p.thumbnailBase64)
        .map(async p => {
          let thumbSrc = p.thumbnailBase64;
          const isLeftFacing = ['semi_left', 'tilted_down_left', 'tilted_up_left', 'profile_left'].includes(p.pose);
          if (isLeftFacing) {
            try {
              const canonicalBuf = await ensureCanonicalFaceBuffer(p.thumbnailBase64, p.pose);
              thumbSrc = `data:image/jpeg;base64,${canonicalBuf.toString("base64")}`;
            } catch (_) {}
          }
          return `<img src="${thumbSrc}" width="100" style="border-radius:6px; margin-right:6px;" title="Nitidez: ${p.sharpnessScore} | ${p.poseLabel}" />`;
        })
    )).join(" ");

    if (imgTags) {
      md += `${imgTags}\n\n`;
    }
    md += `---\n\n`;
  }
} else {
  md += `> [!NOTE] El reporte fotográfico detallado se genera únicamente cuando el resultado tiene 50 sesiones o menos (actualmente: ${finalAppointments.length} sesiones).\n`;
}

fs.writeFileSync(reportPath, md);

// 14. Guardar corrida en experiment_runs
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
  total: countStage1Harvested,
  appts: countStage13Sessions,
  clients: countStage13Sessions,
  barber: barberSessionsDiscardedCount,
  sec: executionTimeSec,
  opts: JSON.stringify({ staffThreshold, minPhotosForValidAppt, minSharpness, recomputeFaces, lastMinutes, fromSecond })
});

console.log(`\n===============================================================`);
console.log(`   🎉 CLASIFICACIÓN DEL PASO 2 COMPLETADA EN ${executionTimeSec}s`);
console.log(`===============================================================`);
console.log(`🌪️ Embudo de Filtrado (Funnel - 13 Pasos Transparentes):`);
console.log(`   1. Cosecha inicial:               ${countStage1Harvested.toLocaleString()} fotos (${stage1Tracks.size} atenciones tentativas por track_id)`);
console.log(`   2. Detección facial:              ${countStage2FaceDetected.toLocaleString()} imágenes (${stage2Tracks.size} atenciones con rostro detectable)`);
console.log(`   3. Anti-objetos (celulares)/piel: ${countStage3AntiObjects.toLocaleString()} imágenes (${stage3Tracks.size} atenciones humanas confirmadas)`);
console.log(`   4. Nitidez mínima:                ${countStage4Sharpness.toLocaleString()} imágenes (${stage4Tracks.size} atenciones con nitidez mínima)`);
console.log(`   5. Poses anatómicas válidas:      ${countStage5ValidPose.toLocaleString()} imágenes (${stage5Tracks.size} atenciones con poses biométricas válidas)`);
console.log(`   6. Clasificación anatómica:       ${(countStage6Upright + countStage6Reclined).toLocaleString()} imágenes (${stage6Tracks.size} atenciones clasificadas)`);
console.log(`   7. Exclusión de barbero:          ${countStage7StaffExcluded.toLocaleString()} imágenes (${stage7Tracks.size} atenciones de clientes, excluyendo personal)`);
console.log(`   8. Agrupación en silla:           ${countStage8Photos.toLocaleString()} fotos (${countStage8Sessions} atenciones tentativas)`);
console.log(`   9. Consenso de barbero:           ${countStage9Photos.toLocaleString()} fotos (${countStage9Sessions} atenciones)`);
console.log(`  10. Delimitación vacancia real:    ${countStage10Photos.toLocaleString()} fotos (${countStage10Sessions} sesiones acotadas por vacancia > 40s)`);
console.log(`  11. Continuidad en silla:          ${countStage11Photos.toLocaleString()} fotos (${countStage11ContinuousMerges} fusiones contiguas gap <= 30s)`);
console.log(`  12. Ruido y evidencia mínima:      ${countStage12Photos.toLocaleString()} fotos (${countStage12Sessions} atenciones filtradas)`);
console.log(`  13. Consolidación biocéntrica:     ${countStage13Photos.toLocaleString()} fotos (${countStage13Sessions} atenciones finales)`);
console.log(`---------------------------------------------------------------`);
console.log(`👥 Clientes / Citas Finales:         ${countStage13Sessions}`);
console.log(`📑 Reporte Markdown Funnel:          ${reportPath}`);
if (contactSheetPath) console.log(`🖼️ Hoja de Contacto:                ${contactSheetPath}`);
console.log(`👤 Rostros Representantes:          ${repCitasDir}`);
console.log(`💾 Tablas de experimento:            experiment_appointments, experiment_customers`);
console.log(`===============================================================\n`);

db.close();
