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
          bestFace: null,
          topFaces: [] // Almacena hasta las 10 mejores caras
        };

        this.activeTracks.set(tId, newTrack);
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
  updateIdentityAndFace(trackId, { identity, faceBuffer, faceBoxNorm, sharpnessScore }) {
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
