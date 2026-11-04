/**
 * Servicio de Gestión de Atenciones y Registro de Citas (Appointment & Visit Session Service)
 *
 * Implementa el paradigma de desacoplamiento entre Atención (Appointment) y Cliente:
 * - La Atención se ancla a la silla de corte (barber_chair ROI) y se mantiene activa con YOLO.
 * - Es insensible a giros de cabeza o vistas de espalda: el tracking corporal de YOLO gobierna la sesión.
 * - Requiere una permanencia de al menos 10 minutos (MIN_APPOINTMENT_MINUTES) para constituir una cita válida.
 * - Durante el corte acumula hasta 20 recortes faciales del cliente, excluyendo estrictamente al Barbero (matchStaffFace >= 0.52).
 * - Al terminar la atención, realiza comparación Set-to-Set de los vectores recolectados contra la base de clientes.
 * - Asocia la cita al cliente existente o crea uno nuevo, anexando las fotos de la sesión a su perfil (40+ fotos acumuladas).
 * - Persiste en SQLite (tabla appointments) y Firestore (camera_catcher_appointments y camera_catcher_visits).
 */

import { emitDecisionFromLog } from "./pipeline/decision_feed.js";
import { isServiceChair as isServiceChairRule, isTransitZone } from "../core/barbershop_rules.js";
import { customerService as defaultCustomerService } from "./customer_service.js";
import { daemonReporter } from "../daemon_reporter.js";
import { PIPELINE_CONFIG } from "../core/pipeline_config.js";

import {
  arePosesCompatibleEnhanced,
  computePoseAwareSimilarity,
  computeSetToSetMetrics,
  getClusterSimilarity,
  computeSubsetCohesion
} from "./pipeline/biometrics_math.js";
import {
  filterOutlierSamples,
  deduplicateSessionPhotos,
  mergePhotosAndEmbeddings,
  mergeCustomerPhotos,
  mergeCustomerEmbeddings
} from "./pipeline/gallery_curator.js";
import { matchSessionAgainstClients } from "./pipeline/closure_rules.js";
import { reconcileOrphanedProvisionalProfiles } from "./pipeline/provisional_reconciler.js";
import {
  consolidateChairAppointment,
  finalizeCustomerAndAppointment,
  executeSessionClosurePipeline,
  getRepresentativeFace,
  getMultiPoseRepresentativeBank,
  isVector
} from "./pipeline/appointment_finalizer.js";
import { extractPoseCategory } from "./pipeline/track_block_manager.js";
import { computeCleanCentroid } from "./pipeline/causal_biocentric_consolidator.js";
import { ingestFaceSample } from "./pipeline/sample_collector.js";
import {
  isChairMatch,
  evaluateChairTimeouts,
  orchestrateChairTrack
} from "./pipeline/chair_tracker.js";
import { computeCosineSimilarity } from "../face_recognizer.js";

/**
 * Detecta si dos poses corresponden a orientaciones opuestas (izquierda vs derecha)
 * donde la similitud facial esperada cae naturalmente a 0.05 - 0.20 en una misma persona.
 * @param {string} poseA
 * @param {string} poseB
 * @returns {boolean}
 */
export function isOppositeSide(poseA, poseB) {
  if (!poseA || !poseB || typeof poseA !== 'string' || typeof poseB !== 'string') return false;
  const a = poseA.toLowerCase();
  const b = poseB.toLowerCase();

  const isLeftA = a.endsWith('_left') || a.includes('left');
  const isRightA = a.endsWith('_right') || a.includes('right');
  const isLeftB = b.endsWith('_left') || b.includes('left');
  const isRightB = b.endsWith('_right') || b.includes('right');

  return (isLeftA && isRightB) || (isRightA && isLeftB);
}

export {
  arePosesCompatibleEnhanced,
  computePoseAwareSimilarity,
  computeSetToSetMetrics
};

export class VisitSessionService {
  constructor({
    db,
    bucket,
    sqliteClient,
    customerService,
    minAppointmentMinutes,
    emptyChairTimeoutMs,
    minConsecutiveChairFrames,
    staffThreshold,
    clockFn,
    maxCompletedAppointments,
    quadrants = null,
    chairZone = null,
    onSessionClosed = null
  } = {}) {
    this.db = db;
    this.bucket = bucket;
    this.sqliteClient = sqliteClient || null;
    this.customerService = customerService || defaultCustomerService;
    this.clockFn = typeof clockFn === "function" ? clockFn : null;
    this.quadrants = quadrants;
    this.chairZone = chairZone;
    this.onSessionClosed = typeof onSessionClosed === "function" ? onSessionClosed : null;
    this.minAppointmentMinutes = typeof minAppointmentMinutes === "number"
      ? minAppointmentMinutes
      : (process.env.MIN_APPOINTMENT_MINUTES ? parseInt(process.env.MIN_APPOINTMENT_MINUTES, 10) : PIPELINE_CONFIG.sessions.minAppointmentMinutes);
    this.emptyChairTimeoutMs = typeof emptyChairTimeoutMs === "number"
      ? emptyChairTimeoutMs
      : (process.env.EMPTY_CHAIR_TIMEOUT_MS ? parseInt(process.env.EMPTY_CHAIR_TIMEOUT_MS, 10) : PIPELINE_CONFIG.sessions.emptyChairTimeoutMs);
    this.minConsecutiveChairFrames = typeof minConsecutiveChairFrames === "number"
      ? minConsecutiveChairFrames
      : (process.env.MIN_CONSECUTIVE_CHAIR_FRAMES ? parseInt(process.env.MIN_CONSECUTIVE_CHAIR_FRAMES, 10) : PIPELINE_CONFIG.tracking.minChairFrames);
    this.staffThreshold = typeof staffThreshold === "number"
      ? staffThreshold
      : (process.env.STAFF_EXCLUSION_THRESHOLD ? parseFloat(process.env.STAFF_EXCLUSION_THRESHOLD) : PIPELINE_CONFIG.staffFilter.staffExclusionThreshold);
    this.maxCompletedAppointments = typeof maxCompletedAppointments === "number"
      ? maxCompletedAppointments
      : (process.env.MAX_COMPLETED_APPOINTMENTS ? parseInt(process.env.MAX_COMPLETED_APPOINTMENTS, 10) : 20);
    this.activeSessions = new Map(); // chairId / trackId -> Session
    this.completedAppointments = [];
    this.completedVisits = [];
    this.stats = { sessionsOpened: 0, barberDiscarded: 0, noiseDiscarded: 0, consolidated: 0, continuousMergesCount: 0 };
    this._lastReconcileAt = 0;
  }

  /**
   * Obtiene el tiempo actual (real o virtual sincronizado con video en simulaciones Fast-Forward)
   */
  getNow(overrideNow) {
    if (typeof overrideNow === "number" && overrideNow > 0) return overrideNow;
    if (typeof this.clockFn === "function") return this.clockFn();
    return Date.now();
  }

  /**
   * Calcula similitud de un embedding frente al cluster actual de la sesión
   */
  getClusterSimilarity(embedding, sessionEmbeddings = [], sessionPhotos = [], incomingPose = null) {
    return getClusterSimilarity(embedding, sessionEmbeddings, sessionPhotos, incomingPose);
  }

