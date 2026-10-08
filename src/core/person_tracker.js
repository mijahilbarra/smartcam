/**
 * Motor de Seguimiento de Personas (Person Tracker)
 * Mantiene la persistencia de identidad espacial (trackId) entre fotogramas consecutivos
 * utilizando IoU y seguimiento de centroides.
 */

import { calculateIoU, isPointInsideZone } from "./geometry.js";
import { isChairZone, isTransitZone } from "./barbershop_rules.js";

export class PersonTracker {
  constructor(options = {}) {
    this.iouThreshold = options.iouThreshold || 0.30;
    this.maxMissedFrames = options.maxMissedFrames || 8;
    this.nextTrackId = 1;
    this.activeTracks = new Map(); // trackId -> TrackedPerson
    this.historyTracks = [];
  }

  /**
   * Actualiza el estado de las personas seguidas con las nuevas detecciones
   * @param {Array<{box: number[], score: number, class: string}>} detections - Detecciones de YOLOv8
   * @param {Array<Object>} quadrants - Cuadrantes de la barbería
   * @param {number} imgWidth
   * @param {number} imgHeight
   * @returns {Array<Object>} Lista de personas activas con su trackId y cuadrante actual
   */
  update(detections, quadrants = [], imgWidth = 1024, imgHeight = 576) {
    const now = Date.now();
    const personDetections = (detections || []).filter(d => d.class === "person");

    const trackEntries = Array.from(this.activeTracks.entries());
    const matchedTrackIds = new Set();
    const matchedDetectionIndices = new Set();

    // 1. Matriz de emparejamiento por IoU
    const matches = [];
    for (let tIdx = 0; tIdx < trackEntries.length; tIdx++) {
      const [tId, track] = trackEntries[tIdx];
      for (let dIdx = 0; dIdx < personDetections.length; dIdx++) {
        const det = personDetections[dIdx];
        const iou = calculateIoU(track.box, det.box);
        if (iou >= this.iouThreshold) {
          matches.push({ tId, dIdx, iou });
        }
      }
    }

    // Ordenar de mayor a menor IoU (Greedy matching)
    matches.sort((a, b) => b.iou - a.iou);

    for (const match of matches) {
      if (matchedTrackIds.has(match.tId) || matchedDetectionIndices.has(match.dIdx)) {
        continue;
      }
      matchedTrackIds.add(match.tId);
      matchedDetectionIndices.add(match.dIdx);

      const track = this.activeTracks.get(match.tId);
      const det = personDetections[match.dIdx];

      track.box = det.box;
      track.boxNorm = [
        Number((det.box[1] / imgHeight).toFixed(4)), // ymin
        Number((det.box[0] / imgWidth).toFixed(4)),  // xmin
        Number((det.box[3] / imgHeight).toFixed(4)), // ymax
        Number((det.box[2] / imgWidth).toFixed(4))   // xmax
      ];
      track.confidence = det.score;
      track.lastSeen = now;
      track.missedFrames = 0;
      track.centroid = {
        x: Math.round((det.box[0] + det.box[2]) / 2),
        y: Math.round((det.box[1] + det.box[3]) / 2)
      };

      // Evaluar cuadrante físico
      track.seenCount = (track.seenCount || 0) + 1;
      const prevQuadrant = track.currentQuadrant;
      track.currentQuadrant = this.findMatchingQuadrant(track.box, quadrants, imgWidth, imgHeight);
      if (prevQuadrant?.id !== track.currentQuadrant?.id) {
        track.quadrantChangedAt = now;
      }
      if (track.currentQuadrant && isChairZone(track.currentQuadrant)) {
        track.consecutiveChairFrames = (track.consecutiveChairFrames || 0) + 1;
      } else {
        track.consecutiveChairFrames = 0;
      }
    }

    // 1b. Etapa 2: Emparejamiento por proximidad euclidiana de centroides
    // Para personas que se desplazan rápido o cambian de postura entre fotogramas (evita saltos de trackId)
    const centroidMatches = [];
    const maxCentroidDist = Math.max(imgWidth, imgHeight) * 0.32;

    for (let tIdx = 0; tIdx < trackEntries.length; tIdx++) {
      const [tId, track] = trackEntries[tIdx];
      if (matchedTrackIds.has(tId)) continue;

      for (let dIdx = 0; dIdx < personDetections.length; dIdx++) {
        if (matchedDetectionIndices.has(dIdx)) continue;
        const det = personDetections[dIdx];
        const detCx = (det.box[0] + det.box[2]) / 2;
        const detCy = (det.box[1] + det.box[3]) / 2;

        const trackCx = track.centroid?.x ?? ((track.box[0] + track.box[2]) / 2);
        const trackCy = track.centroid?.y ?? ((track.box[1] + track.box[3]) / 2);

        const dx = trackCx - detCx;
        const dy = trackCy - detCy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const trackW = Math.abs(track.box[2] - track.box[0]);
        const trackH = Math.abs(track.box[3] - track.box[1]);
        const allowedDist = Math.max(trackW, trackH, 90) * 1.6;

        if (dist <= Math.min(allowedDist, maxCentroidDist)) {
          centroidMatches.push({ tId, dIdx, dist });
        }
      }
    }

    centroidMatches.sort((a, b) => a.dist - b.dist);

    for (const match of centroidMatches) {
      if (matchedTrackIds.has(match.tId) || matchedDetectionIndices.has(match.dIdx)) {
        continue;
      }
      matchedTrackIds.add(match.tId);
      matchedDetectionIndices.add(match.dIdx);

      const track = this.activeTracks.get(match.tId);
      const det = personDetections[match.dIdx];

      track.box = det.box;
      track.boxNorm = [
        Number((det.box[1] / imgHeight).toFixed(4)),
        Number((det.box[0] / imgWidth).toFixed(4)),
        Number((det.box[3] / imgHeight).toFixed(4)),
        Number((det.box[2] / imgWidth).toFixed(4))
      ];
      track.confidence = det.score;
      track.lastSeen = now;
      track.missedFrames = 0;
      track.centroid = {
        x: Math.round((det.box[0] + det.box[2]) / 2),
        y: Math.round((det.box[1] + det.box[3]) / 2)
      };

      track.seenCount = (track.seenCount || 0) + 1;
      const prevQuadrant = track.currentQuadrant;
      track.currentQuadrant = this.findMatchingQuadrant(track.box, quadrants, imgWidth, imgHeight);
      if (prevQuadrant?.id !== track.currentQuadrant?.id) {
        track.quadrantChangedAt = now;
      }
      if (track.currentQuadrant && isChairZone(track.currentQuadrant)) {
        track.consecutiveChairFrames = (track.consecutiveChairFrames || 0) + 1;
      } else {
        track.consecutiveChairFrames = 0;
      }
    }

    // 2. Gestionar tracks existentes no emparejados en este cuadro
    for (const [tId, track] of trackEntries) {
      if (!matchedTrackIds.has(tId)) {
        track.missedFrames += 1;
        if (track.missedFrames > this.maxMissedFrames) {
          track.status = "left";
          track.leftAt = now;
          this.historyTracks.push({ ...track });
          this.activeTracks.delete(tId);
        }
      }
    }

    // 3. Crear nuevos tracks para detecciones sin emparejar
    for (let dIdx = 0; dIdx < personDetections.length; dIdx++) {
      if (!matchedDetectionIndices.has(dIdx)) {
        const det = personDetections[dIdx];
        const tId = this.nextTrackId++;
        const quadrant = this.findMatchingQuadrant(det.box, quadrants, imgWidth, imgHeight);

        const newTrack = {
          trackId: tId,
          seenCount: 1,
          consecutiveChairFrames: quadrant && isChairZone(quadrant) ? 1 : 0,
          box: det.box,
          boxNorm: [
            Number((det.box[1] / imgHeight).toFixed(4)), // ymin
            Number((det.box[0] / imgWidth).toFixed(4)),  // xmin
            Number((det.box[3] / imgHeight).toFixed(4)), // ymax
            Number((det.box[2] / imgWidth).toFixed(4))   // xmax
          ],
          confidence: det.score,
          firstSeen: now,
          lastSeen: now,
          missedFrames: 0,
          centroid: {
            x: Math.round((det.box[0] + det.box[2]) / 2),
            y: Math.round((det.box[1] + det.box[3]) / 2)
          },
          currentQuadrant: quadrant,
          quadrantChangedAt: now,
          status: "unidentified", // unidentified -> identifying -> identified
          identity: null,
          isStaffHint: false,
          role: "client",
          bestFace: null,
          topFaces: [] // Almacena hasta las 10 mejores caras
        };

        this.activeTracks.set(tId, newTrack);
      }
    }

    // 4. Resolución de conflicto en Sillas de Barbero:
    // En una silla de corte solo puede haber 1 cliente sentado. El acompañante de pie es el barbero.
    const chairTracksMap = new Map();
    for (const track of this.activeTracks.values()) {
      if (track.currentQuadrant?.type === "barber_chair") {
        const qId = track.currentQuadrant.id;
        if (!chairTracksMap.has(qId)) chairTracksMap.set(qId, []);
        chairTracksMap.get(qId).push(track);
      }
    }

    for (const [qId, tracksInChair] of chairTracksMap.entries()) {
      if (tracksInChair.length > 1) {
        // Si uno ya está identificado como staff/barbero, ese es el barbero
        const staffTrack = tracksInChair.find(t => t.identity?.isStaff === true);
        const nonStaffTracks = tracksInChair.filter(t => t.identity?.isStaff !== true);

        if (staffTrack && nonStaffTracks.length > 0) {
          staffTrack.isStaffHint = true;
          staffTrack.role = "staff";
          for (const nonStaff of nonStaffTracks) {
            nonStaff.isStaffHint = false;
            nonStaff.role = "client";
          }
        } else {
          // Si ninguno está formalizado aún:
          // El barbero de pie tiene su cabeza más alta (y1 menor / ymin menor) o mayor altura total.
          // El cliente sentado tiene la cabeza más baja (y1 mayor).
          tracksInChair.sort((a, b) => a.box[1] - b.box[1]);
          const standingBarber = tracksInChair[0];
          standingBarber.isStaffHint = true;
          standingBarber.role = "staff";

          for (let i = 1; i < tracksInChair.length; i++) {
            tracksInChair[i].isStaffHint = false;
            tracksInChair[i].role = "client";
          }
        }
      }
    }

    return Array.from(this.activeTracks.values());
  }

