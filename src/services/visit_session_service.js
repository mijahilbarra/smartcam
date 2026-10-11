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
import { computeCosineSimilarity } from "../face_recognizer.js";
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

    // Si es personal/barbero, no se registra como atención de cliente
    if (track.identity?.isStaff || track.isStaffHint || track.role === "staff") {
      return null;
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

    const isPendingInit = track.identity?.isPendingConfirmation ||
                          track.identity?.isCandidate ||
                          !track.identity?.personId ||
                          (track.identity?.name && (track.identity.name.includes("confirmación") || track.identity.name === "Cliente"));
    const validIdentity = isPendingInit ? null : track.identity;
    const visitId = `appt_${now}_${track.trackId}`;
    session = {
      id: visitId,
      visitId,
      appointmentId: visitId,
      trackId: track.trackId,
      chairId,
      chairName,
      startedAt: new Date(now).toISOString(),
      startedAtEpoch: now,
      lastSeenEpoch: now,
      emptySinceEpoch: null,
      lastPresenceLogAt: now,
      status: "en_corte",
      personId: validIdentity?.personId || null,
      personName: validIdentity?.name || null,
      clientId: validIdentity?.personId || null,
      clientName: validIdentity?.name || null,
      isStaff: false,
      visitCount: validIdentity?.visitCount || 1,
      bestFaceScore: track.bestFace?.sharpnessScore || 0,
      bestFaceStoragePath: null,
      thumbnailBase64: null,
      lastPhotoAt: 0,
      photos: [],
      embeddings: [],
      topFaces: []
    };
    this.activeSessions.set(track.trackId, session);
    this.logVerbal(`💺 Persona se sienta en ${session.chairName}. Iniciando registro de atención.`, "process");

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
      const trackInChair = activeTracks.find(t => {
        const qId = t.currentQuadrant?.id;
        const qName = t.currentQuadrant?.name || t.currentQuadrant?.label;
        const sChairIdClean = session.chairId?.replace(/^person_/, "");
        return (qId && (qId === session.chairId || qId === sChairIdClean)) ||
               (qName && (qName === session.chairName || session.chairName?.includes(qName) || qName?.includes(session.chairName)));
      });

      if (trackInChair) {
        if (session.status === "esperando_liberacion") {
          session.status = "en_corte";
          session.emptySinceEpoch = null;
          this.logVerbal(`🔄 Persona retomó la silla ${session.chairName}. Reanudando atención.`, "process");
        }
        session.lastSeenEpoch = now;
      } else {
        // La silla no tiene track presente
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
    return closed;
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

    // 1. Exclusión estricta del barbero/staff (umbral 0.58):
    if (isStaff) {
      console.log(`[Appointment] Rostro en ${session.chairName} pertenece a Staff. Excluido de atención.`);
      return false;
    }

    if (embedding) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffCheck = matchStaffFace(embedding, knownProfiles, 0.58);
      if (staffCheck.isStaffMatch || staffCheck.maxStaffSim >= 0.58) {
        console.log(`[Appointment] Rostro en ${session.chairName} coincide con Barbero/Staff (Sim: ${staffCheck.maxStaffSim.toFixed(3)} >= 0.58). Excluido de atención.`);
        return false;
      }
    }

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
          if (sharpnessScore > (session.bestFaceScore || 0)) {
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
    // Si la última foto tomada fue hace menos de 20 segundos, omitir foto repetida
    if (session.photos.length > 0 && session.lastPhotoAt && !skipCooldown && (now - session.lastPhotoAt < 20000)) {
      const samePoseIdx = session.photos.findIndex(p => p.pose === incomingPose);
      const updateIdx = samePoseIdx !== -1 ? samePoseIdx : (session.photos.length - 1);
      if (updateIdx !== -1 && sharpnessScore > (session.photos[updateIdx].sharpnessScore || 0)) {
        session.photos[updateIdx] = photoItem;
        if (embedding && session.embeddings[updateIdx]) {
          session.embeddings[updateIdx] = embedding;
        }
        session.lastPhotoAt = now;
        if (sharpnessScore > (session.bestFaceScore || 0)) {
          session.bestFaceScore = sharpnessScore;
          session.thumbnailBase64 = finalThumbnailBase64;
        }
      }
      return false;
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

    // Actualizar bestFaceScore y miniatura
    if (sharpnessScore > (session.bestFaceScore || 0)) {
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
      this.logVerbal(`Atención descartada para Barbero/Staff: ${session.personName || `Track #${trackId}`}.`, "info");
      return null;
    }

    // 2. Comprobar umbral de permanencia mínima obligatoria (mínimo 10 min)
    const minMinutes = options.minMinutes !== undefined ? options.minMinutes : this.minAppointmentMinutes;
    if (durationMinutes < minMinutes) {
      this.logVerbal(`⏱️ Estancia de ${durationMinutes} min en ${session.chairName} descartada (< ${minMinutes} min - transeúnte o cancelada).`, "info");
      return null;
    }

    // Filtrado de outliers en el cluster de fotos antes de clasificar
    if (session.photos?.length >= 3 && session.embeddings?.length >= 3) {
      const filtered = this.filterOutlierSamples(session.photos, session.embeddings);
      session.photos = filtered.photos;
      session.embeddings = filtered.embeddings;
    }

    // Deduplicación estricta de fotos de la sesión (elimina clones repetidos, conserva hasta 20 ángulos únicos)
    if (session.photos && session.photos.length > 0) {
      const dedupedSession = this.deduplicateSessionPhotos(session.photos, session.embeddings, 20);
      session.photos = dedupedSession.photos;
      session.embeddings = dedupedSession.embeddings;
    }

    // 3. Prohibición estricta: Una atención válida REQUIERE fotos y biometría facial capturada
    if (!session.photos || session.photos.length === 0) {
      this.logVerbal(`⚠️ Estancia de ${durationMinutes} min en ${session.chairName} descartada: 0 fotos capturadas (sin rostro identificable).`, "info");
      return null;
    }

    // 4. Set-to-Set matching si no tenía identidad previa confirmada
    this.logVerbal(`🔍 Analizando biometría acumulada de atención (${session.photos.length} fotos contra base de clientes)...`, "process");

    let finalClient = null;
    if (session.personId && !session.personId.startsWith("unidentified_") && !session.personId.startsWith("cand_")) {
      const existing = this.customerService?.getCustomerData?.(session.personId);
      if (existing && !existing.name?.includes("confirmación")) {
        finalClient = existing;
      } else if (!existing && session.personName &&
                 !session.personName.includes("confirmación") &&
                 session.personName !== "Cliente" &&
                 session.personName !== "Cliente nuevo" &&
                 !session.isPendingConfirmation) {
        finalClient = {
          id: session.personId,
          name: session.personName,
          visitCount: session.visitCount || 1,
          appointmentCount: session.visitCount || 1,
          photos: session.photos,
          embeddings: session.embeddings
        };
      }
    }

    if (!finalClient && session.embeddings.length > 0) {
      finalClient = this.matchSessionAgainstClients(session.embeddings);
      if (finalClient && finalClient.name?.includes("confirmación")) {
        finalClient = null;
      }
    }

    if (finalClient) {
      session.personId = finalClient.id;
      session.personName = finalClient.name;
      session.clientId = finalClient.id;
      session.clientName = finalClient.name;
      session.visitCount = (finalClient.visitCount || 1) + 1;
      finalClient.visitCount = session.visitCount;
      finalClient.appointmentCount = (finalClient.appointmentCount || finalClient.visitCount || 1) + 1;
      finalClient.lastSeen = new Date(now).toISOString();

      this.logVerbal(`✅ Cliente identificado como recurrente: "${finalClient.name}" (Visita #${finalClient.visitCount}). Atención vinculada exitosamente.`, "success");

      // Si finalClient provino de comparación biométrica (RAM podada sin fotos),
      // hidratar fotos existentes desde SQLite antes de acumular:
      const fullExisting = this.customerService?.getCustomerData?.(finalClient.id) ||
                           this.sqliteClient?.getCustomerById?.(finalClient.id);
      if (fullExisting && Array.isArray(fullExisting.photos) && fullExisting.photos.length > 0) {
        finalClient.photos = fullExisting.photos;
      }

      // Acumular fotos de la sesión en el perfil del cliente (soportando 40+ fotos y sin duplicados)
      if (session.photos.length > 0) {
        const prevPhotos = finalClient.photos;
        finalClient.photos = this.mergeCustomerPhotos(finalClient.photos, session.photos, finalClient.embeddings, session.embeddings);
        finalClient.embeddings = this.mergeCustomerEmbeddings(finalClient.embeddings, session.embeddings, prevPhotos, session.photos);
      }

      if (this.customerService) {
        await this.customerService.saveOrUpdateCustomer(finalClient, {
          db: this.db,
          bucket: this.bucket,
          galleryUpdated: true,
          forceSync: true
        });
      }
    } else {
      // Registrar nuevo cliente formal desde esta atención legítima (>= 10 min y con fotos)
      const newClientId = `person_${now}_${trackId}`;
      const allKnown = this.customerService?.getComparisonProfiles?.() || [];
      const clientCount = allKnown.filter(p => !p.isStaff && !p.name?.includes("confirmación")).length;
      finalClient = {
        id: newClientId,
        name: `Cliente #${clientCount + 1}`,
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

      this.logVerbal(`🆕 Creando nuevo cliente: "${finalClient.name}" con galería de ${session.photos.length} fotos.`, "success");

      if (this.customerService) {
        await this.customerService.saveOrUpdateCustomer(finalClient, {
          db: this.db,
          bucket: this.bucket,
          isNew: true,
          forceSync: true
        });
      }
    }

    const appointmentRecord = {
      id: session.appointmentId || session.visitId,
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

    return appointmentRecord;
  }

  /**
   * Realiza comparación Set-to-Set entre los vectores de la sesión y los perfiles de clientes conocidos
   * @param {Array<Array<number>>} sessionEmbeddings
   * @param {number} [threshold=0.65]
   * @returns {Object|null}
   */
  matchSessionAgainstClients(sessionEmbeddings, threshold = 0.65) {
    if (!sessionEmbeddings || sessionEmbeddings.length === 0) return null;
    const profiles = (this.customerService?.getComparisonProfiles?.() || []).filter(p => !p.isStaff);
    if (profiles.length === 0) return null;

    let bestMatch = null;
    let highestScore = -1;
    let secondScore = -1;

    for (const profile of profiles) {
      const profileVectors = Array.isArray(profile.embeddings) && profile.embeddings.length > 0
        ? profile.embeddings.map(e => Array.isArray(e) ? e : (e?.vector || null)).filter(Boolean)
        : (profile.embedding ? [profile.embedding] : []);

      if (profileVectors.length === 0) continue;

      let maxSim = -1;
      let sumSim = 0;
      let count = 0;

      for (const sVec of sessionEmbeddings) {
        let bestForS = -1;
        for (const pVec of profileVectors) {
          const sim = computeCosineSimilarity(sVec, pVec);
          if (sim > bestForS) bestForS = sim;
        }
        if (bestForS > maxSim) maxSim = bestForS;
        if (bestForS > 0) {
          sumSim += bestForS;
          count++;
        }
      }

      const avgSim = count > 0 ? (sumSim / count) : 0;
      const combinedScore = (maxSim * 0.7) + (avgSim * 0.3);

      if (combinedScore > highestScore) {
        secondScore = highestScore;
        highestScore = combinedScore;
        bestMatch = profile;
      } else if (combinedScore > secondScore) {
        secondScore = combinedScore;
      }
    }

    if (highestScore >= threshold && (highestScore - secondScore >= 0.04 || secondScore < 0.60)) {
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
   * Unifica fotos de la nueva sesión a la galería del cliente sin duplicados (soporta 40+ fotos)
   */
  mergeCustomerPhotos(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
    const list = Array.isArray(existingPhotos) ? [...existingPhotos] : [];
    const embList = Array.isArray(existingEmbeddings) ? [...existingEmbeddings] : [];

    for (let k = 0; k < newSessionPhotos.length; k++) {
      const ph = newSessionPhotos[k];
      const emb = newSessionEmbeddings?.[k] || null;

      // 1. Verificación por miniatura idéntica
      const exactIdx = list.findIndex(e => e.thumbnailBase64 && ph.thumbnailBase64 && e.thumbnailBase64 === ph.thumbnailBase64);
      if (exactIdx !== -1) {
        if ((ph.sharpnessScore || 0) > (list[exactIdx].sharpnessScore || 0)) {
          list[exactIdx] = ph;
          if (emb && embList[exactIdx]) embList[exactIdx] = emb;
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
        if ((ph.sharpnessScore || 0) > (list[dupIdx].sharpnessScore || 0)) {
          list[dupIdx] = ph;
          if (emb && embList[dupIdx]) embList[dupIdx] = emb;
        }
        continue;
      }

      list.push(ph);
      if (emb) embList.push(emb);
    }

    return list;
  }

  /**
   * Unifica embeddings de la nueva sesión a la galería del cliente en paralelo con las fotos
   */
  mergeCustomerEmbeddings(existingEmbeddings = [], newSessionEmbeddings = [], existingPhotos = [], newSessionPhotos = []) {
    const list = Array.isArray(existingEmbeddings) ? [...existingEmbeddings] : [];
    for (let k = 0; k < newSessionEmbeddings.length; k++) {
      const emb = newSessionEmbeddings[k];
      const ph = newSessionPhotos?.[k];
      if (ph && Array.isArray(existingPhotos)) {
        const exactIdx = existingPhotos.findIndex(e => e.thumbnailBase64 && ph.thumbnailBase64 && e.thumbnailBase64 === ph.thumbnailBase64);
        if (exactIdx !== -1) {
          if ((ph.sharpnessScore || 0) > (existingPhotos[exactIdx]?.sharpnessScore || 0)) {
            list[exactIdx] = emb;
          }
          continue;
        }
      }
      list.push(emb);
    }
    return list;
  }

  /**
   * Obtiene las sesiones activas en este momento
   */
  getActiveSessions() {
    return Array.from(this.activeSessions.values());
  }
}
