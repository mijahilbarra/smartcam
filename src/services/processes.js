import {
  acquireFrame,
  uploadDiagnosticSnapshot,
  STEP_NAME as STEP_ACQUISITION_NAME,
  STEP_DESCRIPTION as ACQUISITION_DESCRIPTION,
  formatStepSummary as formatAcquisitionSummary
} from "./pipeline/acquisition_step.js";
import {
  acquireClearFrame,
  enrichCropsWithClearStream,
  STEP_NAME as STEP_CLEAR_STREAM_NAME,
  STEP_DESCRIPTION as CLEAR_STREAM_DESCRIPTION,
  formatStepSummary as formatClearStreamSummary
} from "./pipeline/clear_stream_step.js";
import {
  detectScene,
  STEP_NAME as STEP_DETECTION_NAME,
  STEP_DESCRIPTION as DETECTION_DESCRIPTION,
  formatStepSummary as formatDetectionSummary
} from "./pipeline/detection_step.js";
import {
  trackEntities,
  matchIdentitiesToTracks,
  isStandingPosture,
  STEP_NAME as STEP_TRACKING_NAME,
  STEP_DESCRIPTION as TRACKING_DESCRIPTION,
  formatStepSummary as formatTrackingSummary
} from "./pipeline/tracking_step.js";
import {
  extractClientCrops,
  reidentifyPeople,
  evaluateFaceQuality,
  validateHumanSkinAndTexture,
  matchStaffFace,
  VALID_CLIENT_FACE_POSES,
  STEP_SKIN_TEXTURE_NAME,
  SKIN_TEXTURE_DESCRIPTION,
  formatSkinTextureSummary,
  STEP_ANTI_OBJECT_NAME,
  ANTI_OBJECT_DESCRIPTION,
  formatAntiObjectSummary,
  STEP_SHARPNESS_NAME,
  SHARPNESS_DESCRIPTION,
  formatSharpnessSummary,
  STEP_VALID_POSE_NAME,
  VALID_POSE_DESCRIPTION,
  formatValidPoseSummary,
  STEP_ANATOMICAL_CLASS_NAME,
  ANATOMICAL_CLASS_DESCRIPTION,
  formatAnatomicalClassSummary,
  STEP_SHARPNESS_POSE_NAME,
  SHARPNESS_POSE_DESCRIPTION,
  formatSharpnessPoseSummary,
  STEP_STAFF_FILTER_NAME,
  STAFF_FILTER_DESCRIPTION,
  formatStaffFilterSummary
} from "./pipeline/biometrics_step.js";
import {
  updateVisits,
  STEP_NAME as STEP_VISITS_NAME,
  STEP_DESCRIPTION as VISITS_DESCRIPTION,
  formatStepSummary as formatVisitsSummary
} from "./pipeline/visits_step.js";
import {
  computeOccupancy,
  STEP_NAME as STEP_OCCUPANCY_NAME,
  STEP_DESCRIPTION as OCCUPANCY_DESCRIPTION,
  formatStepSummary as formatOccupancySummary
} from "./pipeline/occupancy_step.js";
import {
  broadcastTelemetry,
  STEP_NAME as STEP_TELEMETRY_NAME,
  STEP_DESCRIPTION as TELEMETRY_DESCRIPTION,
  formatStepSummary as formatTelemetrySummary
} from "./pipeline/telemetry_step.js";
import {
  persistCycleData,
  STEP_NAME as STEP_PERSISTENCE_NAME,
  STEP_DESCRIPTION as PERSISTENCE_DESCRIPTION,
  formatStepSummary as formatPersistenceSummary
} from "./pipeline/persistence_step.js";

// Re-exportar funciones y metadatos de pipeline para acceso unificado sin duplicación
export {
  acquireFrame,
  uploadDiagnosticSnapshot,
  STEP_ACQUISITION_NAME,
  ACQUISITION_DESCRIPTION,
  formatAcquisitionSummary,

  acquireClearFrame,
  enrichCropsWithClearStream,
  STEP_CLEAR_STREAM_NAME,
  CLEAR_STREAM_DESCRIPTION,
  formatClearStreamSummary,

  detectScene,
  STEP_DETECTION_NAME,
  DETECTION_DESCRIPTION,
  formatDetectionSummary,

  trackEntities,
  matchIdentitiesToTracks,
  isStandingPosture,
  STEP_TRACKING_NAME,
  TRACKING_DESCRIPTION,
  formatTrackingSummary,

  extractClientCrops,
  reidentifyPeople,
  evaluateFaceQuality,
  validateHumanSkinAndTexture,
  matchStaffFace,
  VALID_CLIENT_FACE_POSES,
  STEP_SKIN_TEXTURE_NAME,
  SKIN_TEXTURE_DESCRIPTION,
  formatSkinTextureSummary,
  STEP_ANTI_OBJECT_NAME,
  ANTI_OBJECT_DESCRIPTION,
  formatAntiObjectSummary,
  STEP_SHARPNESS_NAME,
  SHARPNESS_DESCRIPTION,
  formatSharpnessSummary,
  STEP_VALID_POSE_NAME,
  VALID_POSE_DESCRIPTION,
  formatValidPoseSummary,
  STEP_ANATOMICAL_CLASS_NAME,
  ANATOMICAL_CLASS_DESCRIPTION,
  formatAnatomicalClassSummary,
  STEP_SHARPNESS_POSE_NAME,
  SHARPNESS_POSE_DESCRIPTION,
  formatSharpnessPoseSummary,
  STEP_STAFF_FILTER_NAME,
  STAFF_FILTER_DESCRIPTION,
  formatStaffFilterSummary,

  updateVisits,
  STEP_VISITS_NAME,
  VISITS_DESCRIPTION,
  formatVisitsSummary,

  computeOccupancy,
  STEP_OCCUPANCY_NAME,
  OCCUPANCY_DESCRIPTION,
  formatOccupancySummary,

  broadcastTelemetry,
  STEP_TELEMETRY_NAME,
  TELEMETRY_DESCRIPTION,
  formatTelemetrySummary,

  persistCycleData,
  STEP_PERSISTENCE_NAME,
  PERSISTENCE_DESCRIPTION,
  formatPersistenceSummary
};

