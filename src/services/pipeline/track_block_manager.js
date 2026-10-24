/**
 * Gestor del Ciclo de Vida de Bloques por TrackId (TrackBlockManager)
 *
 * Implementa la arquitectura atómica centrada en Tracklets propuesta por el usuario:
 * 1. La unidad atómica de seguimiento es el trackId de YOLO.
 * 2. Durante la vida del trackId se acumulan muestras, poses, centroides y postura (sentado vs de pie).
 * 3. Al finalizar o desaparecer el trackId, se toma UNA SOLA DECISIÓN ATÓMICA sobre el bloque:
 *    - ¿Es el barbero de pie o limpiando? -> DESCARTAR BLOQUE COMPLETO.
 *    - ¿Es una nuca / falso positivo sin dos ojos ni rostro anatómico? -> DESCARTAR BLOQUE COMPLETO.
 *    - ¿Es ruido efímero (< 90s sin servicio real)? -> DESCARTAR BLOQUE COMPLETO.
 *    - ¿Es un cliente humano genuino en silla? -> CONFIRMAR BLOQUE para resolución de atención.
 */

import { computeCosineSimilarity } from "../../face_recognizer.js";
import { isStandingPosture } from "../../core/geometry.js";

export class TrackBlockManager {
  constructor(options = {}) {
    this.staffProfiles = options.staffProfiles || [];
    this.staffThreshold = options.staffThreshold ?? 0.46;
    this.activeBlocks = new Map(); // trackId -> BlockData
    this.completedBlocks = [];
    this.onBlockDecided = options.onBlockDecided || null;
  }

  /**
   * Registra una muestra entrante asociada a un trackId en la silla.
   * @param {Object} params
   * @param {number} params.trackId
   * @param {string} params.chairId
   * @param {number} params.timestampEpoch
   * @param {number} params.videoSecond
   * @param {Array<number>} params.box [x1, y1, x2, y2]
   * @param {Object} [params.faceData]
   * @param {boolean} [params.isStaff]
   */
  ingestTrackSample({
    trackId,
    chairId,
    timestampEpoch,
    videoSecond,
    box,
    faceData = null,
    isStaff = false
  }) {
    if (!trackId) return;

    let block = this.activeBlocks.get(trackId);
    if (!block) {
      block = {
        trackId,
        chairId,
        startedAtEpoch: timestampEpoch,
        lastSeenEpoch: timestampEpoch,
        startVideoSecond: videoSecond,
        lastVideoSecond: videoSecond,
        totalFrames: 0,
        standingFrames: 0,
        seatedFrames: 0,
        crops: [],
        photos: [],
        embeddings: [],
        anatomicalFacesCount: 0,
        bestFaceScore: 0,
        bestFaceThumbnail: null,
        bestAnatomicalFace: null,
        maxStaffSim: 0,
        isStaffConfirmed: isStaff
      };
      this.activeBlocks.set(trackId, block);
    }

    block.lastSeenEpoch = timestampEpoch;
    block.lastVideoSecond = videoSecond;
    block.totalFrames++;

    const standing = box ? isStandingPosture(box) : false;
    if (standing) {
      block.standingFrames++;
    } else {
      block.seatedFrames++;
    }

    if (faceData && faceData.vector) {
      block.crops.push({
        timestampEpoch,
        videoSecond,
        box,
        faceData
      });

      // Verificar si es rostro anatómico genuino (tiene 2 ojos visibles y pose erguida/semi-perfil)
      const hasTwoEyes = faceData.hasTwoEyes !== undefined
        ? Boolean(faceData.hasTwoEyes)
        : (faceData.landmarks && Array.isArray(faceData.landmarks) && faceData.landmarks.length >= 5);

      const isAnatomicalPose = ['frontal', 'semi_left', 'semi_right', 'tilted_up', 'tilted_up_left', 'tilted_up_right'].includes(faceData.pose);
      const isAnatomical = hasTwoEyes && isAnatomicalPose;

      if (isAnatomical) {
        block.anatomicalFacesCount++;
        if ((faceData.sharpnessScore || 0) > (block.bestAnatomicalFace?.sharpnessScore || 0)) {
          block.bestAnatomicalFace = faceData;
        }
      }

      if ((faceData.sharpnessScore || 0) > block.bestFaceScore) {
        block.bestFaceScore = faceData.sharpnessScore || 0;
        block.bestFaceThumbnail = faceData.thumbnailBase64 || null;
      }

      // Evaluar similitud con staff conocido
      if (this.staffProfiles.length > 0 && faceData.vector) {
        for (const staff of this.staffProfiles) {
          const sVec = staff.embedding || staff.vector;
          if (sVec) {
            const sim = computeCosineSimilarity(faceData.vector, sVec);
            if (sim > block.maxStaffSim) {
              block.maxStaffSim = sim;
            }
          }
        }
      }

      block.embeddings.push(faceData.vector);
      if (faceData.thumbnailBase64) {
        block.photos.push({
          thumbnailBase64: faceData.thumbnailBase64,
          sharpnessScore: faceData.sharpnessScore,
          pose: faceData.pose,
          landmarks: faceData.landmarks,
          hasTwoEyes,
          isAnatomical
        });
      }
    }
  }

