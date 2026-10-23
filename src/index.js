/**
 * Punto de Entrada Principal (Entrypoint) del Daemon IOT Camera Catcher
 * Inicializa logging, Firebase Admin, servidor Express, listeners de Firestore y programador cron.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

process.env.MALLOC_ARENA_MAX = process.env.MALLOC_ARENA_MAX || "2";
sharp.concurrency(1);
sharp.cache(false);

// Re-exports de compatibilidad para suites de prueba y clientes externos
export { parseTimeToMinutes, isWithinWorkingHours, WorkingHoursManager } from "./core/working_hours.js";

import { initLogger } from "./infrastructure/logging/logger.js";
import { initFirebaseAdmin } from "./infrastructure/firebase/firebase_admin.js";
import { daemonReporter } from "./daemon_reporter.js";
import { customerService } from "./services/customer_service.js";
import { cleanupZombies, startNeolinkDaemon, stopNeolinkDaemon } from "./infrastructure/camera/neolink_client.js";
import {
  getDynamicConfig,
  registerFirestoreListeners,
  prefetchQuadrants
} from "./infrastructure/firebase/firestore_listeners.js";
import { WorkingHoursManager } from "./core/working_hours.js";
import { CaptureOrchestrator } from "./services/capture_orchestrator.js";
import { StreamServer } from "./infrastructure/streaming/stream_server.js";
import { telemetryStream } from "./infrastructure/streaming/telemetry_stream.js";
import { getSystemMemoryMetrics } from "./core/system_metrics.js";
import { GoogleDriveClient, loadEnvFile } from "./infrastructure/storage/gdrive_client.js";
import { StreamRecorder } from "./infrastructure/recording/stream_recorder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
loadEnvFile(path.join(PROJECT_ROOT, ".env"));
const TOML_PATH = process.env.NEOLINK_TOML_PATH || path.join(PROJECT_ROOT, "neolink.toml");
const DAEMON_LOG_FILE = path.join(PROJECT_ROOT, "daemon.log");
const TMP_LOG_FILE = "/tmp/camera-catcher.log";

// 1. Inicializar sistema de logs en archivo para diagnóstico SSH
initLogger(DAEMON_LOG_FILE, TMP_LOG_FILE);

// 2. Inicializar Firebase Admin SDK (con Application Default Credentials en GCP)
const { db, bucket, databaseId } = initFirebaseAdmin();
daemonReporter.init(db);
customerService.initForDatabase(databaseId);
console.log(`[Storage] SQLite configurado en paridad con Firestore [Database: ${databaseId}] -> ${customerService.sqliteClient.dbPath}`);

// 3. Inicializar Servicios de Dominio y Orquestación
const workingHours = new WorkingHoursManager({
  defaultStart: "11:00",
  defaultEnd: "23:00",
  defaultTz: "America/Lima"
});

const mockVideoPath = process.env.MOCK_VIDEO_PATH ? path.resolve(PROJECT_ROOT, process.env.MOCK_VIDEO_PATH) : null;

const streamServer = new StreamServer({
  rtspUrl: process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub",
  fps: Number(process.env.STREAM_FPS) || 3.5,
  streamFastForward: process.env.STREAM_FAST_FORWARD === "true",
  mockVideoPath,
  mockVideoLastMinutes: process.env.MOCK_VIDEO_LAST_MINUTES ? Number(process.env.MOCK_VIDEO_LAST_MINUTES) : null,
  mockVideoStartSs: process.env.MOCK_VIDEO_START_SS ? Number(process.env.MOCK_VIDEO_START_SS) : null,
  mockVideoDurationSs: process.env.MOCK_VIDEO_DURATION_SS ? Number(process.env.MOCK_VIDEO_DURATION_SS) : null,
  mockVideoLoop: process.env.MOCK_VIDEO_LOOP === "true",
  onEnsureRtspSource: async ({ forceRestart = false } = {}) => {
    if (!mockVideoPath) {
      await startNeolinkDaemon({ tomlPath: TOML_PATH, forceRestart });
    }
  }
});

const orchestrator = new CaptureOrchestrator({
  db,
  bucket,
  tomlPath: TOML_PATH,
  streamServer
});

// Inicializar cliente Google Drive y grabador de streaming continuo si las credenciales existen
let gdriveClient = null;
let streamRecorder = null;

if (process.env.GDRIVE_REFRESH_TOKEN) {
  gdriveClient = new GoogleDriveClient();
  if (process.env.ENABLE_GDRIVE_RECORDING !== "false") {
    streamRecorder = new StreamRecorder({
      gdriveClient,
      workingHours,
      rtspUrl: process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub",
      segmentDurationSec: Number(process.env.GDRIVE_SEGMENT_DURATION_SEC) || 900
    });
    console.log("[Storage] GoogleDriveClient y StreamRecorder inicializados exitosamente.");
  }
}

/**
 * Función expuesta para disparar la captura manualmente o desde tests
 */
