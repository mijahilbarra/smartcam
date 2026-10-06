import assert from "assert";
import { VisitSessionService } from "../src/services/visit_session_service.js";

console.log("=== Test de Gestión de Sesiones y Visitas (VisitSessionService) ===");

// Mock de DB en memoria
const savedDocs = {};
const mockDb = {
  doc: (path) => ({
    set: async (data) => {
      savedDocs[path] = data;
    }
  })
};

const service = new VisitSessionService({ db: mockDb });

// 1. Cliente se sienta en Silla 1
console.log("\n[1] Cliente entra a Silla de Barbero...");
const track1 = {
  trackId: 101,
  currentQuadrant: { id: "silla_barbero_puesto1", label: "Silla 1", type: "barber_chair" },
  identity: null,
  bestFace: null
};

const s1 = await service.processTrack(track1);
assert.ok(s1, "Debe crearse una sesión de visita");
assert.strictEqual(s1.trackId, 101);
assert.strictEqual(s1.chairId, "silla_barbero_puesto1");
assert.strictEqual(s1.status, "en_corte");
console.log("-> Sesión creada:", { visitId: s1.visitId, chair: s1.chairName });

// 2. Identificación del cliente y cara nítida
console.log("\n[2] Se asocia identidad (Cliente Frecuente) y cara nítida...");
track1.identity = {
  personId: "person_juan_perez",
  name: "Juan Pérez",
  isStaff: false,
  visitCount: 4
};
track1.bestFace = {
  sharpnessScore: 88,
  faceBuffer: Buffer.from("face_bytes")
};

const s2 = await service.processTrack(track1);
assert.strictEqual(s2.personName, "Juan Pérez");
assert.strictEqual(s2.bestFaceScore, 88);
assert.strictEqual(s2.visitCount, 4);
console.log("-> Sesión actualizada con identidad:", {
  person: s2.personName,
  score: s2.bestFaceScore,
  visits: s2.visitCount
});

// 3. Cliente finaliza el corte y sale de la silla
console.log("\n[3] Cliente sale de la silla y finaliza la visita...");
const completed = await service.closeSession(101);
assert.ok(completed, "Debe retornar el registro completado");
assert.strictEqual(completed.personId, "person_juan_perez");
assert.strictEqual(completed.personName, "Juan Pérez");
assert.strictEqual(completed.isFrequent, true);
assert.strictEqual(completed.status, "completed");

// Verificar persistencia en Firestore mock
const visitDocPath = `camera_catcher_visits/${completed.id}`;
assert.ok(savedDocs[visitDocPath], "Debe haberse guardado en Firestore");
assert.strictEqual(savedDocs[visitDocPath].personName, "Juan Pérez");
console.log("-> Visita persistida en Firestore:", savedDocs[visitDocPath]);

// 4. Barbero en silla (no debe generar visita de cliente)
console.log("\n[4] Barbero en silla (personal)...");
const staffTrack = {
  trackId: 102,
  currentQuadrant: { id: "silla_barbero_puesto1", label: "Silla 1", type: "barber_chair" },
  identity: { personId: "staff_javier", name: "Javier Barbero", isStaff: true }
};
await service.processTrack(staffTrack);
const staffCompleted = await service.closeSession(102);
assert.strictEqual(staffCompleted, null, "No debe registrar visita para el staff");
console.log("-> Barbero verificado y omitido de visitas de clientes con éxito.");

console.log("\n🎉 ¡Todos los tests de VisitSessionService pasaron exitosamente!");
