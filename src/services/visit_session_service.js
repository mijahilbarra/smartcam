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

      if (hasHomologousComparison) {
        // Hay al menos una pareja homóloga disponible (frontal-frontal, left-left, right-right o tilted-tilted)
        if (maxHomologousSim >= 0.50) {
          // Identidad confirmada por correspondencia homóloga
          isVeto = false;
          this.logVerbal(`🛡️ Identidad confirmada en ${chairName} (maxHomologousSim=${maxHomologousSim.toFixed(3)} [${matchedHomologousCategory}], maxGallerySim=${maxGallerySim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)}): NO hay veto, extendiendo sesión de forma continua.`, "process");
        } else if (maxHomologousSim < 0.35) {
          // Discrepancia real en la misma pose
          if (isPhysicalContinuity && centroidSim >= 0.25) {
            isVeto = false;
            this.logVerbal(`🛡️ Inercia de Silla en ${chairName} (vacancia=${(vacancyMs / 1000).toFixed(1)}s < 10s): Se descarta rotación por continuidad física activa (homologousSim=${maxHomologousSim.toFixed(3)}, centroidSim=${centroidSim.toFixed(3)}).`, "process");
          } else {
            isVeto = true;
            vetoReason = `discrepancia en pose homóloga (${matchedHomologousCategory}: sim=${maxHomologousSim.toFixed(3)} < 0.35, centroidSim=${centroidSim.toFixed(3)})`;
          }
        } else {
          // maxHomologousSim está en zona intermedia [0.35, 0.50)
          const isValidIntermediate = (maxGallerySim >= 0.50 || centroidSim >= 0.40) ||
            (isPhysicalContinuity && centroidSim >= 0.30);
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
        // Prohibido terminantemente que una discrepancia entre poses opuestas dispare un veto si no hay discrepancia en poses homólogas.
        const isAlternateMatch = maxGallerySim >= 0.50 || centroidSim >= 0.45;
        if (isAlternateMatch || isPhysicalContinuity || centroidSim >= 0.30 || maxGallerySim >= 0.40) {
          isVeto = false;
          this.logVerbal(`🛡️ Invarianza de poses opuestas en ${chairName}: No hay discrepancia en poses homólogas, veto omitido y nuevo nicho absorbido (alternateMatch=${isAlternateMatch}, vacancia=${(vacancyMs / 1000).toFixed(1)}s, centroidSim=${centroidSim.toFixed(3)}, maxGallerySim=${maxGallerySim.toFixed(3)}).`, "process");
        } else {
          isVeto = true;
          vetoReason = `vacancia prolongada (${(vacancyMs / 1000).toFixed(1)}s >= 10s) sin poses homólogas ni coincidencia de galería (maxGallerySim=${maxGallerySim.toFixed(3)} < 0.40, centroidSim=${centroidSim.toFixed(3)} < 0.30)`;
        }
      }

      if (isVeto) {
        isRadicalMismatch = true;
        this.logVerbal(`🛑 Veto Homólogo directo en ${chairName} (${vetoReason}). Cerrando sesión previa por rotación.`, "process");
      }

      if (isRadicalMismatch) {
        isRotatedFromMismatch = true;
        await this.closeSession(chairId, {
          endedAtEpoch: block.startedAtEpoch || now
        });
        session = null;
      } else {
        session.lastSeenEpoch = Math.max(session.lastSeenEpoch || 0, block.lastSeenEpoch || now);
        session.lastClientSeenEpoch = Math.max(session.lastClientSeenEpoch || 0, block.lastSeenEpoch || now);
        session.emptySinceEpoch = null;
        if (session.status === "esperando_liberacion") {
          session.status = "en_corte";
        }

        if (block.photos && block.photos.length > 0) {
          const repRef = repPrev?.vector ? repPrev : repBlock;
          const filteredBlockPhotos = [];
          const filteredBlockEmbeddings = [];
          for (let k = 0; k < (block.photos || []).length; k++) {
            const ph = block.photos[k];
            const emb = block.embeddings?.[k] || null;
            const v = isVector(emb) ? emb : (emb?.vector || null);
            if (repRef?.vector && v) {
              const isOpp = isOppositeSide(ph?.pose, repRef?.photo?.pose || repRef?.pose);
              if (!isOpp) {
                const sim = computeCosineSimilarity(v, repRef.vector);
                if (sim < 0.40) continue;
              }
            }
            filteredBlockPhotos.push(ph);
            filteredBlockEmbeddings.push(emb);
          }

          if (filteredBlockPhotos.length > 0) {
            const merged = mergePhotosAndEmbeddings(
              session.photos || [],
              filteredBlockPhotos,
              session.embeddings || [],
              filteredBlockEmbeddings
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

        if (block.trackId && block.trackId !== session.trackId) {
          this.activeSessions.delete(session.trackId);
          session.trackId = block.trackId;
          this.activeSessions.set(block.trackId, session);
        }

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

        this.logVerbal(`🔄 Sesión en ${chairName} extendida con bloque #${block.trackId} (${block.photos?.length || 0} fotos, total: ${session.photos?.length || 0}).`, "info");
        return session;
      }
    }

    const startedAt = block.startedAtEpoch || now;
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
      chairId,
      chairName,
      chairZone: block.chairZone || null,
      startedAt: new Date(startedAt).toISOString(),
      startedAtEpoch: startedAt,
      lastSeenEpoch: block.lastSeenEpoch || now,
      lastClientSeenEpoch: block.lastSeenEpoch || now,
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
      topFaces: []
    };

    this.activeSessions.set(chairId, newSession);
    this.activeSessions.set(block.trackId, newSession);
    if (this.stats) this.stats.sessionsOpened++;

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
}
