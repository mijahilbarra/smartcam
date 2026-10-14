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

import sharp from "sharp";
import { uploadFaceCrop } from "../infrastructure/firebase/storage_client.js";
import { isServiceChair as isServiceChairRule, isTransitZone } from "../core/barbershop_rules.js";
import { computeCosineSimilarity, extractFaceEmbedding, arePosesCompatible } from "../face_recognizer.js";
import { matchStaffFace } from "./people_service.js";
import { customerService as defaultCustomerService } from "./customer_service.js";
import { daemonReporter } from "../daemon_reporter.js";

export class VisitSessionService {
  constructor({ db, bucket, sqliteClient, customerService, minAppointmentMinutes, emptyChairTimeoutMs, minConsecutiveChairFrames } = {}) {
    this.db = db;
    this.bucket = bucket;
    this.sqliteClient = sqliteClient || null;
    this.customerService = customerService || defaultCustomerService;
    this.minAppointmentMinutes = typeof minAppointmentMinutes === "number"
      ? minAppointmentMinutes
      : (process.env.MIN_APPOINTMENT_MINUTES ? parseInt(process.env.MIN_APPOINTMENT_MINUTES, 10) : 10);
    this.emptyChairTimeoutMs = typeof emptyChairTimeoutMs === "number"
      ? emptyChairTimeoutMs
      : (process.env.EMPTY_CHAIR_TIMEOUT_MS ? parseInt(process.env.EMPTY_CHAIR_TIMEOUT_MS, 10) : 30000);
    this.minConsecutiveChairFrames = typeof minConsecutiveChairFrames === "number"
      ? minConsecutiveChairFrames
      : (process.env.MIN_CONSECUTIVE_CHAIR_FRAMES ? parseInt(process.env.MIN_CONSECUTIVE_CHAIR_FRAMES, 10) : 6);
    this.activeSessions = new Map(); // trackId -> Session
    this.completedAppointments = [];
    this.completedVisits = [];
    this._lastReconcileAt = 0;
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
    const now = options.now || Date.now();
    const isChair = this.isServiceChair(track.currentQuadrant);

    if (!isChair) {
      return null;
    }

    const chairId = track.currentQuadrant.id;
    const chairName = track.currentQuadrant.label || track.currentQuadrant.name || chairId;

    // 1. Buscar si ya existe una sesión activa para esta silla o para este trackId
    let session = this.findSessionByChair(chairId) || this.activeSessions.get(track.trackId);

    // Si viene miniatura pero no embedding en bestFace, extraer embedding de inmediato
    if (track.bestFace && !track.bestFace.embedding && track.bestFace.thumbnailBase64) {
      try {
        const raw = track.bestFace.thumbnailBase64.replace(/^data:image\/[a-z]+;base64,/, "");
        track.bestFace.embedding = await extractFaceEmbedding(Buffer.from(raw, "base64"));
      } catch (_) {}
    }

    // Si tiene embedding facial, evaluar contra Barbero/Staff (umbral definitivo 0.50)
    if (track.bestFace?.embedding) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffCheck = matchStaffFace(track.bestFace.embedding, knownProfiles, 0.50);
      if (staffCheck.isStaffMatch || staffCheck.maxStaffSim >= 0.50) {
        track.role = "staff";
        track.isStaffHint = true;
        if (track.identity) track.identity.isStaff = true;
        return null;
      }
    }

    // Si es personal/barbero, no se registra como atención de cliente
    if (track.identity?.isStaff || track.isStaffHint || track.role === "staff") {
      return null;
    }

    if (session) {
      // Detección de rotación rápida de clientes (< 30s):
      // Si la sesión está en 'esperando_liberacion' y entra una persona nueva con trackId distinto:
      if (session.status === "esperando_liberacion" && session.trackId !== track.trackId) {
        let isDifferentClient = false;
        const newEmbedding = track.bestFace?.embedding;
        if (newEmbedding && session.embeddings && session.embeddings.length > 0) {
          const canonicalVector = Array.isArray(session.embeddings[0])
            ? session.embeddings[0]
            : (session.embeddings[0]?.vector || null);
          if (canonicalVector) {
            const sim = computeCosineSimilarity(newEmbedding, canonicalVector);
            if (sim < 0.45) {
              isDifferentClient = true;
              this.logVerbal(`🔄 Rotación rápida en ${session.chairName}: nuevo cliente (Track #${track.trackId}) difiere del previo (similitud: ${sim.toFixed(3)} < 0.45). Cerrando atención anterior...`, "process");
            }
          }
        }

        if (isDifferentClient) {
          const endedAt = session.emptySinceEpoch || now;
          const durationMin = Math.max(1, Math.round((endedAt - session.startedAtEpoch) / 60000));
          await this.closeSession(session.trackId, {
            endedAtEpoch: endedAt,
            durationMinutes: durationMin
          });
          session = null;
        }
      }
    }

    if (session) {
      // Re-indexar si el trackId cambió por saltos transitorios de YOLO
      if (session.trackId !== track.trackId) {
        this.activeSessions.delete(session.trackId);
        session.trackId = track.trackId;
        this.activeSessions.set(track.trackId, session);
      }

      session.lastSeenEpoch = now;

      // Sincronizar identidad si el track fue formalmente identificado
      if (track.identity && track.identity.personId && !track.identity.isCandidate && !track.identity.isPendingConfirmation) {
        session.personId = track.identity.personId;
        session.personName = track.identity.name;
        session.clientId = track.identity.personId;
        session.clientName = track.identity.name;
        session.isStaff = !!track.identity.isStaff;
        session.visitCount = track.identity.visitCount || session.visitCount || 1;
      }

      if (session.status === "esperando_liberacion") {
        session.status = "en_corte";
        session.emptySinceEpoch = null;
        this.logVerbal(`🔄 Persona retomó la silla ${session.chairName}. Reanudando atención.`, "process");
      } else {
        // Log periódico de presencia cada 60 segundos
        if (now - (session.lastPresenceLogAt || 0) >= 60000) {
          session.lastPresenceLogAt = now;
          const elapsedMin = Math.max(1, Math.round((now - session.startedAtEpoch) / 60000));
          this.logVerbal(`✂️ La silla ${session.chairName} no parece vacía. Corte en progreso (${elapsedMin} min).`, "info");
        }
      }

      // Si tiene una cara nítida en track.bestFace, agregarla a la atención
      if (track.bestFace && track.bestFace.sharpnessScore > 0) {
        await this.addFaceSample(session.trackId, {
          faceBuffer: track.bestFace.faceBuffer,
          sharpnessScore: track.bestFace.sharpnessScore || 0,
          embedding: track.bestFace.embedding || track.identity?.embedding || null,
          thumbnailBase64: track.bestFace.thumbnailBase64 || null,
          isStaff: false,
          pose: track.bestFace.pose || track.identity?.pose || 'frontal',
          poseLabel: track.bestFace.poseLabel || track.identity?.poseLabel || 'Frontal'
        });
      }

      return session;
    }

    // 2. Iniciar nueva sesión si entra a una silla de atención sin sesión previa
    // Exigir al menos minConsecutiveChairFrames (default 6) antes de abrir una nueva atención
    const minFrames = options.minConsecutiveChairFrames ?? this.minConsecutiveChairFrames ?? 6;
    const chairFrames = track.consecutiveChairFrames !== undefined ? track.consecutiveChairFrames : minFrames;
    if (chairFrames < minFrames) {
      return null; // Transeúnte en tránsito o debounce insuficiente: no abrir atención efímera
    }