  /**
   * Calcula métricas multi-dimensionales Pose-Aware entre dos conjuntos de embeddings/fotos (Set-to-Set)
   */
  computeSetToSetMetrics(vecsA = [], photosA = [], vecsB = [], photosB = []) {
    return computeSetToSetMetrics(vecsA, photosA, vecsB, photosB);
  }

  /**
   * Calcula la cohesión interna de un subconjunto de vectores (promedio de la mejor similitud de cada elemento con sus pares)
   */
  computeSubsetCohesion(vecs = []) {
    return computeSubsetCohesion(vecs);
  }

  /**
   * Emite logs verbales informativos a la consola y al panel de telemetría por SSE
   */
  logVerbal(text, type = "info") {
    console.log(`[Appointment] ${text}`);
    try {
      daemonReporter.reportVerbalLog(text, type);
    } catch (_) {}
    try {
      emitDecisionFromLog(text);
    } catch (_) {}
  }

  /**
   * Datos explicativos del bloque en análisis: qué evidencia lleva acumulada y
   * qué criterios debe cumplir para ser confirmado como cliente (ver TrackBlockManager).
   */
  _buildBlockInsight(b, blockMgr, now) {
    const staffThreshold = blockMgr?.staffThreshold ?? 0.46;
    const total = b.totalFrames || 0;
    const standingRatio = total > 0 ? (b.standingFrames || 0) / total : 0;
    const durationSeconds = Math.max(0, Math.round(((b.lastSeenEpoch || now) - (b.startedAtEpoch || now)) / 1000));
    const poses = Array.from(new Set((b.crops || []).map(c => c.faceData?.pose).filter(Boolean)));
    const photosCount = b.crops?.length || 0;
    const maxStaffSim = Number((b.maxStaffSim || 0).toFixed(3));
    return {
      staffThreshold,
      standingRatio: Number(standingRatio.toFixed(2)),
      staffFaces: b.staffFacesCount || 0,
      clientFaces: b.clientFacesCount || 0,
      posesCaptured: poses,
      checks: [
        { id: "anatomical", label: "Rostro con dos ojos", ok: (b.anatomicalFacesCount || 0) > 0, detail: `${b.anatomicalFacesCount || 0} rostros anatómicos` },
        { id: "not_staff", label: "No es el barbero", ok: maxStaffSim < staffThreshold, detail: `similitud ${maxStaffSim} (umbral ${staffThreshold})` },
        { id: "seated", label: "Sentado en la silla", ok: standingRatio < 0.65, detail: `${Math.round(standingRatio * 100)}% del tiempo de pie` },
        { id: "duration", label: "Permanencia suficiente", ok: durationSeconds >= 90 || photosCount >= 5, detail: `${durationSeconds}s, ${photosCount} fotos (mín. 90s o 5 fotos)` }
      ]
    };
  }

  /**
   * Busca una sesión activa asignada a un identificador de silla físico
   */
  findSessionByChair(chairId) {
    if (!chairId) return null;
    for (const session of this.activeSessions.values()) {
      if (session.chairId === chairId) return session;
    }
    return null;
  }

  /**
   * Determina si un cuadrante corresponde a una silla de atención al cliente
   */
  isServiceChair(quadrant) {
    if (!quadrant) return false;
    if (isTransitZone(quadrant)) return false;
    return isServiceChairRule(quadrant);
  }

  /**
   * Procesa la actualización de un track de persona activa en la escena
   * @param {Object} track - Pista del PersonTracker
   * @returns {Promise<Object|null>}
   */
  async processTrack(track, options = {}) {
    if (!track) return null;
    const now = this.getNow(options.now);
    const isChair = this.isServiceChair(track.currentQuadrant);

    if (!isChair) {
      return null;
    }

    const chairId = track.currentQuadrant.id;
    const chairName = track.currentQuadrant.label || track.currentQuadrant.name || chairId;

    return orchestrateChairTrack({
      track,
      options,
      now,
      activeSessions: this.activeSessions,
      customerService: this.customerService,
      staffThreshold: this.staffThreshold,
      minConsecutiveChairFrames: this.minConsecutiveChairFrames,
      db: this.db,
      bucket: this.bucket,
      stats: this.stats,
      getClusterSimilarity: (emb, sEmbs, sPhs, pose) => this.getClusterSimilarity(emb, sEmbs, sPhs, pose),
      closeSession: (id, opts) => this.closeSession(id, opts),
      addFaceSample: (tId, smp) => this.addFaceSample(tId, smp),
      logVerbal: (txt, type) => this.logVerbal(txt, type)
    });
  }

