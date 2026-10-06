/**
 * Servicio de Gestión de Sesiones y Registro de Visitas (Visit Session Service)
 * Gestiona el ciclo de vida de los clientes en las sillas de la barbería:
 * - Detecta el inicio de la atención cuando un cliente se sienta.
 * - Registra únicamente los recortes faciales de alta calidad en Storage (~30 KB).
 * - Persiste la visita en Firestore (`camera_catcher_visits`) al terminar el servicio.
 * - Elimina la necesidad de almacenar fotos inútiles de la escena completa.
 */

import { uploadFaceCrop } from "../infrastructure/firebase/storage_client.js";
import { isServiceChair as isServiceChairRule, isTransitZone } from "../core/barbershop_rules.js";

export class VisitSessionService {
  constructor({ db, bucket } = {}) {
    this.db = db;
    this.bucket = bucket;
    this.activeSessions = new Map(); // trackId -> VisitSession
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
   * Procesa la actualización de un track de persona activa
   * @param {Object} track - Pista del PersonTracker
   * @returns {Promise<Object|null>}
   */
  async processTrack(track) {
    if (!track) return null;
    const now = Date.now();
    const isChair = this.isServiceChair(track.currentQuadrant);

    // 1. Iniciar nueva sesión si entra a una silla de atención
    if (isChair && !this.activeSessions.has(track.trackId)) {
      const visitId = `visit_${now}_${track.trackId}`;
      const session = {
        visitId,
        trackId: track.trackId,
        chairId: track.currentQuadrant.id,
        chairName: track.currentQuadrant.label || track.currentQuadrant.name || track.currentQuadrant.id,
        startedAt: new Date(now).toISOString(),
        startedAtEpoch: now,
        status: "en_corte",
        personId: track.identity?.personId || null,
        personName: track.identity?.name || null,
        isStaff: track.identity?.isStaff || false,
        visitCount: track.identity?.visitCount || 1,
        bestFaceScore: track.bestFace?.sharpnessScore || 0,
        bestFaceStoragePath: null,
        topFaces: []
      };
      this.activeSessions.set(track.trackId, session);
      console.log(`[Visit] Iniciada sesión de visita (${visitId}) para Track #${track.trackId} en ${session.chairName}.`);
      return session;
    }

    // 2. Si ya hay una sesión activa para este track
    if (this.activeSessions.has(track.trackId)) {
      const session = this.activeSessions.get(track.trackId);

      // Si la persona fue identificada posteriormente
      if (track.identity && (!session.personId || session.personId !== track.identity.personId)) {
        session.personId = track.identity.personId;
        session.personName = track.identity.name;
        session.isStaff = !!track.identity.isStaff;
        session.visitCount = track.identity.visitCount || 1;
        console.log(`[Visit] Sesión ${session.visitId} asociada a identidad: "${session.personName}" (Staff: ${session.isStaff})`);
      }

      // Si tiene una cara nítida que supera el récord de la sesión
      if (track.bestFace && track.bestFace.sharpnessScore > (session.bestFaceScore || 0)) {
        session.bestFaceScore = track.bestFace.sharpnessScore;

        if (this.bucket && track.bestFace.faceBuffer) {
          const personSlug = session.personId || `track_${track.trackId}`;
          const faceStoragePath = `camera_catcher/faces/${personSlug}_${now}.jpg`;

          try {
            await uploadFaceCrop(this.bucket, faceStoragePath, track.bestFace.faceBuffer, {
              personId: session.personId || "",
              personName: session.personName || "",
              sharpnessScore: session.bestFaceScore,
              visitId: session.visitId
            });
            session.bestFaceStoragePath = faceStoragePath;

            // Actualizar avatar en el catálogo de personas de Firestore
            if (this.db && session.personId && !session.isStaff) {
              await this.db.doc(`camera_catcher_people/${session.personId}`).set({
                thumbnailPath: faceStoragePath,
                bestFaceScore: session.bestFaceScore,
                lastSeen: new Date().toISOString()
              }, { merge: true });
            }

            console.log(`[Visit] Subido recorte facial nítido (~30 KB) a Storage (${faceStoragePath}) con score ${session.bestFaceScore}.`);
          } catch (uploadErr) {
            console.warn(`[Visit] Error subiendo recorte facial a Storage:`, uploadErr.message);
          }
        }
      }

      return session;
    }

    return null;
  }

  /**
   * Finaliza la sesión de visita cuando la persona se levanta o sale de la escena
   * @param {number} trackId
   * @returns {Promise<Object|null>}
   */
  async closeSession(trackId) {
    if (!this.activeSessions.has(trackId)) return null;

    const session = this.activeSessions.get(trackId);
    this.activeSessions.delete(trackId);

    const now = Date.now();
    const durationMinutes = Math.max(1, Math.round((now - session.startedAtEpoch) / 60000));

    // Si es personal/barbero, no se registra como visita de cliente
    if (session.isStaff) {
      console.log(`[Visit] Sesión finalizada para Barbero/Staff: ${session.personName || `Track #${trackId}`}.`);
      return null;
    }

    const visitRecord = {
      id: session.visitId,
      personId: session.personId || `unidentified_${trackId}`,
      personName: session.personName || "Cliente sin identificar",
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
      createdAt: new Date(now).toISOString()
    };

    this.completedVisits.push(visitRecord);

    // Persistir en Firestore en la colección camera_catcher_visits
    if (this.db) {
      try {
        await this.db.doc(`camera_catcher_visits/${session.visitId}`).set(visitRecord);
        console.log(`[Visit] ✅ Visita registrada exitosamente en camera_catcher_visits/${session.visitId} (${session.personName}, ${durationMinutes} min).`);
      } catch (dbErr) {
        console.error(`[Visit] Error guardando visita en Firestore:`, dbErr.message);
      }
    }

    return visitRecord;
  }

  /**
   * Obtiene las sesiones activas en este momento
   */
  getActiveSessions() {
    return Array.from(this.activeSessions.values());
  }
}