  /**
   * Determina en qué cuadrante o silla está la persona
   */
  findMatchingQuadrant(box, quadrants, imgWidth, imgHeight) {
    if (!quadrants || quadrants.length === 0) return null;
    const [x1, y1, x2, y2] = box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const normX = imgWidth ? cx / imgWidth : 0;
    const normY = imgHeight ? cy / imgHeight : 0;

    const candidates = [];
    for (const q of quadrants) {
      if (!q) continue;
      let isInside = false;

      // 1. Si tiene polígono normalizado, verificar si el punto está dentro
      if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3 && imgWidth && imgHeight) {
        if (isPointInsideZone(normX, normY, q)) {
          isInside = true;
        }
      }

      // 2. Si no o fallback, verificar caja
      if (!isInside && q.box) {
        const [qx1, qy1, qx2, qy2] = q.box;
        if (cx >= qx1 && cx <= qx2 && cy >= qy1 && cy <= qy2) {
          isInside = true;
        }
      }

      if (isInside) {
        candidates.push(q);
      }
    }

    if (candidates.length === 0) return null;

    // Priorizar sillas y puestos de trabajo por encima de pasillos y tránsito
    candidates.sort((a, b) => {
      const aScore = isChairZone(a) || a.type === "barber_chair" || a.type === "barber_workstation" ? 2 : (isTransitZone(a) ? 0 : 1);
      const bScore = isChairZone(b) || b.type === "barber_chair" || b.type === "barber_workstation" ? 2 : (isTransitZone(b) ? 0 : 1);
      return bScore - aScore;
    });