  /**
   * Procesa un bloque confirmado de cliente emitido por TrackBlockManager
   * @param {Object} block
   * @param {Object} [options]
   * @returns {Promise<Object|null>}
   */
  async processConfirmedBlock(block, options = {}) {
    if (!block || !block.chairId) return null;
    const now = this.getNow(options.now || block.lastSeenEpoch);
    const chairId = block.chairId;
    const chairName = block.chairName || chairId;

    let session = this.findSessionByChair(chairId);
    let isRotatedFromMismatch = false;

    // Si es un bloque de presencia física sentada sin rostro reconocible (isSeatedPresenceOnly):
    // NO se elimina ni se ignora para continuidad: sirve para confirmar que la silla sigue ocupada
    // y extender la sesión en curso (cubriendo hasta 5 min de lavado/inclinación/barbero tapando)
    // sin alterar fotos ni vectores.
    if (session) {
      session.lastSeenEpoch = Math.max(session.lastSeenEpoch || 0, block.lastSeenEpoch || now);
    }

    if (block.isSeatedPresenceOnly) {
      if (session) {
        // Presencia sin rostro: solo mantiene el heartbeat de presencia física si la atención NO está esperando liberación.
        // Si ya está esperando liberación (cliente se levantó), una presencia sin rostro (capa, barbero limpiando o nuca)
        // NUNCA debe cancelar el conteo de liberación ni resetear emptySinceEpoch.
        if (session.status !== "esperando_liberacion") {
          const lastFaceMs = session.lastFaceSeenEpoch || session.startedAtEpoch || 0;
          const blockEndMs = block.lastSeenEpoch || now;
          const maxPresenceBridgeMs = 60000;
          if (blockEndMs - lastFaceMs <= maxPresenceBridgeMs) {
            session.lastSeenEpoch = Math.max(session.lastSeenEpoch || 0, blockEndMs);
            if (block.boxes && block.boxes.length > 0) {
              if (!session.boxes) session.boxes = [];
              session.boxes.push(...block.boxes);
              if (session.boxes.length > 100) session.boxes = session.boxes.slice(-100);
            }
            if (this.customerService?.profilesCache && session.tempClientId) {
              const p = this.customerService.profilesCache.get(session.tempClientId);
              if (p) p.lastSeen = new Date(session.lastSeenEpoch).toISOString();
            }
            if (!session.allSessionTrackIds) session.allSessionTrackIds = [session.initialTrackId || session.trackId].filter(Boolean);
            if (block.trackId && !session.allSessionTrackIds.includes(block.trackId)) {
              session.allSessionTrackIds.push(block.trackId);
            }
            const anchorTrackId = session.initialTrackId || session.trackId;
            this.trackBlockManager?.updateBlockHistory?.(block.trackId, {
              status: "fusionado",
              statusLabel: `Puente → Fusionado con #${anchorTrackId}`,
              sessionId: session.id,
              mergedWithTrackId: anchorTrackId,
              mergedWithLabel: `#${anchorTrackId} (${session.clientName || "En corte"})`,
              reason: `Puente de presencia física sin rostro visible (${block.durationSeconds || 1}s): mantuvo viva la atención activa #${anchorTrackId} sin agregar fotos.`
            });
            return session;
          }
        }
        this.trackBlockManager?.updateBlockHistory?.(block.trackId, {
          status: "eliminado",
          statusLabel: "Eliminado (Presencia Sin Rostro)",
          reason: `Presencia sin rostro (${block.durationSeconds || 1}s) descartada por silla en liberación o tiempo sin rostro excedido.`
        });
        return session;
      }
      this.trackBlockManager?.updateBlockHistory?.(block.trackId, {
        status: "eliminado",
        statusLabel: "Eliminado (Sin Rostro ni Sesión)",
        reason: `Presencia en silla sin rostro visible (${block.durationSeconds || 1}s, 0 fotos) y sin ninguna sesión activa previa en ${chairName} a la cual servir de puente.`
      });
      return null;
    }

    if (session) {
      // Banco de Representantes por Posición (Multi-Pose Representative Bank)
      if (!session.representatives) {
        session.representatives = { frontal: null, left: null, right: null, tilted: null };
      }
      if (!Object.values(session.representatives).some(Boolean) && session.photos && session.photos.length > 0) {
        session.representatives = getMultiPoseRepresentativeBank(session.photos, session.embeddings);
      }
      if (!block.representatives) {
        block.representatives = { frontal: null, left: null, right: null, tilted: null };
      }
      if (!Object.values(block.representatives).some(Boolean) && block.photos && block.photos.length > 0) {
        block.representatives = getMultiPoseRepresentativeBank(block.photos, block.embeddings);
      }

      const repPrev = getRepresentativeFace(session.photos || [], session.embeddings || []);
      const repBlock = getRepresentativeFace(block.photos || [], block.embeddings || []);

      // Precalcular similitudes de galería acumulada y centroides limpios
      let maxGallerySim = 0;
      const prevVecs = (session.embeddings || []).map(e => isVector(e) ? e : e?.vector).filter(Boolean);
      const blockVecs = (block.embeddings || []).map(e => isVector(e) ? e : e?.vector).filter(Boolean);
      if (prevVecs.length === 0 && repPrev?.vector) prevVecs.push(repPrev.vector);
      if (blockVecs.length === 0 && repBlock?.vector) blockVecs.push(repBlock.vector);

      for (const va of prevVecs) {
        for (const vb of blockVecs) {
          const sim = computeCosineSimilarity(va, vb);
          if (sim > maxGallerySim) maxGallerySim = sim;
        }
      }

      const staffProfiles = this.customerService?.getComparisonProfiles?.()?.filter(p => p.isStaff) || [];
      const cleanCentroidPrev = computeCleanCentroid(prevVecs, staffProfiles, this.staffThreshold) || repPrev?.vector;
      const cleanCentroidBlock = computeCleanCentroid(blockVecs, staffProfiles, this.staffThreshold) || repBlock?.vector;
      const centroidSim = (cleanCentroidPrev && cleanCentroidBlock)
        ? computeCosineSimilarity(cleanCentroidPrev, cleanCentroidBlock)
        : 0;

      const vacancyMs = session.emptySinceEpoch
        ? (now - session.emptySinceEpoch)
        : (session.lastClientSeenEpoch && block.startedAtEpoch ? Math.max(0, block.startedAtEpoch - session.lastClientSeenEpoch) : 0);
      const isPhysicalContinuity = vacancyMs < 10000;

      // Comparación Homóloga Grupo-a-Grupo entre session.representatives y block.representatives
      const homologousSims = {};
      let maxHomologousSim = -1;
      let matchedHomologousCategory = null;
      let hasHomologousComparison = false;

      for (const cat of ['frontal', 'left', 'right', 'tilted']) {
        const repS = session.representatives[cat];
        const repB = block.representatives[cat];
        const vecS = repS ? (isVector(repS) ? repS : repS.vector) : null;
        const vecB = repB ? (isVector(repB) ? repB : repB.vector) : null;
        if (vecS && vecB) {
          const sim = computeCosineSimilarity(vecS, vecB);
          homologousSims[cat] = sim;
          hasHomologousComparison = true;
          if (sim > maxHomologousSim) {
            maxHomologousSim = sim;
            matchedHomologousCategory = cat;
          }
        }
      }

      let isRadicalMismatch = false;
      let isVeto = false;
      let vetoReason = "";

      // Jerarquía de Certeza Biocéntrica (Argon 4 Override Absoluto):
      // Si el centroide o la galería demuestran coincidencia masiva (centroidSim >= 0.60 o maxGallerySim >= 0.65),
      // se anula CUALQUIER veto por vacancia temporal o discrepancia homóloga sintética.
      const hasOverwhelmingBiometricProof = (maxGallerySim >= 0.65 || centroidSim >= 0.60);

      const isProlongedVacancy = vacancyMs >= 30000;
      if (hasOverwhelmingBiometricProof) {
        isVeto = false;
        this.logVerbal(`🛡️ Inmunidad Biocéntrica en ${chairName}: Coincidencia masiva (centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}). Veto homólogo por vacancia anulado.`, "process");
      } else if (isProlongedVacancy) {
        // Tras >= 30s de silla vacía, exigir confirmación biométrica con la sesión previa (incluyendo pose homóloga si existe) para no unir al siguiente cliente tras un cambio de silla
        const hasHomologousContradiction = hasHomologousComparison && maxHomologousSim < 0.22 && matchedHomologousCategory !== 'tilted';
        const hasPostVacancyMatch = !hasHomologousContradiction && (
          maxHomologousSim >= 0.42 ||
          (maxHomologousSim >= 0.25 && centroidSim >= 0.40 && maxGallerySim >= 0.39) ||
          (!hasHomologousComparison && centroidSim >= 0.42 && maxGallerySim >= 0.45) ||
          (centroidSim >= 0.50 && maxGallerySim >= 0.55)
        );
        if (!hasPostVacancyMatch) {
          isVeto = true;
          vetoReason = `cambio de cliente o vacancia prolongada (${(vacancyMs / 1000).toFixed(1)}s >= 30s) sin confirmación biométrica fuerte (maxHomologousSim=${maxHomologousSim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)})`;
        } else {
          isVeto = false;
          this.logVerbal(`🛡️ Retorno confirmado tras vacancia (${(vacancyMs / 1000).toFixed(1)}s) en ${chairName} (maxHomologousSim=${maxHomologousSim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}).`, "process");
        }
      } else if (hasHomologousComparison) {
        // Verificar si las poses homólogas comparadas son de alta confiabilidad (2 ojos visibles sin oclusión y pose erguida, NO tilted)
        const matchedRepS = session.representatives[matchedHomologousCategory];
        const matchedRepB = block.representatives[matchedHomologousCategory];
        const isHomologousOccludedOrOneEye = (!matchedRepS?.hasTwoEyes || !matchedRepB?.hasTwoEyes || matchedHomologousCategory === 'tilted');
        const isSmallIncomingBlock = (block.photos?.length || 0) <= 3;

        // Hay al menos una pareja homóloga disponible (frontal-frontal, left-left, right-right o tilted-tilted)
        if (maxHomologousSim >= 0.50) {
          // Identidad confirmada por correspondencia homóloga
          isVeto = false;
          this.logVerbal(`🛡️ Identidad confirmada en ${chairName} (maxHomologousSim=${maxHomologousSim.toFixed(3)} [${matchedHomologousCategory}], maxGallerySim=${maxGallerySim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)}): NO hay veto, extendiendo sesión de forma continua.`, "process");
        } else if (maxHomologousSim < 0.35) {
          // Si hay correspondencia contundente en la galería acumulada o en centroides limpios,
          // se preserva la identidad (la discrepancia en pose homóloga se debe a variación de cabeceo / pitch o iluminación dentro de la misma categoría)
          const hasStrongBiometricEvidence = maxGallerySim >= 0.68 || (centroidSim >= 0.52 && maxGallerySim >= 0.58);

          // Discrepancia severa en pose erguida homóloga sin evidencia biométrica contundente
          // Excluir si hay continuidad física inmediata en la silla (isPhysicalContinuity)
          const isPhysicalSupported = isPhysicalContinuity;
          const isSevereMismatch = !isPhysicalContinuity && maxHomologousSim < 0.25 && !hasStrongBiometricEvidence && matchedHomologousCategory !== 'tilted';

          if (
            !isSevereMismatch && (
              isPhysicalContinuity ||
              hasStrongBiometricEvidence ||
              (isHomologousOccludedOrOneEye && (isPhysicalContinuity || centroidSim >= 0.38 || maxGallerySim >= 0.48)) ||
              (isSmallIncomingBlock && isPhysicalContinuity && centroidSim >= 0.35) ||
              (centroidSim >= 0.42 && maxGallerySim >= 0.50)
            )
          ) {
            isVeto = false;
            this.logVerbal(`🛡️ Continuidad de Identidad en ${chairName} (vacancia=${(vacancyMs / 1000).toFixed(1)}s, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}): Se descarta rotación por continuidad en silla / pose reclinada o lateral (homologousSim=${maxHomologousSim.toFixed(3)} [${matchedHomologousCategory}]).`, "process");
          } else {
            isVeto = true;
            vetoReason = `discrepancia en pose homóloga (${matchedHomologousCategory}: sim=${maxHomologousSim.toFixed(3)} < 0.35, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)})`;
          }
        } else {
          // maxHomologousSim está en zona intermedia [0.35, 0.50)
          const isValidIntermediate = isPhysicalContinuity ||
            (maxHomologousSim >= 0.40 && (centroidSim >= 0.32 || maxGallerySim >= 0.42)) ||
            maxGallerySim >= 0.48 ||
            centroidSim >= 0.38 ||
            (isHomologousOccludedOrOneEye && (centroidSim >= 0.30 || maxGallerySim >= 0.40));
          if (isValidIntermediate) {
            isVeto = false;
            this.logVerbal(`🛡️ Identidad confirmada por evidencia acumulada en ${chairName} (maxHomologousSim=${maxHomologousSim.toFixed(3)} [${matchedHomologousCategory}], maxGallerySim=${maxGallerySim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)}): extendiendo sesión.`, "process");
          } else {
            isVeto = true;
            vetoReason = `evidencia homóloga insuficiente tras vacancia (${(vacancyMs / 1000).toFixed(1)}s >= 10s, maxHomologousSim=${maxHomologousSim.toFixed(3)} < 0.50, centroidSim=${centroidSim.toFixed(3)})`;
          }
        }
      } else {
        // NO hay poses homólogas compartidas (ej. session tiene left, block tiene right).
        // Prohibido terminantemente que una discrepancia entre poses opuestas dispare un veto si hay evidencia mínima de centroide/galería,
        // pero si ni el centroide ni la galería superan un mínimo biológico (centroidSim < 0.22 && maxGallerySim < 0.28) y el bloque previo tenía <= 2 fotos, no contaminar.
        const isAlternateMatch = maxGallerySim >= 0.50 || centroidSim >= 0.45;
        const isCompleteMismatchAgainstTinySession = (session.photos?.length || 0) <= 2 && centroidSim < 0.22 && maxGallerySim < 0.28;
        if (!isCompleteMismatchAgainstTinySession && (isAlternateMatch || isPhysicalContinuity || centroidSim >= 0.30 || maxGallerySim >= 0.40)) {
          isVeto = false;
          this.logVerbal(`🛡️ Invarianza de poses opuestas en ${chairName}: No hay discrepancia en poses homólogas, veto omitido y nuevo nicho absorbido (alternateMatch=${isAlternateMatch}, vacancia=${(vacancyMs / 1000).toFixed(1)}s, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}).`, "process");
        } else {
          isVeto = true;
          vetoReason = `sin poses homólogas ni coincidencia mínima de galería (maxGallerySim=${maxGallerySim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)})`;
        }
      }

      if (isVeto) {
        isRadicalMismatch = true;
        this.logVerbal(`🛑 Veto Homólogo directo en ${chairName} (${vetoReason}). Cerrando sesión previa por rotación.`, "process");
      }

      if (isRadicalMismatch) {
        isRotatedFromMismatch = true;
        session._lastRotationVetoReason = vetoReason;
        await this.closeSession(chairId, {
          endedAtEpoch: block.startedAtEpoch || now
        });
        session = null;
      } else {
        session.lastSeenEpoch = Math.max(session.lastSeenEpoch || 0, block.lastSeenEpoch || now);
        session.lastClientSeenEpoch = Math.max(session.lastClientSeenEpoch || 0, block.lastSeenEpoch || now);
        session.lastFaceSeenEpoch = Math.max(session.lastFaceSeenEpoch || 0, block.lastSeenEpoch || now);
        session.emptySinceEpoch = null;
        if (session.status === "esperando_liberacion") {
          session.status = "en_corte";
        }

        if (block.photos && block.photos.length > 0) {
          const prevPhotosCount = (session.photos || []).length;
          const isInitialWeakAnchor = prevPhotosCount <= 2 || !repPrev?.hasFrontalAnchor;
          const repRef = (!isInitialWeakAnchor && repPrev?.vector) ? repPrev : repBlock;
          const filteredBlockPhotos = [];
          const filteredBlockEmbeddings = [];
          for (let k = 0; k < (block.photos || []).length; k++) {
            const ph = block.photos[k];
            const emb = block.embeddings?.[k] || null;
            const v = isVector(emb) ? emb : (emb?.vector || null);
            if (!isInitialWeakAnchor && repRef?.vector && v) {
              const isOpp = isOppositeSide(ph?.pose, repRef?.photo?.pose || repRef?.pose);
              if (!isOpp) {
                const sim = computeCosineSimilarity(v, repRef.vector);
                if (sim < 0.36) continue;
              }
            }
            filteredBlockPhotos.push(ph);
            filteredBlockEmbeddings.push(emb);
          }
          // Si el filtro descartó todas las fotos pero el bloque entrante fue aceptado y tiene más evidencia que una sesión casi vacía, usar las fotos del bloque
          const photosToMerge = filteredBlockPhotos.length > 0
            ? filteredBlockPhotos
            : (prevPhotosCount <= 3 ? block.photos : []);
          const embeddingsToMerge = filteredBlockPhotos.length > 0
            ? filteredBlockEmbeddings
            : (prevPhotosCount <= 3 ? (block.embeddings || []) : []);

          if (photosToMerge.length > 0) {
            // Si la sesión previa solo tenía 1-2 fotos y el nuevo bloque trae >= 4 fotos sólidas cuya similitud con las iniciales es baja (ej. cola del cliente previo o sombra), reemplazar las fotos iniciales
            const shouldReplaceInitialWeakPhotos = prevPhotosCount <= 2 &&
              photosToMerge.length >= 4 &&
              (filteredBlockPhotos.length === 0 || (centroidSim > 0 && centroidSim < 0.35 && maxGallerySim < 0.42));
            const basePhotos = shouldReplaceInitialWeakPhotos ? [] : (session.photos || []);
            const baseEmbeddings = shouldReplaceInitialWeakPhotos ? [] : (session.embeddings || []);
            const merged = mergePhotosAndEmbeddings(
              basePhotos,
              photosToMerge,
              baseEmbeddings,
              embeddingsToMerge
            );
            const deduped = deduplicateSessionPhotos(merged.photos, merged.embeddings, 20);
            session.photos = deduped.photos;
            session.embeddings = deduped.embeddings;
          }
        }

        if ((block.bestFaceScore || 0) > (session.bestFaceScore || 0)) {
          session.bestFaceScore = block.bestFaceScore;
          if (block.bestFaceThumbnail) {
            session.thumbnailBase64 = block.bestFaceThumbnail;
          }
        }

        // Extender banco acumulado de representantes por categoría
        if (block.representatives) {
          if (!session.representatives) {
            session.representatives = { frontal: null, left: null, right: null, tilted: null };
          }
          for (const cat of ['frontal', 'left', 'right', 'tilted']) {
            const bRep = block.representatives[cat];
            const sRep = session.representatives[cat];
            if (bRep) {
              const bScore = Number(bRep.score ?? bRep.sharpnessScore ?? 0);
              const sScore = sRep ? Number(sRep.score ?? sRep.sharpnessScore ?? 0) : -1;
              if (!sRep || bScore > sScore || (bRep.isAnatomical && !sRep.isAnatomical)) {
                session.representatives[cat] = { ...bRep };
              }
            }
          }
        }

        const anchorTrackId = session.initialTrackId || session.trackId;
        if (!session.initialTrackId) session.initialTrackId = anchorTrackId;
        if (!session.allSessionTrackIds) session.allSessionTrackIds = [anchorTrackId];
        if (block.trackId && !session.allSessionTrackIds.includes(block.trackId)) {
          session.allSessionTrackIds.push(block.trackId);
        }

        if (block.trackId && block.trackId !== session.trackId) {
          this.activeSessions.delete(session.trackId);
          session.trackId = block.trackId;
          this.activeSessions.set(block.trackId, session);
        }

        this.trackBlockManager?.updateBlockHistory?.(block.trackId, {
          status: "fusionado",
          statusLabel: `Fusionado con #${anchorTrackId}`,
          sessionId: session.id,
          mergedWithTrackId: anchorTrackId,
          mergedWithLabel: `#${anchorTrackId} (${session.clientName || "En corte"})`,
          reason: `Unido a la sesión activa en ${chairName} (#${anchorTrackId}): continuidad confirmada (centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}${hasHomologousComparison ? `, maxHomologousSim=${maxHomologousSim.toFixed(3)} [${matchedHomologousCategory}]` : ""}, vacancia=${(vacancyMs / 1000).toFixed(1)}s).`
        });

        if (this.customerService && session.personId) {
          const cust = this.customerService.getCustomerData(session.personId);
          if (cust) {
            cust.lastSeen = new Date(session.lastSeenEpoch).toISOString();
            cust.photos = session.photos;
            cust.embeddings = session.embeddings;
            if (session.bestFaceScore > (cust.bestFaceScore || 0)) {
              cust.bestFaceScore = session.bestFaceScore;
              cust.thumbnailBase64 = session.thumbnailBase64;
            }
          }
        }

        if (block.boxes && block.boxes.length > 0) {
          if (!session.boxes) session.boxes = [];
          session.boxes.push(...block.boxes);
          if (session.boxes.length > 100) session.boxes = session.boxes.slice(-100);
        }

        if (!session.confirmedBlocks) session.confirmedBlocks = [];
        const existingIdx = session.confirmedBlocks.findIndex(cb => cb.trackId === block.trackId);
        const blockSummary = {
          trackId: block.trackId,
          photosCount: block.photos?.length || block.crops?.length || 0,
          durationSeconds: block.durationSeconds || Math.max(1, Math.round(((block.lastSeenEpoch || now) - (block.startedAtEpoch || now)) / 1000)),
          bestFaceScore: block.bestFaceScore || 0,
          poses: block.photos ? Array.from(new Set(block.photos.map(p => p.pose).filter(Boolean))) : []
        };
        if (existingIdx >= 0) {
          session.confirmedBlocks[existingIdx] = blockSummary;
        } else {
          session.confirmedBlocks.push(blockSummary);
        }

        this.logVerbal(`🔄 Sesión en ${chairName} extendida con bloque #${block.trackId} (${block.photos?.length || 0} fotos, total: ${session.photos?.length || 0}).`, "info");
        return session;
      }
    }

    let startedAt = block.startedAtEpoch || now;
    const absorbedTrackIds = [];

    // Medida 3 (Argon 4): Absorción Retrospectiva de Presencia Sentada en la misma silla
    // Si la silla física tuvo presencia sentada continua (SEATED_PRESENCE_BLOCK o bloques de presencia)
    // inmediatamente antes de este bloque confirmado (sin vacancia prolongada > 45s y posterior a la última cita cerrada)
    if (this.trackBlockManager?.allTrackBlocks && this.trackBlockManager.allTrackBlocks.length > 0) {
      const lastClosedAppt = [...this.completedAppointments].reverse().find(a => a.chairId === chairId);
      const minEpochAllowed = lastClosedAppt ? (lastClosedAppt.endedAtEpoch || new Date(lastClosedAppt.endedAt).getTime()) : 0;

      const chairHistory = [...this.trackBlockManager.allTrackBlocks]
        .filter(tb => tb.chairId === chairId && (tb.endedAtEpoch || 0) <= startedAt && (tb.startedAtEpoch || 0) >= minEpochAllowed)
        .sort((a, b) => (b.endedAtEpoch || 0) - (a.endedAtEpoch || 0));

      let cursorEpoch = startedAt;
      let earliestPresenceEpoch = startedAt;

      for (const tb of chairHistory) {
        const gap = cursorEpoch - (tb.endedAtEpoch || cursorEpoch);
        // Continuidad sentada: brecha <= 90s (para tolerar reclinación de cabeza / capa en misma silla) y no descartado por ser staff/barbero
        if (gap <= 90000 && gap >= -60000 && tb.verdict !== "DISCARDED_BARBER" && tb.verdict !== "DISCARDED_BARBER_STANDING") {
          earliestPresenceEpoch = Math.min(earliestPresenceEpoch, tb.startedAtEpoch || cursorEpoch);
          cursorEpoch = tb.startedAtEpoch || cursorEpoch;
          absorbedTrackIds.push(tb.trackId);
        } else {
          break;
        }
      }

      if (earliestPresenceEpoch < startedAt) {
        this.logVerbal(`🪑 Absorción retrospectiva en ${chairName}: inicio ajustado de ${new Date(startedAt).toISOString()} a ${new Date(earliestPresenceEpoch).toISOString()} (${Math.round((startedAt - earliestPresenceEpoch) / 60000)} min absorbidos de presencia sentada, TBs: [${absorbedTrackIds.join(', ')}]).`, "process");
        startedAt = earliestPresenceEpoch;
      }
    }

    const tempClientId = `person_${startedAt}_${block.trackId}`;
    const visitId = `appt_${startedAt}_${block.trackId}`;

    const deduped = (block.photos && block.photos.length > 0)
      ? deduplicateSessionPhotos(block.photos, block.embeddings || [], 20)
      : { photos: [], embeddings: [] };

    const newSession = {
      id: visitId,
      visitId,
      appointmentId: visitId,
      trackId: block.trackId,
      initialTrackId: block.trackId,
      allSessionTrackIds: [block.trackId, ...absorbedTrackIds],
      chairId,
      chairName,
      chairZone: block.chairZone || null,
      startedAt: new Date(startedAt).toISOString(),
      startedAtEpoch: startedAt,
      lastSeenEpoch: block.lastSeenEpoch || now,
      lastClientSeenEpoch: block.lastSeenEpoch || now,
      lastFaceSeenEpoch: block.lastSeenEpoch || now,
      lastMatchedClientFaceEpoch: block.lastSeenEpoch || now,
      emptySinceEpoch: null,
      pendingRotationSplitEpoch: null,
      rotatedFromPrevSession: isRotatedFromMismatch,
      _blockPrevChairMerge: false,
      rotationCandidates: [],
      lastPresenceLogAt: now,
      status: "en_corte",
      tempClientId,
      personId: tempClientId,
      personName: "Cliente (Por verificar)",
      clientId: tempClientId,
      clientName: "Cliente (Por verificar)",
      isStaff: false,
      visitCount: 1,
      bestFaceScore: block.bestFaceScore || 0,
      bestFaceStoragePath: null,
      thumbnailBase64: block.bestFaceThumbnail || (deduped.photos[0]?.thumbnailBase64) || null,
      lastPhotoAt: 0,
      lastSyncAt: now,
      photos: deduped.photos,
      embeddings: deduped.embeddings,
      representatives: {
        frontal: block.representatives?.frontal ? { ...block.representatives.frontal } : null,
        left:    block.representatives?.left ? { ...block.representatives.left } : null,
        right:   block.representatives?.right ? { ...block.representatives.right } : null,
        tilted:  block.representatives?.tilted ? { ...block.representatives.tilted } : null
      },
      boxes: block.boxes ? [...block.boxes] : (block.crops ? block.crops.map(c => c.box).filter(Boolean) : []),
      topFaces: [],
      confirmedBlocks: [{
        trackId: block.trackId,
        photosCount: deduped.photos?.length || block.photos?.length || 0,
        durationSeconds: block.durationSeconds || Math.max(1, Math.round(((block.lastSeenEpoch || now) - (block.startedAtEpoch || now)) / 1000)),
        bestFaceScore: block.bestFaceScore || 0,
        poses: (block.photos || deduped.photos) ? Array.from(new Set((block.photos || deduped.photos).map(p => p.pose).filter(Boolean))) : []
      }]
    };

    this.activeSessions.set(chairId, newSession);
    this.activeSessions.set(block.trackId, newSession);
    if (this.stats) this.stats.sessionsOpened++;

    this.trackBlockManager?.updateBlockHistory?.(block.trackId, {
      status: "confirmado",
      statusLabel: isRotatedFromMismatch ? `Nueva Sesión (#${block.trackId})` : `Abrió Sesión (#${block.trackId})`,
      sessionId: visitId,
      reason: isRotatedFromMismatch
        ? `Rotación de cliente confirmada en ${chairName}: abrió nueva atención #${block.trackId} (${deduped.photos.length} fotos).`
        : `Bloque inicial que abrió nueva atención en ${chairName} (#${block.trackId}, ${deduped.photos.length} fotos anatómicas).`
    });

    this.logVerbal(`💺 Nueva sesión iniciada en ${chairName} para bloque confirmado #${block.trackId} (${deduped.photos.length} fotos).`, "process");

    if (this.customerService) {
      const provisionalCustomer = {
        id: tempClientId,
        name: "Cliente (Por verificar)",
        status: "to_verify",
        isStaff: false,
        role: "client",
        firstSeen: new Date(startedAt).toISOString(),
        lastSeen: new Date(block.lastSeenEpoch || now).toISOString(),
        visitCount: 1,
        appointmentCount: 1,
        bestFaceScore: newSession.bestFaceScore,
        thumbnailBase64: newSession.thumbnailBase64,
        thumbnailPath: null,
        photos: newSession.photos,
        embeddings: newSession.embeddings,
        embedding: newSession.embeddings[0] || null
      };
      try {
        await this.customerService.saveOrUpdateCustomer(provisionalCustomer, {
          db: this.db,
          bucket: this.bucket,
          isNew: true,
          forceSync: true,
          backgroundSync: true
        });
      } catch (err) {
        console.warn(`[Appointment] Aviso al crear cliente to_verify inicial:`, err.message);
      }
    }

    return newSession;
  }

