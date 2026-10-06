/**
 * Punto de Entrada Principal (Entrypoint) del Daemon IOT Camera Catcher
 * Inicializa logging, Firebase Admin, servidor Express, listeners de Firestore y programador cron.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Re-exports de compatibilidad para suites de prueba y clientes externos
export { parseTimeToMinutes, isWithinWorkingHours, WorkingHoursManager } from "./core/working_hours.js";

import { initLogger } from "./infrastructure/logging/logger.js";
import { initFirebaseAdmin } from "./infrastructure/firebase/firebase_admin.js";
import { daemonReporter } from "./daemon_reporter.js";
import { cleanupZombies, startNeolinkDaemon } from "./infrastructure/camera/neolink_client.js";
import {
  getDynamicConfig,
  registerFirestoreListeners,
  prefetchQuadrants
} from "./infrastructure/firebase/firestore_listeners.js";
import { WorkingHoursManager } from "./core/working_hours.js";
import { CaptureOrchestrator } from "./services/capture_orchestrator.js";
import { StreamServer } from "./infrastructure/streaming/stream_server.js";
import { telemetryStream } from "./infrastructure/streaming/telemetry_stream.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TOML_PATH = process.env.NEOLINK_TOML_PATH || path.join(PROJECT_ROOT, "neolink.toml");
const DAEMON_LOG_FILE = path.join(PROJECT_ROOT, "daemon.log");
const TMP_LOG_FILE = "/tmp/camera-catcher.log";

// 1. Inicializar sistema de logs en archivo para diagnóstico SSH
initLogger(DAEMON_LOG_FILE, TMP_LOG_FILE);

// 2. Inicializar Firebase Admin SDK (con Application Default Credentials en GCP)
const { db, bucket } = initFirebaseAdmin();
daemonReporter.init(db);

// 3. Inicializar Servicios de Dominio y Orquestación
const workingHours = new WorkingHoursManager({
  defaultStart: "11:00",
  defaultEnd: "23:00",
  defaultTz: "America/Lima"
});

const streamServer = new StreamServer({
  rtspUrl: process.env.RTSP_STREAM_URL || "rtsp://127.0.0.1:8554/barberia/sub",
  fps: 8
});

const orchestrator = new CaptureOrchestrator({
  db,
  bucket,
  tomlPath: TOML_PATH,
  streamServer
});

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "iot-camera-catcher",
    vm: "gcp-e2-micro",
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

app.get("/api/visits/active", (req, res) => {
  res.json({
    activeSessions: orchestrator.visitService.getActiveSessions(),
    timestamp: new Date().toISOString()
  });
});

app.all("/capture", (req, res) => {
  if (orchestrator.isCapturing) {
    return res.status(409).json({
      success: false,
      status: "already_running",
      message: "Ya hay una captura en curso."
    });
  }

  orchestrator.execute("manual").catch(err => console.error("[Daemon] Error en captura asíncrona:", err));

  return res.status(202).json({
    success: true,
    status: "started",
    message: "Ciclo de captura iniciado exitosamente."
  });
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
  onManualCapture: (src) => orchestrator.execute(src)
});

// 6. Loop de Visión en Tiempo Real
let realtimeLoopInterval = null;

export function startRealtimeLoop(intervalMs = 2500) {
  // Asegurar que el stream esté activo permanentemente para alimentar frames a memoria en 0ms
  streamServer.startFfmpegStream(true);

  if (realtimeLoopInterval) clearInterval(realtimeLoopInterval);
  realtimeLoopInterval = setInterval(async () => {
    if (!workingHours.isWorkingNow()) return;
    if (orchestrator.isCapturing) return;

    try {
      await orchestrator.execute("realtime");
    } catch (err) {
      console.warn("[RealtimeLoop] Aviso en ciclo de visión:", err.message);
    }
  }, intervalMs);
  console.log(`[RealtimeLoop] Bucle de visión continua activo cada ${intervalMs / 1000}s.`);
}

export function stopRealtimeLoop() {
  if (realtimeLoopInterval) {
    clearInterval(realtimeLoopInterval);
    realtimeLoopInterval = null;
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

await cleanupZombies();
await startNeolinkDaemon({ tomlPath: TOML_PATH });
console.log("[Startup] Limpieza y daemon RTSP Neolink completado. Sistema listo.");

// Iniciar bucle continuo de visión y seguimiento en tiempo real
setTimeout(() => {
  if (!workingHours.isWorkingNow()) {
    console.log(`[Startup] Fuera de horario laboral. Bucle de visión en espera.`);
    return;
  }
  console.log("[Startup] Arrancando bucle de visión y seguimiento continuo en tiempo real...");
  startRealtimeLoop(2500);
}, 3000);

export { app, workingHours, orchestrator, db, bucket, server };
