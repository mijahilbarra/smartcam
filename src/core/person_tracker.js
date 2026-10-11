/**
 * Motor de Seguimiento de Personas (Person Tracker)
 * Mantiene la persistencia de identidad espacial (trackId) entre fotogramas consecutivos
 * utilizando IoU y seguimiento de centroides.
 */

import { calculateIoU, isPointInsideZone } from "./geometry.js";
import { isChairZone, isTransitZone } from "./barbershop_rules.js";
import { computeCosineSimilarity } from "../face_recognizer.js";

export class PersonTracker {
  constructor(options = {}) {
    this.iouThreshold = options.iouThreshold || 0.30;
    this.maxMissedFrames = options.maxMissedFrames || 8;
    this.maxChairMissedFrames = options.maxChairMissedFrames || 75; // ~30s de memoria para cliente sentado en silla
    this.minChairFrames = options.minChairFrames || 6; // Debounce de asiento: 6 fotogramas (~2s de quietud)
    this.leaveDebounceFrames = options.leaveDebounceFrames || 6; // Debounce de levantarse: 6 fotogramas continuos fuera
    this.nextTrackId = 1;
    this.activeTracks = new Map(); // trackId -> TrackedPerson
    this.historyTracks = [];
    this.pendingEvents = [];
  }

  emitEvent(text, type = "info") {
    this.pendingEvents.push({ text, type });
  }

  consumeEvents() {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  _handleQuadrantChange(track, prevQuadrant, currentQuadrant, now) {
    if (prevQuadrant?.id === currentQuadrant?.id) return;
    track.quadrantChangedAt = now;
  }

  _updateChairSittingState(track) {
    const isStaff = track.isStaffHint === true || track.identity?.isStaff === true || track.role === "staff";
    const inChair = !isStaff && track.currentQuadrant && isChairZone(track.currentQuadrant);

    if (inChair) {
      track.consecutiveChairFrames = (track.consecutiveChairFrames || 0) + 1;
      track.consecutiveNonChairFrames = 0;

      // Si ya estaba formalmente sentado y cambia de silla
      if (track.isFormallySeated && track.lastChairQuadrant && track.lastChairQuadrant.id !== track.currentQuadrant.id) {
        const oldName = track.lastChairQuadrant.label || track.lastChairQuadrant.name || 'Silla de corte';
        const newName = track.currentQuadrant.label || track.currentQuadrant.name || 'Silla de corte';
        this.emitEvent(`🚶 Persona (Track #${track.trackId}) se levantó de ${oldName}`, "process");
        this.emitEvent(`💺 Persona (Track #${track.trackId}) se sienta en ${newName}`, "process");
        track.lastChairQuadrant = track.currentQuadrant;
      } else if (track.consecutiveChairFrames >= this.minChairFrames && !track.isFormallySeated) {
        // Disparo formal de asiento tras >= minChairFrames (6 a 8) consecutivos
        track.isFormallySeated = true;
        track.lastChairQuadrant = track.currentQuadrant;
        const quadName = track.currentQuadrant.label || track.currentQuadrant.name || 'Silla de corte';
        this.emitEvent(`💺 Persona (Track #${track.trackId}) se sienta en ${quadName}`, "process");
      }
    } else {
      track.consecutiveNonChairFrames = (track.consecutiveNonChairFrames || 0) + 1;
      track.consecutiveChairFrames = 0;

      // Disparo de levantarse: requiere al menos leaveDebounceFrames (6) consecutivos fuera
      // Evita falsos 'se levantó / entra y sale' ante movimientos de brazos del barbero o caídas de 1-2 frames
      if (track.isFormallySeated && track.consecutiveNonChairFrames >= this.leaveDebounceFrames) {
        track.isFormallySeated = false;
        const quadName = track.lastChairQuadrant?.label || track.lastChairQuadrant?.name || 'Silla de corte';
        this.emitEvent(`🚶 Persona (Track #${track.trackId}) se levantó de ${quadName}`, "process");
      }
    }
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
      this._handleQuadrantChange(track, prevQuadrant, track.currentQuadrant, now);
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
      this._handleQuadrantChange(track, prevQuadrant, track.currentQuadrant, now);
    }

    // 1c. Etapa 3: Emparejamiento por continuidad espacial en Silla de Barbero
    // Si un cliente confirmado o sentado quedó sin emparejar en este cuadro (por ej. oclusión temporal de brazos del barbero),
    // y en esa misma silla aparece una detección no emparejada:
    // Vincula inmediatamente la detección al track existente para preservar de forma inmutable su trackId.
    for (const [tId, track] of trackEntries) {
      if (matchedTrackIds.has(tId)) continue;
      if (!track.isFormallySeated && (!track.currentQuadrant || !isChairZone(track.currentQuadrant))) continue;
      const chairId = (track.lastChairQuadrant || track.currentQuadrant)?.id;
      if (!chairId) continue;

      for (let dIdx = 0; dIdx < personDetections.length; dIdx++) {
        if (matchedDetectionIndices.has(dIdx)) continue;
        const det = personDetections[dIdx];
        const detQuadrant = this.findMatchingQuadrant(det.box, quadrants, imgWidth, imgHeight);
        if (detQuadrant?.id === chairId) {
          matchedTrackIds.add(tId);
          matchedDetectionIndices.add(dIdx);

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
          track.currentQuadrant = detQuadrant;
          this._handleQuadrantChange(track, prevQuadrant, track.currentQuadrant, now);
          break;
        }
      }
    }

    // 2. Gestionar tracks existentes no emparejados en este cuadro
    for (const [tId, track] of trackEntries) {
      if (!matchedTrackIds.has(tId)) {
        track.missedFrames += 1;
        const maxAllowed = track.isFormallySeated
          ? this.maxChairMissedFrames
          : this.maxMissedFrames;
        if (track.missedFrames > maxAllowed) {
          track.status = "left";
          track.leftAt = now;
          if (track.isFormallySeated) {
            track.isFormallySeated = false;
            const quadName = track.lastChairQuadrant?.label || track.lastChairQuadrant?.name || 'Silla de corte';
            this.emitEvent(`🚶 Persona (Track #${tId}) se levantó de ${quadName}`, "process");
          }
          this.historyTracks.push({ ...track });
          this.activeTracks.delete(tId);
          this.emitEvent(`🚪 Persona (Track #${tId}) salió del encuadre`, "info");
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
          consecutiveChairFrames: 0,
          consecutiveNonChairFrames: 0,
          isFormallySeated: false,
          lastChairQuadrant: null,
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
          topFaces: [], // Almacena hasta las 10 mejores caras
          lastPhotoTime: 0,
          lastPose: null
        };

        this.activeTracks.set(tId, newTrack);
        this.emitEvent(`🚶 Persona ingresa al local (Track #${tId})`, "info");
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
          if (standingBarber.identity?.role !== "client" && standingBarber.identity?.isStaff !== false) {
            standingBarber.isStaffHint = true;
            standingBarber.role = "staff";
          }

          for (let i = 1; i < tracksInChair.length; i++) {
            tracksInChair[i].isStaffHint = false;
            tracksInChair[i].role = "client";
          }
        }
      } else if (tracksInChair.length === 1) {
        const singleTrack = tracksInChair[0];
        if (singleTrack.identity?.isStaff === true) {
          singleTrack.isStaffHint = true;
          singleTrack.role = "staff";
        }
      }
    }