  /**
   * Revisa todas las sesiones en sillas y activa el contador de 30s si la silla se libera,
   * o cierra la atención automáticamente si la silla permanece vacía por >= 30s.
   * @param {number} [now=Date.now()]
   * @param {Array<Object>} [activeTracks=[]]
   * @returns {Promise<Array<Object>>} Atenciones cerradas
   */
  async checkChairTimeouts(now, activeTracks = []) {
    now = this.getNow(now);
    const closed = await evaluateChairTimeouts({
      activeSessions: this.activeSessions,
      activeTracks,
      emptyChairTimeoutMs: this.emptyChairTimeoutMs,
      now,
      getClusterSimilarity: (emb, sEmbs, sPhs, pose) => this.getClusterSimilarity(emb, sEmbs, sPhs, pose),
      closeSession: (id, opts) => this.closeSession(id, opts),
      processTrack: (track, opts) => this.processTrack(track, opts),
      logVerbal: (txt, type) => this.logVerbal(txt, type)
    });

    // Reconciliación automática periódica de perfiles 'to_verify' huérfanos o pertenecientes al Barbero
    if (now - (this._lastReconcileAt || 0) >= 15000) {
      await this.reconcileOrphanedProvisionalProfiles(now);
    }

    return closed;
  }

  /**
   * Reconciliador automático de perfiles provisionales ("to_verify").
   * Detecta y auto-elimina perfiles que:
   * 1. Pertenecen al Barbero (consenso > 50% de sus vectores coinciden con el Barbero >= 0.50)
   * 2. O son perfiles huérfanos/abandonados (sin sesión activa en curso y con inactividad >= emptyChairTimeoutMs)
   * @param {number} [now=Date.now()]
   * @returns {Promise<number>} Número de perfiles auto-eliminados
   */
  async reconcileOrphanedProvisionalProfiles(now) {
    now = this.getNow(now);
    this._lastReconcileAt = now;
    return reconcileOrphanedProvisionalProfiles({
      customerService: this.customerService,
      db: this.db,
      activeSessions: this.activeSessions,
      staffThreshold: this.staffThreshold,
      emptyChairTimeoutMs: this.emptyChairTimeoutMs,
      now,
      logVerbal: (txt, type) => this.logVerbal(txt, type)
    });
  }

