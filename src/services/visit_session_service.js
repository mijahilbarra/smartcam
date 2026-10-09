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

export class VisitSessionService {
  constructor({ db, bucket, sqliteClient, customerService, minAppointmentMinutes } = {}) {
    this.db = db;
    this.bucket = bucket;
    this.sqliteClient = sqliteClient || null;
    this.customerService = customerService || defaultCustomerService;
    this.minAppointmentMinutes = typeof minAppointmentMinutes === "number"
      ? minAppointmentMinutes
      : (process.env.MIN_APPOINTMENT_MINUTES ? parseInt(process.env.MIN_APPOINTMENT_MINUTES, 10) : 10);
    this.activeSessions = new Map(); // trackId -> Session
    this.completedAppointments = [];
    this.completedVisits = [];
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
  async processTrack(track) {
    if (!track) return null;
    const now = Date.now();
    const isChair = this.isServiceChair(track.currentQuadrant);

    // 1. Iniciar nueva sesión si entra a una silla de atención
    if (isChair && !this.activeSessions.has(track.trackId)) {
      const isPendingInit = track.identity?.isPendingConfirmation || (track.identity?.name && track.identity.name.includes("confirmación"));
      const validIdentity = isPendingInit ? null : track.identity;
      const visitId = `appt_${now}_${track.trackId}`;
      const session = {
        id: visitId,
        visitId,
        appointmentId: visitId,
        trackId: track.trackId,
        chairId: track.currentQuadrant.id,
        chairName: track.currentQuadrant.label || track.currentQuadrant.name || track.currentQuadrant.id,
        startedAt: new Date(now).toISOString(),
        startedAtEpoch: now,
        lastSeenEpoch: now,
        status: "en_corte",
        personId: validIdentity?.personId || null,
        personName: validIdentity?.name || null,
        clientId: validIdentity?.personId || null,
        clientName: validIdentity?.name || null,
        isStaff: validIdentity?.isStaff || false,
        visitCount: validIdentity?.visitCount || 1,
        bestFaceScore: track.bestFace?.sharpnessScore || 0,
        bestFaceStoragePath: null,
        thumbnailBase64: null,
        photos: [],
        embeddings: [],
        topFaces: []
      };
      this.activeSessions.set(track.trackId, session);
      console.log(`[Appointment] Iniciada atención (${visitId}) para Track #${track.trackId} en ${session.chairName}.`);
      return session;
    }

    // 2. Si ya hay una sesión activa para este track
    if (this.activeSessions.has(track.trackId)) {
      const session = this.activeSessions.get(track.trackId);
      session.lastSeenEpoch = now;

      // Si la persona fue identificada previamente y no es candidato provisional
      const isPendingTrack = track.identity?.isPendingConfirmation || (track.identity?.name && track.identity.name.includes("confirmación"));
      if (track.identity && !isPendingTrack && (!session.personId || session.personId !== track.identity.personId)) {
        session.personId = track.identity.personId;
        session.personName = track.identity.name;
        session.clientId = track.identity.personId;
        session.clientName = track.identity.name;
        session.isStaff = !!track.identity.isStaff;
        session.visitCount = track.identity.visitCount || 1;
        console.log(`[Appointment] Sesión ${session.visitId} asociada a identidad: "${session.personName}" (Staff: ${session.isStaff})`);
      }

      // Si tiene una cara nítida en track.bestFace, agregarla a la atención
      if (track.bestFace && track.bestFace.sharpnessScore > 0) {
        await this.addFaceSample(track.trackId, {
          faceBuffer: track.bestFace.faceBuffer,
          sharpnessScore: track.bestFace.sharpnessScore || 0,
          embedding: track.bestFace.embedding || track.identity?.embedding || null,
          thumbnailBase64: track.bestFace.thumbnailBase64 || null,
          isStaff: track.identity?.isStaff || false
        });
      }

      return session;
    }

    return null;
  }

  /**
   * Acumula una muestra facial en la sesión activa con exclusión estricta de personal/barbero
   * @param {number} trackId
   * @param {Object} sample
   * @returns {Promise<boolean>}
   */
  async addFaceSample(trackId, sample = {}) {
    if (!this.activeSessions.has(trackId)) return false;
    const session = this.activeSessions.get(trackId);
    const { faceBuffer, sharpnessScore = 0, embedding, thumbnailBase64, isStaff } = sample;

    // 1. Exclusión estricta del barbero/staff:
    if (isStaff || session.isStaff) {
      console.log(`[Appointment] Rostro en ${session.chairName} pertenece a Staff. Excluido de atención.`);
      return false;
    }

    if (embedding) {
      const knownProfiles = this.customerService?.getComparisonProfiles?.() || [];
      const staffCheck = matchStaffFace(embedding, knownProfiles, 0.52);
      if (staffCheck.isStaffMatch) {
        console.log(`[Appointment] Rostro en ${session.chairName} coincide con Barbero/Staff (Sim: ${staffCheck.maxStaffSim.toFixed(3)}). Excluido de atención.`);
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

    // 3. Acumulación de fotos y embeddings (hasta 20 recortes por atención)
    const now = Date.now();
    const photoItem = {
      thumbnailBase64: finalThumbnailBase64,
      sharpnessScore,
      capturedAt: new Date(now).toISOString()
    };

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

    // 4. Actualizar bestFaceScore y miniatura
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

    return true;
  }

  /**
   * Finaliza la atención cuando la persona se levanta o sale de la escena.
   * Realiza comparación Set-to-Set contra la base de clientes y persiste el appointment.
   * @param {number} trackId
   * @param {Object} [options]
   * @returns {Promise<Object|null>}
   */
  async closeSession(trackId, options = {}) {
    if (!this.activeSessions.has(trackId)) return null;

    const session = this.activeSessions.get(trackId);
    this.activeSessions.delete(trackId);

    const now = options.endedAtEpoch || Date.now();
    const durationMs = now - session.startedAtEpoch;
    const durationMinutes = options.durationMinutes !== undefined
      ? options.durationMinutes
      : Math.max(1, Math.round(durationMs / 60000));

    // 1. Si es personal/barbero, no se registra como atención de cliente
    if (session.isStaff) {
      console.log(`[Appointment] Atención finalizada para Barbero/Staff: ${session.personName || `Track #${trackId}`}.`);
      return null;
    }

    // 2. Comprobar umbral de permanencia mínima obligatoria (mínimo 10 min)
    const minMinutes = options.minMinutes !== undefined ? options.minMinutes : this.minAppointmentMinutes;
    if (durationMinutes < minMinutes) {
      console.log(`[Appointment] Estancia de ${durationMinutes} min en ${session.chairName} descartada (< ${minMinutes} min - transeúnte o cancelada).`);
      return null;
    }

    // 3. Prohibición estricta: Una atención válida REQUIERE fotos y biometría facial capturada
    if (!session.photos || session.photos.length === 0) {
      console.log(`[Appointment] Estancia de ${durationMinutes} min en ${session.chairName} descartada: 0 fotos capturadas (sin rostro identificable).`);
      return null;
    }

    // 4. Set-to-Set matching si no tenía identidad previa confirmada
    let finalClient = null;
    if (session.personId && !session.personId.startsWith("unidentified_")) {
      const existing = this.customerService?.getCustomerData?.(session.personId);
      if (existing && !existing.name?.includes("confirmación")) {
        finalClient = existing;
      } else if (!existing && session.personName && !session.personName.includes("confirmación")) {
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
      console.log(`[Appointment] Atención vinculada a cliente recurrente: "${finalClient.name}" (${finalClient.id})`);
      session.personId = finalClient.id;
      session.personName = finalClient.name;
      session.clientId = finalClient.id;
      session.clientName = finalClient.name;
      session.visitCount = (finalClient.visitCount || 1) + 1;
      finalClient.visitCount = session.visitCount;
      finalClient.appointmentCount = (finalClient.appointmentCount || finalClient.visitCount || 1) + 1;
      finalClient.lastSeen = new Date(now).toISOString();

      // Si finalClient provino de comparación biométrica (RAM podada sin fotos),
      // hidratar fotos existentes desde SQLite antes de acumular:
      const fullExisting = this.customerService?.getCustomerData?.(finalClient.id) ||
                           this.sqliteClient?.getCustomerById?.(finalClient.id);
      if (fullExisting && Array.isArray(fullExisting.photos) && fullExisting.photos.length > 0) {
        finalClient.photos = fullExisting.photos;
      }

      // Acumular fotos de la sesión en el perfil del cliente (soportando 40+ fotos)
      if (session.photos.length > 0) {
        finalClient.photos = this.mergeCustomerPhotos(finalClient.photos, session.photos);
        finalClient.embeddings = this.mergeCustomerEmbeddings(finalClient.embeddings, session.embeddings);
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

      console.log(`[Appointment] ✅ Nuevo cliente registrado desde atención: "${finalClient.name}" (${finalClient.id})`);

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
        console.log(`[Appointment] ✅ Atención registrada exitosamente en camera_catcher_appointments/${appointmentRecord.id} (${appointmentRecord.clientName}, ${durationMinutes} min, ${session.photos.length} fotos).`);
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
   * Concatena fotos de la nueva sesión a la galería del cliente (soporta 40+ fotos)
   */
  mergeCustomerPhotos(existingPhotos = [], newSessionPhotos = []) {
    const list = Array.isArray(existingPhotos) ? [...existingPhotos] : [];
    for (const ph of newSessionPhotos) {
      list.push(ph);
    }
    return list;
  }

  /**
   * Concatena embeddings de la nueva sesión a la galería del cliente
   */
  mergeCustomerEmbeddings(existingEmbeddings = [], newSessionEmbeddings = []) {
    const list = Array.isArray(existingEmbeddings) ? [...existingEmbeddings] : [];
    for (const emb of newSessionEmbeddings) {
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
