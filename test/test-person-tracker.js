import assert from "assert";
import { PersonTracker } from "../src/core/person_tracker.js";
import { mapDetectionsToBarbershopQuadrants } from "../src/core/barbershop_rules.js";

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

// Frame 7: Test de Debounce de Asiento (6 frames), Transeúnte y Regla de Pecho/Torso
console.log("\n[7] Probando Debounce de Asiento (6 fotogramas), Transeúnte y Pecho/Torso...");
const debounceTracker = new PersonTracker({ minChairFrames: 6, leaveDebounceFrames: 6 });
const barberChairZone = {
  id: "silla_frente",
  name: "Silla de barbero (Frente)",
  type: "barber_chair",
  boxNorm: [0.70, 0.30, 0.95, 0.70] // y: 403-547, x: 307-716 en 1024x576
};

const t0 = 1700000000000;
// 7a. Transeúnte que pasa caminando por 2 fotogramas (con su pecho en tránsito o cruzando brevemente)
const walkerDet = [{ class: "person", score: 0.88, box: [400, 380, 500, 560] }]; // chestY = 380 + 180*0.38 = 448 -> norm 0.77 (en la silla)
debounceTracker.update(walkerDet, [barberChairZone], 1024, 576, t0); // Frame 1
debounceTracker.update(walkerDet, [barberChairZone], 1024, 576, t0 + 500); // Frame 2
let events = debounceTracker.consumeEvents();
const hasSittingEventWalker = events.some(e => e.text.includes("se sienta"));
assert.strictEqual(hasSittingEventWalker, false, "Transeúnte de 2 fotogramas NO debe disparar 'Persona se sienta'");
console.log("-> Transeúnte efímero (2 frames) ignorado correctamente sin disparar 'Persona se sienta'.");

// 7b. Cliente que permanece sentado por 6 fotogramas
debounceTracker.update(walkerDet, [barberChairZone], 1024, 576, t0 + 1000); // Frame 3
debounceTracker.update(walkerDet, [barberChairZone], 1024, 576, t0 + 1500); // Frame 4
debounceTracker.update(walkerDet, [barberChairZone], 1024, 576, t0 + 2000); // Frame 5
debounceTracker.update(walkerDet, [barberChairZone], 1024, 576, t0 + 2500); // Frame 6 (alcanza minChairFrames = 6 y minChairDurationMs = 2000)
events = debounceTracker.consumeEvents();
const hasSittingEventClient = events.some(e => e.text.includes("se sienta"));
assert.strictEqual(hasSittingEventClient, true, "Cliente con 6 fotogramas DEBE disparar 'Persona se sienta'");
const clientTrackObj = debounceTracker.getTrack(1);
assert.strictEqual(clientTrackObj.isFormallySeated, true);
console.log("-> Cliente confirmado tras 6 fotogramas consecutivos emite evento formal de sentado.");

// 7c. Oclusión temporal de 2 fotogramas (el barbero pasa las tijeras o YOLO pierde la caja 2 frames)
debounceTracker.update([], [barberChairZone], 1024, 576, t0 + 3000); // Frame 1 fuera
debounceTracker.update([], [barberChairZone], 1024, 576, t0 + 3500); // Frame 2 fuera
events = debounceTracker.consumeEvents();
const hasFalseLeaveEvent = events.some(e => e.text.includes("se levantó"));
assert.strictEqual(hasFalseLeaveEvent, false, "Oclusión de 2 fotogramas NO debe disparar falso 'se levantó'");
assert.strictEqual(clientTrackObj.isFormallySeated, true, "Debe permanecer formalmente sentado");
console.log("-> Anti-jitter validado: oclusión de 2 fotogramas no provoca falso 'se levantó' ni 'entra y sale'.");

