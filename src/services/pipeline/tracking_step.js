import { calculateIoU } from "../../core/geometry.js";

/**
 * 4. Actualización del seguimiento temporal de personas (PersonTracker).
 */
export function trackEntities(tracker, mlResult) {
  if (!tracker) return [];
  const activeTracks = tracker.update(
    mlResult.rawDetections || [],
    mlResult.quadrants || [],
    mlResult.imageDimensions?.width,
    mlResult.imageDimensions?.height
  );
  console.log(`[Tracker] Personas rastreadas activas (${activeTracks.length}): ${activeTracks.map(t => `#${t.trackId} [${t.currentQuadrant?.label || 'General'}]`).join(", ") || 'Ninguna'}`);
  return activeTracks;
}

/**
 * 6. Asociación de identidades al tracker mediante superposición espacial IoU.
 */
export function matchIdentitiesToTracks({ tracker, activeTracks = [], identifiedPeople = [], iouThreshold = 0.20 }) {
  if (!tracker) return new Set();
  const matchedTrackIds = new Set();
  const usedPersonIds = new Set();

  for (const person of identifiedPeople) {
    const personKey = person.personId || person.name;
    if (personKey && usedPersonIds.has(personKey)) continue;

    let bestTrack = null;
    let maxIoU = 0;

    if (person.box) {
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
        sharpnessScore: person.sharpnessScore,
        thumbnailBase64: person.thumbnailBase64 || person.faceThumbnailBase64 || null,
        embedding: person.embedding || null
      });
      console.log(`[Tracker] Identidad "${person.name}" asociada a Track #${bestTrack.trackId} vía IoU (${(maxIoU * 100).toFixed(1)}%).`);
    }
  }

  return matchedTrackIds;
}
