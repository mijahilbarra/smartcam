/**
 * scripts/step1_harvest_crops.js
 * 
 * PASO 1: Extracción y Cosecha de Recortes de Clientes desde Video
 * 
 * Reproduce el archivo de video (7h, 10h o cualquier clip) a alta velocidad,
 * ejecuta detección de personas (YOLOv8) y seguimiento espacial (PersonTracker),
 * y cosecha todos los recortes de personas en la silla de barbero junto con su
 * calidad facial, pose y embedding biométrico hacia una base de datos SQLite dedicada.
 * 
 * Uso:
 *   node scripts/step1_harvest_crops.js [ruta_al_video] [opciones]
 * 
 * Opciones:
 *   --db <path>           Ruta a la base de datos SQLite (defecto: data/experiments.db)
 *   --fps <number>        Tasa de muestreo de fotogramas (defecto: 3.5)
 *   --start-ss <number>   Segundo de inicio para cosechar tramo específico
 *   --duration-ss <num>   Duración en segundos a procesar
 *   --save-images         Guarda recortes JPEG individuales en disco (data/harvested_crops/)
 *   --aligned             Embedding facial ALINEADO: SCRFD (5 puntos) + alineación ArcFace + ResNet50
 *                         (src/services/face_alignment.js). Guarda además los puntos faciales
 *                         (landmarks_json) para poder estimar la pose con geometría real en el Paso 2.
 *                         Recomendado con --db distinto para no sobrescribir una cosecha existente.
 */

process.env.ONNX_THREADS = process.env.ONNX_THREADS || "4";
process.env.SILENT_DETECTOR = "true";
// Detección SCRFD a 320px: ~4x más rápida que 640 con la misma tasa de detección en recortes de persona
process.env.SCRFD_DET_SIZE = process.env.SCRFD_DET_SIZE || "320";

import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import Database from "better-sqlite3";
import sharp from "sharp";
import { detectScene } from "../src/services/pipeline/detection_step.js";
import { PersonTracker } from "../src/core/person_tracker.js";
import { evaluateFaceQuality } from "../src/services/face_quality_service.js";
import { extractFaceEmbedding } from "../src/face_recognizer.js";
import { vectorToBlob } from "../src/infrastructure/storage/sqlite_client.js";
import { prefetchQuadrants } from "../src/infrastructure/firebase/firestore_listeners.js";
import { calculateIoU } from "../src/core/geometry.js";
import { PIPELINE_CONFIG } from "../src/core/pipeline_config.js";

const PROJECT_ROOT = path.resolve(process.cwd());

// 1. Procesar argumentos CLI
const args = process.argv.slice(2);
let videoPath = "data/recordings/barberia_stream_7h.mp4";
let dbPath = path.join(PROJECT_ROOT, "data", "experiments.db");
let fps = 3.5;
let startSs = 0;
let durationSs = 0;
let saveImagesToDisk = true;
let useAlignedEmbeddings = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--db" && args[i + 1]) {
    dbPath = path.resolve(args[++i]);
  } else if (arg === "--fps" && args[i + 1]) {
    fps = parseFloat(args[++i]);
  } else if (arg === "--start-ss" && args[i + 1]) {
    startSs = parseFloat(args[++i]);
  } else if (arg === "--duration-ss" && args[i + 1]) {
    durationSs = parseFloat(args[++i]);
  } else if (arg === "--aligned") {
    useAlignedEmbeddings = true;
  } else if (arg === "--no-save-images") {
    saveImagesToDisk = false;
  } else if (!arg.startsWith("--") && !videoPath.includes(arg)) {
    videoPath = arg;
  }
}

videoPath = path.isAbsolute(videoPath) ? videoPath : path.resolve(PROJECT_ROOT, videoPath);

if (!fs.existsSync(videoPath)) {
  console.error(`[Paso 1] ❌ Video no encontrado en: ${videoPath}`);
  process.exit(1);
}

let extractAlignedEmbedding = null;
if (useAlignedEmbeddings) {
  try {
    const mod = await import("../src/services/face_alignment.js");
    extractAlignedEmbedding = mod.extractAlignedEmbedding;
  } catch (err) {
    console.error(`[Paso 1] ❌ Error importando src/services/face_alignment.js:`, err.message);
    process.exit(1);
  }
}

