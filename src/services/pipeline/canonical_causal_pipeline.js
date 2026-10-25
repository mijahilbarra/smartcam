/**
 * ⚡ PIPELINE CAUSAL CANÓNICO Y COMPONIBLE
 *
 * Fuente Única de la Verdad para:
 * 1. Canal 1: Producción en Vivo 24/7 (neolink / processes.js / visits_step.js)
 * 2. Canal 2: Simulación Rápida de Streaming (run-and-monitor.js)
 * 3. Canal 3: Fast Causal Replay (step2_causal_replay.js)
 *
 * Arquitectura lineal, desacoplada y composable paso a paso:
 * Paso 1: evaluateCropStep (Las 7 etapas canónicas de filtrado)
 * Paso 2: ingestSampleStep (Ingesta atómica en TrackBlockManager)
 * Paso 3: evaluateInactiveBlocksStep (Extracción de bloques confirmados CONFIRMED_CLIENT_BLOCK)
 * Paso 4: dispatchConfirmedBlocksStep (Despacho a VisitSessionService)
 * Paso 5: heartbeatStep (Avance de reloj virtual y vacancia de sillas)
 * Ciclo Completo: executeCausalCycle (Con soporte de hooks/callbacks entre pasos)
 * Flush: flushCausalPipeline (Cierre ordenado de bloques y sillas)
 */

import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";
import { evaluateCrop7Stages } from "./crop_filter_engine.js";

/**
 * Paso 1: Evalúa un recorte de persona a través de la Cascada Canónica de 7 Etapas.
 *
 * @param {Object} cropInput - Recorte en memoria o registro SQLite cosechado
 * @param {Object} [options]
 * @param {Array<Object>} [options.staffProfiles]
 * @param {number} [options.staffThreshold]
 * @param {number} [options.minSharpness]
 * @param {Array<string>} [options.validPoses]
 * @param {number} [options.imgHeight]
 * @returns {Object} Resultado de la evaluación con diagnóstico por etapa
 */
export function evaluateCropStep(cropInput, options = {}) {
  if (!cropInput) {
    return {
      passed: false,
      stage: 0,
      reason: "sin_recorte",
      isStanding: false,
      isStaff: false,
      staffSimilarity: 0,
      norm: null,
      faceData: null
    };
  }
  return evaluateCrop7Stages(cropInput, options);
}

/**
 * Paso 2: Ingesta una muestra atómica de track o recorte en TrackBlockManager.
 *
 * @param {Object} params
 * @param {Object} params.sample - Muestra normalizada { trackId, chairId, timestampEpoch, videoSecond, box, faceData, isStaff }
 * @param {Object} params.trackBlockManager - Instancia de TrackBlockManager
 * @returns {Object|null} Bloque activo correspondiente al trackId
 */
export function ingestSampleStep({ sample, trackBlockManager }) {
  if (!trackBlockManager || !sample || !sample.trackId) return null;

  trackBlockManager.ingestTrackSample({
    trackId: sample.trackId,
    chairId: sample.chairId,
    timestampEpoch: sample.timestampEpoch,
    videoSecond: sample.videoSecond ?? Math.round((sample.timestampEpoch || 0) / 1000),
    box: sample.box,
    faceData: sample.faceData,
    isStaff: Boolean(sample.isStaff)
  });

  return trackBlockManager.activeBlocks.get(sample.trackId) || null;
}

/**
 * Paso 3: Evalúa los bloques inactivos en TrackBlockManager y extrae aquellos que cumplen CONFIRMED_CLIENT_BLOCK.
 *
 * @param {Object} params
 * @param {Object} params.trackBlockManager - Instancia de TrackBlockManager
 * @param {number} params.timestampEpoch - Marca de tiempo actual (epoch ms)
 * @param {number} [params.inactivityTimeoutMs] - Umbral de inactividad
 * @param {Object} [params.options] - Opciones adicionales
 * @returns {Array<Object>} Lista de bloques confirmados
 */