    return candidates[0];
  }

  /**
   * Actualiza la identidad y el buffer de mejores caras para un track
   */
  updateIdentityAndFace(trackId, { identity, faceBuffer, faceBoxNorm, sharpnessScore, thumbnailBase64, embedding }) {
    const track = this.activeTracks.get(trackId);
    if (!track) return false;

    if (identity) {
      track.identity = identity;
      track.status = "identified";
    }

    if (faceBuffer && sharpnessScore) {
      const faceShot = {
        faceBuffer,
        faceBoxNorm,
        sharpnessScore,
        thumbnailBase64: thumbnailBase64 || identity?.thumbnailBase64 || null,
        embedding: embedding || identity?.embedding || null,
        timestamp: new Date().toISOString()
      };

      // Si supera la mejor cara histórica
      if (!track.bestFace || sharpnessScore > track.bestFace.sharpnessScore) {
        track.bestFace = faceShot;
      }

      // Mantener en el top 10 ordenado por nitidez
      track.topFaces.push(faceShot);
      track.topFaces.sort((a, b) => b.sharpnessScore - a.sharpnessScore);
      if (track.topFaces.length > 10) {
        track.topFaces.pop();
      }
    }

    return true;
  }

  /**
   * Retorna una pista por su ID
   */
  getTrack(trackId) {
    return this.activeTracks.get(trackId) || null;
  }

  /**
   * Limpia todas las pistas
   */
  reset() {
    this.activeTracks.clear();
    this.historyTracks = [];
    this.nextTrackId = 1;
  }
}
