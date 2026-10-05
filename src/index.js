/**
 * Punto de Entrada Principal (Entrypoint) del Daemon IOT Camera Catcher
 * Inicializa logging, Firebase Admin, servidor Express, listeners de Firestore y programador cron.
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Re-exports de compatibilidad para suites de prueba y clientes externos
export { parseTimeToMinutes, isWithinWorkingHours } from "./core/working_hours.js";

import { initLogger } from "./infrastructure/logging/logger.js";
import { initFirebaseAdmin } from "./infrastructure/firebase/firebase_admin.js";
import { daemonReporter } from "./daemon_reporter.js";
import { cleanupZombies } from "./infrastructure/camera/neolink_client.js";
import {
  getDynamicConfig,
  registerFirestoreListeners,
  prefetchQuadrants
} from "./infrastructure/firebase/firestore_listeners.js";
import { SchedulerService } from "./services/scheduler_service.js";
import { CaptureOrchestrator } from "./services/capture_orchestrator.js";

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
const scheduler = new SchedulerService({
  defaultIntervalMinutes: 15,
  defaultStart: "11:00",
  defaultEnd: "23:00",
  defaultTz: "America/Lima"
});

const orchestrator = new CaptureOrchestrator({
  db,
  bucket,
  tomlPath: TOML_PATH,
  scheduler
});

scheduler.onTick = (triggerSource) => orchestrator.execute(triggerSource);

/**
 * Función expuesta para disparar la captura manualmente o desde tests
 */
export async function executeCaptureProcess(triggerSource = "scheduled") {
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
    scheduler: scheduler.getState(),
    timestamp: new Date().toISOString()
  });
});

app.all("/capture", async (req, res) => {
  try {
    const result = await orchestrator.execute("manual");
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
  scheduler,
  onManualCapture: (src) => orchestrator.execute(src)
});

// 6. Secuencia de Arranque (Boot Lifecycle)
try {
  db.doc("camera_catcher/status").set({
    service: "camera-catcher",
    status: "running",
    startedAt: new Date().toISOString(),
    pid: process.pid,
    nodeVersion: process.version
  }, { merge: true }).catch(() => {});
} catch (_) {}

await prefetchQuadrants(db);

try {
  const cfg = await getDynamicConfig(db);
  console.log(`[Startup] Configuración cargada: Intervalo ${cfg.intervalMinutes} min, Horario ${cfg.workStartTime} a ${cfg.workEndTime} (${cfg.timezone}).`);
  scheduler.updateWorkingHours(cfg.workStartTime, cfg.workEndTime, cfg.timezone);
  scheduler.setupTimer(cfg.intervalMinutes);
} catch (_) {
  scheduler.setupTimer(15);
}

await cleanupZombies();
console.log("[Startup] Limpieza de procesos completada. Sistema listo.");
setTimeout(() => {
  if (!scheduler.isWorkingNow()) {
    console.log(`[Startup] Fuera de horario laboral. Omitiendo captura inicial automática.`);
    return;
  }
  console.log("[Startup] Ejecutando captura inicial automática de arranque...");
  orchestrator.execute("startup").catch(err => {
    console.error("[Startup] Error en captura inicial:", err.message);
  });
}, 4000);

export { app, scheduler, orchestrator, db, bucket };
