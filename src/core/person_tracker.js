/**
 * Motor de Seguimiento de Personas (Person Tracker)
 * Mantiene la persistencia de identidad espacial (trackId) entre fotogramas consecutivos
 * utilizando IoU y seguimiento de centroides.
 */

import { calculateIoU, isPointInsideZone } from "./geometry.js";
import { isChairZone, isTransitZone } from "./barbershop_rules.js";
import { computeCosineSimilarity } from "../face_recognizer.js";
import { PIPELINE_CONFIG } from "./pipeline_config.js";

export class PersonTracker {
  constructor(options = {}) {
    this.iouThreshold = options.iouThreshold ?? PIPELINE_CONFIG.tracking.iouThreshold;
    this.maxMissedFrames = options.maxMissedFrames || 8;
    this.maxChairMissedFrames = options.maxChairMissedFrames || 75; // ~30s de memoria para cliente sentado en silla
    this.minChairFrames = options.minChairFrames ?? PIPELINE_CONFIG.tracking.minChairFrames; // Debounce de asiento: 6 fotogramas
    this.leaveDebounceFrames = options.leaveDebounceFrames ?? PIPELINE_CONFIG.tracking.leaveDebounceFrames; // Debounce de levantarse: 6 fotogramas
    this.minChairDurationMs = options.minChairDurationMs !== undefined ? options.minChairDurationMs : PIPELINE_CONFIG.tracking.minChairDurationMs;
    this.leaveDebounceDurationMs = options.leaveDebounceDurationMs !== undefined ? options.leaveDebounceDurationMs : PIPELINE_CONFIG.tracking.leaveDebounceDurationMs;
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

  _updateChairSittingState(track, now = Date.now()) {
    if ((track.missedFrames || 0) > 0) return;
    const isStaff = track.isStaffHint === true || track.identity?.isStaff === true || track.role === "staff";
    const inChair = !isStaff && track.currentQuadrant && isChairZone(track.currentQuadrant);

    if (inChair) {
      if (!track.chairEnteredAt || track.consecutiveChairFrames === 0) {
        track.chairEnteredAt = now;
      }
      track.consecutiveChairFrames = (track.consecutiveChairFrames || 0) + 1;
      track.consecutiveNonChairFrames = 0;
      track.chairLeftAt = null;

      // Si ya estaba formalmente sentado y cambia de silla
      if (track.isFormallySeated && track.lastChairQuadrant && track.lastChairQuadrant.id !== track.currentQuadrant.id) {
        const oldName = track.lastChairQuadrant.label || track.lastChairQuadrant.name || 'Silla de corte';
        const newName = track.currentQuadrant.label || track.currentQuadrant.name || 'Silla de corte';
        this.emitEvent(`🚶 Persona (Track #${track.trackId}) se levantó de ${oldName}`, "process");
        this.emitEvent(`💺 Persona (Track #${track.trackId}) se sienta en ${newName}`, "process");
        track.lastChairQuadrant = track.currentQuadrant;
      } else if (
        !track.isFormallySeated &&
        track.consecutiveChairFrames >= this.minChairFrames &&
        (now - track.chairEnteredAt) >= (this.minChairDurationMs || 2000)
      ) {
        // Disparo formal de asiento tras >= minChairFrames y duración >= minChairDurationMs
        track.isFormallySeated = true;
        track.lastChairQuadrant = track.currentQuadrant;
        const quadName = track.currentQuadrant.label || track.currentQuadrant.name || 'Silla de corte';
        this.emitEvent(`💺 Persona (Track #${track.trackId}) se sienta en ${quadName}`, "process");
      }
    } else {
      if (!track.chairLeftAt || track.consecutiveNonChairFrames === 0) {
        track.chairLeftAt = now;
      }
      track.consecutiveNonChairFrames = (track.consecutiveNonChairFrames || 0) + 1;
      track.consecutiveChairFrames = 0;
      track.chairEnteredAt = null;

      // Disparo de levantarse: requiere al menos leaveDebounceFrames consecutivos fuera
      // o (now - (track.chairLeftAt || now)) >= (this.leaveDebounceDurationMs || 2000)
      if (
        track.isFormallySeated &&
        (track.consecutiveNonChairFrames >= this.leaveDebounceFrames ||
         (now - (track.chairLeftAt || now)) >= (this.leaveDebounceDurationMs || 2000))
      ) {
        track.isFormallySeated = false;
        track.latestFace = null;
        if (track.bestFace) track.bestFace._consumedByVisit = true;
        const quadName = track.lastChairQuadrant?.label || track.lastChairQuadrant?.name || 'Silla de corte';
        this.emitEvent(`🚶 Persona (Track #${track.trackId}) se levantó de ${quadName}`, "process");
        track.lastChairQuadrant = null;
        track.chairLeftAt = null;
      }
    }
  }

  /**
   * Actualiza el estado de las personas seguidas con las nuevas detecciones
   * @param {Array<{box: number[], score: number, class: string}>} detections - Detecciones de YOLOv8
   * @param {Array<Object>} quadrants - Cuadrantes de la barbería
   * @param {number} imgWidth
   * @param {number} imgHeight
   * @param {number} [now=Date.now()]
   * @returns {Array<Object>} Lista de personas activas con su trackId y cuadrante actual
   */
  update(detections, quadrants = [], imgWidth = 1024, imgHeight = 576, now = Date.now()) {
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
        const isSeatedClientTrack = track.isFormallySeated || (track.currentQuadrant && isChairZone(track.currentQuadrant));
        const chairId = (track.lastChairQuadrant || track.currentQuadrant)?.id;

        if (isSeatedClientTrack && chairId) {
          const detQuadrant = this.findMatchingQuadrant(det.box, quadrants, imgWidth, imgHeight);
          if (detQuadrant && detQuadrant.id !== chairId) {
            // Un cliente sentado en silla nunca salta por centroide hacia otro cuadrante distinto (ej. silla de espera)
            continue;
          }
          const detH = Math.abs(det.box[3] - det.box[1]);
          if (trackH > 0 && detH > trackH * 1.38) {
            // Evitar que el track del cliente sentado salte hacia el barbero de pie (caja mucho más alta)
            continue;
          }
        }
        const allowedDist = isSeatedClientTrack
          ? Math.min(Math.max(trackW, trackH, 90) * 1.3, 140)
          : Math.max(trackW, trackH, 90) * 1.6;

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
    // Si un cliente confirmado o sentado quedó sin emparejar brevemente (oclusión temporal de brazos del barbero <= 12 frames),
    // y en esa misma silla aparece una detección compatible en altura (sentado):
    // Vincula inmediatamente la detección de menor altura al track existente para preservar su trackId sin saltar al barbero de pie.
    for (const [tId, track] of trackEntries) {
      if (matchedTrackIds.has(tId)) continue;
      if ((track.missedFrames || 0) > 12) continue;
      if (!track.isFormallySeated && (!track.currentQuadrant || !isChairZone(track.currentQuadrant))) continue;
      const chairId = (track.lastChairQuadrant || track.currentQuadrant)?.id;
      if (!chairId) continue;

      const trackH = track.box ? Math.abs(track.box[3] - track.box[1]) : 0;
      const candidateDetsInChair = [];
      for (let dIdx = 0; dIdx < personDetections.length; dIdx++) {
        if (matchedDetectionIndices.has(dIdx)) continue;
        const det = personDetections[dIdx];
        const detQuadrant = this.findMatchingQuadrant(det.box, quadrants, imgWidth, imgHeight);
        if (detQuadrant?.id === chairId) {
          const detH = det.box ? Math.abs(det.box[3] - det.box[1]) : 0;
          if (trackH > 0 && detH > trackH * 1.35) continue;
          candidateDetsInChair.push({ dIdx, det, detQuadrant, detH });
        }
      }

      if (candidateDetsInChair.length > 0) {
        candidateDetsInChair.sort((a, b) => a.detH - b.detH);
        const chosen = candidateDetsInChair[0];
        matchedTrackIds.add(tId);
        matchedDetectionIndices.add(chosen.dIdx);

        track.box = chosen.det.box;
        track.boxNorm = [
          Number((chosen.det.box[1] / imgHeight).toFixed(4)),
          Number((chosen.det.box[0] / imgWidth).toFixed(4)),
          Number((chosen.det.box[3] / imgHeight).toFixed(4)),
          Number((chosen.det.box[2] / imgWidth).toFixed(4))
        ];
        track.confidence = chosen.det.score;
        track.lastSeen = now;
        track.missedFrames = 0;
        track.centroid = {
          x: Math.round((chosen.det.box[0] + chosen.det.box[2]) / 2),
          y: Math.round((chosen.det.box[1] + chosen.det.box[3]) / 2)
        };
        track.seenCount = (track.seenCount || 0) + 1;
        const prevQuadrant = track.currentQuadrant;
        track.currentQuadrant = chosen.detQuadrant;
        this._handleQuadrantChange(track, prevQuadrant, track.currentQuadrant, now);
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
            track.latestFace = null;
            if (track.bestFace) track.bestFace._consumedByVisit = true;
            const quadName = track.lastChairQuadrant?.label || track.lastChairQuadrant?.name || 'Silla de corte';
            this.emitEvent(`🚶 Persona (Track #${tId}) se levantó de ${quadName}`, "process");
            track.lastChairQuadrant = null;
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
          chairEnteredAt: null,
          chairLeftAt: null,
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
          latestFace: null,
          topFaces: [], // Almacena hasta las 10 mejores caras
          lastPhotoTime: 0,
          lastPose: null
        };

        this.activeTracks.set(tId, newTrack);
        this.emitEvent(`🚶 Persona ingresa al local (Track #${tId})`, "info");
      }
    }

    // 4. Resolución de conflicto en Sillas de Barbero:
    // En una silla de corte solo puede haber 1 cliente sentado visible en el cuadro actual. El acompañante de pie es el barbero.
    // IMPORTANTE: Ignorar tracks con missedFrames > 0 para que un track ocluido nunca envenene al track visible como "staff".
    const chairTracksMap = new Map();
    for (const track of this.activeTracks.values()) {
      if ((track.missedFrames || 0) > 0) continue;
      if (track.currentQuadrant?.type === "barber_chair") {
        const qId = track.currentQuadrant.id;
        if (!chairTracksMap.has(qId)) chairTracksMap.set(qId, []);
        chairTracksMap.get(qId).push(track);
      }
    }

    for (const [qId, tracksInChair] of chairTracksMap.entries()) {
      if (tracksInChair.length > 1) {
        let seatedTrack = null;
        let standingTracks = [];

        // 1. Si uno de los tracks ya estaba formalmente sentado (track.isFormallySeated === true y track.role === "client"),
        // preservarlo como el cliente sentado
        const formallySeatedClients = tracksInChair.filter(t => t.isFormallySeated === true && t.role === "client");
        if (formallySeatedClients.length === 1) {
          seatedTrack = formallySeatedClients[0];
          standingTracks = tracksInChair.filter(t => t !== seatedTrack);
        } else {
          // 2. Usar la altura corporal total (box[3] - box[1]):
          // El barbero de pie tiene mayor elongación vertical que el cliente sentado con la capa.
          // El cliente sentado tiene menor elongación vertical.
          const sortedByHeight = [...tracksInChair].sort((a, b) => {
            const hA = a.box ? (a.box[3] - a.box[1]) : 0;
            const hB = b.box ? (b.box[3] - b.box[1]) : 0;
            return hA - hB;
          });
          seatedTrack = sortedByHeight[0];
          standingTracks = sortedByHeight.slice(1);
        }

        // 3. El track de pie se marca incondicionalmente: standingTrack.isStaffHint = true; standingTrack.role = "staff";
        // El sentado: seatedTrack.isStaffHint = false; seatedTrack.role = "client";
        seatedTrack.isStaffHint = false;
        seatedTrack.role = "client";

        for (const standingTrack of standingTracks) {
          standingTrack.isStaffHint = true;
          standingTrack.role = "staff";
        }
      } else if (tracksInChair.length === 1) {
        const singleTrack = tracksInChair[0];
        const boxH = singleTrack.box ? (singleTrack.box[3] - singleTrack.box[1]) : 0;
        const boxTop = singleTrack.box ? singleTrack.box[1] : imgHeight;
        const isClearStandingGeometry = imgHeight > 0 && (boxH / imgHeight) >= 0.58 && (boxTop / imgHeight) <= 0.20;
        const isStandingPosture = imgHeight > 0 && ((boxH / imgHeight) >= 0.55 || (boxTop / imgHeight) <= 0.22);

        if (singleTrack.identity?.isStaff === true) {
          singleTrack.isStaffHint = true;
          singleTrack.role = "staff";
        } else if (!singleTrack.isFormallySeated && singleTrack.isStaffHint === true && (isClearStandingGeometry || isStandingPosture)) {
          singleTrack.isStaffHint = true;
          singleTrack.role = "staff";
        } else if (singleTrack.isFormallySeated === true && singleTrack.role === "client") {
          singleTrack.isStaffHint = false;
          singleTrack.role = "client";
        } else if ((singleTrack.isStaffHint === true || singleTrack.role === "staff") && isStandingPosture) {
          singleTrack.isStaffHint = true;
          singleTrack.role = "staff";
        } else {
          singleTrack.isStaffHint = false;
          singleTrack.role = "client";
        }
      }
    }

    // 5. Actualizar estado de permanencia y debounce de asiento (6 a 8 fotogramas)
    for (const track of this.activeTracks.values()) {
      this._updateChairSittingState(track, now);
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
  updateIdentityAndFace(trackId, { identity, faceBuffer, faceBoxNorm, sharpnessScore, thumbnailBase64, embedding, pose, now: overrideNow }) {
    const track = this.activeTracks.get(trackId);
    if (!track) return false;

    if (identity) {
      track.identity = identity;
      track.status = "identified";
    }

    if (faceBuffer && sharpnessScore) {
      const now = typeof overrideNow === "number" && overrideNow > 0 ? overrideNow : Date.now();
      const incomingPose = pose || identity?.pose || null;
      const targetEmbedding = embedding || identity?.embedding || null;

      const faceShot = {
        faceBuffer,
        faceBoxNorm,
        sharpnessScore,
        thumbnailBase64: thumbnailBase64 || identity?.thumbnailBase64 || null,
        embedding: targetEmbedding,
        pose: incomingPose || 'frontal',
        poseLabel: identity?.poseLabel || null,
        timestamp: new Date(now).toISOString()
      };

      track.latestFace = faceShot;

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
      // Si la última foto tomada fue hace menos de 20,000 ms (o 12,000 ms virtuales) y la pose es la misma, omitir adición
      const cooldownMs = (typeof overrideNow === "number" && overrideNow > 0) ? 12000 : (process.env.STREAM_FAST_FORWARD === "true" ? 2000 : 20000);
      if (track.lastPhotoTime && (now - track.lastPhotoTime < cooldownMs) && incomingPose && track.lastPose === incomingPose) {
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