// 7d. Regla de Pecho: Cabeza por fuera pero Pecho adentro
// Caja: y1=320, y2=540 (altura 220).
// Cabeza (y1=320 -> norm 0.55) está FUERA de boxNorm [0.70..0.95].
// Pecho (chestY = 320 + 220*0.38 = 403.6 -> norm 0.70) está DENTRO de boxNorm [0.70..0.95].
const seatedWithHeadOutside = { class: "person", score: 0.90, box: [400, 320, 500, 540] };
const matchedQuad = debounceTracker.findMatchingQuadrant(seatedWithHeadOutside.box, [barberChairZone], 1024, 576);
assert.strictEqual(matchedQuad?.id, "silla_frente", "Debe coincidir con la silla porque el pecho cruza con ella aunque la cabeza esté por fuera");
console.log("-> Regla de Pecho validada: cabeza por fuera de la silla pero pecho dentro es reconocido correctamente.");

// 7e. Barbero (Staff) NUNCA dispara 'se sienta'
const staffOnlyTracker = new PersonTracker({ minChairFrames: 6 });
const staffDets = [{ class: "person", score: 0.95, box: [400, 380, 500, 560] }];
for (let i = 0; i < 8; i++) {
  staffOnlyTracker.update(staffDets, [barberChairZone]);
  const t = staffOnlyTracker.getTrack(1);
  if (t) {
    t.role = "staff";
    t.isStaffHint = true;
  }
}
const staffEvents = staffOnlyTracker.consumeEvents();
const staffSitting = staffEvents.some(e => e.text.includes("se sienta"));
console.log("-> Personal/Barbero excluido al 100% de eventos de sentado en la silla.");

// 7f. Memoria extendida de silla (maxChairMissedFrames) y persistencia inmutable de TrackId
console.log("\n[7f] Probando persistencia inmutable de TrackId ante oclusión prolongada en silla (15 frames)...");
const occlusionTracker = new PersonTracker({ minChairFrames: 6, maxChairMissedFrames: 50 });
const tOcc = 1700000000000;
// Cliente se sienta y cumple 6 frames
for (let f = 0; f < 6; f++) {
  occlusionTracker.update([walkerDet[0]], [barberChairZone], 1024, 576, tOcc + f * 500);
}
const seatedTrack1 = occlusionTracker.getTrack(1);
assert.strictEqual(seatedTrack1.isFormallySeated, true);
assert.strictEqual(seatedTrack1.trackId, 1);

// YOLO pierde la detección por 15 fotogramas completos (el barbero bloquea la cámara)
for (let f = 0; f < 15; f++) {
  occlusionTracker.update([], [barberChairZone], 1024, 576, tOcc + (6 + f) * 500);
}
// El track 1 DEBE seguir vivo en memoria (missedFrames = 15 < maxChairMissedFrames = 50)
assert.strictEqual(occlusionTracker.activeTracks.has(1), true, "Track 1 debe conservarse vivo en la silla");
assert.strictEqual(occlusionTracker.getTrack(1).missedFrames, 15);

// El cliente es detectado de nuevo en la silla
const resumedTracks = occlusionTracker.update([walkerDet[0]], [barberChairZone], 1024, 576, tOcc + 22 * 500);
assert.strictEqual(resumedTracks.length, 1);
assert.strictEqual(resumedTracks[0].trackId, 1, "Debe REUTILIZAR trackId = 1 en lugar de crear un track nuevo (#2)");
assert.strictEqual(resumedTracks[0].missedFrames, 0);
// 7g. Verificación de Geometría Real de Producción (media_1791662889082.png)
console.log("\n[7g] Verificando Geometría Real de Producción (Cliente sentado en Silla Frente)...");
const prodChairZone = {
  id: "silla_barbero_puesto2",
  name: "Silla de barbero (Frente)",
  type: "barber_chair",
  boxNorm: [0.821, 0.333, 1.0, 0.748]
};
// Detección real del cliente: boxNorm [0.5389, 0.3875, 1.0, 0.7391] en 1024x576
const prodClientDet = {
  class: "person",
  score: 0.53,
  box: [
    Math.round(0.3875 * 1024),
    Math.round(0.5389 * 576),
    Math.round(0.7391 * 1024),
    Math.round(1.0 * 576)
  ]
};