export async function executeCaptureProcess(triggerSource = "manual") {
  return orchestrator.execute(triggerSource);
}

// 4. Servidor Express para Health Checks y Endpoints de Disparo
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "iot-camera-catcher",
    vm: "gcp-e2-micro",
    memory: getSystemMemoryMetrics(),
    workingHours: workingHours.getState(),
    timestamp: new Date().toISOString()
  });
});

app.get(["/api/stream", "/stream"], (req, res) => {
  streamServer.handleStreamRequest(req, res);
});

app.get(["/api/snapshot", "/snapshot"], (req, res) => {
  const frame = streamServer.getLatestFrame();
  if (frame) {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.end(frame);
  }
  return res.status(503).json({ error: "Stream frame not ready yet" });
});

app.get(["/api/yolo/stream", "/api/telemetry/stream"], (req, res) => {
  telemetryStream.handleRequest(req, res);
});

app.get(["/api/yolo/latest", "/api/telemetry/latest"], (req, res) => {
  res.json(telemetryStream.getLatestTelemetry() || { status: "no_data_yet" });
});

app.get("/api/simulation/progress", (req, res) => {
  const ss = orchestrator?.streamServer;
  const framesEmitted = ss?.framesEmitted || 0;
  const fps = ss?.fps || 60;
  const videoDuration = (ss?.mockVideoPath && typeof ss?.getVideoDuration === "function")
    ? ss.getVideoDuration(ss.mockVideoPath)
    : (ss?.mockVideoPath?.includes("7h") ? 20076.4 : (ss?.mockVideoPath?.includes("10h") ? 33939.5 : 20076.4));
  const totalDurationSec = videoDuration || (ss?.mockVideoPath?.includes("10h") ? 33939.5 : 20076.4);
  const totalFrames = Math.round(totalDurationSec * fps);
  const elapsedSec = framesEmitted / fps;
  const percent = totalFrames > 0 ? Math.min(100, (framesEmitted / totalFrames) * 100) : 0;
  res.json({
    framesEmitted,
    totalFrames,
    elapsedSec,
    percent,
    activeSessions: orchestrator?.visitService?.getActiveSessions?.()?.length || 0
  });
});

app.get("/api/recording/status", (req, res) => {
  if (!streamRecorder) {
    return res.json({
      status: "disabled",
      configured: Boolean(gdriveClient),
      isRecording: false
    });
  }
  return res.json({
    status: streamRecorder.isRecording ? "recording" : "idle",
    ...streamRecorder.getStats()
  });
});

