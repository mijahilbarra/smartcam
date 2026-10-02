import express from "express";
import admin from "firebase-admin";
import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { analyzeImageWithGemini } from "./gemini.js";
import { detectObjectsAndQuadrants } from "./detector.js";

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TOML_PATH = path.join(PROJECT_ROOT, "neolink.toml");

// Initialize Firebase Admin (uses Application Default Credentials on GCP Compute Engine)
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || "skip-bigotes",
  storageBucket: process.env.STORAGE_BUCKET || "skip-bigotes.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
app.use(express.json());

// Enable CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const DEFAULT_PROMPT = "Describe what do you see in the image";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6INfNkg0w5zqDOcming00kU9aN0SjMF71fHqISR9BxUHg";

let isCapturing = false;

/**
 * Fetch or initialize dynamic prompt and interval from Firestore: camera_catcher/prompt
 */
async function getDynamicConfig() {
  try {
    const promptRef = db.doc("camera_catcher/prompt");
    const doc = await promptRef.get();
    if (!doc.exists) {
      console.log("[Config] camera_catcher/prompt no existe. Creando con configuración por defecto...");
      const initialConfig = {
        default: DEFAULT_PROMPT,
        intervalMinutes: 15,
        updatedAt: new Date().toISOString()
      };
      await promptRef.set(initialConfig);
      return initialConfig;
    }
    const data = doc.data();
    return {
      prompt: data?.default || DEFAULT_PROMPT,
      intervalMinutes: data?.intervalMinutes !== undefined ? Number(data.intervalMinutes) : 15
    };
  } catch (err) {
    console.warn("[Config] Error leyendo configuración de Firestore, usando defaults:", err.message);
    return { prompt: DEFAULT_PROMPT, intervalMinutes: 15 };
  }
}

/**
 * Execute single snapshot capture, upload, Gemini analysis and Firestore recording
 */
export async function executeCaptureProcess() {
  if (isCapturing) {
    console.log("[Capture] Ya hay una captura en curso. Omitiendo ejecución concurrente.");
    return { status: "already_running" };
  }

  isCapturing = true;
  const timestamp = Date.now();
  const docId = `photo_${timestamp}`;
  const localOutputPath = `/tmp/snap_${timestamp}.jpeg`;

  try {
    console.log(`\n========================================`);
    console.log(`[1/5] Ejecutando captura P2P (${docId})...`);

    // Use Neolink docker container
    const cmd = `docker run --rm -v "${TOML_PATH}":/etc/neolink.toml -v /tmp:/out quantumentangledandy/neolink:latest neolink image -c /etc/neolink.toml --use-stream -f /out/snap_${timestamp}.jpeg barberia`;

    try {
      await execPromise(cmd, { timeout: 45000 });
    } catch (err) {
      try {
        await fs.stat(localOutputPath);
      } catch (_) {
        throw new Error(`Neolink capture failed: ${err.message}`);
      }
    }

    // 2. Read image buffer
    const buffer = await fs.readFile(localOutputPath);
    console.log(`[2/5] Fotograma capturado: ${buffer.length} bytes.`);

    // 3. Run Local Machine Learning (ONNX Runtime / YOLO)
    console.log(`[3/6] Analizando fotograma con Machine Learning local (ONNX Runtime)...`);
    const mlResult = await detectObjectsAndQuadrants(buffer);
    console.log(`[ML] Inferencia completada en ${mlResult.inferenceMs} ms. Cuadrantes detectados: ${mlResult.quadrants.length}`);

    // 4. Upload original and annotated images to Firebase Storage
    const storagePath = `camera_catcher/photos/${docId}.jpg`;
    const annotatedStoragePath = `camera_catcher/photos/${docId}_annotated.jpg`;
    console.log(`[4/6] Subiendo a Firebase Storage: ${storagePath} y ${annotatedStoragePath}...`);

    const fileOriginal = bucket.file(storagePath);
    await fileOriginal.save(buffer, {
      metadata: {
        contentType: "image/jpeg",
        metadata: {
          capturedAt: new Date().toISOString(),
          camera: "barberia",
          source: "gcp-e2-micro",
          type: "raw"
        }
      }
    });

    const fileAnnotated = bucket.file(annotatedStoragePath);
    await fileAnnotated.save(mlResult.annotatedBuffer, {
      metadata: {
        contentType: "image/jpeg",
        metadata: {
          capturedAt: new Date().toISOString(),
          camera: "barberia",
          source: "gcp-e2-micro",
          type: "annotated_quadrants"
        }
      }
    });

    // Clean temp local file
    try {
      await fs.unlink(localOutputPath);
    } catch (_) {}

    // 5. Config / Summary
    console.log(`[5/6] Preparando resumen analítico...`);
    const summaryText = `ML Local: ${mlResult.quadrants.map(q => `${q.label} [${q.status}]`).join(", ")}`;
    console.log(`[Resumen] ${summaryText}`);

    // 6. Save in Firestore: camera_catcher/photos/photos/<docId>
    const docRef = db.doc(`camera_catcher/photos/photos/${docId}`);
    const record = {
      id: docId,
      imageStoragePath: storagePath,
      annotatedStoragePath: annotatedStoragePath,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: new Date().toISOString(),
      epoch: timestamp,
      analysis: summaryText,
      ml: {
        engine: "onnxruntime-node",
        inferenceMs: mlResult.inferenceMs,
        imageDimensions: mlResult.imageDimensions,
        quadrants: mlResult.quadrants,
        rawDetections: mlResult.rawDetections
      },
      camera: "barberia",
      source: "gcp-e2-micro"
    };

    await docRef.set(record);
    console.log(`[6/6] [Firestore] Documento guardado exitosamente en camera_catcher/photos/photos/${docId}`);
    console.log(`========================================\n`);

    return record;
  } finally {
    isCapturing = false;
  }
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "iot-camera-catcher",
    vm: "gcp-e2-micro",
    currentIntervalMinutes,
    timestamp: new Date().toISOString()
  });
});

