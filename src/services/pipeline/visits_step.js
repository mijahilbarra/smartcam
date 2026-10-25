/**
 * 7. Gestión del ciclo de vida de sesiones de visita (apertura, actualización y cierre).
 * Integra TrackBlockManager para ingesta atómica y resolución de bloques por trackId.
 * Utiliza los pasos composables desacoplados de canonical_causal_pipeline.js.
 */

import { TrackBlockManager } from "./track_block_manager.js";
import {
  evaluateCropStep,
  ingestSampleStep,
  evaluateInactiveBlocksStep,
  dispatchConfirmedBlocksStep,
  heartbeatStep
} from "./canonical_causal_pipeline.js";

/**
 * Actualiza el ciclo de vida de visitas y bloques en sillas
 * @param {Object} params
 * @param {Object} params.visitService
 * @param {Object} params.tracker
 * @param {Array<Object>} [params.activeTracks=[]]
 * @param {number} [params.now]
 * @param {TrackBlockManager} [params.trackBlockManager]
 */
export async function updateVisits({
  visitService,
  tracker,
  activeTracks = [],
  now,
  trackBlockManager = null
}) {
  if (!visitService) return;

  const currentNow = now || (typeof visitService.getNow === "function" ? visitService.getNow() : Date.now());

  // Resolver o inicializar TrackBlockManager
  const blockMgr = trackBlockManager || visitService.trackBlockManager;
  let cycleMetrics = null;
  let confirmedBlocks = [];

  if (blockMgr) {
    cycleMetrics = {
      harvested: activeTracks.length,
      faceDetected: 0,
      antiObjects: 0,
      sharpness: 0,
      validPoses: 0,
      upright: 0,
      reclined: 0,
      staffExcluded: 0,
      clientPassed: 0,
      confirmedBlocks: 0
    };

    // 1. Ingestar muestras de tracks activos en sillas mediante los pasos canónicos
    for (const track of activeTracks) {
      if (!track.trackId) continue;
      const isChair = track.currentQuadrant?.type === "barber_chair";
      if (!isChair) continue;

      const chairId = track.currentQuadrant.id;
      // CERO STALE FACE LEAK: NUNCA hacer fallback perpetuo a bestFace (evita re-inyección en bucle)
      const face = track.latestFace || null;
      let faceData = null;
      let isStaff = Boolean(track.isStaffHint === true || track.role === "staff" || track.identity?.isStaff === true);

      if (face) {
        cycleMetrics.faceDetected++;
        // Pasar la caja completa del cuerpo (track.box) junto a los datos faciales
        const cropInput = { ...face, box: track.box };
        const evalRes = evaluateCropStep(cropInput, {
          staffProfiles: blockMgr.staffProfiles || [],
          staffThreshold: blockMgr.staffThreshold
        });

        if (evalRes.stage >= 3) cycleMetrics.antiObjects++;
        if (evalRes.stage >= 4) cycleMetrics.sharpness++;
        if (evalRes.stage >= 5) cycleMetrics.validPoses++;
        if (evalRes.faceData?.isUpright) cycleMetrics.upright++;
        else if (evalRes.stage >= 6) cycleMetrics.reclined++;
        if (evalRes.isStaff || evalRes.isStanding) cycleMetrics.staffExcluded++;

        if (evalRes.passed) {
          cycleMetrics.clientPassed++;
          faceData = evalRes.faceData;
        }
        if (evalRes.isStaff) {
          isStaff = true;
        }

        // Limpiar latestFace tras evaluarlo para asegurar evaluación fresca en el siguiente cuadro
        track.latestFace = null;
      }

      ingestSampleStep({
        sample: {
          trackId: track.trackId,
          chairId,
          timestampEpoch: currentNow,
          videoSecond: Math.round(currentNow / 1000),
          box: track.box,
          faceData,
          isStaff
        },
        trackBlockManager: blockMgr
      });
    }

    // 2. Evaluar cierre de bloques inactivos
    confirmedBlocks = evaluateInactiveBlocksStep({
      trackBlockManager: blockMgr,
      timestampEpoch: currentNow
    });
    cycleMetrics.confirmedBlocks = confirmedBlocks.length;

    // 3. Despachar bloques confirmados
    if (confirmedBlocks.length > 0) {
      await dispatchConfirmedBlocksStep({
        confirmedBlocks,
        visitService,
        timestampEpoch: currentNow
      });
    }

    // 4. Heartbeat de vacancia y chequeo de sillas (con checkCurrent activo para streaming continuo)
    await heartbeatStep({
      currentTs: currentNow,
      lastTimestamp: visitService._lastHeartbeatTs ?? null,
      trackBlockManager: blockMgr,
      visitService,
      options: { activeTracks, checkCurrent: true }
    });
    visitService._lastHeartbeatTs = currentNow;
  } else {
    // Fallback de compatibilidad para suites de prueba sin TrackBlockManager
    for (const track of activeTracks) {
      await visitService.processTrack(track, { now: currentNow });
    }
    if (typeof visitService.checkChairTimeouts === "function") {
      await visitService.checkChairTimeouts(currentNow, activeTracks);
    }
  }

  if (tracker?.historyTracks) {
    if (!blockMgr) {
      for (const lostTrack of tracker.historyTracks) {
        await visitService.closeSession(lostTrack.trackId);
      }
    }
    tracker.historyTracks = [];
  }

  return {
    confirmedBlocks,
    cycleMetrics
  };
}

export const STEP_NAME = "Gestión del Ciclo de Vida de Visitas y Citas";
export const STEP_DESCRIPTION = (timeoutSec = 45) =>
  `Gestión temporal del ciclo de vida de visitas con TrackBlockManager atómico y consolidación causal.`;
export const formatStepSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `7. **${STEP_NAME}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`;
