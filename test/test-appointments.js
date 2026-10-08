import assert from "assert";
import { VisitSessionService } from "../src/services/visit_session_service.js";
import { SQLiteClient } from "../src/infrastructure/storage/sqlite_client.js";
import { CustomerService } from "../src/services/customer_service.js";

console.log("=== Suite de Pruebas: Pipeline de Atenciones (Appointments) Desacoplado de Clientes ===");

// 1. Configuración de entorno de pruebas con SQLite :memory:
const sqlite = new SQLiteClient(":memory:");
const custService = new CustomerService({ sqliteClient: sqlite });

// Mock DB de Firestore
const firestoreDocs = {};
const mockDb = {
  doc: (path) => ({
    set: async (data) => {
      firestoreDocs[path] = data;
    },
    get: async () => ({
      exists: Boolean(firestoreDocs[path]),
      data: () => firestoreDocs[path]
    })
  })
};

// Registrar Staff Barbero en memoria y SQLite
const barberVector = new Array(512).fill(0);
barberVector[0] = 1.0; // Vector unitario L2 en dimensión 0
const barberProfile = {
  id: "staff_barbero_01",
  name: "Barbero Principal",
  isStaff: true,
  role: "barber",
  embedding: barberVector,
  embeddings: [barberVector],
  photos: [{ url: "barber.jpg" }],
  bestFaceScore: 95
};
custService.saveOrUpdateCustomer(barberProfile);

// Registrar Cliente Existente #141
const client141Vector = new Array(512).fill(0);
client141Vector[1] = 1.0; // Vector unitario L2 en dimensión 1
const client141Photos = Array.from({ length: 20 }, (_, i) => ({
  thumbnailBase64: `data:image/jpeg;base64,photo_${i + 1}`,
  sharpnessScore: 80 + (i % 10),
  capturedAt: "2026-10-05T10:00:00.000Z"
}));
const client141 = {
  id: "client_141",
  name: "Cliente #141",
  isStaff: false,
  role: "client",
  firstSeen: "2026-10-05T10:00:00.000Z",
  lastSeen: "2026-10-05T10:45:00.000Z",
  visitCount: 1,
  appointmentCount: 1,
  embedding: client141Vector,
  embeddings: [client141Vector],
  photos: client141Photos,
  bestFaceScore: 89
};
custService.saveOrUpdateCustomer(client141);

console.log("\n[1] Probando sesión efímera (< 10 min): debe ser descartada sin generar appointment...");
const service = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

// Persona se sienta en Silla 1
const ephemeralTrack = {
  trackId: 201,
  currentQuadrant: { id: "silla_corte_1", label: "Silla de Corte 1", type: "barber_chair" }
};
const ephemeralSession = await service.processTrack(ephemeralTrack);
assert.ok(ephemeralSession, "Debe iniciar sesión de seguimiento en silla");
assert.strictEqual(ephemeralSession.status, "en_corte");

// Sale a los 2 minutos
const ephemeralResult = await service.closeSession(201, { durationMinutes: 2 });
assert.strictEqual(ephemeralResult, null, "Permanencia de 2 min debe ser descartada (< 10 min)");
console.log("-> Sesión de 2 min descartada exitosamente. Previene creación de perfiles falsos.");

console.log("\n[2] Probando tolerancia a giros de cabeza / espalda con YOLO...");
const longTrack = {
  trackId: 202,
  currentQuadrant: { id: "silla_corte_1", label: "Silla de Corte 1", type: "barber_chair" }
};
await service.processTrack(longTrack);

// Frame 1: Rostro visible
await service.addFaceSample(202, {
  sharpnessScore: 85,
  thumbnailBase64: "data:image/jpeg;base64,face_client",
  embedding: client141Vector,
  isStaff: false
});

// Frames 2, 3, 4: Cliente gira la cabeza / mira hacia la espalda (YOLO detecta el cuerpo, pero no hay rostro)
const sessionAfterTurn = await service.processTrack(longTrack);
assert.ok(sessionAfterTurn, "La sesión debe mantenerse activa durante el corte");
assert.strictEqual(service.activeSessions.has(202), true, "Sesión no debe cancelarse por giro de cabeza");
console.log("-> Tolerancia a giros de cabeza validada: YOLO mantiene activa la atención en la silla.");

console.log("\n[3] Probando exclusión estricta del Barbero en la silla durante la atención...");
// Barbero se inclina sobre la silla: su rostro es detectado en la silla
const addedBarber = await service.addFaceSample(202, {
  sharpnessScore: 94,
  thumbnailBase64: "data:image/jpeg;base64,barber_face",
  embedding: barberVector,
  isStaff: false // Se simula detección no etiquetada que debe ser filtrada por embedding
});
assert.strictEqual(addedBarber, false, "Rostro del barbero debe ser rechazado y no entrar al appointment");

const activeSession = service.activeSessions.get(202);
assert.strictEqual(activeSession.photos.length, 1, "Solo la foto legítima del cliente debe estar en el appointment");
console.log("-> Exclusión del barbero en la silla validada: 0 fotos de personal añadidas al appointment.");

console.log("\n[4] Probando finalización de atención de 45 min y Re-identificación Set-to-Set...");
// Agregamos más fotos del cliente a la sesión (hasta 20)
for (let i = 2; i <= 20; i++) {
  await service.addFaceSample(202, {
    sharpnessScore: 80 + (i % 10),
    thumbnailBase64: `data:image/jpeg;base64,session_photo_${i}`,
    embedding: client141Vector
  });
}
assert.strictEqual(activeSession.photos.length, 20, "Debe acumular hasta 20 fotos en la atención");