  /**
   * Acumula una muestra facial en la sesión activa con exclusión estricta de personal/barbero
   * @param {number} trackId
   * @param {Object} sample
   * @returns {Promise<boolean>}
   */
  async addFaceSample(trackIdOrChairId, sample = {}) {
    let session = this.activeSessions.get(trackIdOrChairId);
    if (!session) {
      for (const s of this.activeSessions.values()) {
        if (s.chairId === trackIdOrChairId || s.trackId === trackIdOrChairId) {
          session = s;
          break;
        }
      }
    }
    if (!session) return false;
    const now = this.getNow(sample.timestamp || sample.capturedAtEpoch);
    return ingestFaceSample({
      session,
      sample,
      customerService: this.customerService,
      staffThreshold: this.staffThreshold,
      bucket: this.bucket,
      db: this.db,
      now,
      logVerbal: (txt, type) => this.logVerbal(txt, type)
    });
  }

  /**
   * Finaliza la atención cuando la persona se levanta o sale de la escena.
   * Realiza comparación Set-to-Set contra la base de clientes y persiste el appointment.
   * @param {number|string} trackIdOrChairId
   * @param {Object} [options]
   * @returns {Promise<Object|null>}
   */
  async closeSession(trackIdOrChairId, options = {}) {
    let session = this.activeSessions.get(trackIdOrChairId);
    if (!session) {
      for (const s of this.activeSessions.values()) {
        if (s.chairId === trackIdOrChairId || s.trackId === trackIdOrChairId || s.visitId === trackIdOrChairId) {
          session = s;
          break;
        }
      }
    }
    if (!session) return null;

    for (const [key, val] of this.activeSessions.entries()) {
      if (val === session) {
        this.activeSessions.delete(key);
      }
    }
    const trackId = session.trackId;

    const now = this.getNow(options.endedAtEpoch);

    const closureOptions = {
      quadrants: this.quadrants,
      chairZone: this.chairZone,
      ...options
    };

    const result = await executeSessionClosurePipeline({
      session,
      trackId,
      options: closureOptions,
      now,
      minAppointmentMinutes: this.minAppointmentMinutes,
      completedAppointments: this.completedAppointments,
      completedVisits: this.completedVisits,
      maxCompletedAppointments: this.maxCompletedAppointments,
      activeSessions: this.activeSessions,
      customerService: this.customerService,
      sqliteClient: this.sqliteClient,
      db: this.db,
      bucket: this.bucket,
      stats: this.stats,
      trackBlockManager: this.trackBlockManager,
      closeSession: (id, opts) => this.closeSession(id, opts),
      matchSessionAgainstClients: (embs) => this.matchSessionAgainstClients(embs),
      logVerbal: (txt, type) => this.logVerbal(txt, type)
    });

    if (typeof this.onSessionClosed === "function") {
      try {
        this.onSessionClosed({ session, trackId, options: closureOptions, result, endedAtEpoch: now });
      } catch (e) {
        console.warn("[VisitSessionService] Error en callback onSessionClosed:", e.message);
      }
    }

    return result;
  }