export function evaluateInactiveBlocksStep({
  trackBlockManager,
  timestampEpoch,
  inactivityTimeoutMs,
  options = {}
}) {
  if (!trackBlockManager || !trackBlockManager.activeBlocks) return [];

  const timeoutMs = inactivityTimeoutMs ??
    options.inactivityTimeoutMs ??
    PIPELINE_CONFIG.tracking?.blockInactivityTimeoutMs ??
    20000;

  const confirmedBlocks = [];
  for (const [tId, block] of Array.from(trackBlockManager.activeBlocks.entries())) {
    if (timestampEpoch - block.lastSeenEpoch > timeoutMs) {
      const decision = trackBlockManager.evaluateAndCloseBlock(tId, timestampEpoch);
      if (decision.valid && decision.verdict === "CONFIRMED_CLIENT_BLOCK") {
        confirmedBlocks.push(decision.block);
      }
    }
  }

  return confirmedBlocks;
}

/**
 * Paso 4: Despacha bloques confirmados a VisitSessionService para formalización o consolidación.
 *
 * @param {Object} params
 * @param {Array<Object>} params.confirmedBlocks - Lista de bloques confirmados
 * @param {Object} params.visitService - Instancia de VisitSessionService
 * @param {number} [params.timestampEpoch] - Marca temporal de despacho
 * @param {Object} [params.options]
 * @returns {Promise<Array<Object>>} Atenciones/sesiones procesadas
 */
export async function dispatchConfirmedBlocksStep({
  confirmedBlocks = [],
  visitService,
  timestampEpoch,
  options = {}
}) {
  if (!visitService || !Array.isArray(confirmedBlocks) || confirmedBlocks.length === 0) {
    return [];
  }

  const dispatchedAppointments = [];
  const now = timestampEpoch ?? options.now ?? Date.now();

  for (const block of confirmedBlocks) {
    const appt = await visitService.processConfirmedBlock(block, { now });
    if (appt) {
      dispatchedAppointments.push(appt);
    }
  }

  return dispatchedAppointments;
}

/**
 * Paso 5: Avanza el reloj causal paso a paso evaluando vacancia y timeouts de sillas.
 *
 * @param {Object} params
 * @param {number} params.currentTs - Marca temporal actual (epoch ms)
 * @param {number|null} [params.lastTimestamp] - Marca temporal del cuadro anterior
 * @param {Object} params.trackBlockManager - Instancia de TrackBlockManager
 * @param {Object} params.visitService - Instancia de VisitSessionService
 * @param {Object} [params.options] - Opciones (stepIntervalMs, inactivityTimeoutMs, activeTracks, checkCurrent)
 * @returns {Promise<Array<Object>>} Atenciones formalizadas o cerradas por timeout
 */
export async function heartbeatStep({
  currentTs,
  lastTimestamp,
  trackBlockManager,
  visitService,
  options = {}
}) {
  if (!visitService) return [];

  const stepIntervalMs = options.stepIntervalMs ?? 1000;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ??
    PIPELINE_CONFIG.tracking?.blockInactivityTimeoutMs ??
    20000;

  const closedAppointments = [];

  const getActiveChairTracks = (step) => {
    if (Array.isArray(options.activeTracks) && options.activeTracks.length > 0) {
      return options.activeTracks;
    }
    const active = [];
    if (trackBlockManager && trackBlockManager.activeBlocks) {
      for (const b of trackBlockManager.activeBlocks.values()) {
        const totalFrames = (b.seatedFrames || 0) + (b.standingFrames || 0);
        const isStanding = totalFrames > 0 && ((b.standingFrames || 0) / totalFrames >= 0.65) && ((b.seatedFrames || 0) < 15);
        const isStaleNoFace = (step - b.startedAtEpoch > 45000) && ((b.anatomicalFacesCount || 0) === 0);
        if (!b.isStaffConfirmed && !isStanding && !isStaleNoFace && (step - b.lastSeenEpoch <= inactivityTimeoutMs)) {
          active.push({
            trackId: b.trackId,
            currentQuadrant: { id: b.chairId, label: b.chairId, type: "barber_chair" },
            isFormallySeated: true,
            confidence: 0.90
          });
        }
      }
    }
    return active;
  };

  // Avance en saltos de reloj virtual cuando hay un diferencial de tiempo mayor a stepIntervalMs
  if (lastTimestamp !== null && lastTimestamp !== undefined && currentTs - lastTimestamp > stepIntervalMs) {
    for (let step = lastTimestamp + stepIntervalMs; step < currentTs; step += stepIntervalMs) {
      const activeChairTracks = getActiveChairTracks(step);
      const closed = await visitService.checkChairTimeouts(step, activeChairTracks);
      if (Array.isArray(closed) && closed.length > 0) {
        closedAppointments.push(...closed);
      }
    }
  }

  // Verificación en el tiempo actual (modo streaming continuo o paso puntual)
  const shouldCheckCurrent = options.checkCurrent === true ||
    (options.checkCurrent !== false && (lastTimestamp === null || lastTimestamp === undefined));

  if (shouldCheckCurrent) {
    const activeChairTracks = getActiveChairTracks(currentTs);
    const closed = await visitService.checkChairTimeouts(currentTs, activeChairTracks);
    if (Array.isArray(closed) && closed.length > 0) {
      closedAppointments.push(...closed);
    }
  }

  return closedAppointments;
}