// Cierre de sesión formal tras 45 minutos
const completion = await service.closeSession(202, { durationMinutes: 45 });
assert.ok(completion, "Debe completarse la atención");
assert.strictEqual(completion.id, activeSession.appointmentId);
assert.strictEqual(completion.clientId, "client_141", "Set-to-Set matching debe vincular al Cliente #141");
assert.strictEqual(completion.durationMinutes, 45);
assert.strictEqual(completion.status, "completed");

// Verificar persistencia en SQLite
const savedAppt = sqlite.getAppointmentById(completion.id);
assert.ok(savedAppt, "La atención debe estar persistida en SQLite");
assert.strictEqual(savedAppt.clientId, "client_141");
assert.strictEqual(savedAppt.durationMinutes, 45);
assert.strictEqual(savedAppt.photos.length, 20);
console.log("-> Atención persistida exitosamente en SQLite con 20 fotos.");

// Verificar persistencia en Firestore mock
assert.ok(firestoreDocs[`camera_catcher_appointments/${completion.id}`], "Debe persistirse en camera_catcher_appointments");
console.log("-> Atención persistida exitosamente en Firestore.");

console.log("\n[5] Probando acumulación de 40 fotos en el perfil del cliente tras múltiples visitas...");
const updatedCustomer = custService.getCustomerData("client_141");
assert.strictEqual(updatedCustomer.appointmentCount, 2, "appointmentCount debe incrementarse a 2");
assert.strictEqual(updatedCustomer.photos.length, 40, "El cliente debe haber acumulado 40 fotos (20 iniciales + 20 de la sesión)");
console.log("-> Galería de Cliente #141 ampliada exitosamente a 40 fotos a través de sesiones.");

console.log("\n[6] Probando creación de nuevo cliente ante cliente nunca antes visto...");
const newTrack = {
  trackId: 203,
  currentQuadrant: { id: "silla_corte_2", label: "Silla de Corte 2", type: "barber_chair" }
};
await service.processTrack(newTrack);

const brandNewVector = new Array(512).fill(0);
brandNewVector[2] = 1.0; // Vector unitario L2 en dimensión 2
await service.addFaceSample(203, {
  sharpnessScore: 88,
  thumbnailBase64: "data:image/jpeg;base64,new_client_face",
  embedding: brandNewVector
});

const newCompletion = await service.closeSession(203, { durationMinutes: 30 });
assert.ok(newCompletion, "Debe completarse la atención del nuevo cliente");
assert.ok(newCompletion.clientId, "Debe asignarse un clientId nuevo");
assert.strictEqual(newCompletion.durationMinutes, 30);

const createdCustomer = custService.getCustomerData(newCompletion.clientId);
assert.ok(createdCustomer, "El nuevo cliente debe estar registrado");
assert.strictEqual(createdCustomer.appointmentCount, 1, "Nuevo cliente debe tener appointmentCount = 1");
console.log(`-> Nuevo cliente registrado exitosamente (${createdCustomer.name}) con appointmentCount: 1.`);

console.log("\n[7] Probando sesión de 40 min pero con 0 fotos (sin rostro): debe ser descartada sin generar appointment...");
const zeroPhotosTrack = {
  trackId: 204,
  currentQuadrant: { id: "silla_corte_1", label: "Silla de Corte 1", type: "barber_chair" }
};
await service.processTrack(zeroPhotosTrack);
const zeroPhotosResult = await service.closeSession(204, { durationMinutes: 40 });
assert.strictEqual(zeroPhotosResult, null, "Sesión sin fotos debe ser descartada a pesar de duración de 40 min");
console.log("-> Sesión sin fotos descartada exitosamente: previene citas vacías y clientes fantasma.");

console.log("\n[8] Probando que candidatos en confirmación ('Cliente en confirmación') no se guarden como clientes corruptos...");
const pendingCandidateTrack = {
  trackId: 205,
  currentQuadrant: { id: "silla_corte_1", label: "Silla de Corte 1", type: "barber_chair" },
  identity: {
    personId: "cand_temp_123",
    name: "Cliente en confirmación (1/3)",
    isPendingConfirmation: true
  }
};
await service.processTrack(pendingCandidateTrack);
const candidateVector = new Array(512).fill(0);
candidateVector[3] = 1.0;
await service.addFaceSample(205, {
  sharpnessScore: 92,
  thumbnailBase64: "data:image/jpeg;base64,cand_photo",
  embedding: candidateVector
});
const candidateCompletion = await service.closeSession(205, { durationMinutes: 25 });
assert.ok(candidateCompletion, "Atención legítima de 25 min debe completarse");
assert.ok(!candidateCompletion.clientName.includes("confirmación"), "El nombre de la atención NO debe incluir 'confirmación'");
const registeredClient = custService.getCustomerData(candidateCompletion.clientId);
assert.ok(registeredClient, "Debe registrarse el cliente formal");
assert.ok(!registeredClient.name.includes("confirmación"), "El cliente formal NO debe llamarse 'Cliente en confirmación'");
console.log(`-> Candidato provisional filtrado y formalizado limpiamente como: "${registeredClient.name}".`);

console.log("\n[9] Probando valor por defecto de minAppointmentMinutes (debe ser 10 min)...");
const defaultService = new VisitSessionService();
assert.strictEqual(defaultService.minAppointmentMinutes, 10, "minAppointmentMinutes debe ser 10 por defecto");
console.log("-> Umbral por defecto de 10 minutos validado exitosamente.");

sqlite.close();
console.log("\n🎉 ¡Todas las pruebas del pipeline de Atenciones pasaron al 100%!");
