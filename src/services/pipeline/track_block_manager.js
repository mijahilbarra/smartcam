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
import { resolveChairZone, validateSpatialChairAnchor } from "./closure_rules.js";
import { computeBoxInsideChairRatio } from "../../core/barbershop_rules.js";

export class TrackBlockManager {
  constructor(options = {}) {
    this.staffProfiles = options.staffProfiles || [];
    this.staffThreshold = options.staffThreshold ?? 0.46;
    this.quadrants = options.quadrants || null;
    this.width = options.width || 1280;
    this.height = options.height || 720;
    this.activeBlocks = new Map(); // trackId -> BlockData
    this.completedBlocks = [];
    this.totalConfirmedBlocksCount = 0;
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

    // Validación de solapamiento espacial con la silla asignada:
    // Si la muestra tiene box con insideRatio < 0.50, no acumularla en la silla (es acompañante en sofá o transeúnte)
    if (box && chairId) {
      let parsedBox = box;
      if (typeof box === "string") {
        try { parsedBox = JSON.parse(box); } catch (_) {}
      }
      if (Array.isArray(parsedBox) && parsedBox.length >= 4) {
        const chairZone = resolveChairZone(chairId, this.quadrants);
        if (chairZone) {
          const ratio = computeBoxInsideChairRatio(parsedBox, chairZone, this.width, this.height);
          if (ratio < 0.50) {
            return;
          }
        }
      }
    }

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
        boxes: [],
        anatomicalFacesCount: 0,
        bestFaceScore: 0,
        bestFaceThumbnail: null,
        bestAnatomicalFace: null,
        maxStaffSim: 0,
        staffFacesCount: 0,
        clientFacesCount: 0,
        isStaffConfirmed: isStaff
      };
      this.activeBlocks.set(trackId, block);
    }

    block.lastSeenEpoch = timestampEpoch;
    block.lastVideoSecond = videoSecond;
    block.totalFrames++;

    if (box && Array.isArray(box) && box.length >= 4) {
      if (!block.boxes) block.boxes = [];
      if (block.boxes.length < 100) {
        block.boxes.push(box);
      }
    }

    const standing = box ? isStandingPosture(box) : false;
    if (standing) {
      block.standingFrames++;
    } else {
      block.seatedFrames++;
    }

    if (faceData && faceData.vector) {
      // Verificar si es rostro anatómico genuino (tiene 2 ojos visibles y pose erguida/semi-perfil)
      const hasTwoEyes = faceData.hasTwoEyes !== undefined
        ? Boolean(faceData.hasTwoEyes)
        : (faceData.landmarks && Array.isArray(faceData.landmarks) && faceData.landmarks.length >= 5);

      const isAnatomicalPose = ['frontal', 'semi_left', 'semi_right', 'profile_left', 'profile_right', 'tilted_down', 'tilted_down_left', 'tilted_down_right', 'tilted_up', 'tilted_up_left', 'tilted_up_right'].includes(faceData.pose);
      const isAnatomical = hasTwoEyes || (faceData.landmarks && Array.isArray(faceData.landmarks) && faceData.landmarks.length >= 5 && isAnatomicalPose);

      // Evaluar similitud con staff conocido para esta muestra puntual
      let sampleStaffSim = 0;
      if (this.staffProfiles.length > 0 && faceData.vector) {
        for (const staff of this.staffProfiles) {
          const sVec = staff.embedding || staff.vector;
          if (sVec) {
            const sim = computeCosineSimilarity(faceData.vector, sVec);
            if (sim > sampleStaffSim) {
              sampleStaffSim = sim;
            }
          }
          if (Array.isArray(staff.embeddings)) {
            for (const emb of staff.embeddings) {
              const vec = emb?.vector || (Array.isArray(emb) ? emb : null);
              if (vec) {
                const sim = computeCosineSimilarity(faceData.vector, vec);
                if (sim > sampleStaffSim) {
                  sampleStaffSim = sim;
                }
              }
            }
          }
        }
      }

      if (sampleStaffSim > block.maxStaffSim) {
        block.maxStaffSim = sampleStaffSim;
      }

      const isSampleStaff = sampleStaffSim >= this.staffThreshold;
      if (isSampleStaff) {
        block.staffFacesCount = (block.staffFacesCount || 0) + 1;
      } else {
        block.clientFacesCount = (block.clientFacesCount || 0) + 1;
      }

      // Solo actualizar mejores rostros si NO coincide con el personal (evitar que el barbero sea el thumbnail)
      if (!isSampleStaff) {
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
      }

      const sampleObj = {
        timestampEpoch,
        videoSecond,
        box,
        isStaffMatch: isSampleStaff,
        staffSim: sampleStaffSim,
        faceData: {
          ...faceData,
          hasTwoEyes,
          isAnatomical
        }
      };

      // Scoring para buffer acotado (máximo 20 mejores muestras ordenadas por nitidez y pose).
      // Las fotos que coinciden con staff se penalizan (-2000) para priorizar siempre al cliente real en el buffer.
      const poseWeights = { frontal: 30, semi_left: 20, semi_right: 20, tilted_up: 10, tilted_up_left: 10, tilted_up_right: 10 };
      const sampleScore = (isSampleStaff ? -2000 : 0) + (isAnatomical ? 1000 : 0) + (hasTwoEyes ? 200 : 0) + (poseWeights[faceData.pose] || 0) + (faceData.sharpnessScore || 0);
      sampleObj._qualityScore = sampleScore;

      block.crops.push(sampleObj);

      // Acotar a máximo 20 mejores muestras ordenadas por nitidez y pose
      if (block.crops.length > 20) {
        block.crops.sort((a, b) => (b._qualityScore || 0) - (a._qualityScore || 0));
        block.crops = block.crops.slice(0, 20);
      }

      // Mantener embeddings y photos sincronizados con los crops acotados para blindar RAM
      block.embeddings = block.crops.map(c => c.faceData?.vector).filter(Boolean);
      block.photos = block.crops
        .filter(c => c.faceData?.thumbnailBase64)
        .map(c => ({
          thumbnailBase64: c.faceData.thumbnailBase64,
          sharpnessScore: c.faceData.sharpnessScore,
          pose: c.faceData.pose,
          landmarks: c.faceData.landmarks,
          hasTwoEyes: c.faceData.hasTwoEyes,
          isAnatomical: c.faceData.isAnatomical,
          box: c.box || c.faceData?.box || null,
          boxNorm: c.faceData?.boxNorm || null
        }));
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

    // 0. FILTRO ESPACIAL DE SILLA DE FIREBASE
    const spatialRes = validateSpatialChairAnchor(block, block.chairId, {
      quadrants: this.quadrants,
      width: this.width,
      height: this.height
    });
    if (!spatialRes.isValid) {
      const decision = {
        valid: false,
        verdict: "DISCARDED_OUTSIDE_CHAIR",
        reason: `Fuera de caja de silla Firebase (${spatialRes.reason}, insideRatio=${((spatialRes.avgInsideRatio || 0) * 100).toFixed(1)}%, y2=${spatialRes.avgY2?.toFixed(0)})`,
        block: { ...block, durationMinutes, durationSeconds }
      };
      this._emitDecision(decision);
      return decision;
    }

    // 1. FILTRO DE BARBERO / PERSONAL DE PIE
    // Consenso biométrico y postural: solo se descarta como personal si:
    // a) Confirmado como staff por upstream
    // b) O no hubo ninguna foto de cliente y el máximo sim supera el umbral
    // c) O más del 50% de las fotos coinciden con el personal (consenso de rostros)
    // d) O estuvo de pie predominantemente (standingRatio >= 0.60) con alta similitud con personal
    const totalFaces = (block.staffFacesCount || 0) + (block.clientFacesCount || 0);
    const staffRatio = totalFaces > 0 ? (block.staffFacesCount / totalFaces) : 0;

    const isStaffConsensus = block.isStaffConfirmed ||
      (block.clientFacesCount === 0 && block.maxStaffSim >= this.staffThreshold) ||
      (totalFaces >= 2 && staffRatio >= 0.50) ||
      (standingRatio >= 0.60 && block.maxStaffSim >= this.staffThreshold);

    if (isStaffConsensus) {
      const decision = {
        valid: false,
        verdict: "DISCARDED_BARBER",
        reason: `Coincidencia biométrica mayoritaria con personal (staffRatio=${(staffRatio * 100).toFixed(0)}%, maxStaffSim=${block.maxStaffSim.toFixed(3)} >= ${this.staffThreshold})`,
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

    // PURGA QUIRÚRGICA DE FOTOS DEL BARBERO EN BLOQUES DE CLIENTE:
    // Si el cliente estuvo sentado y su bloque es genuino, pero se asomó el barbero en un par de frames,
    // eliminamos esas fotos de staff de la galería para que no contaminen los embeddings ni el medoide.
    if (block.staffFacesCount > 0 && block.crops.length > 0) {
      block.crops = block.crops.filter(c => !c.isStaffMatch);
      block.embeddings = block.crops.map(c => c.faceData?.vector).filter(Boolean);
      block.photos = block.crops
        .filter(c => c.faceData?.thumbnailBase64)
        .map(c => ({
          thumbnailBase64: c.faceData.thumbnailBase64,
          sharpnessScore: c.faceData.sharpnessScore,
          pose: c.faceData.pose,
          landmarks: c.faceData.landmarks,
          hasTwoEyes: c.faceData.hasTwoEyes,
          isAnatomical: c.faceData.isAnatomical,
          box: c.box || c.faceData?.box || null,
          boxNorm: c.faceData?.boxNorm || null
        }));
      block.anatomicalFacesCount = block.crops.filter(c => c.faceData?.isAnatomical).length;
      if (!block.bestFaceThumbnail && block.photos.length > 0) {
        block.bestFaceThumbnail = block.photos[0].thumbnailBase64;
      }
    }

    // 2. FILTRO DE INTEGRIDAD ANATÓMICA (ANTI-NUCA / ANTI-FALSO POSITIVO / ANTI-LIMPIEZA SIN ROSTRO)
    // Para que un bloque sea un servicio humano real, DEBE tener al menos 1 rostro anatómico genuino
    // con dos ojos visibles y pose válida. Las nucas con clipper/peine no tienen 2 ojos ni pose erguida,
    // y los eventos de limpieza o manipulación de capa no tienen cliente humano visible.
    if (!block.crops || block.crops.length === 0 || !block.anatomicalFacesCount || block.anatomicalFacesCount === 0) {
      const cropsCount = block.crops ? block.crops.length : 0;
      const decision = {
        valid: false,
        verdict: "DISCARDED_NO_ANATOMICAL_FACE",
        reason: `Cero rostros anatómicos con dos ojos visibles (${cropsCount} fotos) (falso positivo de nuca/pelo/limpieza sin cliente humano)`,
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
    this.totalConfirmedBlocksCount = (this.totalConfirmedBlocksCount || 0) + 1;
    this.completedBlocks.push(confirmedBlock);
    if (this.completedBlocks.length > 5) {
      this.completedBlocks.shift();
    }

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
