import { calculateIoU } from "../../core/geometry.js";
import { daemonReporter } from "../../daemon_reporter.js";
import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";

/**
 * 4. Actualización del seguimiento temporal de personas (PersonTracker).
 */
export function trackEntities(tracker, mlResult, now) {
  if (!tracker) return [];
  const activeTracks = tracker.update(
    mlResult.rawDetections || [],
    mlResult.quadrants || [],
    mlResult.imageDimensions?.width,
    mlResult.imageDimensions?.height,
    now
  );

  if (typeof tracker.consumeEvents === "function") {
    const events = tracker.consumeEvents();
    for (const evt of events) {
      daemonReporter.reportVerbalLog(evt.text, evt.type);
    }
  }

  console.log(`[Tracker] Personas rastreadas activas (${activeTracks.length}): ${activeTracks.map(t => `#${t.trackId} [${t.currentQuadrant?.label || 'General'}]`).join(", ") || 'Ninguna'}`);
  return activeTracks;
}

/**
 * 6. Asociación de identidades al tracker mediante superposición espacial IoU.
 */
export function matchIdentitiesToTracks({ tracker, activeTracks = [], identifiedPeople = [], iouThreshold = PIPELINE_CONFIG.tracking.iouThreshold ?? 0.30, now }) {
  if (!tracker) return new Set();
  const matchedTrackIds = new Set();
  const usedPersonIds = new Set();

  for (const person of identifiedPeople) {
    const personKey = person.personId || person.name;
    if (personKey && usedPersonIds.has(personKey)) continue;

    // Si el recorte fue marcado explícitamente como acompañante de pie en silla (companion_in_chair)
    // y no fue confirmado como staff, NO inyectarlo en el track del cliente sentado
    if (person.roleHint === "companion_in_chair" && !person.isStaff) {
      continue;
    }

    let bestTrack = null;
    let maxIoU = 0;

    if (person.box) {
      // Primero verificar a qué track físico corresponde geométricamente la caja con mayor IoU
      let rawBestTrack = null;
      let rawMaxIoU = 0;
      for (const track of activeTracks) {
        const iou = calculateIoU(person.box, track.box);
        if (iou > rawMaxIoU) {
          rawMaxIoU = iou;
          rawBestTrack = track;
        }
      }
      // Si la caja pertenece geométricamente al track del barbero de pie (IoU >= 0.70 con un track isStaffHint),
      // no redirigir ese rostro hacia el track del cliente sentado por solapamiento parcial
      if (!person.isStaff && rawBestTrack && rawMaxIoU >= 0.70 && rawBestTrack.isStaffHint && !rawBestTrack.identity?.isStaff) {
        continue;
      }

      for (const track of activeTracks) {
        if (matchedTrackIds.has(track.trackId)) continue;
        // Evitar asignar un cliente al track del barbero de pie
        if (!person.isStaff && track.isStaffHint && !track.identity?.isStaff) continue;
        // Evitar asignar staff al cliente sentado
        if (person.isStaff && !track.isStaffHint && track.role === "client") continue;

        const iou = calculateIoU(person.box, track.box);
        if (iou > maxIoU) {
          maxIoU = iou;
          bestTrack = track;
        }
      }
    }

    // Coincidencia espacial suficiente
    if (bestTrack && maxIoU >= iouThreshold) {
      matchedTrackIds.add(bestTrack.trackId);
      if (personKey) usedPersonIds.add(personKey);
      tracker.updateIdentityAndFace(bestTrack.trackId, {
        identity: person,
        faceBuffer: person.faceBuffer,
        faceBoxNorm: person.faceBoxNorm,
        landmarks: person.landmarks || null,
        hasTwoEyes: person.hasTwoEyes,
        frontalityScore: person.frontalityScore,
        yawScore: person.yawScore,
        pitchScore: person.pitchScore,
        sharpnessScore: person.sharpnessScore,
        thumbnailBase64: person.thumbnailBase64 || person.faceThumbnailBase64 || null,
        embedding: person.embedding || null,
        pose: person.pose || null,
        now
      });
      console.log(`[Tracker] Identidad "${person.name}" asociada a Track #${bestTrack.trackId} vía IoU (${(maxIoU * 100).toFixed(1)}%).`);
    }
  }

  return matchedTrackIds;
}

export { isStandingPosture } from "../../core/geometry.js";

export const STEP_NAME = "Seguimiento y Geometría Postural";
export const STEP_DESCRIPTION = (imgHeight = 720) =>
  `Seguimiento temporal con PersonTracker y clasificación postural de pie vs sentado (boxTop/${imgHeight} <= 0.22 || boxH/${imgHeight} >= 0.55).`;
export const formatStepSummary = (tracksCount = 0, appointmentsCount = 0, details = "") =>
  `**${STEP_NAME}:** ${tracksCount.toLocaleString()} tracks procesados, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`;