  /**
   * Realiza comparación Set-to-Set entre los vectores de la sesión y los perfiles de clientes conocidos
   */
  matchSessionAgainstClients(sessionEmbeddings, threshold = 0.78) {
    const candidateProfiles = this.customerService?.getComparisonProfiles?.() || [];
    return matchSessionAgainstClients(sessionEmbeddings, candidateProfiles, threshold);
  }

  /**
   * Filtra muestras outliers en el cluster de fotos y embeddings de la sesión.
   */
  filterOutlierSamples(photos = [], embeddings = []) {
    return filterOutlierSamples(photos, embeddings);
  }

  /**
   * Deduplica fotos de sesión eliminando miniaturas idénticas y similitud coseno >= 0.88 (misma pose)
   * Limita a un máximo de fotos diversas y nítidas para la atención.
   */
  deduplicateSessionPhotos(photos = [], embeddings = [], maxPhotos = 20) {
    return deduplicateSessionPhotos(photos, embeddings, maxPhotos);
  }

  /**
   * Unifica fotos y embeddings asegurando correspondencia estricta 1:1,
   * deduplicación con similitud >= 0.88 y protección inmutable de la foto canónica inicial (index 0).
   */
  _mergePhotosAndEmbeddings(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
    return mergePhotosAndEmbeddings(existingPhotos, newSessionPhotos, existingEmbeddings, newSessionEmbeddings);
  }