/**
 * Función ejecutora del ciclo causal en orden lineal estricto:
 * 1. evaluateCropStep
 *    -> Hook: hooks.onCropEvaluated(cropEvaluation, cropInput)
 * 2. ingestSampleStep
 *    -> Hook: hooks.onSampleIngested(ingestedBlock, sample)
 * 3. evaluateInactiveBlocksStep
 *    -> Hook: hooks.onInactiveBlocksEvaluated(confirmedBlocks)
 * 4. dispatchConfirmedBlocksStep
 *    -> Hook: hooks.onBlocksDispatched(dispatchedAppointments, confirmedBlocks)
 * 5. heartbeatStep
 *    -> Hook: hooks.onHeartbeatAdvanced(closedAppointments)
 *
 * @param {Object} params
 * @param {Object} [params.cropInput] - Registro cosechado o recorte de imagen
 * @param {Object} [params.sample] - Muestra normalizada para TrackBlockManager
 * @param {Object} params.trackBlockManager - Instancia de TrackBlockManager
 * @param {Object} params.visitService - Instancia de VisitSessionService
 * @param {number|null} [params.lastTimestamp] - Marca de tiempo anterior
 * @param {Object} [params.options] - Configuración adicional
 * @param {Object} [params.hooks] - Callbacks de instrumentación/acumuladores
 * @returns {Promise<Object>} Resumen del ciclo ejecutado
 */