// 2. Inicializar SQLite para experimentos
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS harvested_crops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_file TEXT NOT NULL,
    frame_index INTEGER NOT NULL,
    video_second REAL NOT NULL,
    timestamp_epoch INTEGER NOT NULL,
    chair_id TEXT NOT NULL,
    track_id INTEGER,
    box_json TEXT,
    confidence REAL,
    crop_path TEXT,
    crop_blob BLOB,
    face_detected INTEGER DEFAULT 0,
    face_box_json TEXT,
    face_crop_blob BLOB,
    sharpness_score REAL DEFAULT 0,
    pose TEXT,
    pose_label TEXT,
    skin_ratio REAL DEFAULT 0,
    warm_ratio REAL DEFAULT 0,
    embedding_blob BLOB,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_harvest_video ON harvested_crops(video_file, video_second);
  CREATE INDEX IF NOT EXISTS idx_harvest_chair ON harvested_crops(chair_id, video_second);
  CREATE INDEX IF NOT EXISTS idx_harvest_track ON harvested_crops(track_id);
`);

// Columnas del embedding alineado (idempotente para bases ya existentes)
{
  const existingCols = db.prepare("PRAGMA table_info(harvested_crops)").all().map((c) => c.name);
  if (!existingCols.includes("landmarks_json")) db.exec("ALTER TABLE harvested_crops ADD COLUMN landmarks_json TEXT");
  if (!existingCols.includes("aligned_det_score")) db.exec("ALTER TABLE harvested_crops ADD COLUMN aligned_det_score REAL");
}

const stmtInsertHarvest = db.prepare(`
  INSERT INTO harvested_crops (
    video_file, frame_index, video_second, timestamp_epoch, chair_id, track_id,
    box_json, confidence, crop_path, crop_blob, face_detected, face_box_json,
    face_crop_blob, sharpness_score, pose, pose_label, skin_ratio, warm_ratio,
    embedding_blob, landmarks_json, aligned_det_score
  ) VALUES (
    @videoFile, @frameIndex, @videoSecond, @timestampEpoch, @chairId, @trackId,
    @boxJson, @confidence, @cropPath, @cropBlob, @faceDetected, @faceBoxJson,
    @faceCropBlob, @sharpnessScore, @pose, @poseLabel, @skinRatio, @warmRatio,
    @embeddingBlob, @landmarksJson, @alignedDetScore
  )
`);

// 3. Preparar directorios de recortes si se activa almacenamiento en disco
const videoBasename = path.basename(videoPath, path.extname(videoPath));
const harvestImgDir = path.join(PROJECT_ROOT, "data", "harvested_crops", videoBasename);
if (saveImagesToDisk && !fs.existsSync(harvestImgDir)) {
  fs.mkdirSync(harvestImgDir, { recursive: true });
}

// 4. Calcular métricas del video con ffprobe
function getVideoDuration(filePath) {
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, { encoding: "utf8", timeout: 5000 });
    const d = parseFloat(out.trim());
    return Number.isFinite(d) ? d : 20076;
  } catch (_) {
    return 20076;
  }
}

const totalDurationSec = durationSs > 0 ? durationSs : getVideoDuration(videoPath);
const totalEstimatedFrames = Math.round(totalDurationSec * fps);

console.log(`\n===============================================================`);
console.log(`   🌾 PASO 1: COSECHA DE RECORTES Y BIOMETRÍA DE VIDEO`);
console.log(`===============================================================`);
console.log(`📹 Video fuente:        ${videoPath}`);
console.log(`⏱️ Duración estimada:    ${(totalDurationSec / 3600).toFixed(2)}h (${Math.round(totalDurationSec)}s)`);
console.log(`🎞️ Tasa de muestreo:     ${fps} FPS (~${totalEstimatedFrames} fotogramas)`);
console.log(`💾 Base de datos destino: ${dbPath}`);
console.log(`📁 Directorio de fotos:  ${saveImagesToDisk ? harvestImgDir : "(Solo SQLite)"}`);
console.log(`===============================================================\n`);

// Limpiar registros previos de este video específico si se re-ejecuta
const prevCount = db.prepare("SELECT COUNT(*) as count FROM harvested_crops WHERE video_file = ?").get(videoBasename).count;
if (prevCount > 0) {
  console.log(`[Paso 1] 🔄 Limpiando ${prevCount} registros previos del video '${videoBasename}'...`);
  db.prepare("DELETE FROM harvested_crops WHERE video_file = ?").run(videoBasename);
}

// 5. Cargar calibración de cuadrantes locales
await prefetchQuadrants(null);

// 6. Configuración de Ingesta con FFmpeg
const ffmpegArgs = [
  ...(startSs > 0 ? ["-ss", String(startSs)] : []),
  ...(durationSs > 0 ? ["-t", String(durationSs)] : []),
  "-i", videoPath,
  "-an",
  "-r", String(fps),
  "-threads", "0",
  "-f", "image2pipe",
  "-q:v", "3",
  "-vcodec", "mjpeg",
  "pipe:1"
];

const tracker = new PersonTracker();
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

let chunkBuffer = Buffer.alloc(0);
let frameIndex = 0;
let harvestedCount = 0;
const startEpoch = Date.now();
let lastProgressUpdate = 0;

function renderProgress(currentFrame, totalFrames, sec, count) {
  const now = Date.now();
  const interval = process.stdout.isTTY ? 500 : 5000;
  if (now - lastProgressUpdate < interval) return;
  lastProgressUpdate = now;

  const pct = Math.min(100, (currentFrame / (totalFrames || 1)) * 100);
  const barLen = 25;
  const filled = Math.round((pct / 100) * barLen);
  const empty = barLen - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  const elapsedSec = (now - startEpoch) / 1000;
  const procFps = elapsedSec > 0 ? (currentFrame / elapsedSec).toFixed(1) : "0.0";
  const speedX = (parseFloat(procFps) / fps).toFixed(1);

  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  if (process.stdout.isTTY) {
    process.stdout.write(`\x1Bc===============================================================
   🌾 PASO 1: COSECHA DE RECORTES Y BIOMETRÍA DE VIDEO
