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
const angleVec1 = new Array(512).fill(0);
angleVec1[1] = 0.82;
angleVec1[2] = Math.sqrt(1 - 0.82 * 0.82);

await service.addFaceSample(202, {
  sharpnessScore: 85,
  thumbnailBase64: "data:image/jpeg;base64,face_client",
  embedding: angleVec1,
  pose: "frontal",
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
// 4a. Probar rechazo de foto duplicada con menor nitidez
const dupRejected = await service.addFaceSample(202, {
  sharpnessScore: 70, // Menor que 85
  thumbnailBase64: "data:image/jpeg;base64,face_client_dup",
  embedding: angleVec1, // Similitud 1.0 con la foto 1
  pose: "frontal",
  skipCooldown: true
});
assert.strictEqual(dupRejected, false, "Foto duplicada con menor nitidez debe ser rechazada");
assert.strictEqual(activeSession.photos.length, 1, "No debe duplicar fotos en la atención");

// 4b. Probar reemplazo en caso de foto duplicada con MAYOR nitidez
const dupReplaced = await service.addFaceSample(202, {
  sharpnessScore: 95, // Mayor que 85
  thumbnailBase64: "data:image/jpeg;base64,face_client_sharper",
  embedding: angleVec1,
  pose: "frontal",
  skipCooldown: true
});
assert.strictEqual(dupReplaced, true, "Foto duplicada con mayor nitidez debe reemplazar a la anterior");
assert.strictEqual(activeSession.photos.length, 1, "Reemplazo no debe aumentar el conteo de fotos");
assert.strictEqual(activeSession.photos[0].sharpnessScore, 95);

// 4c. Probar control de cadencia temporal (< 20 segundos) sin skipCooldown
const tooFastSample = await service.addFaceSample(202, {
  sharpnessScore: 90,
  thumbnailBase64: "data:image/jpeg;base64,face_client_rapid",
  embedding: angleVec1,
  pose: "frontal",
  skipCooldown: false,
  timestamp: Date.now() + 5000 // 5s después (< 20s)
});
assert.strictEqual(tooFastSample, false, "Cadencia temporal debe rechazar fotos tomadas en < 20 segundos");

// 4d. Agregamos 19 fotos adicionales de ángulos legítimos con skipCooldown (hasta completar 20)
for (let i = 2; i <= 20; i++) {
  const angleVec = new Array(512).fill(0);
  angleVec[1] = 0.82;
  angleVec[i + 2] = Math.sqrt(1 - 0.82 * 0.82);
  await service.addFaceSample(202, {
    sharpnessScore: 80 + (i % 10),
    thumbnailBase64: `data:image/jpeg;base64,session_photo_${i}`,
    embedding: angleVec,
    pose: `angle_${i}`,
    skipCooldown: true
  });
}
assert.strictEqual(activeSession.photos.length, 20, "Debe acumular hasta 20 fotos en la atención");

// 4e. Probar filtro anti-outliers de la sesión
const outlierSamplePhotos = [
  { thumbnailBase64: "thumb1" },
  { thumbnailBase64: "thumb2" },
  { thumbnailBase64: "thumb3" },
  { thumbnailBase64: "thumb_intruder" }
];
const vNormal1 = new Array(512).fill(0); vNormal1[1] = 0.9; vNormal1[5] = Math.sqrt(1 - 0.9 * 0.9);
const vNormal2 = new Array(512).fill(0); vNormal2[1] = 0.9; vNormal2[6] = Math.sqrt(1 - 0.9 * 0.9);
const vNormal3 = new Array(512).fill(0); vNormal3[1] = 0.9; vNormal3[7] = Math.sqrt(1 - 0.9 * 0.9);
const vRogue = new Array(512).fill(0); vRogue[200] = 1.0; // Ortogonal al cluster (similitud 0.0 < 0.45)
const outlierResult = service.filterOutlierSamples(outlierSamplePhotos, [vNormal1, vNormal2, vNormal3, vRogue]);
assert.strictEqual(outlierResult.photos.length, 3, "Filtro anti-outliers debe eliminar la foto espuria");
assert.strictEqual(outlierResult.photos.some(p => p.thumbnailBase64 === "thumb_intruder"), false);
console.log("-> Filtro anti-outliers validado: foto anómala (< 0.45 similitud) descartada del cluster.");

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

console.log("\n[10] Probando eliminación de atención (appointment) y cliente asociado en SQLite...");
assert.strictEqual(sqlite.deleteAppointment(candidateCompletion.id), true, "Debe eliminar la atención de SQLite");
assert.strictEqual(sqlite.getAppointmentById(candidateCompletion.id), null, "La atención eliminada no debe existir");
assert.strictEqual(sqlite.deleteCustomer(candidateCompletion.clientId), true, "Debe eliminar el cliente de SQLite");
assert.strictEqual(sqlite.getCustomerById(candidateCompletion.clientId), null, "El cliente eliminado no debe existir");
console.log("-> Eliminación de atención y cliente en cascada validada exitosamente.");

console.log("\n[11] Probando máquina de estados de silla y gracia de 30 segundos (checkChairTimeouts)...");
const timeoutService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10,
  emptyChairTimeoutMs: 30000
});