export { analyzeCapeState, trackCapeLifecycle, isCapeBarrierSeparating, CAPE_STATES } from "./pipeline/cape_detector.js";

/**
 * Pipeline principal de ejecución: orquesta el flujo paso a paso
 * de manera lineal, limpia y declarativa (< 90 líneas).
 *
 * @param {Object} context - Dependencias del ciclo (db, bucket, tracker, visitService, streamServer, tomlPath)
 * @param {Object} options - Parámetros del ciclo (triggerSource: 'realtime' | 'manual' | 'startup')
 * @returns {Promise<Object>} Resultado del ciclo
 */
export async function runProcessCycle(context = {}, options = {}) {
  const {
    db, bucket, tomlPath, streamServer, tracker, visitService, localOutputPath
  } = context;

  const triggerSource = options.triggerSource || "manual";
  const isRealtime = triggerSource === "realtime";
  const isManual = !isRealtime;
  const timestamp = Date.now();
  const docId = `photo_${timestamp}`;

  // 1. Adquisición del fotograma (RAM 0ms en realtime o P2P Neolink adaptativo)
  const buffer = await acquireFrame({
    streamServer, tomlPath, docId, isRealtime, triggerSource, localOutputPath
  });
  if (!buffer) return { status: "waiting_for_frame" };

  // 2. Subida diagnóstica a Firebase Storage (solo manual / arranque)
  const storagePath = await uploadDiagnosticSnapshot({ bucket, docId, buffer, isManual });

  const virtualNow = typeof visitService?.getNow === "function"
    ? visitService.getNow()
    : (typeof streamServer?.getVirtualNow === "function" ? streamServer.getVirtualNow() : Date.now());

  // 3. Percepción e inferencia de visión local (ONNX / YOLO)
  const mlResult = await detectScene(buffer, { isRealtime });

  // 4. Seguimiento temporal y espacial de entidades (PersonTracker)
  const activeTracks = trackEntities(tracker, mlResult, virtualNow);

  // 4a. Emisión de telemetría de ultra baja latencia desacoplada (SSE)
  const immediateOccupancy = computeOccupancy({
    quadrants: mlResult.quadrants, identifiedPeople: [], rawDetections: mlResult.rawDetections
  });
  broadcastTelemetry({
    docId, mlResult, activeTracks, identifiedPeople: null, occupancy: immediateOccupancy
  });

  // 4b. Enriquecimiento reactivo de recortes con Stream Clear de alta resolución
  await enrichCropsWithClearStream({
    activeTracks, mlResult, options, context, docId, localOutputPath
  });

  // 5. Recortes y re-identificación biométrica facial gobernada por sesión
  const activeSessions = visitService?.getActiveSessions?.() || [];
  const clientRecords = await extractClientCrops({ bucket, clientCrops: mlResult.clientCrops, docId, isManual });
  const identifiedPeople = await reidentifyPeople({
    db, clientRecords, clientCrops: mlResult.clientCrops, activeSessions, isRealtime, backgroundSync: options.backgroundSync, nowEpoch: virtualNow
  });

  // 6. Asociación de identidades y caras nítidas a tracks vía IoU
  matchIdentitiesToTracks({ tracker, activeTracks, identifiedPeople, now: virtualNow });

  // 7. Gestión del ciclo de vida de visitas y sesiones en sillas
  await updateVisits({ visitService, tracker, activeTracks, now: virtualNow });

  // 8. Cálculo dinámico de métricas de ocupación
  const occupancy = computeOccupancy({
    quadrants: mlResult.quadrants, identifiedPeople, rawDetections: mlResult.rawDetections
  });

  // 9. Emisión de telemetría enriquecida en tiempo real por SSE
  broadcastTelemetry({ docId, mlResult, activeTracks, identifiedPeople, occupancy });

  // 10. Persistencia atómica y reporte de estado (SSE / Firestore)
  return await persistCycleData({
    db, docId, timestamp, storagePath, clientRecords, identifiedPeople,
    mlResult, visitService, activeTracks, occupancy, isRealtime
  });
}