===============================================================
📹 Video:     ${path.basename(videoPath)}
💾 Destino:   ${dbPath}
⚡ Velocidad: ${procFps} FPS (~${speedX}x tiempo real)
===============================================================
⏳ [${bar}] ${pct.toFixed(1)}% | Frame: ${currentFrame}/${totalFrames} | Cosechados: ${count} | T: ${timeStr}
`);
  } else {
    process.stdout.write(`[Paso 1] ⏳ [${bar}] ${pct.toFixed(1)}% | Frame: ${currentFrame}/${totalFrames} | Cosechados: ${count} | Video: ${timeStr} | ${procFps} FPS (~${speedX}x)\n`);
  }
}

// 6. Proceso Principal de Lectura y Detección
const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "ignore"] });

const insertTx = db.transaction((records) => {
  for (const rec of records) {
    stmtInsertHarvest.run(rec);
  }
});

// Resuelve los embeddings alineados pendientes (corren en paralelo en el pool de ONNX/sharp) y guarda el lote
async function flushBatch(batch) {
  await Promise.all(batch.map(async (rec) => {
    if (!rec._alignedPromise) return;
    try {
      const res = await rec._alignedPromise;
      if (res) {
        rec.embeddingBlob = vectorToBlob(res.embedding);
        rec.landmarksJson = JSON.stringify(res.landmarks.map((p) => [Number(p[0].toFixed(1)), Number(p[1].toFixed(1))]));
        rec.alignedDetScore = Number(res.detScore.toFixed(4));
      }
    } catch (_) {}
    delete rec._alignedPromise;
  }));
  insertTx(batch);
}

let pendingBatch = [];

async function processSingleFrame(frameBuffer, fIdx) {
  const videoSec = startSs + (fIdx / fps);
  const timestampEpoch = startEpoch + Math.round(videoSec * 1000);

  // 1. Detección YOLOv8n
  const mlResult = await detectScene(frameBuffer, { isRealtime: true });
  
  // 2. PersonTracker
  const activeTracks = tracker.update(
    mlResult.rawDetections || [],
    mlResult.quadrants || [],
    mlResult.imageDimensions?.width,
    mlResult.imageDimensions?.height,
    timestampEpoch
  );

  // 3. Evaluar recortes de personas en sillas de atención
  const crops = mlResult.clientCrops || [];
  for (let cIdx = 0; cIdx < crops.length; cIdx++) {
    const crop = crops[cIdx];
    // Solo registrar si es zona de corte o atención (barber_chair)
    const isChair = crop.zoneType === "barber_chair" || crop.zoneId?.includes("silla") || crop.role === "client";
    if (!isChair) continue;

    const cropBuffer = crop.buffer;
    if (!cropBuffer) continue;

    // Asociar al trackId correspondiente usando IoU de YOLO
    let matchedTrackId = null;
    let bestTrack = null;
    let maxIoU = 0;

    if (crop.box) {
      for (const tr of activeTracks) {
        if (!tr.box) continue;
        const iou = calculateIoU(crop.box, tr.box);
        if (iou > maxIoU) {
          maxIoU = iou;
          bestTrack = tr;
        }
      }
    }

    if (bestTrack && maxIoU >= (PIPELINE_CONFIG.tracking.iouThreshold ?? 0.30)) {
      matchedTrackId = bestTrack.trackId;
    } else {
      // Fallback a cuadrante si es el único track sentado formalmente en esa silla
      const formallySeatedInChair = activeTracks.filter(
        tr => tr.isFormallySeated && (tr.currentQuadrant?.id === crop.zoneId || tr.lastChairQuadrant?.id === crop.zoneId)
      );
      if (formallySeatedInChair.length === 1) {
        matchedTrackId = formallySeatedInChair[0].trackId;
      }
    }

    // 4. Evaluar calidad facial
    const quality = await evaluateFaceQuality(cropBuffer, {
      minConfidence: PIPELINE_CONFIG.faceDetection.minConfidence,
      minSharpness: PIPELINE_CONFIG.faceDetection.minSharpness
    });

    let faceBlob = null;
    let embBlob = null;
    let faceBoxJson = null;
    let alignedPromise = null;

    if (quality.isValid && quality.faceBuffer) {
      faceBlob = quality.faceBuffer;
      faceBoxJson = JSON.stringify(quality.faceBoxNorm || []);
      if (useAlignedEmbeddings) {
        // Se resuelve de forma diferida en flushBatch para solapar cómputo entre recortes
        alignedPromise = extractAlignedEmbedding(cropBuffer);
        alignedPromise.catch(() => {});
      } else {
        try {
          const emb = await extractFaceEmbedding(quality.faceBuffer);
          if (emb && emb.length === 512) {
            embBlob = vectorToBlob(emb);
          }
        } catch (_) {}
      }
    }

    harvestedCount++;
    const cropFilename = `crop_${videoBasename}_${String(harvestedCount).padStart(6, '0')}.jpg`;
    const cropRelPath = path.join("data", "harvested_crops", videoBasename, cropFilename);

    if (saveImagesToDisk) {
      fs.writeFile(path.join(PROJECT_ROOT, cropRelPath), cropBuffer, () => {});
    }

    pendingBatch.push({
      videoFile: videoBasename,
      frameIndex: fIdx,
      videoSecond: Number(videoSec.toFixed(2)),
      timestampEpoch,
      chairId: crop.zoneId || "silla_barbero_puesto2",
      trackId: matchedTrackId,
      boxJson: JSON.stringify(crop.box || []),
      confidence: crop.confidence || 0.90,
      cropPath: saveImagesToDisk ? cropRelPath : null,
      cropBlob: cropBuffer,
      faceDetected: quality.isValid ? 1 : 0,
      faceBoxJson,
      faceCropBlob: faceBlob,
      sharpnessScore: quality.sharpnessScore || 0,
      pose: quality.pose || "unknown",
      poseLabel: quality.poseLabel || "Desconocido",
      skinRatio: quality.skinRatio || 0,
      warmRatio: quality.warmRatio || 0,
      embeddingBlob: embBlob,
      landmarksJson: null,
      alignedDetScore: null,
      _alignedPromise: alignedPromise
    });

    if (pendingBatch.length >= 25) {
      await flushBatch(pendingBatch);
      pendingBatch = [];
    }
  }

  renderProgress(fIdx, totalEstimatedFrames, videoSec, harvestedCount);
}

// Búfer para procesar fotogramas secuencialmente
const frameQueue = [];
let isProcessingQueue = false;

async function runQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (frameQueue.length > 0) {
    const item = frameQueue.shift();
    await processSingleFrame(item.buffer, item.index);
  }
  isProcessingQueue = false;
}

ffmpeg.stdout.on("data", (chunk) => {
  chunkBuffer = Buffer.concat([chunkBuffer, chunk]);

  const firstSoi = chunkBuffer.indexOf(JPEG_SOI);
  if (firstSoi > 0) {
    chunkBuffer = chunkBuffer.slice(firstSoi);
  }

  let startIndex = chunkBuffer.indexOf(JPEG_SOI);
  let endIndex = chunkBuffer.indexOf(JPEG_EOI);

  while (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const frame = chunkBuffer.slice(startIndex, endIndex + 2);
    chunkBuffer = chunkBuffer.slice(endIndex + 2);

    frameIndex++;
    frameQueue.push({ buffer: frame, index: frameIndex });
    runQueue();

    startIndex = chunkBuffer.indexOf(JPEG_SOI);
    endIndex = chunkBuffer.indexOf(JPEG_EOI);
  }
});

ffmpeg.on("close", async () => {
  // Esperar a que la cola termine de procesar
  while (frameQueue.length > 0 || isProcessingQueue) {
    await new Promise(r => setTimeout(r, 50));
  }

  if (pendingBatch.length > 0) {
    await flushBatch(pendingBatch);
    pendingBatch = [];
  }

  console.log(`\n\n===============================================================`);
  console.log(`   ✅ COSECHA DEL PASO 1 COMPLETADA CON ÉXITO`);
  console.log(`===============================================================`);
  console.log(`📊 Fotogramas leídos:      ${frameIndex}`);
  console.log(`🌾 Recortes en silla:      ${harvestedCount}`);
  console.log(`💾 Base de datos guardada: ${dbPath}`);
  console.log(`⏱️ Tiempo total de ejecución: ${((Date.now() - startEpoch) / 1000).toFixed(1)}s`);
  console.log(`===============================================================\n`);

  db.close();
  process.exit(0);
});