  /**
   * Unifica fotos de la nueva sesión a la galería del cliente sin duplicados (soporta 40+ fotos)
   */
  mergeCustomerPhotos(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
    return mergeCustomerPhotos(existingPhotos, newSessionPhotos, existingEmbeddings, newSessionEmbeddings);
  }

  /**
   * Unifica embeddings de la nueva sesión a la galería del cliente en paralelo con las fotos conservadas
   */
  mergeCustomerEmbeddings(existingEmbeddings = [], newSessionEmbeddings = [], existingPhotos = [], newSessionPhotos = []) {
    return mergeCustomerEmbeddings(existingEmbeddings, newSessionEmbeddings, existingPhotos, newSessionPhotos);
  }

  /**
   * Obtiene las sesiones activas en este momento
   */
  getActiveSessions() {
    return Array.from(new Set(this.activeSessions.values()));
  }

  /**
   * Obtiene la telemetría dinámica enriquecida de las sillas activas para visualización en tiempo real.
   * @param {number} [overrideNow] - Timestamp actual (real o simulado)
   * @param {Object} [trackBlockManager] - Instancia activa de TrackBlockManager
   * @param {Array<Object>} [activeTracks] - Pistas activas de YOLO
   * @returns {Array<Object>}
   */
  getActiveChairSessionsTelemetry(overrideNow, trackBlockManager = null, activeTracks = []) {
    const now = this.getNow(overrideNow);
    const blockMgr = trackBlockManager || this.trackBlockManager;
    const result = [];
    const processedChairs = new Set();

    // 1. Sesiones de atención formalizadas o en corte
    for (const session of this.getActiveSessions()) {
      if (!session || !session.chairId) continue;
      processedChairs.add(session.chairId);

      const elapsedMs = Math.max(0, now - (session.startedAtEpoch || now));
      const elapsedMinutes = Math.floor(elapsedMs / 60000);
      const isVerified = Boolean(
        session.status !== "to_verify" &&
        session.clientName &&
        !session.clientName.toLowerCase().includes("por verificar") &&
        !session.clientName.toLowerCase().includes("confirmación")
      );

      // Bloques confirmados acumulados en la sesión
      const confirmedBlocks = Array.isArray(session.confirmedBlocks)
        ? session.confirmedBlocks.map(cb => ({ ...cb }))
        : [];

      // Si trackBlockManager tiene bloques completados para esta silla, sincronizar
      if (blockMgr?.completedBlocks) {
        for (const cb of blockMgr.completedBlocks) {
          if (cb.chairId === session.chairId && !confirmedBlocks.some(b => b.trackId === cb.trackId)) {
            confirmedBlocks.push({
              trackId: cb.trackId,
              photosCount: cb.photosCount ?? cb.photos?.length ?? cb.crops?.length ?? 0,
              durationSeconds: cb.durationSeconds || Math.max(1, Math.round(((cb.lastSeenEpoch || now) - (cb.startedAtEpoch || now)) / 1000)),
              bestFaceScore: cb.bestFaceScore || 0,
              poses: cb.photos ? Array.from(new Set(cb.photos.map(p => p.pose).filter(Boolean))) : []
            });
          }
        }
      }

      // Bloque actualmente en análisis en esta silla
      let currentBlockInAnalysis = null;
      if (blockMgr?.activeBlocks) {
        for (const b of blockMgr.activeBlocks.values()) {
          if (b.chairId === session.chairId || b.trackId === session.trackId) {
            const latestCrop = b.crops && b.crops.length > 0 ? b.crops[b.crops.length - 1] : null;
            const currentPose = latestCrop?.faceData?.pose || b.bestAnatomicalFace?.pose || (b.photos && b.photos.length > 0 ? b.photos[b.photos.length - 1].pose : "frontal");
            currentBlockInAnalysis = {
              trackId: b.trackId,
              frameCount: b.totalFrames || 0,
              seatedFrames: b.seatedFrames || 0,
              standingFrames: b.standingFrames || 0,
              candidatePhotos: b.crops?.length || b.photos?.length || 0,
              anatomicalCount: b.anatomicalFacesCount || 0,
              pose: currentPose,
              sharpnessScore: Number((b.bestFaceScore || 0).toFixed(1)),
              durationSeconds: Math.max(0, Math.round((now - b.startedAtEpoch) / 1000)),
              maxStaffSim: Number((b.maxStaffSim || 0).toFixed(3)),
          ...this._buildBlockInsight(b, blockMgr, now),
              ...this._buildBlockInsight(b, blockMgr, now),
              thumbnailBase64: b.bestFaceThumbnail || (b.photos && b.photos[0]?.thumbnailBase64) || null
            };
            break;
          }
        }
      }

      // Fallback si no hay bloque en activeBlocks pero hay un track de YOLO en la silla
      if (!currentBlockInAnalysis && Array.isArray(activeTracks)) {
        const chairTrack = activeTracks.find(t =>
          (t.currentQuadrant?.id === session.chairId || t.currentQuadrant?.name === session.chairName) &&
          !t.isStaffHint
        );
        if (chairTrack) {
          currentBlockInAnalysis = {
            trackId: chairTrack.trackId,
            frameCount: chairTrack.framesInChair || 1,
            candidatePhotos: chairTrack.latestFace ? 1 : 0,
            anatomicalCount: 1,
            pose: chairTrack.latestFace?.pose || "frontal",
            sharpnessScore: Number((chairTrack.sharpnessScore || 0).toFixed(1)),
            durationSeconds: Math.max(1, Math.round(elapsedMs / 1000)),
            maxStaffSim: 0,
            thumbnailBase64: chairTrack.latestFace?.thumbnailBase64 || null
          };
        }
      }

      const repPhoto = session.thumbnailBase64 ||
        (session.photos && session.photos.length > 0 ? session.photos[0].thumbnailBase64 : null) ||
        currentBlockInAnalysis?.thumbnailBase64 ||
        null;

      result.push({
        chairId: session.chairId,
        chairName: session.chairName || session.chairZone?.label || session.chairId,
        clientName: session.clientName || session.personName || "Cliente (Por verificar)",
        personId: session.personId || session.tempClientId || session.clientId || null,
        isVerified,
        isConfirmed: isVerified,
        startTime: session.startedAt || new Date(session.startedAtEpoch || now).toISOString(),
        elapsedMinutes,
        photosCount: session.photos?.length || 0,
        confirmedBlocks,
        currentBlockInAnalysis,
        representativePhoto: repPhoto,
        latestCropUrl: session.bestFaceStoragePath || null
      });
    }

    // 2. Sillas con bloques activos en TrackBlockManager que aún no formalizaron una sesión
    if (blockMgr?.activeBlocks) {
      for (const b of blockMgr.activeBlocks.values()) {
        if (!b.chairId || processedChairs.has(b.chairId) || b.isStaffConfirmed) continue;
        processedChairs.add(b.chairId);

        const elapsedMs = Math.max(0, now - (b.startedAtEpoch || now));
        const elapsedMinutes = Math.floor(elapsedMs / 60000);
        const latestCrop = b.crops && b.crops.length > 0 ? b.crops[b.crops.length - 1] : null;
        const currentPose = latestCrop?.faceData?.pose || b.bestAnatomicalFace?.pose || (b.photos && b.photos.length > 0 ? b.photos[b.photos.length - 1].pose : "frontal");

        const currentBlockInAnalysis = {
          trackId: b.trackId,
          frameCount: b.totalFrames || 0,
          seatedFrames: b.seatedFrames || 0,
          standingFrames: b.standingFrames || 0,
          candidatePhotos: b.crops?.length || b.photos?.length || 0,
          anatomicalCount: b.anatomicalFacesCount || 0,
          pose: currentPose,
          sharpnessScore: Number((b.bestFaceScore || 0).toFixed(1)),
          durationSeconds: Math.max(0, Math.round(elapsedMs / 1000)),
          maxStaffSim: Number((b.maxStaffSim || 0).toFixed(3)),
          thumbnailBase64: b.bestFaceThumbnail || (b.photos && b.photos[0]?.thumbnailBase64) || null
        };

        const repPhoto = b.bestFaceThumbnail ||
          (b.photos && b.photos.length > 0 ? b.photos[0].thumbnailBase64 : null) ||
          null;

        result.push({
          chairId: b.chairId,
          chairName: b.chairName || b.chairId,
          clientName: "Cliente (Por verificar)",
          personId: `temp_${b.trackId}`,
          isVerified: false,
          isConfirmed: false,
          startTime: new Date(b.startedAtEpoch || now).toISOString(),
          elapsedMinutes,
          photosCount: b.photos?.length || b.crops?.length || 0,
          confirmedBlocks: [],
          currentBlockInAnalysis,
          representativePhoto: repPhoto,
          latestCropUrl: null
        });
      }
    }

    // 3. Pistas activas de YOLO en sillas de corte no cubiertas por las anteriores
    if (Array.isArray(activeTracks)) {
      for (const track of activeTracks) {
        if (!track || track.isStaffHint) continue;
        const chairId = track.currentQuadrant?.type === "barber_chair" ? track.currentQuadrant.id : null;
        if (!chairId || processedChairs.has(chairId)) continue;
        processedChairs.add(chairId);

        const chairName = track.currentQuadrant?.label || track.currentQuadrant?.name || chairId;
        const elapsedMinutes = Math.floor(((track.framesInChair || 1) * 2) / 60);

        result.push({
          chairId,
          chairName,
          clientName: track.identity?.name || "Cliente (Por verificar)",
          personId: `temp_${track.trackId}`,
          isVerified: Boolean(track.identity?.name && !track.identity.name.toLowerCase().includes("por verificar")),
          isConfirmed: Boolean(track.identity?.name && !track.identity.name.toLowerCase().includes("por verificar")),
          startTime: new Date(now).toISOString(),
          elapsedMinutes,
          photosCount: track.latestFace ? 1 : 0,
          confirmedBlocks: [],
          currentBlockInAnalysis: {
            trackId: track.trackId,
            frameCount: track.framesInChair || 1,
            candidatePhotos: track.latestFace ? 1 : 0,
            anatomicalCount: 1,
            pose: track.latestFace?.pose || "frontal",
            sharpnessScore: Number((track.sharpnessScore || 0).toFixed(1)),
            durationSeconds: Math.max(1, (track.framesInChair || 1) * 2),
            maxStaffSim: 0,
            thumbnailBase64: track.latestFace?.thumbnailBase64 || null
          },
          representativePhoto: track.latestFace?.thumbnailBase64 || null,
          latestCropUrl: null
        });
      }
    }

    return result;
  }
}