export async function executeCausalCycle({
  cropInput = null,
  sample = null,
  trackBlockManager,
  visitService,
  lastTimestamp = null,
  options = {},
  hooks = {}
}) {
  // Paso 1: Evaluación de recorte con las 7 etapas canónicas
  const evalOptions = {
    staffProfiles: options.staffProfiles || trackBlockManager?.staffProfiles || [],
    staffThreshold: options.staffThreshold ?? trackBlockManager?.staffThreshold,
    minSharpness: options.minSharpness,
    validPoses: options.validPoses,
    imgHeight: options.imgHeight ?? trackBlockManager?.height ?? 720
  };

  const cropEvaluation = cropInput
    ? evaluateCropStep(cropInput, evalOptions)
    : null;

  if (typeof hooks.onCropEvaluated === "function") {
    hooks.onCropEvaluated(cropEvaluation, cropInput);
  } else if (typeof hooks.afterEvaluateCrop === "function") {
    hooks.afterEvaluateCrop(cropEvaluation, cropInput);
  }

  // Resolver sample normalizado
  let finalSample = null;
  if (sample) {
    let resolvedBox = sample.box;
    if (!resolvedBox && cropEvaluation?.faceData?.box) {
      resolvedBox = cropEvaluation.faceData.box;
    }
    finalSample = {
      ...sample,
      box: resolvedBox,
      faceData: sample.faceData !== undefined
        ? sample.faceData
        : (cropEvaluation?.passed ? cropEvaluation.faceData : null),
      isStaff: sample.isStaff !== undefined
        ? sample.isStaff
        : Boolean(cropEvaluation?.isStaff)
    };
  } else if (cropInput) {
    const ts = cropInput.timestampEpoch ?? cropInput.timestamp_epoch ?? Date.now();
    let box = cropInput.box;
    if (!box && cropInput.box_json) {
      try {
        box = typeof cropInput.box_json === "string" ? JSON.parse(cropInput.box_json) : cropInput.box_json;
      } catch (_) {}
    }
    finalSample = {
      trackId: cropInput.trackId ?? cropInput.track_id ?? 1,
      chairId: cropInput.chairId ?? cropInput.chair_id,
      timestampEpoch: ts,
      videoSecond: cropInput.videoSecond ?? cropInput.video_second ?? Math.round(ts / 1000),
      box: box || cropEvaluation?.faceData?.box,
      faceData: cropEvaluation?.passed ? cropEvaluation.faceData : null,
      isStaff: Boolean(cropEvaluation?.isStaff)
    };
  }

  // Paso 2: Ingesta atómica en TrackBlockManager
  let ingestedBlock = null;
  if (finalSample && trackBlockManager) {
    ingestedBlock = ingestSampleStep({ sample: finalSample, trackBlockManager });
  }

  if (typeof hooks.onSampleIngested === "function") {
    hooks.onSampleIngested(ingestedBlock, finalSample);
  } else if (typeof hooks.afterIngestSample === "function") {
    hooks.afterIngestSample(ingestedBlock, finalSample);
  }

  // Paso 3: Evaluación de bloques inactivos
  const currentTs = finalSample?.timestampEpoch ?? options.currentTs ?? Date.now();
  const confirmedBlocks = trackBlockManager
    ? evaluateInactiveBlocksStep({
        trackBlockManager,
        timestampEpoch: currentTs,
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        options
      })
    : [];

  if (typeof hooks.onInactiveBlocksEvaluated === "function") {
    hooks.onInactiveBlocksEvaluated(confirmedBlocks);
  } else if (typeof hooks.afterEvaluateInactiveBlocks === "function") {
    hooks.afterEvaluateInactiveBlocks(confirmedBlocks);
  }

  // Paso 4: Despacho de bloques confirmados a VisitSessionService
  const dispatchedAppointments = (visitService && confirmedBlocks.length > 0)
    ? await dispatchConfirmedBlocksStep({
        confirmedBlocks,
        visitService,
        timestampEpoch: currentTs,
        options
      })
    : [];

  if (typeof hooks.onBlocksDispatched === "function") {
    hooks.onBlocksDispatched(dispatchedAppointments, confirmedBlocks);
  } else if (typeof hooks.afterDispatchBlocks === "function") {
    hooks.afterDispatchBlocks(dispatchedAppointments, confirmedBlocks);
  }

  // Paso 5: Avance de reloj causal (Heartbeat) y timeouts de vacancia
  const closedAppointments = (visitService && trackBlockManager)
    ? await heartbeatStep({
        currentTs,
        lastTimestamp,
        trackBlockManager,
        visitService,
        options
      })
    : [];

  if (typeof hooks.onHeartbeatAdvanced === "function") {
    hooks.onHeartbeatAdvanced(closedAppointments);
  } else if (typeof hooks.afterHeartbeat === "function") {
    hooks.afterHeartbeat(closedAppointments);
  }

  return {
    cropEvaluation,
    sample: finalSample,
    ingestedBlock,
    confirmedBlocks,
    dispatchedAppointments,
    closedAppointments
  };
}

/**
 * Finaliza de manera ordenada todos los bloques y sillas al término del stream o video.
 *
 * @param {Object} params
 * @param {number} params.lastTimestamp - Última marca temporal procesada
 * @param {Object} params.trackBlockManager - Instancia de TrackBlockManager
 * @param {Object} params.visitService - Instancia de VisitSessionService
 * @param {Object} [params.options] - Opciones (emptyChairTimeoutMs)
 * @returns {Promise<void>}
 */
export async function flushCausalPipeline({
  lastTimestamp,
  trackBlockManager,
  visitService,
  options = {}
}) {
  if (!visitService || !trackBlockManager) return;

  const emptyChairTimeoutMs = options.emptyChairTimeoutMs ??
    PIPELINE_CONFIG.sessions?.emptyChairTimeoutMs ??
    45000;

  // 1. Cerrar todos los bloques activos en TrackBlockManager
  for (const [tId, block] of Array.from(trackBlockManager.activeBlocks.entries())) {
    const decision = trackBlockManager.evaluateAndCloseBlock(tId, lastTimestamp);
    if (decision.valid && decision.verdict === "CONFIRMED_CLIENT_BLOCK") {
      await visitService.processConfirmedBlock(decision.block, { now: lastTimestamp });
    }
  }

  // 2. Forzar avance de reloj para timeout y cierre ordenado de sillas
  if (lastTimestamp !== null && lastTimestamp !== undefined) {
    const finalStep = lastTimestamp + emptyChairTimeoutMs + 1000;
    await visitService.checkChairTimeouts(finalStep, []);
    for (const [chairOrTrack] of Array.from(visitService.activeSessions.entries())) {
      await visitService.closeSession(chairOrTrack, { endedAtEpoch: lastTimestamp });
    }
  }
}
