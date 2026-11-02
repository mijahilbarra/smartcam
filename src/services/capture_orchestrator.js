import { emitBlockDecision } from "./pipeline/decision_feed.js";
import { telemetryStream } from "../infrastructure/streaming/telemetry_stream.js";
import { killCaptureContainer } from "../infrastructure/camera/neolink_client.js";
import { daemonReporter } from "../daemon_reporter.js";
import { PersonTracker } from "../core/person_tracker.js";
import { VisitSessionService } from "./visit_session_service.js";
import { runProcessCycle, flushProcessPipeline, TrackBlockManager } from "./processes.js";
import { PIPELINE_CONFIG } from "../core/pipeline_config.js";
import { getCachedQuadrants } from "./pipeline/closure_rules.js";

/**
 * Controlador de Ciclo de Captura y Procesamiento
 * Mantiene el estado en memoria (tracker, sesiones activas, mutex de captura)
 * y delega la ejecución paso a paso al pipeline funcional `runProcessCycle`.
 */
export class CaptureOrchestrator {
  constructor({ db, bucket, tomlPath, streamServer, quadrants } = {}) {
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
    // Dimensiones y parámetros espaciales de video
    const videoWidth = Number(process.env.VIDEO_WIDTH) || 1280;
    const videoHeight = Number(process.env.VIDEO_HEIGHT) || 720;
    const resolvedQuadrants = quadrants || getCachedQuadrants();
    const chairZone = resolvedQuadrants?.find(q => q.type === "barber_chair" || q.id === "silla_barbero_puesto2") || resolvedQuadrants?.[0] || null;
    const staffThreshold = PIPELINE_CONFIG.staffFilter?.staffExclusionThreshold ?? 0.46;

    this.visitService = new VisitSessionService({
      db,
      bucket,
      minAppointmentMinutes,
      emptyChairTimeoutMs,
      staffThreshold,
      maxCompletedAppointments: Infinity,
      quadrants: resolvedQuadrants,
      chairZone,
      clockFn
    });

    // Cargar perfiles de staff desde customerService
    const comparisonProfiles = this.visitService?.customerService?.getComparisonProfiles?.() || [];
    const staffProfiles = comparisonProfiles.filter(p => p.isStaff);

    this.trackBlockManager = new TrackBlockManager({
      staffProfiles,
      staffThreshold,
      quadrants: resolvedQuadrants,
      width: videoWidth,
      height: videoHeight,
      onBlockDecided: (decision) => {
        emitBlockDecision(decision);
        if (decision.valid) {
          console.log(`[TrackBlockManager] ✅ Bloque confirmado #${decision.block?.trackId} en ${decision.block?.chairId}: ${decision.reason}`);
        } else if (decision.isSeatedPresenceOnly) {
          console.log(`[TrackBlockManager] 🪑 Bloque de presencia sin rostro #${decision.block?.trackId}: ${decision.reason}`);
        } else {
          console.log(`[TrackBlockManager] ⚠️ Bloque descartado #${decision.block?.trackId}: ${decision.verdict} - ${decision.reason}`);
        }
      }
    });
    this.visitService.trackBlockManager = this.trackBlockManager;

    if (streamServer && !streamServer.onMockVideoEnd) {
      streamServer.onMockVideoEnd = async (virtualNow) => {
        await flushProcessPipeline({
          lastTimestamp: virtualNow,
          trackBlockManager: this.trackBlockManager,
          visitService: this.visitService,
          options: { emptyChairTimeoutMs }
        });

        // Emitir estado final completo con todos los TrackBlocks cerrados para la UI
        if (this.trackBlockManager?.getAllTrackBlocksSnapshot) {
          const finalBlocks = this.trackBlockManager.getAllTrackBlocksSnapshot(virtualNow);
          telemetryStream.broadcast({
            allTrackBlocks: finalBlocks
          });
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
      // Sincronizar perfiles de staff si se inicializaron posteriormente
      if (this.trackBlockManager && (!this.trackBlockManager.staffProfiles || this.trackBlockManager.staffProfiles.length === 0)) {
        const comparisonProfiles = this.visitService?.customerService?.getComparisonProfiles?.() || [];
        const staff = comparisonProfiles.filter(p => p.isStaff);
        if (staff.length > 0) {
          this.trackBlockManager.staffProfiles = staff;
        }
      }

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
        visitService: this.visitService,
        trackBlockManager: this.trackBlockManager
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
