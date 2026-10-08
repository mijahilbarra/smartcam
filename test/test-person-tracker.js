import assert from "assert";
import { PersonTracker } from "../src/core/person_tracker.js";

console.log("=== Test de Seguimiento de Personas (PersonTracker) ===");

const tracker = new PersonTracker({ iouThreshold: 0.3, maxMissedFrames: 3 });

// Frame 1: Dos personas detectadas
console.log("\n[1] Cuadro 1: Dos personas detectadas...");
const frame1Dets = [
  { class: "person", score: 0.88, box: [100, 100, 200, 300] },
  { class: "person", score: 0.91, box: [400, 150, 500, 400] }
];
const quadrants = [
  { id: "silla_1", label: "Silla 1", box: [80, 80, 220, 320] },
  { id: "silla_2", label: "Silla 2", box: [380, 120, 520, 420] }
];

let active = tracker.update(frame1Dets, quadrants);
assert.strictEqual(active.length, 2, "Debe registrar 2 tracks");
assert.strictEqual(active[0].trackId, 1);
assert.strictEqual(active[1].trackId, 2);
assert.strictEqual(active[0].currentQuadrant.id, "silla_1");
assert.strictEqual(active[1].currentQuadrant.id, "silla_2");
console.log("-> Tracks activos iniciales:", active.map(t => ({ id: t.trackId, quad: t.currentQuadrant.id })));

// Frame 2: Persona 1 se mueve ligeramente (misma posición aprox)
console.log("\n[2] Cuadro 2: Persona 1 se mueve ligeramente...");
const frame2Dets = [
  { class: "person", score: 0.89, box: [105, 102, 205, 305] },
  { class: "person", score: 0.90, box: [402, 148, 498, 398] }
];
active = tracker.update(frame2Dets, quadrants);
assert.strictEqual(active.length, 2);
assert.strictEqual(active[0].trackId, 1, "Debe conservar trackId = 1");
assert.strictEqual(active[1].trackId, 2, "Debe conservar trackId = 2");
console.log("-> Persistencia de trackId validada:", active.map(t => t.trackId));

// Frame 3: Asociar identidad y múltiples caras nítidas (Top 10)
console.log("\n[3] Actualización de identidad y buffer de mejores caras...");
tracker.updateIdentityAndFace(1, {
  identity: { personId: "p_1", name: "Carlos Barbero", isStaff: true },
  faceBuffer: Buffer.from("face_low_res"),
  faceBoxNorm: [0.1, 0.1, 0.3, 0.3],
  sharpnessScore: 65
});

tracker.updateIdentityAndFace(1, {
  faceBuffer: Buffer.from("face_high_res"),
  faceBoxNorm: [0.1, 0.1, 0.3, 0.3],
  sharpnessScore: 92
});

const t1 = tracker.getTrack(1);
assert.strictEqual(t1.status, "identified");
assert.strictEqual(t1.identity.name, "Carlos Barbero");
assert.strictEqual(t1.bestFace.sharpnessScore, 92, "La mejor cara debe ser la de score 92");
assert.strictEqual(t1.topFaces.length, 2);
console.log("-> Identidad y Top 10 caras validadas exitosamente:", {
  name: t1.identity.name,
  bestScore: t1.bestFace.sharpnessScore,
  totalFaces: t1.topFaces.length
});

// Frame 4: Persona 2 sale de escena por varios cuadros
console.log("\n[4] Persona 2 desaparece de escena...");
tracker.update([frame2Dets[0]], quadrants); // Cuadro omitido 1
tracker.update([frame2Dets[0]], quadrants); // Cuadro omitido 2
tracker.update([frame2Dets[0]], quadrants); // Cuadro omitido 3
tracker.update([frame2Dets[0]], quadrants); // Cuadro omitido 4 (supera maxMissedFrames = 3)

const finalActive = tracker.update([frame2Dets[0]], quadrants);
assert.strictEqual(finalActive.length, 1, "Solo debe quedar Persona 1 activa");
assert.strictEqual(tracker.historyTracks.length, 1, "Persona 2 debe estar en el historial");
assert.strictEqual(tracker.historyTracks[0].trackId, 2);
console.log("-> Salida de persona e historial validados exitosamente.");

// Frame 5: Desplazamiento rápido donde IoU = 0 (Persona 1 da varios pasos rápidos)
console.log("\n[5] Desplazamiento rápido con IoU = 0 (Centroid proximity fallback)...");
// Caja anterior de Persona 1 era [105, 102, 205, 305] (ancho 100, alto 203, cx=155, cy=203)
// Nueva caja desplazada a [220, 110, 320, 310] (cx=270, cy=210, dx=115px).
// [105..205] y [220..320] NO se solapan (IoU = 0).
const fastMovingDets = [
  { class: "person", score: 0.88, box: [220, 110, 320, 310] }
];
const centroidTracks = tracker.update(fastMovingDets, quadrants);
assert.strictEqual(centroidTracks.length, 1, "Debe haber 1 track activo");
assert.strictEqual(centroidTracks[0].trackId, 1, "Debe preservar trackId = 1 gracias a la proximidad de centroides a pesar de IoU = 0");
console.log("-> Preservación de trackId ante desplazamiento rápido (IoU = 0) validada exitosamente.");

// Frame 6: Conflicto en Silla de Barbero con 2 personas (Barbero de pie vs Cliente sentado)
console.log("\n[6] Conflicto en Silla de Barbero: 2 personas en la misma silla...");
const chairZone = {
  id: "silla_corte_principal",
  name: "Silla de Corte",
  type: "barber_chair",
  box: [50, 50, 400, 450]
};
const twoInChairTracker = new PersonTracker();
const twoPeopleDets = [
  // Barbero de pie: cabeza alta (y1 = 60), altura 300px
  { class: "person", score: 0.92, box: [80, 60, 200, 360] },
  // Cliente sentado: cabeza más baja (y1 = 180), altura 200px
  { class: "person", score: 0.89, box: [180, 180, 320, 380] }
];
const chairTracks = twoInChairTracker.update(twoPeopleDets, [chairZone]);
assert.strictEqual(chairTracks.length, 2, "Debe haber 2 tracks en la silla");

const barberTrack = chairTracks.find(t => t.isStaffHint === true);
const clientTrack = chairTracks.find(t => t.isStaffHint === false);
assert.ok(barberTrack, "Debe haber identificado al barbero de pie como staff");
assert.ok(clientTrack, "Debe haber identificado al cliente sentado");
assert.strictEqual(barberTrack.role, "staff");
assert.strictEqual(clientTrack.role, "client");
console.log("-> Discriminación de Barbero (Staff de pie) vs Cliente (sentado) validada exitosamente.");

console.log("\n🎉 ¡Todos los tests de PersonTracker pasaron exitosamente!");