// Capture trigger endpoint
app.all("/capture", async (req, res) => {
  try {
    const result = await executeCaptureProcess();
    res.status(200).json({
      success: true,
      message: "Capture and analysis completed successfully",
      data: result
    });
  } catch (err) {
    console.error("[Error] Capture process failed:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 8085;
app.listen(PORT, () => {
  console.log(`[Server] Daemon escuchando en http://localhost:${PORT}`);
});

// Dynamic Interval Cron Scheduler
let currentIntervalMinutes = 15;
let cronTimerId = null;

function setupCronTimer(minutes) {
  if (cronTimerId) {
    clearInterval(cronTimerId);
    cronTimerId = null;
  }

  const num = Number(minutes);
  // Allow decimals like 0.5 (30 sec). Safe minimum 6 seconds (0.1 min)
  currentIntervalMinutes = (!isNaN(num) && num > 0) ? Math.max(0.1, num) : 15;
  const intervalMs = Math.round(currentIntervalMinutes * 60 * 1000);

  console.log(`[Cron] Programador de captura configurado cada ${currentIntervalMinutes} min (${intervalMs / 1000} seg).`);

  cronTimerId = setInterval(async () => {
    console.log(`[Cron] Ejecutando captura programada periódica (${currentIntervalMinutes} min)...`);
    try {
      await executeCaptureProcess();
    } catch (err) {
      console.error(`[Cron] Error en captura periódica:`, err.message);
    }
  }, intervalMs);
}

// Initial scheduler setup
setupCronTimer(15);

// Listen to Firestore prompt & interval changes in real time
db.doc("camera_catcher/prompt").onSnapshot((snapshot) => {
  const data = snapshot.data();
  if (data && data.intervalMinutes !== undefined) {
    const newInterval = Number(data.intervalMinutes);
    if (!isNaN(newInterval) && newInterval !== currentIntervalMinutes) {
      console.log(`[Config] Actualización de intervalo detectada en Firestore: ${newInterval} minutos.`);
      setupCronTimer(newInterval);
    }
  }
}, (err) => {
  console.warn(`[Config] Error escuchando camera_catcher/prompt:`, err.message);
});

// Real-time listener for manual captures from the web ("Capturar Ahora")
let lastTriggerHandled = Date.now();
console.log(`[Listener] Escuchando comandos en tiempo real de Firestore: camera_catcher/commands...`);
db.doc("camera_catcher/commands").onSnapshot((snapshot) => {
  const data = snapshot.data();
  if (data && data.action === "capture" && data.requestedAt > lastTriggerHandled) {
    lastTriggerHandled = data.requestedAt;
    console.log(`[Listener] Disparo manual recibido desde la web a las ${new Date(data.requestedAt).toLocaleTimeString()}`);
    executeCaptureProcess().catch(err => {
      console.error(`[Listener] Error procesando captura manual:`, err.message);
    });
  }
}, (err) => {
  console.warn(`[Listener] Error en snapshot listener de commands:`, err.message);
});
