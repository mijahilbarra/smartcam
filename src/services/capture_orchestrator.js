import { killCaptureContainer } from "../infrastructure/camera/neolink_client.js";
import { daemonReporter } from "../daemon_reporter.js";
import { PersonTracker } from "../core/person_tracker.js";
import { VisitSessionService } from "./visit_session_service.js";
import { runProcessCycle } from "./processes.js";

import { PIPELINE_CONFIG } from "../core/pipeline_config.js";

/**
 * Controlador de Ciclo de Captura y Procesamiento
 * Mantiene el estado en memoria (tracker, sesiones activas, mutex de captura)
 * y delega la ejecución paso a paso al pipeline funcional `runProcessCycle`.
 */
export class CaptureOrchestrator {
  constructor({ db, bucket, tomlPath, streamServer } = {}) {
    this.db = db;
    this.bucket = bucket;
    this.tomlPath = tomlPath;
    this.streamServer = streamServer;
    this.isCapturing = false;
    this.tracker = new PersonTracker();
    const minAppointmentMinutes = process.env.MIN_APPOINTMENT_MINUTES
      ? parseInt(process.env.MIN_APPOINTMENT_MINUTES, 10)
      : (PIPELINE_CONFIG.sessions?.minAppointmentMinutes ?? 8);
    const emptyChairTimeoutMs = process.env.EMPTY_CHAIR_TIMEOUT_MS
      ? parseInt(process.env.EMPTY_CHAIR_TIMEOUT_MS, 10)
      : (PIPELINE_CONFIG.sessions?.emptyChairTimeoutMs ?? 45000);
    const clockFn = streamServer && typeof streamServer.getVirtualNow === "function"
      ? () => streamServer.getVirtualNow()
      : null;
    this.visitService = new VisitSessionService({ db, bucket, minAppointmentMinutes, emptyChairTimeoutMs, clockFn });

    if (streamServer && !streamServer.onMockVideoEnd) {
      streamServer.onMockVideoEnd = async (virtualNow) => {
        const active = this.visitService.getActiveSessions();
        for (const s of active) {
          await this.visitService.closeSession(s.trackId, { endedAtEpoch: virtualNow });
        }
      };
    }
  }

  /**
   * Ejecuta el ciclo integral delegando en el pipeline funcional de procesos
   * @param {string} triggerSource - "manual" | "startup" | "realtime"
   * @returns {Promise<Object>}
   */
  async execute(triggerSource = "manual", options = {}) {
    if (this.isCapturing) {
      console.log("[Capture] Ya hay una captura en curso. Omitiendo ejecución concurrente.");
      return { status: "already_running" };
    }

    this.isCapturing = true;

    try {
      const cycleOptions = {
        triggerSource,
        asyncClear: triggerSource === "realtime",
        backgroundSync: triggerSource === "realtime",
        ...options
      };
      return await runProcessCycle({
        db: this.db,
        bucket: this.bucket,
        tomlPath: this.tomlPath,
        streamServer: this.streamServer,
        tracker: this.tracker,
        visitService: this.visitService
      }, cycleOptions);
    } catch (err) {
      console.error(`[Capture Error] Falló el proceso de captura:`, err.message);
      await daemonReporter.reportError(err);
      throw err;
    } finally {
      this.isCapturing = false;
      if (triggerSource !== "realtime") {
        await killCaptureContainer();
      }
    }
  }
}