  /**
   * Finaliza y evalúa atómicamente el bloque de un trackId al salir de la escena o terminar.
   * @param {number} trackId
   * @param {number} nowEpoch
   * @returns {{ valid: boolean, verdict: string, reason: string, block: Object|null }}
   */
  evaluateAndCloseBlock(trackId, nowEpoch = Date.now()) {
    const block = this.activeBlocks.get(trackId);
    if (!block) return { valid: false, verdict: "NOT_FOUND", reason: "TrackId no registrado", block: null };

    this.activeBlocks.delete(trackId);

    const durationMs = Math.max(0, block.lastSeenEpoch - block.startedAtEpoch);
    const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
    const durationSeconds = Math.round(durationMs / 1000);

    const standingRatio = block.totalFrames > 0 ? (block.standingFrames / block.totalFrames) : 0;

    // 1. FILTRO DE BARBERO / PERSONAL DE PIE
    // Si estuvo predominantemente de pie (standingRatio > 0.60) sin sentarse formalmente,
    // o su rostro promedio coincide con el personal conocido
    if (block.isStaffConfirmed || block.maxStaffSim >= this.staffThreshold) {
      const decision = {
        valid: false,
        verdict: "DISCARDED_BARBER",
        reason: `Coincidencia biométrica con personal (${block.maxStaffSim.toFixed(3)} >= ${this.staffThreshold})`,
        block: { ...block, durationMinutes, durationSeconds }
      };
      this._emitDecision(decision);
      return decision;
    }

    if (standingRatio >= 0.65 && block.seatedFrames < 15) {
      const decision = {
        valid: false,
        verdict: "DISCARDED_BARBER_STANDING",
        reason: `Postura de pie detectada (${(standingRatio * 100).toFixed(0)}% frames de pie, solo ${block.seatedFrames} sentado)`,
        block: { ...block, durationMinutes, durationSeconds }
      };
      this._emitDecision(decision);
      return decision;
    }

    // 2. FILTRO DE INTEGRIDAD ANATÓMICA (ANTI-NUCA / ANTI-FALSO POSITIVO)
    // Para que un bloque sea un servicio humano real, DEBE tener al menos 1 rostro anatómico genuino
    // con dos ojos visibles y pose válida. Las nucas con clipper/peine no tienen 2 ojos ni pose erguida.
    if (block.crops.length > 0 && block.anatomicalFacesCount === 0) {
      const decision = {
        valid: false,
        verdict: "DISCARDED_NO_ANATOMICAL_FACE",
        reason: `Cero rostros anatómicos con dos ojos visibles en ${block.crops.length} fotos (falso positivo de nuca/pelo)`,
        block: { ...block, durationMinutes, durationSeconds }
      };
      this._emitDecision(decision);
      return decision;
    }

    // 3. FILTRO DE EFIMERIDAD / PASO RÁPIDO
    // Si dura menos de 90 segundos y tiene menos de 4 fotos válidas, es un paso rápido o limpieza de silla
    if (durationSeconds < 90 && block.crops.length < 5) {
      const decision = {
        valid: false,
        verdict: "DISCARDED_EPHEMERAL_PASSING",
        reason: `Estancia efímera (${durationSeconds}s, ${block.crops.length} fotos)`,
        block: { ...block, durationMinutes, durationSeconds }
      };
      this._emitDecision(decision);
      return decision;
    }

    // 4. BLOQUE HUMANO VÁLIDO EN SILLA
    const confirmedBlock = {
      ...block,
      durationMinutes,
      durationSeconds,
      valid: true
    };
    this.completedBlocks.push(confirmedBlock);

    const decision = {
      valid: true,
      verdict: "CONFIRMED_CLIENT_BLOCK",
      reason: `Cliente humano confirmado en silla (${durationMinutes} min, ${block.anatomicalFacesCount} rostros anatómicos)`,
      block: confirmedBlock
    };
    this._emitDecision(decision);
    return decision;
  }

  _emitDecision(decision) {
    if (typeof this.onBlockDecided === "function") {
      try {
        this.onBlockDecided(decision);
      } catch (err) {
        console.warn("[TrackBlockManager] Error en callback onBlockDecided:", err.message);
      }
    }
  }
}
