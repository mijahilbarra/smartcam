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
  executeSessionClosurePipeline
} from "./pipeline/appointment_finalizer.js";
import { ingestFaceSample } from "./pipeline/sample_collector.js";
import {
  isChairMatch,
  evaluateChairTimeouts,
  orchestrateChairTrack
} from "./pipeline/chair_tracker.js";

export {
  arePosesCompatibleEnhanced,
  computePoseAwareSimilarity,
  computeSetToSetMetrics
};

export class VisitSessionService {
  constructor({ db, bucket, sqliteClient, customerService, minAppointmentMinutes, emptyChairTimeoutMs, minConsecutiveChairFrames, staffThreshold, clockFn, maxCompletedAppointments } = {}) {
    this.db = db;
    this.bucket = bucket;
    this.sqliteClient = sqliteClient || null;
    this.customerService = customerService || defaultCustomerService;
    this.clockFn = typeof clockFn === "function" ? clockFn : null;
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

    return executeSessionClosurePipeline({
      session,
      trackId,
      options,
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