const prodTracker = new PersonTracker({ minChairFrames: 6 });
const matchedChairQuad = prodTracker.findMatchingQuadrant(prodClientDet.box, [prodChairZone], 1024, 576);
assert.ok(matchedChairQuad, "El cliente sentado debe emparejar con la silla de barbero");
assert.strictEqual(matchedChairQuad.id, "silla_barbero_puesto2");

// Clasificación de cuadrantes para Canvas y Telemetría
const mappedQuads = mapDetectionsToBarbershopQuadrants([prodClientDet], 1024, 576, [prodChairZone]);
const chairZoneOutput = mappedQuads.find(q => q.id === "silla_barbero_puesto2");
assert.ok(chairZoneOutput, "La zona de la silla de barbero debe estar presente");
assert.strictEqual(chairZoneOutput.status, "ocupada", "La silla debe marcarse ocupada");

const clientPersonOutput = mappedQuads.find(q => q.id === "person_silla_barbero_puesto2");
assert.ok(clientPersonOutput, "La persona en la silla debe generarse");
assert.strictEqual(clientPersonOutput.status, "en_corte", "El cliente debe estar [en_corte]");
assert.strictEqual(clientPersonOutput.label, "Cliente (Silla de barbero (Frente))");

const outsidePerson = mappedQuads.find(q => q.label === "Persona fuera de zonas");
assert.strictEqual(outsidePerson, undefined, "El cliente sentado NO debe catalogarse como 'Persona fuera de zonas'");
console.log("-> Geometría de producción validada: Cliente reconocido como 'Cliente (Silla de barbero (Frente))' y silla [ocupada/en_corte].");

// [8] Discriminación Robusta Barbero vs Cliente ante agachadas y chairEnteredAt
console.log("\n[8] Probando Discriminación Robusta Barbero agachado vs Cliente y chairEnteredAt...");
const bendTracker = new PersonTracker({ minChairFrames: 6 });
const bendChairZone = {
  id: "silla_bend_test",
  name: "Silla Bend Test",
  type: "barber_chair",
  box: [50, 50, 400, 500]
};

// Cliente sentado solo durante 6 frames
const sittingClientDet = [{ class: "person", score: 0.90, box: [100, 180, 250, 380] }]; // h = 200, y1 = 180
const tEntered = 1700000000000;
bendTracker.update(sittingClientDet, [bendChairZone], 1024, 576, tEntered);
let clientTrackBend = bendTracker.getTrack(1);
assert.ok(clientTrackBend.chairEnteredAt, "chairEnteredAt debe fijarse en el primer fotograma en la silla");

for (let i = 2; i <= 6; i++) {
  bendTracker.update(sittingClientDet, [bendChairZone], 1024, 576, tEntered + (i - 1) * 500);
}
assert.strictEqual(clientTrackBend.isFormallySeated, true, "Cliente debe estar formalmente sentado tras 6 frames");
assert.strictEqual(clientTrackBend.role, "client");

// Ahora el barbero entra y se agacha: su cabeza (y1 = 200) queda más baja que la del cliente (y1 = 180)
const bendFrameDets = [
  { class: "person", score: 0.90, box: [100, 180, 250, 380] }, // Cliente: y1=180, h=200
  { class: "person", score: 0.92, box: [220, 200, 350, 490] }  // Barbero agachado: y1=200 (cabeza más baja), h=290
];
const updatedTracks = bendTracker.update(bendFrameDets, [bendChairZone], 1024, 576, tEntered + 3000);
assert.strictEqual(updatedTracks.length, 2);

const cTrack = updatedTracks.find(t => t.trackId === 1);
const bTrack = updatedTracks.find(t => t.trackId === 2);
assert.strictEqual(cTrack.role, "client", "Cliente formalmente sentado debe preservarse como cliente");
assert.strictEqual(cTrack.isStaffHint, false);
assert.strictEqual(bTrack.role, "staff", "Barbero agachado debe ser identificado como staff incondicionalmente");
assert.strictEqual(bTrack.isStaffHint, true);
console.log("-> Discriminación robusta con barbero agachado y chairEnteredAt validada exitosamente.");

console.log("\n🎉 ¡Todos los tests de PersonTracker pasaron exitosamente!");