    // Blindaje contra Barbero/Staff en la silla:
    // Si la persona ya tiene un rostro con coincidencia indudable de staff (>= 0.50), no abrir atención de cliente
    if (track.bestFace?.embedding) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffCheck = matchStaffFace(track.bestFace.embedding, knownProfiles, 0.50);
      if (staffCheck.isStaffMatch || staffCheck.maxStaffSim >= 0.50) {
        return null;
      }
    }

    const tempClientId = `person_${now}_${track.trackId}`;
    const visitId = `appt_${now}_${track.trackId}`;
    const startedAt = track.chairEnteredAt || now;
    session = {
      id: visitId,
      visitId,
      appointmentId: visitId,
      trackId: track.trackId,
      chairId,
      chairName,
      startedAt: new Date(startedAt).toISOString(),
      startedAtEpoch: startedAt,
      lastSeenEpoch: now,
      emptySinceEpoch: null,
      lastPresenceLogAt: now,
      status: "en_corte",
      tempClientId,
      personId: tempClientId,
      personName: "Cliente (Por verificar)",
      clientId: tempClientId,
      clientName: "Cliente (Por verificar)",
      isStaff: false,
      visitCount: 1,
      bestFaceScore: track.bestFace?.sharpnessScore || 0,
      bestFaceStoragePath: null,
      thumbnailBase64: track.bestFace?.thumbnailBase64 || null,
      lastPhotoAt: 0,
      lastSyncAt: now,
      photos: [],
      embeddings: [],
      topFaces: []
    };
    this.activeSessions.set(track.trackId, session);
    this.logVerbal(`💺 Persona se sienta en ${session.chairName}. Creando cliente en estado "to_verify" e iniciando registro de atención.`, "process");

    // Crear inmediatamente el perfil to_verify en Firestore y SQLite para visualización en tiempo real
    if (this.customerService) {
      const initialPhotos = [];
      if (track.bestFace?.thumbnailBase64) {
        initialPhotos.push({
          thumbnailBase64: track.bestFace.thumbnailBase64,
          sharpnessScore: track.bestFace.sharpnessScore || 0,
          capturedAt: new Date(now).toISOString(),
          pose: track.bestFace.pose || 'frontal',
          poseLabel: track.bestFace.poseLabel || 'Frontal'
        });
      }
      const initialEmbeddings = [];
      if (track.bestFace?.embedding) {
        initialEmbeddings.push(track.bestFace.embedding);
      }
      const provisionalCustomer = {
        id: tempClientId,
        name: "Cliente (Por verificar)",
        status: "to_verify",
        isStaff: false,
        role: "client",
        firstSeen: new Date(startedAt).toISOString(),
        lastSeen: new Date(now).toISOString(),
        visitCount: 1,
        appointmentCount: 1,
        bestFaceScore: track.bestFace?.sharpnessScore || 0,
        thumbnailBase64: track.bestFace?.thumbnailBase64 || null,
        thumbnailPath: null,
        photos: initialPhotos,
        embeddings: initialEmbeddings,
        embedding: initialEmbeddings[0] || null
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

    if (track.bestFace && track.bestFace.sharpnessScore > 0) {
      await this.addFaceSample(track.trackId, {
        faceBuffer: track.bestFace.faceBuffer,
        sharpnessScore: track.bestFace.sharpnessScore || 0,
        embedding: track.bestFace.embedding || null,
        thumbnailBase64: track.bestFace.thumbnailBase64 || null,
        isStaff: false,
        pose: track.bestFace.pose || 'frontal',
        poseLabel: track.bestFace.poseLabel || 'Frontal'
      });
    }

    return session;
  }

  /**
   * Revisa todas las sesiones en sillas y activa el contador de 30s si la silla se libera,
   * o cierra la atención automáticamente si la silla permanece vacía por >= 30s.
   * @param {number} [now=Date.now()]
   * @param {Array<Object>} [activeTracks=[]]
   * @returns {Promise<Array<Object>>} Atenciones cerradas
   */
  async checkChairTimeouts(now = Date.now(), activeTracks = []) {
    const closed = [];
    for (const session of Array.from(this.activeSessions.values())) {
      const isChairMatch = (t) => {
        const qId = t.currentQuadrant?.id;
        const qName = t.currentQuadrant?.name || t.currentQuadrant?.label;
        const sChairIdClean = session.chairId?.replace(/^person_/, "");
        const inQuadrant = (qId && (qId === session.chairId || qId === sChairIdClean)) ||
               (qName && (qName === session.chairName || session.chairName?.includes(qName) || qName?.includes(session.chairName)));
        if (inQuadrant) return true;
        if (t.lastChairQuadrant && (t.lastChairQuadrant.id === session.chairId || t.lastChairQuadrant.id === sChairIdClean)) {
          return true;
        }
        return false;
      };

      // Histéresis de presencia:
      // Si la atención ya está "en_corte", tolerar detecciones del cliente >= 0.22 (giros de cabeza o visto de espaldas)
      // Si la atención está en "esperando_liberacion", exigir >= 0.50 para que el cabezal vacío (< 0.50) no cancele la salida
      const minConfidence = session.status === "en_corte" ? 0.22 : 0.50;

      const trackInChair = activeTracks.find(t => {
        if (t.role === "staff" || t.isStaffHint === true || t.identity?.isStaff === true) {
          return false;
        }
        if ((t.confidence || 0) < minConfidence) {
          return false;
        }
        return isChairMatch(t) || t.trackId === session.trackId;
      });

      // Anclaje por co-presencia activa del Barbero (Barber Working Anchor):
      // Si el barbero está trabajando activamente en o junto a esta silla, el corte está en progreso
      const barberWorkingAtChair = activeTracks.find(t => {
        const isStaff = t.role === "staff" || t.isStaffHint === true || t.identity?.isStaff === true;
        if (!isStaff) return false;
        return isChairMatch(t);
      });

      if (trackInChair) {
        if (session.status === "esperando_liberacion") {
          // Si entra una persona nueva con trackId distinto y rostro diferente antes de 30s:
          if (trackInChair.trackId !== session.trackId && trackInChair.bestFace?.embedding && session.embeddings?.length > 0) {
            const canonicalVector = Array.isArray(session.embeddings[0])
              ? session.embeddings[0]
              : (session.embeddings[0]?.vector || null);
            if (canonicalVector) {
              const sim = computeCosineSimilarity(trackInChair.bestFace.embedding, canonicalVector);
              if (sim < 0.45) {
                const endedAt = session.emptySinceEpoch || now;
                const durationMin = Math.max(1, Math.round((endedAt - session.startedAtEpoch) / 60000));
                this.logVerbal(`🔄 Rotación rápida en ${session.chairName}: nuevo cliente detectado antes de 30s (similitud: ${sim.toFixed(3)} < 0.45). Finalizando atención previa...`, "process");
                const appt = await this.closeSession(session.trackId, {
                  endedAtEpoch: endedAt,
                  durationMinutes: durationMin
                });
                if (appt) closed.push(appt);
                await this.processTrack(trackInChair, { now });
                continue;
              }
            }
          }
          session.status = "en_corte";
          session.emptySinceEpoch = null;
          this.logVerbal(`🔄 Persona retomó la silla ${session.chairName}. Reanudando atención.`, "process");
        }
        session.lastSeenEpoch = now;
      } else if (session.status === "en_corte" && barberWorkingAtChair) {
        // El barbero está trabajando activamente en la silla: corte en progreso aunque el cliente esté temporalmente de espaldas u ocluido
        session.lastSeenEpoch = now;
      } else {
        // Ni cliente ni barbero presentes en la silla
        if (session.status === "en_corte") {
          session.status = "esperando_liberacion";
          session.emptySinceEpoch = now;
          this.logVerbal(`⏳ Persona se levantó de ${session.chairName}. Silla liberada. Esperando 30s para confirmar si la atención terminó...`, "process");
        } else if (session.status === "esperando_liberacion") {
          const emptyElapsed = now - (session.emptySinceEpoch || now);
          if (emptyElapsed >= this.emptyChairTimeoutMs) {
            const durationMin = Math.max(1, Math.round(((session.emptySinceEpoch || now) - session.startedAtEpoch) / 60000));
            this.logVerbal(`🚪 La persona se fue. Silla ${session.chairName} liberada por más de 30s. Finalizando atención de ${durationMin} min...`, "process");
            const appt = await this.closeSession(session.trackId, {
              endedAtEpoch: session.emptySinceEpoch || now,
              durationMinutes: durationMin
            });
            if (appt) closed.push(appt);
          }
        }
      }
    }

    // Reconciliación automática periódica de perfiles 'to_verify' huérfanos o pertenecientes al Barbero
    if (now - (this._lastReconcileAt || 0) >= 15000) {
      await this.reconcileOrphanedProvisionalProfiles(now);
    }

    return closed;
  }

  /**
   * Reconciliador automático de perfiles provisionales ("to_verify").
   * Detecta y auto-elimina perfiles que:
   * 1. Pertenecen al Barbero (incluso en posturas inclinadas o hacia abajo con similitud >= 0.35)
   * 2. O son perfiles huérfanos/abandonados (sin sesión activa en curso y con inactividad >= emptyChairTimeoutMs)
   * @param {number} [now=Date.now()]
   * @returns {Promise<number>} Número de perfiles auto-eliminados
   */
  async reconcileOrphanedProvisionalProfiles(now = Date.now()) {
    this._lastReconcileAt = now;
    if (!this.customerService) return 0;

    let deletedCount = 0;
    try {
      const candidates = new Map();

      // Candidatos en memoria RAM
      if (this.customerService.profilesCache) {
        for (const [id, p] of this.customerService.profilesCache.entries()) {
          if (p.status === "to_verify" || /^Cliente\s*\(Por verificar\)/i.test(p.name || "")) {
            candidates.set(id, p);
          }
        }
      }

      // Candidatos en Firestore (camera_catcher_people)
      const firestoreInstance = this.db || this.customerService?.db;
      if (firestoreInstance && typeof firestoreInstance.collection === "function") {
        try {
          const snap = await firestoreInstance.collection("camera_catcher_people").where("status", "==", "to_verify").get();
          if (snap && !snap.empty) {
            snap.forEach(docSnap => {
              const data = docSnap.data();
              const id = docSnap.id || data.id;
              if (id) {
                candidates.set(id, { id, ...data });
              }
            });
          }
        } catch (_) {}
      }

      if (candidates.size === 0) return 0;

      // Obtener perfiles y vectores del Staff / Barbero
      const knownProfiles = this.customerService.getComparisonProfiles?.() || [];
      const staffProfiles = knownProfiles.filter(p => {
        if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
        if (p.role === "client" || p.isStaff === false) return false;
        return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
      });

      const staffVectors = [];
      for (const staff of staffProfiles) {
        if (Array.isArray(staff.embeddings)) {
          for (const item of staff.embeddings) {
            if (Array.isArray(item)) staffVectors.push(item);
            else if (item && Array.isArray(item.vector)) staffVectors.push(item.vector);
          }
        }
        if (staffVectors.length === 0 && Array.isArray(staff.embedding)) {
          staffVectors.push(staff.embedding);
        }
      }

      // Si no hay vectores en RAM, consultar staff_barbero en Firestore
      if (staffVectors.length === 0 && firestoreInstance && typeof firestoreInstance.doc === "function") {
        try {
          const sDoc = await firestoreInstance.doc("camera_catcher_people/staff_barbero").get();
          if (sDoc && sDoc.exists) {
            const sData = sDoc.data();
            if (Array.isArray(sData.embeddings)) {
              for (const item of sData.embeddings) {
                const v = Array.isArray(item) ? item : item?.vector;
                if (v) staffVectors.push(v);
              }
            }
            if (staffVectors.length === 0 && Array.isArray(sData.embedding)) {
              staffVectors.push(sData.embedding);
            }
          }
        } catch (_) {}
      }

      for (const [candId, cand] of candidates.entries()) {
        const isAttachedToActiveSession = Array.from(this.activeSessions.values()).some(
          s => s.tempClientId === candId || s.personId === candId || s.clientId === candId
        );

        let maxStaffSim = 0;

        // Evaluar embeddings existentes
        if (Array.isArray(cand.embeddings)) {
          for (const item of cand.embeddings) {
            const v = Array.isArray(item) ? item : item?.vector;
            if (v && staffVectors.length > 0) {
              for (const sv of staffVectors) {
                const sim = computeCosineSimilarity(v, sv);
                if (sim > maxStaffSim) maxStaffSim = sim;
              }
            }
          }
        }

        const staffExclusionThreshold = 0.50;

        // Si no tiene embeddings pero tiene fotos, extraer embedding ONNX bajo demanda
        if (maxStaffSim < staffExclusionThreshold && Array.isArray(cand.photos) && staffVectors.length > 0) {
          for (const ph of cand.photos) {
            if (ph.thumbnailBase64) {
              try {
                const base64Data = ph.thumbnailBase64.replace(/^data:image\/[a-z]+;base64,/, "");
                const buf = Buffer.from(base64Data, "base64");
                const emb = await extractFaceEmbedding(buf);
                if (emb) {
                  for (const sv of staffVectors) {
                    const sim = computeCosineSimilarity(emb, sv);
                    if (sim > maxStaffSim) maxStaffSim = sim;
                  }
                }
              } catch (_) {}
            }
          }
        }

        const isBarberMatch = maxStaffSim >= staffExclusionThreshold;

        if (isBarberMatch) {
          // Descartar cualquier sesión en curso que pertenezca al barbero
          for (const [tId, s] of this.activeSessions.entries()) {
            if (s.tempClientId === candId || s.personId === candId) {
              this.activeSessions.delete(tId);
            }
          }
          this.logVerbal(`🧹 Auto-eliminando perfil "to_verify" (${candId}): Foto coincide con el Barbero/Staff (similitud: ${maxStaffSim.toFixed(3)} >= ${staffExclusionThreshold.toFixed(2)}).`, "process");
          await this.customerService.deleteCustomer(candId, { db: firestoreInstance });
          deletedCount++;
          continue;
        }

        // Si no está en una sesión activa, verificar si fue abandonado
        if (!isAttachedToActiveSession) {
          const lastActivityEpoch = cand.lastSeen ? new Date(cand.lastSeen).getTime() : (cand.firstSeen ? new Date(cand.firstSeen).getTime() : 0);
          const elapsedInactive = now - lastActivityEpoch;

          if (elapsedInactive >= (this.emptyChairTimeoutMs || 30000)) {
            this.logVerbal(`🧹 Auto-eliminando perfil "to_verify" huérfano (${candId}): Silla vacía y sin atención activa (${Math.round(elapsedInactive / 1000)}s inactivo).`, "process");
            await this.customerService.deleteCustomer(candId, { db: firestoreInstance });
            deletedCount++;
          }
        }
      }
    } catch (err) {
      console.warn(`[Appointment] Aviso en reconciliación automática de to_verify:`, err.message);
    }
    return deletedCount;
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
    const trackId = session.trackId;
    const { faceBuffer, sharpnessScore = 0, embedding, thumbnailBase64, isStaff, pose, poseLabel, skipCooldown } = sample;

    // 1. Exclusión estricta del barbero/staff (umbral 0.46 sensible):
    if (isStaff) {
      console.log(`[Appointment] Rostro en ${session.chairName} pertenece a Staff. Excluido de atención.`);
      return false;
    }

    // Solo excluir en caliente si es confirmación indudable de Staff (similitud >= 0.52).
    // La depuración y exclusión estricta anti-barbero (si se parece más al barbero que al cliente)
    // se realiza de forma limpia y completa al final en closeSession().
    if (embedding) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffCheck = matchStaffFace(embedding, knownProfiles, 0.48, { pose: sample.pose });
      if (staffCheck.isStaffMatch || staffCheck.maxStaffSim >= 0.48) {
        console.log(`[Appointment] Rostro en ${session.chairName} coincide con Barbero/Staff (Sim: ${staffCheck.maxStaffSim.toFixed(3)}, SamePoseSim: ${staffCheck.maxSamePoseSim?.toFixed(3) || 0}). Excluido de atención.`);
        return false;
      }
    }

    // Captura continua en silla con YOLO: mientras la persona esté sentada,
    // se acumulan muestras de calidad respetando cadencia temporal y poses.
    // La depuración y selección final (anti-barbero y anti-outliers) se realiza al finalizar en closeSession().

    // 2. Resolver miniatura en base64 (si solo viene el buffer, convertir con Sharp)
    let finalThumbnailBase64 = thumbnailBase64 || null;
    if (!finalThumbnailBase64 && faceBuffer) {
      try {
        const thumbBuf = await sharp(faceBuffer)
          .resize(120, 120, { fit: "cover" })
          .jpeg({ quality: 82 })
          .toBuffer();
        finalThumbnailBase64 = `data:image/jpeg;base64,${thumbBuf.toString("base64")}`;
      } catch (_) {
        finalThumbnailBase64 = `data:image/jpeg;base64,${faceBuffer.toString("base64")}`;
      }
    }

    // Requerir miniatura válida antes de guardar foto en la atención
    if (!finalThumbnailBase64) {
      return false;
    }

    const now = sample.timestamp || sample.capturedAtEpoch || Date.now();
    const incomingPose = pose || 'frontal';
    const incomingPoseLabel = poseLabel || (incomingPose === 'frontal' ? 'Frontal' : incomingPose);
    const isFrontalOrSemi = ['frontal', 'semi_left', 'semi_right', 'tilted_up', 'tilted_down', 'tilted_up_left', 'tilted_up_right', 'tilted_down_left', 'tilted_down_right'].includes(sample.pose || 'frontal');

    const photoItem = {
      thumbnailBase64: finalThumbnailBase64,
      sharpnessScore,
      capturedAt: new Date(now).toISOString(),
      pose: incomingPose,
      poseLabel: incomingPoseLabel
    };

    // 2b. Verificación por miniatura idéntica en base64
    if (finalThumbnailBase64 && session.photos.length > 0) {
      const exactIdx = session.photos.findIndex(p => p.thumbnailBase64 && p.thumbnailBase64 === finalThumbnailBase64);
      if (exactIdx !== -1) {
        if (sharpnessScore > (session.photos[exactIdx].sharpnessScore || 0)) {
          session.photos[exactIdx] = photoItem;
          if (embedding && session.embeddings[exactIdx]) session.embeddings[exactIdx] = embedding;
          session.lastPhotoAt = now;
        }
        return false;
      }
    }

    // 3. Verificación de duplicado cercano / congelado (fotograma idéntico: embedding sim >= 0.985)
    if (embedding && session.embeddings.length > 0) {
      let duplicateIdx = -1;
      for (let i = 0; i < session.embeddings.length; i++) {
        const exEmb = session.embeddings[i];
        const sim = computeCosineSimilarity(embedding, exEmb);
        if (sim >= 0.985) {
          duplicateIdx = i;
          break;
        }
      }

      if (duplicateIdx !== -1) {
        const existingSharpness = session.photos[duplicateIdx]?.sharpnessScore || 0;
        if (sharpnessScore > existingSharpness) {
          session.photos[duplicateIdx] = photoItem;
          session.embeddings[duplicateIdx] = embedding;
          session.lastPhotoAt = now;
          if (sharpnessScore > (session.bestFaceScore || 0) && isFrontalOrSemi) {
            session.bestFaceScore = sharpnessScore;
            session.thumbnailBase64 = finalThumbnailBase64;
          }
          this.logVerbal(`📸 Muestra facial actualizada por mayor nitidez en atención (#${duplicateIdx + 1}, Nitidez: ${sharpnessScore}).`, "process");
          return true;
        }
        return false;
      }
    }

    // 4. Control de cadencia temporal ("de vez en cuando"):
    // Si la última foto tomada fue hace menos de 20 segundos y es la MISMA pose, solo actualizar si mejora nitidez
    const isFastForward = Boolean(process.env.STREAM_FAST_FORWARD === "true");
    const cooldownMs = isFastForward ? 2000 : 20000;
    const samePoseIdx = session.photos.findIndex(p => p.pose === incomingPose);

    if (session.photos.length > 0 && session.lastPhotoAt && !skipCooldown && (now - session.lastPhotoAt < cooldownMs)) {
      if (samePoseIdx !== -1) {
        if (sharpnessScore > (session.photos[samePoseIdx].sharpnessScore || 0)) {
          session.photos[samePoseIdx] = photoItem;
          if (embedding && session.embeddings[samePoseIdx]) {
            session.embeddings[samePoseIdx] = embedding;
          }
          session.lastPhotoAt = now;
          if (sharpnessScore > (session.bestFaceScore || 0) && isFrontalOrSemi) {
            session.bestFaceScore = sharpnessScore;
            session.thumbnailBase64 = finalThumbnailBase64;
          }
        }
        return false;
      }
      // Si es una pose distinta o ángulo nuevo, permitir acumularlo directamente
    }

    // 5. Acumulación de fotos y embeddings (hasta 20 recortes por atención)
    if (session.photos.length < 20) {
      session.photos.push(photoItem);
      if (embedding) session.embeddings.push(embedding);
    } else {
      // Reemplazar la de menor nitidez si la nueva supera
      let minIdx = -1;
      let minScore = sharpnessScore;
      for (let i = 1; i < session.photos.length; i++) {
        if ((session.photos[i].sharpnessScore || 0) < minScore) {
          minScore = session.photos[i].sharpnessScore || 0;
          minIdx = i;
        }
      }
      if (minIdx > 0) {
        session.photos[minIdx] = photoItem;
        if (embedding && session.embeddings[minIdx]) {
          session.embeddings[minIdx] = embedding;
        }
      }
    }

    session.lastPhotoAt = now;

    // Actualizar bestFaceScore y miniatura con Protección de Miniatura (solo frontal o semi-frontal)
    if (sharpnessScore > (session.bestFaceScore || 0) && isFrontalOrSemi) {
      session.bestFaceScore = sharpnessScore;
      session.thumbnailBase64 = finalThumbnailBase64;

      if (this.bucket && faceBuffer) {
        const personSlug = session.personId || `track_${trackId}`;
        const faceStoragePath = `camera_catcher/faces/${personSlug}_${now}.jpg`;
        try {
          await uploadFaceCrop(this.bucket, faceStoragePath, faceBuffer, {
            personId: session.personId || "",
            personName: session.personName || "",
            sharpnessScore: session.bestFaceScore,
            visitId: session.visitId
          });
          session.bestFaceStoragePath = faceStoragePath;
        } catch (uploadErr) {
          console.warn(`[Appointment] Aviso al subir recorte a Storage:`, uploadErr.message);
        }
      }
    }

    // 6. Sincronización periódica en vivo del perfil 'to_verify' hacia Firestore/SQLite (cada 15s)
    if (this.customerService && session.tempClientId) {
      const timeSinceLastSync = now - (session.lastSyncAt || 0);
      if (timeSinceLastSync >= 15000 || session.photos.length === 1) {
        session.lastSyncAt = now;
        const updatedToVerify = {
          id: session.tempClientId,
          name: session.personName || "Cliente (Por verificar)",
          status: "to_verify",
          isStaff: false,
          role: "client",
          lastSeen: new Date(now).toISOString(),
          visitCount: 1,
          appointmentCount: 1,
          bestFaceScore: session.bestFaceScore || 0,
          thumbnailBase64: session.thumbnailBase64 || session.photos[0]?.thumbnailBase64 || null,
          thumbnailPath: session.bestFaceStoragePath || null,
          photos: session.photos,
          embeddings: session.embeddings,
          embedding: session.embeddings[0] || null
        };
        this.customerService.saveOrUpdateCustomer(updatedToVerify, {
          db: this.db,
          bucket: this.bucket,
          galleryUpdated: true,
          forceSync: true,
          backgroundSync: true
        }).catch(err => {
          console.warn(`[Appointment] Error en live-sync de to_verify:`, err.message);
        });
      }
    }

    this.logVerbal(`📸 Muestra facial recolectada para la atención (#${session.photos.length}/20, Nitidez: ${sharpnessScore}).`, "process");
    return true;
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

    this.activeSessions.delete(session.trackId);
    const trackId = session.trackId;

    const now = options.endedAtEpoch || Date.now();
    const durationMs = now - session.startedAtEpoch;
    const durationMinutes = options.durationMinutes !== undefined
      ? options.durationMinutes
      : Math.max(1, Math.round(durationMs / 60000));

    // 1. Si es personal/barbero, no se registra como atención de cliente
    if (session.isStaff) {
      if (session.tempClientId) {
        await this.customerService?.deleteCustomer?.(session.tempClientId, { db: this.db });
      }
      if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
        await this.customerService?.deleteCustomer?.(session.personId, { db: this.db });
      }
      this.logVerbal(`Atención descartada para Barbero/Staff: ${session.personName || `Track #${trackId}`}.`, "info");
      return null;
    }

    session.status = "to_verify";

    // 2. Comprobar umbral de permanencia mínima obligatoria (mínimo 10 min)
    const minMinutes = options.minMinutes !== undefined ? options.minMinutes : this.minAppointmentMinutes;
    if (durationMinutes < minMinutes) {
      if (session.tempClientId) {
        await this.customerService?.deleteCustomer?.(session.tempClientId, { db: this.db });
      }
      if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
        await this.customerService?.deleteCustomer?.(session.personId, { db: this.db });
      }
      this.logVerbal(`⏱️ Estancia de ${durationMinutes} min en ${session.chairName} descartada (< ${minMinutes} min - transeúnte o cancelada).`, "info");
      return null;
    }

    // Sincronizar todas las fotos acumuladas en customerService si tiene más muestras que la sesión
    const custData = this.customerService?.getCustomerData?.(session.personId) ||
                     this.customerService?.getCustomerData?.(session.tempClientId);
    if (custData && Array.isArray(custData.photos) && custData.photos.length > (session.photos?.length || 0)) {
      session.photos = [...custData.photos];
      session.embeddings = Array.isArray(custData.embeddings) ? [...custData.embeddings] : (Array.isArray(custData.embedding) ? [custData.embedding] : []);
    }

    // Snapshot de fotos antes de closeSession (para auditoría y reporte)
    session.photosBeforeClose = session.photos ? [...session.photos] : [];
    session.embeddingsBeforeClose = session.embeddings ? [...session.embeddings] : [];

    // 3. Purga estricta de fotos individuales del Barbero / Staff en el cluster
    if (session.photos && session.photos.length > 0 && session.embeddings && session.embeddings.length > 0) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffProfiles = knownProfiles.filter(p => {
        if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
        if (p.role === "client" || p.isStaff === false) return false;
        return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
      });

      if (staffProfiles.length > 0) {
        const staffVectors = [];
        for (const staff of staffProfiles) {
          if (Array.isArray(staff.embeddings)) {
            for (const item of staff.embeddings) {
              if (Array.isArray(item)) {
                staffVectors.push({ vector: item, pose: 'frontal' });
              } else if (item && Array.isArray(item.vector)) {
                staffVectors.push({ vector: item.vector, pose: item.pose || 'frontal', poseLabel: item.poseLabel || 'Frontal' });
              }
            }
          }
          if (staffVectors.length === 0 && Array.isArray(staff.embedding)) {
            staffVectors.push({ vector: staff.embedding, pose: 'frontal' });
          }
        }

        if (staffVectors.length > 0) {
          const cleanPhotos = [];
          const cleanEmbeddings = [];
          const N = Math.min(session.photos.length, session.embeddings.length);
          const rawVectors = session.embeddings.slice(0, N).map(e => Array.isArray(e) ? e : (e?.vector || null));

          for (let i = 0; i < N; i++) {
            const sVec = rawVectors[i];
            const photoPose = session.photos[i]?.pose || 'frontal';
            let isStaffPhoto = false;
            let maxStaffSim = 0;
            let maxStaffSamePoseSim = 0;

            if (sVec) {
              for (const sv of staffVectors) {
                const sim = computeCosineSimilarity(sVec, sv.vector);
                if (sim > maxStaffSim) maxStaffSim = sim;
                if (arePosesCompatible(photoPose, sv.pose)) {
                  if (sim > maxStaffSamePoseSim) maxStaffSamePoseSim = sim;
                }
              }

              // Calcular afinidad de esta foto con el resto de fotos de la sesión
              let maxClientSim = 0;
              for (let j = 0; j < N; j++) {
                if (i === j || !rawVectors[j]) continue;
                const cSim = computeCosineSimilarity(sVec, rawVectors[j]);
                if (cSim > maxClientSim) maxClientSim = cSim;
              }

              // REGLA:
              // 1. Similitud alta directa con el barbero (>= 0.47)
              // 2. Coincidencia en la misma orientación facial (>= 0.44)
              // 3. Afinidad relativa: se parece más al barbero que al resto del cliente (maxStaffSim > maxClientSim y maxStaffSim >= 0.28)
              if (maxStaffSim >= 0.47 || maxStaffSamePoseSim >= 0.44 || (N > 1 && maxStaffSim > maxClientSim && maxStaffSim >= 0.28)) {
                isStaffPhoto = true;
                console.log(`[Appointment] ✂️ Purga de cluster: Eliminada foto #${i + 1} (${photoPose}) del corte por pertenecer al Barbero/Staff (StaffSim: ${maxStaffSim.toFixed(3)}, SamePoseSim: ${maxStaffSamePoseSim.toFixed(3)}, ClientSim: ${maxClientSim.toFixed(3)}).`);
              }
            }

            if (!isStaffPhoto) {
              cleanPhotos.push(session.photos[i]);
              cleanEmbeddings.push(session.embeddings[i]);
            }
          }
          session.photos = cleanPhotos;
          session.embeddings = cleanEmbeddings;
        }
      }
    }

    // Deduplicación estricta de fotos de la sesión (elimina clones repetidos, conserva hasta 20 ángulos únicos)
    if (session.photos && session.photos.length > 0) {
      const dedupedSession = this.deduplicateSessionPhotos(session.photos, session.embeddings, 20);
      session.photos = dedupedSession.photos;
      session.embeddings = dedupedSession.embeddings;
    }

    // 4. Prohibición estricta: Una atención válida REQUIERE fotos y biometría facial capturada
    if (!session.photos || session.photos.length === 0) {
      if (session.tempClientId) {
        await this.customerService?.deleteCustomer?.(session.tempClientId, { db: this.db });
      }
      if (session.personId && session.personId !== session.tempClientId && !session.personId.startsWith("staff_")) {
        await this.customerService?.deleteCustomer?.(session.personId, { db: this.db });
      }
      this.logVerbal(`⚠️ Estancia de ${durationMinutes} min en ${session.chairName} descartada: 0 fotos capturadas (sin rostro identificable).`, "info");
      return null;
    }

    // Verificación de Consenso Set-to-Set contra el Barbero / Staff:
    // Si la similitud promedio del cluster contra el staff es >= 0.50 O más del 50% de las fotos >= 0.50 con el staff
    if (session.embeddings && session.embeddings.length > 0) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffProfiles = knownProfiles.filter(p => {
        if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
        if (p.role === "client" || p.isStaff === false) return false;
        return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
      });

      if (staffProfiles.length > 0) {
        const sampleStaffSims = [];

        for (const sItem of session.embeddings) {
          const sVec = Array.isArray(sItem) ? sItem : (sItem?.vector || null);
          if (!sVec) continue;

          let bestSimForSample = 0;
          for (const staff of staffProfiles) {
            const staffVectors = [];
            if (Array.isArray(staff.embeddings)) {
              for (const item of staff.embeddings) {
                if (Array.isArray(item)) staffVectors.push(item);
                else if (item && Array.isArray(item.vector)) staffVectors.push(item.vector);
              }
            }
            if (staffVectors.length === 0 && Array.isArray(staff.embedding)) {
              staffVectors.push(staff.embedding);
            }

            for (const v of staffVectors) {
              const sim = computeCosineSimilarity(sVec, v);
              if (sim > bestSimForSample) bestSimForSample = sim;
            }
          }
          sampleStaffSims.push(bestSimForSample);
        }

        if (sampleStaffSims.length > 0) {
          const avgStaffSim = sampleStaffSims.reduce((a, b) => a + b, 0) / sampleStaffSims.length;
          const staffMatchesCount = sampleStaffSims.filter(sim => sim >= 0.50).length;
          const ratioStaff = staffMatchesCount / sampleStaffSims.length;

          // Exigir consenso del cluster: similitud promedio >= 0.50 O más del 50% de las fotos >= 0.50 con el staff
          if (avgStaffSim >= 0.50 || ratioStaff > 0.5) {
            if (session.tempClientId) {
              await this.customerService?.deleteCustomer?.(session.tempClientId, { db: this.db });
            }
            if (session.personId && session.personId !== session.tempClientId) {
              await this.customerService?.deleteCustomer?.(session.personId, { db: this.db });
            }
            console.log("[Appointment] 🗑️ Atención descartada: el cluster de fotos pertenece al Barbero/Staff. Perfil temporal eliminado físicamente.");
            return null;
          }
        }
      }
    }

    // 5. Comparación Set-to-Set obligatoria contra la base de clientes conocidos
    this.logVerbal(`🔍 Analizando biometría acumulada de atención (${session.photos.length} fotos contra base de clientes)...`, "process");

    let matchedClient = null;
    if (session.embeddings && session.embeddings.length > 0) {
      matchedClient = this.matchSessionAgainstClients(session.embeddings);
      if (matchedClient && (matchedClient.name?.includes("confirmación") || matchedClient.status === "to_verify")) {
        matchedClient = null;
      }
    }

    let finalClient = null;

    if (matchedClient) {
      // Coincidencia con cliente recurrente existente
      // CERO FUSIÓN DE FOTOS: La galería histórica de matchedClient NO SE MODIFICA.
      finalClient = matchedClient;
      finalClient.visitCount = (matchedClient.visitCount || 1) + 1;
      finalClient.appointmentCount = (matchedClient.appointmentCount || (matchedClient.visitCount - 1) || 1) + 1;
      finalClient.status = "frequent";
      finalClient.lastSeen = new Date(now).toISOString();

      this.logVerbal(`✅ Cliente identificado como recurrente: "${finalClient.name}" (Visita #${finalClient.visitCount}). Atención vinculada sin alterar su galería previa.`, "success");

      // Preservar la galería previa intacta (hidratar fotos desde SQLite si finalClient vino de caché podada)
      const fullExisting = this.customerService?.getCustomerData?.(finalClient.id) ||
                           this.sqliteClient?.getCustomerById?.(finalClient.id);
      if (fullExisting && Array.isArray(fullExisting.photos) && fullExisting.photos.length > 0) {
        finalClient.photos = fullExisting.photos;
        finalClient.thumbnailBase64 = finalClient.thumbnailBase64 || fullExisting.thumbnailBase64;
      }

      // Guardar cliente recurrente con contadores y lastSeen actualizados (sin modificar fotos)
      if (this.customerService) {
        await this.customerService.saveOrUpdateCustomer(finalClient, {
          db: this.db,
          bucket: this.bucket,
          galleryUpdated: false,
          forceSync: true
        });
      }

      // Eliminar físicamente los perfiles temporales to_verify creados durante la sesión
      if (session.tempClientId && session.tempClientId !== finalClient.id) {
        await this.customerService?.deleteCustomer?.(session.tempClientId, { db: this.db });
      }
      if (session.personId && session.personId !== finalClient.id && session.personId !== session.tempClientId) {
        await this.customerService?.deleteCustomer?.(session.personId, { db: this.db });
      }

      session.personId = finalClient.id;
      session.personName = finalClient.name;
      session.clientId = finalClient.id;
      session.clientName = finalClient.name;
      session.visitCount = finalClient.visitCount;
    } else if ((!session.embeddings || session.embeddings.length === 0) && session.personName && session.personName !== "Cliente (Por verificar)") {
      // Identidad pre-establecida en pruebas o integración sin embeddings
      finalClient = {
        id: session.personId,
        name: session.personName,
        status: (session.visitCount || 1) > 1 ? "frequent" : "new",
        isStaff: false,
        role: "client",
        firstSeen: session.startedAt,
        lastSeen: new Date(now).toISOString(),
        visitCount: session.visitCount || 1,
        appointmentCount: session.visitCount || 1,
        bestFaceScore: session.bestFaceScore || 0,
        thumbnailBase64: session.thumbnailBase64 || session.photos?.[0]?.thumbnailBase64 || null,
        thumbnailPath: session.bestFaceStoragePath || null,
        photos: session.photos || [],
        embeddings: session.embeddings || []
      };

      const tempIdToDelete = session.tempClientId && session.tempClientId !== finalClient.id ? session.tempClientId : null;
      if (tempIdToDelete) {
        await this.customerService?.deleteCustomer?.(tempIdToDelete, { db: this.db });
      }

      session.personId = finalClient.id;
      session.personName = finalClient.name;
      session.clientId = finalClient.id;
      session.clientName = finalClient.name;
      session.visitCount = finalClient.visitCount;

      this.logVerbal(`✅ Atención completada para identidad establecida: "${finalClient.name}".`, "success");
    } else {
      // NO coincidió con clientes previos: Es un nuevo cliente legítimo
      // Promover el perfil to_verify creado en vivo a status: 'new'
      const clientId = session.tempClientId || `person_${now}_${trackId}`;
      const allKnown = this.customerService?.getComparisonProfiles?.() || [];
      const clientCount = allKnown.filter(p => !p.isStaff && !p.name?.includes("confirmación") && p.status !== "to_verify" && p.id !== clientId).length;
      const finalName = `Cliente #${clientCount + 1}`;

      finalClient = {
        id: clientId,
        name: finalName,
        status: "new",
        isStaff: false,
        role: "client",
        firstSeen: session.startedAt,
        lastSeen: new Date(now).toISOString(),
        visitCount: 1,
        appointmentCount: 1,
        bestFaceScore: session.bestFaceScore || 0,
        thumbnailBase64: session.thumbnailBase64 || session.photos[0]?.thumbnailBase64 || null,
        thumbnailPath: session.bestFaceStoragePath || null,
        photos: session.photos,
        embeddings: session.embeddings,
        embedding: session.embeddings[0] || null
      };

      session.personId = finalClient.id;
      session.personName = finalClient.name;
      session.clientId = finalClient.id;
      session.clientName = finalClient.name;
      session.visitCount = 1;

      this.logVerbal(`🆕 Nuevo cliente formalizado: "${finalClient.name}" con galería de ${session.photos.length} fotos.`, "success");

      if (this.customerService) {
        await this.customerService.saveOrUpdateCustomer(finalClient, {
          db: this.db,
          bucket: this.bucket,
          isNew: false, // Ya existía como to_verify, ahora se formaliza como new
          galleryUpdated: true,
          forceSync: true
        });
      }
    }

    const appointmentRecord = {
      id: session.appointmentId || session.visitId,
      trackId: session.trackId,
      personId: finalClient.id,
      personName: finalClient.name,
      clientId: finalClient.id,
      clientName: finalClient.name,
      role: "client",
      isStaff: false,
      isFrequent: (session.visitCount || 1) > 1,
      visitCount: session.visitCount || 1,
      chairId: session.chairId,
      chairName: session.chairName,
      startedAt: session.startedAt,
      endedAt: new Date(now).toISOString(),
      durationMinutes,
      status: "completed",
      clientStatus: finalClient.status,
      bestFaceStoragePath: session.bestFaceStoragePath,
      bestFaceScore: session.bestFaceScore,
      thumbnailPath: session.bestFaceStoragePath || null,
      thumbnailBase64: session.thumbnailBase64 || session.photos[0]?.thumbnailBase64 || null,
      photos: session.photos,
      createdAt: new Date(now).toISOString()
    };

    this.completedAppointments.push(appointmentRecord);
    this.completedVisits.push(appointmentRecord);
    if (this.completedAppointments.length > 20) this.completedAppointments.shift();
    if (this.completedVisits.length > 20) this.completedVisits.shift();

    // Persistir en SQLite si el cliente está disponible
    const sqlite = this.sqliteClient || (this.customerService?.sqliteClient);
    if (sqlite?.saveAppointment) {
      try {
        sqlite.saveAppointment(appointmentRecord);
      } catch (sqlErr) {
        console.warn(`[Appointment] Error guardando atención en SQLite:`, sqlErr.message);
      }
    }

    // Persistir en Firestore en camera_catcher_appointments
    if (this.db) {
      try {
        await this.db.doc(`camera_catcher_appointments/${appointmentRecord.id}`).set(appointmentRecord);
        this.logVerbal(`✅ Atención registrada exitosamente en camera_catcher_appointments/${appointmentRecord.id} (${appointmentRecord.clientName}, ${durationMinutes} min, ${session.photos.length} fotos).`, "success");
      } catch (dbErr) {
        console.error(`[Appointment] Error guardando atención en Firestore:`, dbErr.message);
      }
    }

    // Exportar auditoría fotográfica antes/después de closeSession
    try {
      const fs = await import("fs");
      const path = await import("path");
      const reportDir = path.resolve(process.cwd(), "data/audit_reports");
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      const auditPayload = {
        appointmentId: appointmentRecord.id,
        clientId: finalClient.id,
        clientName: finalClient.name,
        clientStatus: finalClient.status,
        matchedClient: matchedClient ? { id: matchedClient.id, name: matchedClient.name, status: matchedClient.status } : null,
        durationMinutes,
        photosBeforeClose: (session.photosBeforeClose || []).map((p, i) => ({
          idx: i + 1,
          pose: p.pose,
          poseLabel: p.poseLabel,
          sharpnessScore: p.sharpnessScore,
          thumbnailBase64: p.thumbnailBase64
        })),
        photosAfterClose: (session.photos || []).map((p, i) => ({
          idx: i + 1,
          pose: p.pose,
          poseLabel: p.poseLabel,
          sharpnessScore: p.sharpnessScore,
          thumbnailBase64: p.thumbnailBase64
        }))
      };
      const filePath = path.join(reportDir, `audit_${appointmentRecord.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(auditPayload, null, 2));
      console.log(`[Appointment] 📑 Reporte de auditoría de cierre exportado a: ${filePath}`);
    } catch (auditErr) {
      console.warn(`[Appointment] Error exportando auditoría:`, auditErr.message);
    }

    return appointmentRecord;
  }

  /**
   * Realiza comparación Set-to-Set entre los vectores de la sesión y los perfiles de clientes conocidos
   * @param {Array<Array<number>>} sessionEmbeddings
   * @param {number} [threshold=0.65]
   * @returns {Object|null}
   */
  matchSessionAgainstClients(sessionEmbeddings, threshold = 0.60) {
    if (!sessionEmbeddings || sessionEmbeddings.length === 0) return null;
    const profiles = (this.customerService?.getComparisonProfiles?.() || []).filter(p => {
      if (p.isStaff || p.role === "barber" || String(p.id).startsWith("staff_")) return false;
      if (p.status === "to_verify") return false;
      if (p.name && p.name.includes("confirmación")) return false;
      return true;
    });
    if (profiles.length === 0) return null;

    let bestMatch = null;
    let highestScore = -1;
    let secondScore = -1;

    for (const profile of profiles) {
      const profileVectors = Array.isArray(profile.embeddings) && profile.embeddings.length > 0
        ? profile.embeddings.map(e => Array.isArray(e) ? e : (e?.vector || null)).filter(Boolean)
        : (profile.embedding ? [profile.embedding] : []);

      if (profileVectors.length === 0) continue;

      const sampleBestSims = [];

      for (const sVec of sessionEmbeddings) {
        let bestForS = -1;
        for (const pVec of profileVectors) {
          const sim = computeCosineSimilarity(sVec, pVec);
          if (sim > bestForS) bestForS = sim;
        }
        if (bestForS >= 0) {
          sampleBestSims.push(bestForS);
        }
      }

      if (sampleBestSims.length === 0) continue;

      sampleBestSims.sort((a, b) => b - a);
      const maxSim = sampleBestSims[0];

      // topAvgSim es el promedio de las muestras con mejor similitud (o el 50% superior)
      const topCount = Math.max(1, Math.ceil(sampleBestSims.length * 0.5));
      const topSims = sampleBestSims.slice(0, topCount);
      const topAvgSim = topSims.reduce((a, b) => a + b, 0) / topCount;

      const combinedScore = (maxSim * 0.45) + (topAvgSim * 0.55);

      if (combinedScore > highestScore) {
        secondScore = highestScore;
        highestScore = combinedScore;
        bestMatch = profile;
      } else if (combinedScore > secondScore) {
        secondScore = combinedScore;
      }
    }

    if (highestScore >= threshold && (highestScore - secondScore >= 0.05 || secondScore < 0.55)) {
      return bestMatch;
    }
    return null;
  }

  /**
   * Filtra muestras outliers en el cluster de fotos y embeddings de la sesión.
   * Si session.photos.length >= 3 y session.embeddings.length >= 3:
   * Calcula la similitud promedio de cada muestra contra el resto del grupo.
   * Cualquier muestra cuya similitud promedio sea < 0.45 se descarta.
   * @param {Array<Object>} photos
   * @param {Array<Array<number>>} embeddings
   * @returns {{ photos: Array<Object>, embeddings: Array<Array<number>> }}
   */
  filterOutlierSamples(photos = [], embeddings = []) {
    if (!photos || !embeddings || photos.length < 3 || embeddings.length < 3) {
      return { photos: [...photos], embeddings: [...embeddings] };
    }

    const N = Math.min(photos.length, embeddings.length);
    const vectors = embeddings.slice(0, N).map(e => Array.isArray(e) ? e : (e?.vector || null));

    const validIndices = [];
    for (let i = 0; i < N; i++) {
      const vecI = vectors[i];
      if (!vecI) {
        validIndices.push(i);
        continue;
      }

      let totalSim = 0;
      let count = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const vecJ = vectors[j];
        if (!vecJ) continue;
        const sim = computeCosineSimilarity(vecI, vecJ);
        totalSim += sim;
        count++;
      }

      const avgSim = count > 0 ? (totalSim / count) : 1.0;
      if (avgSim >= 0.45) {
        validIndices.push(i);
      } else {
        console.warn(`[Appointment] Muestra #${i + 1} descartada por outlier biométrico (similitud promedio con cluster: ${avgSim.toFixed(3)} < 0.45). Excluye foto contaminante.`);
      }
    }

    const filteredPhotos = validIndices.map(idx => photos[idx]);
    const filteredEmbeddings = validIndices.map(idx => embeddings[idx]);

    // Preservar fotos adicionales si existieran sin embedding
    if (photos.length > N) {
      filteredPhotos.push(...photos.slice(N));
    }

    return { photos: filteredPhotos, embeddings: filteredEmbeddings };
  }

  /**
   * Deduplica fotos de sesión eliminando miniaturas idénticas y similitud coseno >= 0.88 (misma pose)
   * Limita a un máximo de fotos diversas y nítidas para la atención.
   * @param {Array<Object>} photos
   * @param {Array<Array<number>>} embeddings
   * @param {number} [maxPhotos=20]
   * @returns {{ photos: Array<Object>, embeddings: Array<Array<number>> }}
   */
  deduplicateSessionPhotos(photos = [], embeddings = [], maxPhotos = 20) {
    if (!Array.isArray(photos) || photos.length === 0) {
      return { photos: [], embeddings: [] };
    }

    const cleanPhotos = [];
    const cleanEmbeddings = [];

    for (let i = 0; i < photos.length; i++) {
      const ph = photos[i];
      const emb = embeddings?.[i] || null;
      if (!ph) continue;

      let duplicateIdx = -1;
      for (let j = 0; j < cleanPhotos.length; j++) {
        const exPh = cleanPhotos[j];
        const exEmb = cleanEmbeddings[j] || null;

        // 1. Miniatura idéntica en base64
        if (ph.thumbnailBase64 && exPh.thumbnailBase64 && ph.thumbnailBase64 === exPh.thumbnailBase64) {
          duplicateIdx = j;
          break;
        }

        // 2. Similitud coseno alta con misma pose
        if (emb && exEmb) {
          const v1 = Array.isArray(emb) ? emb : (emb.vector || null);
          const v2 = Array.isArray(exEmb) ? exEmb : (exEmb.vector || null);
          if (v1 && v2) {
            const sim = computeCosineSimilarity(v1, v2);
            const samePose = (ph.pose || 'frontal') === (exPh.pose || 'frontal');
            if (sim >= 0.92 || (sim >= 0.88 && samePose)) {
              duplicateIdx = j;
              break;
            }
          }
        }
      }

      if (duplicateIdx !== -1) {
        if ((ph.sharpnessScore || 0) > (cleanPhotos[duplicateIdx].sharpnessScore || 0)) {
          cleanPhotos[duplicateIdx] = ph;
          if (emb) cleanEmbeddings[duplicateIdx] = emb;
        }
      } else {
        cleanPhotos.push(ph);
        if (emb) cleanEmbeddings.push(emb);
      }
    }

    // Limitar al máximo de fotos (ordenadas por diversidad de pose y nitidez)
    if (cleanPhotos.length > maxPhotos) {
      const posesSeen = new Set();
      const prioritized = [];
      const others = [];

      for (let k = 0; k < cleanPhotos.length; k++) {
        const p = cleanPhotos[k];
        const pose = p.pose || 'frontal';
        if (!posesSeen.has(pose)) {
          posesSeen.add(pose);
          prioritized.push({ photo: p, emb: cleanEmbeddings[k] });
        } else {
          others.push({ photo: p, emb: cleanEmbeddings[k] });
        }
      }

      others.sort((a, b) => (b.photo.sharpnessScore || 0) - (a.photo.sharpnessScore || 0));
      const combined = [...prioritized, ...others].slice(0, maxPhotos);

      return {
        photos: combined.map(c => c.photo),
        embeddings: combined.map(c => c.emb).filter(Boolean)
      };
    }

    return { photos: cleanPhotos, embeddings: cleanEmbeddings };
  }

  /**
   * Unifica fotos y embeddings asegurando correspondencia estricta 1:1,
   * deduplicación con similitud >= 0.88 y protección inmutable de la foto canónica inicial (index 0).
   */
  _mergePhotosAndEmbeddings(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
    const list = Array.isArray(existingPhotos) ? [...existingPhotos] : [];
    const embList = Array.isArray(existingEmbeddings) ? [...existingEmbeddings] : [];

    while (embList.length < list.length) embList.push(null);
    if (embList.length > list.length) embList.length = list.length;

    const hasCanonicalPhoto = existingPhotos && existingPhotos.length > 0;

    for (let k = 0; k < newSessionPhotos.length; k++) {
      const ph = newSessionPhotos[k];
      const emb = newSessionEmbeddings?.[k] || null;

      // 1. Verificación por miniatura idéntica
      const exactIdx = list.findIndex(e => e.thumbnailBase64 && ph.thumbnailBase64 && e.thumbnailBase64 === ph.thumbnailBase64);
      if (exactIdx !== -1) {
        // La foto canónica inicial (index 0) de prevPhotos es inmutable y nunca se reemplaza por visitas posteriores
        if (!(hasCanonicalPhoto && exactIdx === 0)) {
          if ((ph.sharpnessScore || 0) > (list[exactIdx].sharpnessScore || 0)) {
            list[exactIdx] = ph;
            if (emb) embList[exactIdx] = emb;
          }
        }
        continue;
      }

      // 2. Verificación por similitud coseno si hay embeddings disponibles
      let dupIdx = -1;
      if (emb && embList.length > 0) {
        const phPose = ph.pose || 'frontal';
        for (let j = 0; j < embList.length; j++) {
          const exEmb = Array.isArray(embList[j]) ? embList[j] : (embList[j]?.vector || null);
          if (!exEmb) continue;
          const sim = computeCosineSimilarity(emb, exEmb);
          const samePose = (list[j]?.pose || 'frontal') === phPose;
          if (sim >= 0.92 || (sim >= 0.88 && samePose)) {
            dupIdx = j;
            break;
          }
        }
      }

      if (dupIdx !== -1) {
        // La foto canónica inicial (index 0) de prevPhotos es inmutable y nunca se reemplaza por visitas posteriores
        if (!(hasCanonicalPhoto && dupIdx === 0)) {
          if ((ph.sharpnessScore || 0) > (list[dupIdx].sharpnessScore || 0)) {
            list[dupIdx] = ph;
            if (emb) embList[dupIdx] = emb;
          }
        }
        continue;
      }

      list.push(ph);
      embList.push(emb);
    }

    return { photos: list, embeddings: embList };
  }

  /**
   * Unifica fotos de la nueva sesión a la galería del cliente sin duplicados (soporta 40+ fotos)
   */
  mergeCustomerPhotos(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
    return this._mergePhotosAndEmbeddings(existingPhotos, newSessionPhotos, existingEmbeddings, newSessionEmbeddings).photos;
  }

  /**
   * Unifica embeddings de la nueva sesión a la galería del cliente en paralelo con las fotos conservadas
   */
  mergeCustomerEmbeddings(existingEmbeddings = [], newSessionEmbeddings = [], existingPhotos = [], newSessionPhotos = []) {
    return this._mergePhotosAndEmbeddings(existingPhotos, newSessionPhotos, existingEmbeddings, newSessionEmbeddings).embeddings;
  }

  /**
   * Obtiene las sesiones activas en este momento
   */
  getActiveSessions() {
    return Array.from(this.activeSessions.values());
  }
}