const t0 = 1000000;
const chairTrack = {
  trackId: 301,
  currentQuadrant: { id: "silla_corte_1", label: "Silla de Corte 1", type: "barber_chair" }
};
const startedSession = await timeoutService.processTrack(chairTrack, { now: t0 });
assert.strictEqual(startedSession.status, "en_corte");

// Agregamos una foto válida
await timeoutService.addFaceSample(301, {
  sharpnessScore: 88,
  thumbnailBase64: "data:image/jpeg;base64,session_301",
  embedding: angleVec1,
  timestamp: t0
});

// Paso A: La persona se levanta temporalmente a los 15 min
const tLeave = t0 + 15 * 60 * 1000;
await timeoutService.checkChairTimeouts(tLeave, []);
assert.strictEqual(startedSession.status, "esperando_liberacion", "Debe entrar en estado esperando_liberacion");
assert.strictEqual(startedSession.emptySinceEpoch, tLeave);

// Paso B: Pasan 10 segundos (< 30s) y la persona RETOMA la silla (con nuevo trackId 302 de YOLO)
const tResume = tLeave + 10000;
const resumedTrack = {
  trackId: 302,
  currentQuadrant: { id: "silla_corte_1", label: "Silla de Corte 1", type: "barber_chair" }
};
const resumedSession = await timeoutService.processTrack(resumedTrack, { now: tResume });
assert.strictEqual(resumedSession.status, "en_corte", "La atención debe reanudarse al retomar la silla");
assert.strictEqual(resumedSession.emptySinceEpoch, null, "Debe cancelar la cuenta regresiva de 30s");
assert.strictEqual(resumedSession.photos.length, 1, "Debe conservar las fotos cosechadas previamente");

// Paso C: La persona se levanta definitivamente a los 25 min
const tFinalLeave = t0 + 25 * 60 * 1000;
await timeoutService.checkChairTimeouts(tFinalLeave, []);
assert.strictEqual(resumedSession.status, "esperando_liberacion");

// Paso D: Pasan 31 segundos (>= 30s) con la silla vacía -> Cierre automático y clasificación Set-to-Set
const tTimeoutClose = tFinalLeave + 31000;
const closedAppts = await timeoutService.checkChairTimeouts(tTimeoutClose, []);
assert.strictEqual(closedAppts.length, 1, "Debe cerrar automáticamente la atención tras 30s desocupada");
assert.strictEqual(closedAppts[0].status, "completed");
assert.strictEqual(closedAppts[0].chairId, "silla_corte_1");
assert.strictEqual(timeoutService.activeSessions.size, 0, "No deben quedar sesiones activas en la silla");
console.log("-> Máquina de estados con gracia de 30s y reanudación validada exitosamente.");

console.log("\n[12] Probando filtro de permanencia y debounce de asiento (consecutiveChairFrames >= 6)...");
const debounceApptService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minConsecutiveChairFrames: 6
});

// Transeúnte en silla por 2 fotogramas (consecutiveChairFrames: 2 < 6)
const walkerTrack = {
  trackId: 401,
  consecutiveChairFrames: 2,
  currentQuadrant: { id: "silla_corte_debounce", label: "Silla Debounce", type: "barber_chair" }
};
const walkerSession = await debounceApptService.processTrack(walkerTrack);
assert.strictEqual(walkerSession, null, "Transeúnte con solo 2 fotogramas NO debe abrir una sesión de atención");
assert.strictEqual(debounceApptService.activeSessions.has(401), false, "No debe haber sesión en memoria");
console.log("-> Transeúnte en tránsito (2 fotogramas) descartado correctamente sin abrir atención.");

// Cliente sentado por >= 6 fotogramas (consecutiveChairFrames: 6)
const seatedTrack = {
  trackId: 402,
  consecutiveChairFrames: 6,
  currentQuadrant: { id: "silla_corte_debounce", label: "Silla Debounce", type: "barber_chair" }
};
const seatedSession = await debounceApptService.processTrack(seatedTrack);
assert.ok(seatedSession, "Cliente con >= 6 fotogramas DEBE abrir la sesión de atención");
assert.strictEqual(seatedSession.status, "en_corte");
assert.strictEqual(debounceApptService.activeSessions.has(402), true);
console.log("-> Cliente con permanencia confirmada (>= 6 fotogramas) inicia atención exitosamente.");

sqlite.close();
console.log("\n🎉 ¡Todas las pruebas del pipeline de Atenciones pasaron al 100%!");