    // 5. Actualizar estado de permanencia y debounce de asiento (6 a 8 fotogramas)
    for (const track of this.activeTracks.values()) {
      this._updateChairSittingState(track);
    }

    return Array.from(this.activeTracks.values());
  }

  /**
   * Determina en qué cuadrante o silla está la persona
   */
  findMatchingQuadrant(box, quadrants, imgWidth = 1024, imgHeight = 576) {
    if (!quadrants || quadrants.length === 0) return null;
    const [x1, y1, x2, y2] = box;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const normX = imgWidth ? cx / imgWidth : 0;
    const normY = imgHeight ? cy / imgHeight : 0;

    const h = y2 - y1;
    const bodyHeights = [0.38, 0.50, 0.65, 0.80, 0.90];
    const xWeights = [
      [0.50, 0.50],
      [0.65, 0.35],
      [0.35, 0.65]
    ];

    const bodySamples = [];
    for (const bh of bodyHeights) {
      const sy = imgHeight ? (y1 + h * bh) / imgHeight : 0;
      for (const [w1, w2] of xWeights) {
        const sx = imgWidth ? (x1 * w1 + x2 * w2) / imgWidth : 0;
        bodySamples.push([sx, sy]);
      }
    }

    const candidates = [];
    for (const q of quadrants) {
      if (!q) continue;
      // Las personas rastreadas deben ubicarse únicamente en zonas físicas configuradas, no en overlays temporales de personas
      if (q.isConfiguredZone === false) continue;
      let isInside = false;
      const isChair = isChairZone(q);

      if (isChair) {
        // Regla de negocio: la cabeza puede estar por fuera de la silla;
        // se muestrea a lo largo del torso y cuerpo sentado (38%, 50%, 65%, 80%, 90% de la altura).
        if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3 && imgWidth && imgHeight) {
          isInside = bodySamples.some(([px, py]) => isPointInsideZone(px, py, q));
        }

        if (!isInside && q.box) {
          const [qx1, qy1, qx2, qy2] = q.box;
          isInside = bodySamples.some(([px, py]) => {
            const pxPx = px * imgWidth;
            const pyPx = py * imgHeight;
            return pxPx >= qx1 && pxPx <= qx2 && pyPx >= qy1 && pyPx <= qy2;
          });
        }

        if (!isInside && q.boxNorm) {
          const [by1, bx1, by2, bx2] = q.boxNorm;
          isInside = bodySamples.some(([px, py]) => px >= bx1 && px <= bx2 && py >= by1 && py <= by2);
        }
      } else {
        // Verificación estándar para pasillos / tránsito / espera
        if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3 && imgWidth && imgHeight) {
          if (isPointInsideZone(normX, normY, q)) {
            isInside = true;
          }
        }

        if (!isInside && q.box) {
          const [qx1, qy1, qx2, qy2] = q.box;
          if (cx >= qx1 && cx <= qx2 && cy >= qy1 && cy <= qy2) {
            isInside = true;
          }
        }

        if (!isInside && q.boxNorm) {
          const [by1, bx1, by2, bx2] = q.boxNorm;
          if (normX >= bx1 && normX <= bx2 && normY >= by1 && normY <= by2) {
            isInside = true;
          }
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
  updateIdentityAndFace(trackId, { identity, faceBuffer, faceBoxNorm, sharpnessScore, thumbnailBase64, embedding, pose }) {
    const track = this.activeTracks.get(trackId);
    if (!track) return false;

    if (identity) {
      track.identity = identity;
      track.status = "identified";
    }

    if (faceBuffer && sharpnessScore) {
      const now = Date.now();
      const incomingPose = pose || identity?.pose || null;
      const targetEmbedding = embedding || identity?.embedding || null;

      const faceShot = {
        faceBuffer,
        faceBoxNorm,
        sharpnessScore,
        thumbnailBase64: thumbnailBase64 || identity?.thumbnailBase64 || null,
        embedding: targetEmbedding,
        pose: incomingPose || 'frontal',
        timestamp: new Date().toISOString()
      };

      // 1. Deduplicación por fotograma idéntico / congelado (sim >= 0.985)
      let duplicateIdx = -1;
      if (targetEmbedding && track.topFaces.length > 0) {
        for (let i = 0; i < track.topFaces.length; i++) {
          const exFace = track.topFaces[i];
          if (!exFace.embedding) continue;
          const sim = computeCosineSimilarity(targetEmbedding, exFace.embedding);
          if (sim >= 0.985) {
            duplicateIdx = i;
            break;
          }
        }
      }

      if (duplicateIdx !== -1) {
        const existingFace = track.topFaces[duplicateIdx];
        if (sharpnessScore > (existingFace.sharpnessScore || 0)) {
          track.topFaces[duplicateIdx] = faceShot;
          track.topFaces.sort((a, b) => b.sharpnessScore - a.sharpnessScore);
          if (!track.bestFace || sharpnessScore > track.bestFace.sharpnessScore) {
            track.bestFace = faceShot;
          }
          track.lastPhotoTime = now;
          if (incomingPose) track.lastPose = incomingPose;
        }
        return true;
      }

      // 2. Control de cadencia temporal ("de vez en cuando"):
      // Si la última foto tomada fue hace menos de 20,000 ms y la pose es la misma, omitir adición
      if (track.lastPhotoTime && (now - track.lastPhotoTime < 20000) && incomingPose && track.lastPose === incomingPose) {
        // Si supera la nitidez de la foto de esta pose, actualizarla
        const samePoseIdx = track.topFaces.findIndex(f => f.pose === incomingPose);
        const updateIdx = samePoseIdx !== -1 ? samePoseIdx : (track.topFaces.length - 1);
        if (updateIdx !== -1 && sharpnessScore > (track.topFaces[updateIdx].sharpnessScore || 0)) {
          track.topFaces[updateIdx] = faceShot;
          track.topFaces.sort((a, b) => b.sharpnessScore - a.sharpnessScore);
          if (!track.bestFace || sharpnessScore > track.bestFace.sharpnessScore) {
            track.bestFace = faceShot;
          }
          track.lastPhotoTime = now;
        }
        return true;
      }

      // 3. Agregar nueva foto válida
      if (!track.bestFace || sharpnessScore > track.bestFace.sharpnessScore) {
        track.bestFace = faceShot;
      }

      track.topFaces.push(faceShot);
      track.topFaces.sort((a, b) => b.sharpnessScore - a.sharpnessScore);
      if (track.topFaces.length > 10) {
        track.topFaces.pop();
      }

      track.lastPhotoTime = now;
      if (incomingPose) track.lastPose = incomingPose;
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