app.get("/api/recording/quota", async (req, res) => {
  if (!gdriveClient) {
    return res.status(503).json({ error: "Google Drive client not configured" });
  }
  try {
    const quota = await gdriveClient.getStorageQuota();
    return res.json(quota);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post(["/api/session/close", "/api/appointments/close"], async (req, res) => {
  try {
    const sessions = orchestrator.visitService.getActiveSessions();
    if (sessions.length === 0) {
      return res.json({ status: "no_active_sessions" });
    }
    const results = [];
    for (const s of sessions) {
      const appt = await orchestrator.visitService.closeSession(s.trackId, { minMinutes: 0 });
      results.push(appt);
    }
    return res.json({ status: "closed", appointments: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8085;
const server = app.listen(PORT, () => {
  console.log(`[Server] Daemon escuchando en http://localhost:${PORT}`);
}).on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[Server] Puerto ${PORT} ya en uso (simulador u otra instancia activa). Omitiendo binding HTTP local.`);
  } else {
    console.error("[Server] Error iniciando servidor HTTP:", err.message);
  }
});

// 5. Registrar Listeners en Tiempo Real de Firestore
registerFirestoreListeners({
  db,
  workingHours,
  customerService
});

const DEFAULT_REALTIME_INTERVAL_MS = Number(process.env.REALTIME_INTERVAL_MS) || 400;
let isRealtimeLoopRunning = false;
let realtimeLoopTimeout = null;

const PROD_STREAM_URL = process.env.PROD_STREAM_URL || "https://stream.perrosuelto.com";

/**
 * Verifica si existe una transmisión activa en producción consultando /api/snapshot
 * @param {string} [url]
 * @param {number} [timeoutMs]
 * @param {number} [maxAttempts]
 * @returns {Promise<{active: boolean, latestBuffer: Buffer|null}>}
 */
export async function checkProductionStream(url = PROD_STREAM_URL, timeoutMs = 6000, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/api/snapshot`, {
        method: "GET",
        signal: controller.signal,
        headers: { "Cache-Control": "no-cache" }
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        const arrayBuf = await res.arrayBuffer();
        if ((contentType.includes("image/jpeg") || contentType.includes("image/jpg")) && arrayBuf.byteLength > 1000) {
          return { active: true, latestBuffer: Buffer.from(arrayBuf) };
        }
      }
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { active: false, latestBuffer: null };
}

export function startRealtimeLoop(intervalMs = DEFAULT_REALTIME_INTERVAL_MS) {
  streamServer.startFfmpegStream(true);
  if (isRealtimeLoopRunning) return;
  isRealtimeLoopRunning = true;

  const loopStep = async () => {
    if (!isRealtimeLoopRunning) return;
    if (!mockVideoPath && !workingHours.isWorkingNow()) {
      if (streamRecorder && streamRecorder.isRecording) {
        streamRecorder.stop().catch((e) => console.warn("[StreamRecorder] Error pausando grabación fuera de horario:", e.message));
      }
      realtimeLoopTimeout = setTimeout(loopStep, 5000);
      return;
    } else if (streamRecorder && !mockVideoPath && !streamRecorder.isRecording) {
      streamRecorder.start();
    }

    const start = Date.now();
    try {
      if (!orchestrator.isCapturing) {
        await orchestrator.execute("realtime");
      }
    } catch (err) {
      console.warn("[RealtimeLoop] Aviso en ciclo de visión:", err.message);
    }

    if (!isRealtimeLoopRunning) return;
    const elapsed = Date.now() - start;
    const delay = Math.max(10, intervalMs - elapsed);
    realtimeLoopTimeout = setTimeout(loopStep, delay);
  };

  console.log(`[RealtimeLoop] Bucle de visión continua activo cadencia dinámica ~${intervalMs}ms (${(1000 / intervalMs).toFixed(1)} FPS objetivo).`);
  loopStep();
}

export function stopRealtimeLoop() {
  isRealtimeLoopRunning = false;
  if (realtimeLoopTimeout) {
    clearTimeout(realtimeLoopTimeout);
    realtimeLoopTimeout = null;
  }
}

// 7. Secuencia de Arranque (Boot Lifecycle)
// Nota: el estado/salud del daemon NO se persiste en Firestore; el frontend lo obtiene por SSE directo.

await prefetchQuadrants(db);

try {
  const cfg = await getDynamicConfig(db);
  console.log(`[Startup] Configuración cargada: Horario ${cfg.workStartTime} a ${cfg.workEndTime} (${cfg.timezone}).`);
  workingHours.updateWorkingHours(cfg.workStartTime, cfg.workEndTime, cfg.timezone);
} catch (err) {
  console.warn("[Startup] Aviso cargando config:", err.message);
}

const isLocalEnvironment = process.env.IS_LOCAL_SIMULATOR === "true" ||
                           process.env.NODE_ENV !== "production" ||
                           process.env.CHECK_PROD_STREAM_FIRST === "true" ||
                           Boolean(process.env.STORAGE_BUCKET && process.env.STORAGE_BUCKET.includes("test"));

if (mockVideoPath) {
  console.log(`[Startup] 🎬 Modo Simulación Offline activado con video local: ${mockVideoPath}`);
  console.log(`[Startup] 🔒 Omitiendo conexión a producción y daemon Neolink. Sistema listo.`);
} else if (isLocalEnvironment) {
  console.log(`[Startup] Verificando si existe transmisión activa en producción (${PROD_STREAM_URL})...`);
  const prodCheck = await checkProductionStream();
  if (prodCheck.active) {
    console.log(`[Startup] 🌐 Transmisión ACTIVA detectada en producción (${PROD_STREAM_URL}).`);
    console.log(`[Startup] 🔒 Cancelando apertura de transmisión local (neolink-daemon) para evitar colisión P2P en cámara física.`);
    await stopNeolinkDaemon();
    streamServer.enableRemoteRelay(PROD_STREAM_URL, prodCheck.latestBuffer);
    console.log(`[Startup] 🔄 Modo Relay local activado hacia ${PROD_STREAM_URL}. Sistema listo.`);
  } else {
    console.log(`[Startup] ℹ️ No se detectó transmisión en producción. Iniciando transmisión local (Neolink RTSP)...`);
    await cleanupZombies();
    await startNeolinkDaemon({ tomlPath: TOML_PATH });
    console.log("[Startup] Limpieza y daemon RTSP Neolink completado. Sistema listo.");
  }
} else {
  await cleanupZombies();
  await startNeolinkDaemon({ tomlPath: TOML_PATH });
  console.log("[Startup] Limpieza y daemon RTSP Neolink completado. Sistema listo.");
}

// Iniciar bucle continuo de visión y seguimiento en tiempo real
function tryStartRealtimeLoop() {
  const isSimulation = Boolean(mockVideoPath);
  if (isSimulation || workingHours.isWorkingNow()) {
    if (isSimulation) {
      console.log(`[Startup] 🎬 Modo Simulación Activo: omitiendo restricción de horario laboral.`);
    }
    console.log(`[Startup] Arrancando bucle de visión y seguimiento continuo en tiempo real (${DEFAULT_REALTIME_INTERVAL_MS}ms)...`);
    startRealtimeLoop();
    if (streamRecorder && !isSimulation && !streamRecorder.isRecording) {
      streamRecorder.start();
    }
  } else {
    console.log(`[Startup] Fuera de horario laboral. Bucle de visión en espera.`);
    if (streamRecorder && streamRecorder.isRecording) {
      streamRecorder.stop().catch((e) => console.warn("[StreamRecorder] Error deteniendo grabador fuera de horario:", e.message));
    }
    // Programar verificación periódica cada 60 segundos para arrancar en cuanto comience el horario laboral
    const checkInterval = setInterval(() => {
      if (workingHours.isWorkingNow()) {
        console.log(`[Startup] Inicio de horario laboral detectado. Arrancando bucle de visión en tiempo real...`);
        clearInterval(checkInterval);
        startRealtimeLoop();
        if (streamRecorder && !isSimulation && !streamRecorder.isRecording) {
          streamRecorder.start();
        }
      }
    }, 60000);
    if (typeof checkInterval.unref === "function") checkInterval.unref();
  }
}

setTimeout(tryStartRealtimeLoop, 3000);

// Limpieza ordenada ante señales de parada
const handleShutdown = async () => {
  if (streamRecorder && streamRecorder.isRecording) {
    try {
      await streamRecorder.stop();
    } catch (_) {}
  }
};
process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);

export { app, workingHours, orchestrator, db, bucket, server, customerService, gdriveClient, streamRecorder };
