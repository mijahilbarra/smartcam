import { acquireFrame, uploadDiagnosticSnapshot } from "./pipeline/acquisition_step.js";
import { acquireClearFrame, enrichCropsWithClearStream } from "./pipeline/clear_stream_step.js";
import { detectScene } from "./pipeline/detection_step.js";
import { trackEntities, matchIdentitiesToTracks } from "./pipeline/tracking_step.js";
import { extractClientCrops, reidentifyPeople } from "./pipeline/biometrics_step.js";
import { updateVisits } from "./pipeline/visits_step.js";
import { computeOccupancy } from "./pipeline/occupancy_step.js";
import { broadcastTelemetry } from "./pipeline/telemetry_step.js";
import { persistCycleData } from "./pipeline/persistence_step.js";

// Re-exportar funciones para preservar 100% de compatibilidad hacia atrás
export {
  acquireFrame,
  uploadDiagnosticSnapshot,
  acquireClearFrame,
  enrichCropsWithClearStream,
  detectScene,
  trackEntities,
  matchIdentitiesToTracks,
  extractClientCrops,
  reidentifyPeople,
  updateVisits,
  computeOccupancy,
  broadcastTelemetry,
  persistCycleData
};

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

  // 3. Percepción e inferencia de visión local (ONNX / YOLO)
  const mlResult = await detectScene(buffer, { isRealtime });

  // 4. Seguimiento temporal y espacial de entidades (PersonTracker)
  const activeTracks = trackEntities(tracker, mlResult);

  // 4a. Emisión de telemetría de ultra baja latencia desacoplada (SSE)
  const immediateOccupancy = computeOccupancy({
    quadrants: mlResult.quadrants, identifiedPeople: [], rawDetections: mlResult.rawDetections
  });
  broadcastTelemetry({
    docId, mlResult, activeTracks, identifiedPeople: [], occupancy: immediateOccupancy
  });

  // 4b. Enriquecimiento reactivo de recortes con Stream Clear de alta resolución
  await enrichCropsWithClearStream({
    activeTracks, mlResult, options, context, docId, localOutputPath
  });

  // 5. Recortes y re-identificación biométrica facial gobernada por sesión
  const activeSessions = visitService?.getActiveSessions?.() || [];
  const clientRecords = await extractClientCrops({ bucket, clientCrops: mlResult.clientCrops, docId, isManual });
  const identifiedPeople = await reidentifyPeople({
    db, clientRecords, clientCrops: mlResult.clientCrops, activeSessions, isRealtime, backgroundSync: options.backgroundSync
  });

  // 6. Asociación de identidades y caras nítidas a tracks vía IoU
  matchIdentitiesToTracks({ tracker, activeTracks, identifiedPeople });

  // 7. Gestión del ciclo de vida de visitas y sesiones en sillas
  await updateVisits({ visitService, tracker, activeTracks });

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
