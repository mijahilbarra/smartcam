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
  heartbeatStep,
  executeCausalCycle
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
  if (blockMgr) {
    const knownProfiles = visitService?.customerService?.getComparisonProfiles?.() || [];
    const staff = knownProfiles.filter(p => p.isStaff || p.role === "barber" || String(p.id).startsWith("staff_"));
    if (staff.length > 0) {
      blockMgr.staffProfiles = staff;
    }
  }
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

    // 1. Ingestar muestras de tracks activos en sillas mediante la estructura canónica compartida con step2_causal_replay
    const chairTracks = [];
    for (const track of activeTracks) {
      if (!track.trackId) continue;
      const existingBlock = blockMgr.activeBlocks?.get(track.trackId);
      const isChair = track.currentQuadrant?.type === "barber_chair" ||
        Boolean(existingBlock && track.box && track.box[3] >= 580);
      if (!isChair) continue;
      chairTracks.push({ track, existingBlock });
    }

    if (chairTracks.length > 0) {
      for (let i = 0; i < chairTracks.length; i++) {
        const { track, existingBlock } = chairTracks[i];
        const isLastChairTrack = i === chairTracks.length - 1;
        const chairId = track.currentQuadrant?.type === "barber_chair"
          ? track.currentQuadrant.id
          : existingBlock.chairId;

        // CERO STALE FACE LEAK: NUNCA hacer fallback perpetuo a bestFace (evita re-inyección en bucle)
        const face = track.latestFace || null;
        if (face) {
          cycleMetrics.faceDetected++;
          track.latestFace = null;
        }

        const cropInput = face ? { ...face, box: track.box, chairId } : null;

        const cycleRes = await executeCausalCycle({
          cropInput,
          sample: {
            trackId: track.trackId,
            chairId,
            timestampEpoch: currentNow,
            videoSecond: Math.round(currentNow / 1000),
            box: track.box
          },
          trackBlockManager: blockMgr,
          visitService: isLastChairTrack ? visitService : null,
          lastTimestamp: isLastChairTrack ? (visitService._lastHeartbeatTs ?? null) : null,
          options: {
            staffProfiles: blockMgr.staffProfiles || [],
            staffThreshold: blockMgr.staffThreshold,
            activeTracks,
            checkCurrent: true
          },
          hooks: {
            onCropEvaluated: (evalRes) => {
              if (!evalRes) return;
              if (!evalRes.passed && process.env.DEBUG_CROP_EVAL === "true") {
                console.log(`[CropEval] Track #${track.trackId} ${chairId} rechazado etapa ${evalRes.stage}: ${evalRes.reason}`);
              }
              if (evalRes.stage >= 3) cycleMetrics.antiObjects++;
              if (evalRes.stage >= 4) cycleMetrics.sharpness++;
              if (evalRes.stage >= 5) cycleMetrics.validPoses++;
              if (evalRes.faceData?.isUpright) cycleMetrics.upright++;
              else if (evalRes.stage >= 6) cycleMetrics.reclined++;
              if (evalRes.isStaff || evalRes.isStanding) cycleMetrics.staffExcluded++;
              if (evalRes.passed) cycleMetrics.clientPassed++;
            }
          }
        });

        if (cycleRes.confirmedBlocks && cycleRes.confirmedBlocks.length > 0) {
          confirmedBlocks.push(...cycleRes.confirmedBlocks);
          if (!isLastChairTrack) {
            await dispatchConfirmedBlocksStep({
              confirmedBlocks: cycleRes.confirmedBlocks,
              visitService,
              timestampEpoch: currentNow
            });
          }
        }
      }
      cycleMetrics.confirmedBlocks = confirmedBlocks.length;
      visitService._lastHeartbeatTs = currentNow;
    } else {
      // Sin tracks en silla en este cuadro: evaluar cierre de bloques inactivos y avanzar heartbeat causal
      const cycleRes = await executeCausalCycle({
        cropInput: null,
        sample: null,
        trackBlockManager: blockMgr,
        visitService,
        lastTimestamp: visitService._lastHeartbeatTs ?? null,
        options: {
          currentTs: currentNow,
          activeTracks,
          checkCurrent: true
        }
      });
      confirmedBlocks = cycleRes.confirmedBlocks || [];
      cycleMetrics.confirmedBlocks = confirmedBlocks.length;
      visitService._lastHeartbeatTs = currentNow;
    }
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
