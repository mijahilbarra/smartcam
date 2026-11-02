import assert from "assert";
import { VisitSessionService } from "../src/services/visit_session_service.js";
import { SQLiteClient } from "../src/infrastructure/storage/sqlite_client.js";
import { CustomerService } from "../src/services/customer_service.js";
import { PIPELINE_CONFIG } from "../src/core/pipeline_config.js";

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

console.log("\n[5] Probando CERO FUSIÓN DE FOTOS: La galería del cliente recurrente permanece intacta...");
const updatedCustomer = custService.getCustomerData("client_141");
assert.strictEqual(updatedCustomer.appointmentCount, 2, "appointmentCount debe incrementarse a 2");
assert.strictEqual(updatedCustomer.photos.length, 20, "El cliente debe conservar sus 20 fotos originales intactas (Cero fusión de fotos)");
console.log("-> CERO FUSIÓN validada: Galería de Cliente #141 intacta (20 fotos), appointment vinculada sin alteración.");

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

console.log(`\n[9] Probando valor por defecto de minAppointmentMinutes (debe ser ${PIPELINE_CONFIG.sessions.minAppointmentMinutes} min)...`);
const defaultService = new VisitSessionService();
assert.strictEqual(defaultService.minAppointmentMinutes, PIPELINE_CONFIG.sessions.minAppointmentMinutes, `minAppointmentMinutes debe ser ${PIPELINE_CONFIG.sessions.minAppointmentMinutes} por defecto`);
console.log(`-> Umbral por defecto de ${PIPELINE_CONFIG.sessions.minAppointmentMinutes} minutos validado exitosamente.`);

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

console.log("\n[12] Probando filtro de permanencia y debounce de asiento (consecutiveChairFrames >= 10)...");
const debounceApptService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minConsecutiveChairFrames: 10
});

// Transeúnte en silla por 2 fotogramas (consecutiveChairFrames: 2 < 10)
const walkerTrack = {
  trackId: 401,
  consecutiveChairFrames: 2,
  currentQuadrant: { id: "silla_corte_debounce", label: "Silla Debounce", type: "barber_chair" }
};
const walkerSession = await debounceApptService.processTrack(walkerTrack);
assert.strictEqual(walkerSession, null, "Transeúnte con solo 2 fotogramas NO debe abrir una sesión de atención");
assert.strictEqual(debounceApptService.activeSessions.has(401), false, "No debe haber sesión en memoria");
console.log("-> Transeúnte en tránsito (2 fotogramas) descartado correctamente sin abrir atención.");

// Cliente sentado por >= 10 fotogramas (consecutiveChairFrames: 10)
const seatedTrack = {
  trackId: 402,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_corte_debounce", label: "Silla Debounce", type: "barber_chair" }
};
const seatedSession = await debounceApptService.processTrack(seatedTrack);
assert.ok(seatedSession, "Cliente con >= 10 fotogramas DEBE abrir la sesión de atención");
assert.strictEqual(seatedSession.status, "en_corte");
assert.strictEqual(debounceApptService.activeSessions.has(402), true);
console.log("-> Cliente con permanencia confirmada (>= 10 fotogramas) inicia atención exitosamente.");

console.log("\n[13] Probando filtro canónico Anti-Nuca / Anti-Espalda (similitud < 0.45)...");
const antiNucaService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

const nucaTrack = {
  trackId: 501,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_corte_nuca", label: "Silla Nuca", type: "barber_chair" }
};
await antiNucaService.processTrack(nucaTrack);

// Muestra 1: Rostro canónico frontal legítimo (dimensión 10 = 1.0)
const canonicalClientVec = new Array(512).fill(0);
canonicalClientVec[10] = 1.0;
const addedCanonical = await antiNucaService.addFaceSample(501, {
  sharpnessScore: 75,
  embedding: canonicalClientVec,
  thumbnailBase64: "data:image/jpeg;base64,canonical_face",
  pose: "frontal",
  poseLabel: "Frontal"
});
assert.strictEqual(addedCanonical, true, "Debe aceptar el primer rostro canónico");
const nucaSession = antiNucaService.activeSessions.get(501);
assert.strictEqual(nucaSession.photos.length, 1);
assert.strictEqual(nucaSession.embeddings.length, 1);

console.log("\n[13] Probando captura continua en silla y filtrado anti-outliers / nuca al finalizar...");
// Muestra 2: Nuca / espalda sin rostro compatible en la silla (dimensión 20 = 1.0 -> Similitud 0.0 < 0.45)
const napeVec = new Array(512).fill(0);
napeVec[20] = 1.0;
const addedNape = await antiNucaService.addFaceSample(501, {
  sharpnessScore: 80,
  embedding: napeVec,
  thumbnailBase64: "data:image/jpeg;base64,nape_crop",
  pose: "tilted_down",
  poseLabel: "Inclinado Abajo",
  skipCooldown: true
});
assert.strictEqual(addedNape, true, "YOLO debe acumular muestras durante la estancia sin bloqueo prematuro");
assert.strictEqual(nucaSession.photos.length, 2);

// Muestra 3: Rostro compatible (similitud 0.85 >= 0.45)
const compatibleClientVec = new Array(512).fill(0);
compatibleClientVec[10] = 0.85;
compatibleClientVec[11] = Math.sqrt(1 - 0.85 * 0.85);
const addedCompatible = await antiNucaService.addFaceSample(501, {
  sharpnessScore: 82,
  embedding: compatibleClientVec,
  thumbnailBase64: "data:image/jpeg;base64,semi_face",
  pose: "semi_left",
  poseLabel: "Semi Perfil Izquierdo",
  skipCooldown: true
});
assert.strictEqual(addedCompatible, true, "Debe aceptar muestra facial compatible");

// Muestra 4: Segundo ángulo compatible del cliente (similitud 0.88)
const compatibleClientVec2 = new Array(512).fill(0);
compatibleClientVec2[10] = 0.88;
compatibleClientVec2[12] = Math.sqrt(1 - 0.88 * 0.88);
const addedCompatible2 = await antiNucaService.addFaceSample(501, {
  sharpnessScore: 81,
  embedding: compatibleClientVec2,
  thumbnailBase64: "data:image/jpeg;base64,semi_face_2",
  pose: "semi_right",
  poseLabel: "Semi Perfil Derecho",
  skipCooldown: true
});
assert.strictEqual(addedCompatible2, true);
assert.strictEqual(nucaSession.photos.length, 4);

// Al finalizar (closeSession): filterOutlierSamples purga la muestra anómala (nuca)
const filteredCluster = antiNucaService.filterOutlierSamples(nucaSession.photos, nucaSession.embeddings);
assert.strictEqual(filteredCluster.photos.length, 3, "Al finalizar debe descartar la muestra de nuca / outlier");
assert.strictEqual(filteredCluster.photos.some(p => p.thumbnailBase64.includes("nape_crop")), false, "No debe incluir la nuca en la selección final");
console.log("-> Filtrado anti-outliers / nuca al finalizar validado exitosamente.");

console.log("\n[14] Probando protección de miniatura por orientación de pose...");
// Muestra 4: Mayor nitidez (98 > 82) pero pose no frontal/semi (perfil o nuca)
const profileVec = new Array(512).fill(0);
profileVec[10] = 0.80;
profileVec[12] = Math.sqrt(1 - 0.80 * 0.80);
await antiNucaService.addFaceSample(501, {
  sharpnessScore: 98,
  embedding: profileVec,
  thumbnailBase64: "data:image/jpeg;base64,profile_photo",
  pose: "profile_left",
  poseLabel: "Perfil Izquierdo",
  skipCooldown: true
});
assert.strictEqual(nucaSession.bestFaceScore, 82, "NO debe reemplazar miniatura con pose de perfil aunque tenga mayor nitidez");
assert.strictEqual(nucaSession.thumbnailBase64, "data:image/jpeg;base64,semi_face", "Debe mantener miniatura frontal/semi");

// Muestra 5: Mayor nitidez (95 > 82) con pose semi_right válida
const validSemiVec = new Array(512).fill(0);
validSemiVec[10] = 0.82;
validSemiVec[13] = Math.sqrt(1 - 0.82 * 0.82);
await antiNucaService.addFaceSample(501, {
  sharpnessScore: 95,
  embedding: validSemiVec,
  thumbnailBase64: "data:image/jpeg;base64,valid_semi_photo",
  pose: "semi_right",
  poseLabel: "Semi Perfil Derecho",
  skipCooldown: true
});
assert.strictEqual(nucaSession.bestFaceScore, 95, "DEBE reemplazar miniatura con pose frontal o semi-frontal");
assert.strictEqual(nucaSession.thumbnailBase64, "data:image/jpeg;base64,valid_semi_photo");
console.log("-> Protección de miniatura por pose (frontal / semi) validada exitosamente.");

console.log("\n[15] Probando Set-to-Set staff Hard Delete al cierre de atención...");
const staffDeleteService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

// Registrar un perfil temporal simulado en estado 'to_verify'
const tempStaffCustId = "to_verify_staff_sitting";
await custService.saveOrUpdateCustomer({
  id: tempStaffCustId,
  name: "Cliente por verificar",
  status: "to_verify",
  isStaff: false,
  role: "client"
});
assert.ok(custService.getCustomerData(tempStaffCustId), "El perfil temporal debe existir antes del cierre");

// Iniciar sesión con fotos que en Set-to-Set pertenecen al barbero (sim >= 0.46)
const staffChairTrack = {
  trackId: 601,
  consecutiveChairFrames: 10,
  identity: { personId: tempStaffCustId, name: "Cliente por verificar" },
  currentQuadrant: { id: "silla_corte_staff_test", label: "Silla Staff Test", type: "barber_chair" }
};
const staffSession = await staffDeleteService.processTrack(staffChairTrack);
staffSession.personId = tempStaffCustId;

// Inyectar cluster de fotos del barbero en la sesión (barberVector tiene sim 1.0 >= 0.46)
staffSession.embeddings.push(barberVector);
staffSession.photos.push({
  thumbnailBase64: "data:image/jpeg;base64,barber_face",
  sharpnessScore: 88,
  capturedAt: new Date().toISOString(),
  pose: "frontal"
});

// Cerrar sesión con duración legítima de 15 minutos
const staffCloseResult = await staffDeleteService.closeSession(601, { durationMinutes: 15 });
assert.strictEqual(staffCloseResult, null, "La atención debe ser descartada si el cluster pertenece al Barbero/Staff");

// Verificar Hard Delete físico en SQLite y RAM
const deletedCustomer = custService.getCustomerData(tempStaffCustId);
assert.strictEqual(deletedCustomer, null, "El perfil temporal debe haber sido eliminado físicamente (Hard Delete)");
console.log("-> Hard Delete del Barbero/Staff y descarte de atención validados exitosamente.");

console.log("\n[16] Probando ciclo de vida de status ('to_verify' -> 'new' / 'frequent')...");
const lifecycleService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

// Caso A: Cliente nuevo legítimo -> status = 'new'
const newClientTrack = {
  trackId: 701,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_corte_lifecycle_1", label: "Silla 1", type: "barber_chair" }
};
await lifecycleService.processTrack(newClientTrack);
const newClientVec = new Array(512).fill(0);
newClientVec[30] = 1.0;
await lifecycleService.addFaceSample(701, {
  sharpnessScore: 80,
  embedding: newClientVec,
  thumbnailBase64: "data:image/jpeg;base64,new_client_face",
  pose: "frontal"
});
const newAppt = await lifecycleService.closeSession(701, { durationMinutes: 20 });
assert.ok(newAppt, "Debe generar atención para cliente nuevo");
assert.ok(newAppt.clientId, "Debe asignar id de cliente");
const createdNewCustomer = custService.getCustomerData(newAppt.clientId);
assert.ok(createdNewCustomer, "El nuevo cliente debe estar persistido");
assert.strictEqual(createdNewCustomer.status, "new", "El estado inicial de cliente nuevo debe ser 'new'");
console.log("-> Creación de cliente con status: 'new' validada exitosamente.");

// Caso B: Cliente recurrente existente -> status = 'frequent' y borrado de id temporal
const tempFrequentId = "to_verify_recurring_temp";
await custService.saveOrUpdateCustomer({
  id: tempFrequentId,
  name: "Cliente temporal",
  status: "to_verify",
  isStaff: false
});

const recurringTrack = {
  trackId: 702,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_corte_lifecycle_2", label: "Silla 2", type: "barber_chair" }
};
const recSession = await lifecycleService.processTrack(recurringTrack);
recSession.personId = tempFrequentId;
recSession.embeddings.push(client141Vector); // Coincide con client_141 existente
recSession.photos.push({
  thumbnailBase64: "data:image/jpeg;base64,recurring_face",
  sharpnessScore: 85,
  capturedAt: new Date().toISOString(),
  pose: "frontal"
});

const recAppt = await lifecycleService.closeSession(702, { durationMinutes: 25 });
assert.ok(recAppt, "Debe generar atención para cliente recurrente");
assert.strictEqual(recAppt.clientId, "client_141", "Debe vincular a client_141");
const updatedClient141 = custService.getCustomerData("client_141");
assert.strictEqual(updatedClient141.status, "frequent", "El cliente recurrente debe tener status: 'frequent'");
assert.strictEqual(custService.getCustomerData(tempFrequentId), null, "El ID temporal 'to_verify' debe haber sido borrado físicamente");
console.log("-> Transición a status: 'frequent' y limpieza de ID temporal validadas exitosamente.");

// [17] Blindar checkChairTimeouts contra el Barbero limpiando la silla
console.log("\n[17] Probando checkChairTimeouts ignorando al Barbero limpiando la silla...");
const cleaningService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10,
  emptyChairTimeoutMs: 30000
});

const tStart = 2000000;
const clientChairTrack = {
  trackId: 801,
  consecutiveChairFrames: 10,
  chairEnteredAt: tStart - 2400, // Debounce offset
  currentQuadrant: { id: "silla_corte_clean", label: "Silla Limpieza", type: "barber_chair" }
};
const cleanSession = await cleaningService.processTrack(clientChairTrack, { now: tStart });
assert.strictEqual(cleanSession.startedAtEpoch, tStart - 2400, "session.startedAtEpoch debe usar track.chairEnteredAt");

await cleaningService.addFaceSample(801, {
  sharpnessScore: 90,
  thumbnailBase64: "data:image/jpeg;base64,clean_client",
  embedding: angleVec1,
  timestamp: tStart
});

// Cliente se levanta a los 25 min -> entra en 'esperando_liberacion'
const tClientLeaves = tStart + 25 * 60 * 1000;
await cleaningService.checkChairTimeouts(tClientLeaves, []);
assert.strictEqual(cleanSession.status, "esperando_liberacion");

// A los 15s de gracia, el barbero entra a barrer la silla
const tBarberCleans = tClientLeaves + 15000;
const barberCleaningTrack = {
  trackId: 999,
  role: "staff",
  isStaffHint: true,
  currentQuadrant: { id: "silla_corte_clean", label: "Silla Limpieza", type: "barber_chair" }
};
await cleaningService.checkChairTimeouts(tBarberCleans, [barberCleaningTrack]);
assert.strictEqual(cleanSession.status, "esperando_liberacion", "El barbero limpiando NO debe reanudar la atención del cliente");

// A los 31s de gracia, la atención debe finalizar automáticamente
const tFinalClosed = tClientLeaves + 31000;
const closedCleaningAppts = await cleaningService.checkChairTimeouts(tFinalClosed, [barberCleaningTrack]);
assert.strictEqual(closedCleaningAppts.length, 1, "Debe finalizar la cita del cliente a pesar de que el barbero esté en la silla");
assert.strictEqual(closedCleaningAppts[0].status, "completed");
console.log("-> Blindaje contra barbero limpiando la silla validado exitosamente.");

// [18] Detección de rotación rápida de clientes (< 30s)
console.log("\n[18] Probando rotación rápida de clientes (< 30s)...");
const fastRotService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10,
  emptyChairTimeoutMs: 30000
});

const tRotStart = 3000000;
const clientATrack = {
  trackId: 901,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_rot", label: "Silla Rotación", type: "barber_chair" }
};
const sessionA = await fastRotService.processTrack(clientATrack, { now: tRotStart });

const clientAVec = new Array(512).fill(0);
clientAVec[40] = 1.0;
await fastRotService.addFaceSample(901, {
  sharpnessScore: 90,
  thumbnailBase64: "data:image/jpeg;base64,client_a",
  embedding: clientAVec,
  timestamp: tRotStart
});

// Cliente A se levanta a los 20 min
const tALeaves = tRotStart + 20 * 60 * 1000;
await fastRotService.checkChairTimeouts(tALeaves, []);
assert.strictEqual(sessionA.status, "esperando_liberacion");

// Solo 10s después, se sienta el Cliente B con un rostro ortogonal (sim < 0.45)
const tBEnters = tALeaves + 10000;
const clientBVec = new Array(512).fill(0);
clientBVec[50] = 1.0; // sim con clientAVec = 0.0 < 0.45
const clientBTrack = {
  trackId: 902,
  consecutiveChairFrames: 10,
  chairEnteredAt: tBEnters,
  bestFace: {
    sharpnessScore: 92,
    embedding: clientBVec,
    thumbnailBase64: "data:image/jpeg;base64,client_b"
  },
  currentQuadrant: { id: "silla_rot", label: "Silla Rotación", type: "barber_chair" }
};

const sessionB = await fastRotService.processTrack(clientBTrack, { now: tBEnters });
assert.ok(sessionB, "Debe abrir una sesión para el nuevo Cliente B");
assert.strictEqual(sessionB.trackId, 902);
const lastClosed = fastRotService.completedAppointments[fastRotService.completedAppointments.length - 1];
assert.strictEqual(lastClosed.trackId, 901, "La sesión cerrada debe pertenecer al Cliente A");
console.log("-> Detección y corte limpio ante rotación rápida (< 30s) validados exitosamente.");

// [19] Sincronización Estricta 1:1 en mergeCustomerEmbeddings y Protección de Foto Canónica (Index 0)
console.log("\n[19] Probando sincronización 1:1 y protección de foto canónica (index 0)...");
const syncService = new VisitSessionService();

const canonicalPhoto = { thumbnailBase64: "data:image/jpeg;base64,canonical", sharpnessScore: 80, pose: "frontal" };
const canonicalEmb = new Array(512).fill(0.01);
canonicalEmb[0] = 1.0;

const secondPhoto = { thumbnailBase64: "data:image/jpeg;base64,second", sharpnessScore: 75, pose: "semi_left" };
const secondEmb = new Array(512).fill(0.01);
secondEmb[1] = 1.0;

const prevPhotos = [canonicalPhoto, secondPhoto];
const prevEmbs = [canonicalEmb, secondEmb];

// Nuevas fotos que intentan reemplazar el index 0 con mayor nitidez (similitud alta 1.0)
const newDuplicatePhoto0 = { thumbnailBase64: "data:image/jpeg;base64,canonical_higher_sharp", sharpnessScore: 99, pose: "frontal" };
const newEmb0 = [...canonicalEmb]; // sim = 1.0

const newDiversePhoto = { thumbnailBase64: "data:image/jpeg;base64,third_angle", sharpnessScore: 88, pose: "semi_right" };
const newDiverseEmb = new Array(512).fill(0.01);
newDiverseEmb[2] = 1.0;

const newPhotos = [newDuplicatePhoto0, newDiversePhoto];
const newEmbs = [newEmb0, newDiverseEmb];

const mergedPhotos = syncService.mergeCustomerPhotos(prevPhotos, newPhotos, prevEmbs, newEmbs);
const mergedEmbs = syncService.mergeCustomerEmbeddings(prevEmbs, newEmbs, prevPhotos, newPhotos);

assert.strictEqual(mergedPhotos.length, mergedEmbs.length, "Photos y embeddings deben tener longitud 1:1 exacta");
assert.strictEqual(mergedPhotos[0].thumbnailBase64, "data:image/jpeg;base64,canonical", "La foto canónica (index 0) debe ser inmutable y nunca reemplazarse");
assert.strictEqual(mergedPhotos[0].sharpnessScore, 80, "El score de index 0 debe conservarse inmutable");
assert.strictEqual(mergedPhotos.length, 3, "Debe deduplicar el duplicado de index 0 y agregar solo la foto diversa");
console.log("-> Sincronización 1:1 y protección de foto canónica validadas exitosamente.");

// [20] Fórmula Set-to-Set Equilibrada y Margen Estricto
console.log("\n[20] Probando fórmula Set-to-Set equilibrada y margen estricto...");
const formulaService = new VisitSessionService({
  customerService: custService
});

const candAVec = new Array(512).fill(0);
candAVec[60] = 1.0;
const candBVec = new Array(512).fill(0);
candBVec[60] = 0.85;
candBVec[61] = Math.sqrt(1 - 0.85 * 0.85);

const mockProfiles = [
  { id: "cand_a", name: "Candidato A", isStaff: false, embeddings: [candAVec] },
  { id: "cand_b", name: "Candidato B", isStaff: false, embeddings: [candBVec] }
];

const custServiceMock = {
  getComparisonProfiles: () => mockProfiles
};
formulaService.customerService = custServiceMock;

const sVecA = [...candAVec];
const matchedCand = formulaService.matchSessionAgainstClients([sVecA], 0.60);
assert.ok(matchedCand, "Debe matchear con candidato A superando umbral y margen");
assert.strictEqual(matchedCand.id, "cand_a");
console.log("-> Fórmula Set-to-Set equilibrada y margen estricto validados exitosamente.");

// [21] Condición de Consenso en Borrado de Staff en closeSession
console.log("\n[21] Probando consenso de cluster para borrado de staff...");
const consensusService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

const tempConsensusId = "to_verify_consensus_client";
await custService.saveOrUpdateCustomer({
  id: tempConsensusId,
  name: "Cliente temporal",
  status: "to_verify",
  isStaff: false
});

const consensusTrack = {
  trackId: 950,
  consecutiveChairFrames: 10,
  identity: { personId: tempConsensusId, name: "Cliente temporal" },
  currentQuadrant: { id: "silla_corte_consensus", label: "Silla Consenso", type: "barber_chair" }
};
const consensusSession = await consensusService.processTrack(consensusTrack);
consensusSession.personId = tempConsensusId;

// Muestra 1: leve parecido fortuito con barbero (0.48 en dim 10), pero fuertemente alineado con el cliente en dim 80
const barberLikeSample = new Array(512).fill(0);
barberLikeSample[10] = 0.48; // Sim con barberVector = 0.48 (antes disparaba Hard Delete)
barberLikeSample[80] = Math.sqrt(1 - 0.48 * 0.48); // 0.877

// Muestras 2 y 3: Coherentes con el cliente en dim 80 (sim > 0.85 con el cluster)
const clientCleanSample1 = new Array(512).fill(0);
clientCleanSample1[80] = 0.92;
clientCleanSample1[81] = Math.sqrt(1 - 0.92 * 0.92);

const clientCleanSample2 = new Array(512).fill(0);
clientCleanSample2[80] = 0.90;
clientCleanSample2[82] = Math.sqrt(1 - 0.90 * 0.90);

consensusSession.embeddings.push(barberLikeSample, clientCleanSample1, clientCleanSample2);
consensusSession.photos.push(
  { thumbnailBase64: "data:image/jpeg;base64,sample1", sharpnessScore: 80, pose: "frontal" },
  { thumbnailBase64: "data:image/jpeg;base64,sample2", sharpnessScore: 82, pose: "semi_left" },
  { thumbnailBase64: "data:image/jpeg;base64,sample3", sharpnessScore: 85, pose: "semi_right" }
);

const consensusResult = await consensusService.closeSession(950, { durationMinutes: 20 });
assert.ok(consensusResult, "La atención NO debe ser descartada por una sola coincidencia fortuita");
const preservedCustomer = custService.getCustomerData(consensusResult.clientId);
assert.ok(preservedCustomer, "El nuevo perfil debe existir y no haber sido descartado como staff");
// [22] Probando creación inmediata de perfil 'to_verify' en Firestore/SQLite al sentarse en silla
console.log("\n[22] Probando creación en tiempo real de perfil 'to_verify'...");
const liveVerifyService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

const sittingTrack = {
  trackId: 960,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_corte_verify", label: "Silla Verify", type: "barber_chair" },
  bestFace: {
    sharpnessScore: 84,
    thumbnailBase64: "data:image/jpeg;base64,initial_face_thumb"
  }
};
const liveSession = await liveVerifyService.processTrack(sittingTrack);
assert.ok(liveSession, "Debe abrir sesión en silla");
assert.ok(liveSession.tempClientId, "Debe tener tempClientId asignado");
const toVerifyInCust = custService.getCustomerData(liveSession.tempClientId);
assert.ok(toVerifyInCust, "Debe existir en SQLite el perfil temporal 'to_verify'");
assert.strictEqual(toVerifyInCust.status, "to_verify", "El status debe ser 'to_verify'");
assert.strictEqual(toVerifyInCust.name, "Cliente (Por verificar)");
assert.ok(firestoreDocs[`camera_catcher_people/${liveSession.tempClientId}`], "Debe sincronizarse de inmediato a Firestore");
assert.strictEqual(firestoreDocs[`camera_catcher_people/${liveSession.tempClientId}`].status, "to_verify");
console.log("-> Creación en tiempo real de 'to_verify' en SQLite y Firestore validada exitosamente.");

// [23] Blindaje de salida en checkChairTimeouts contra detección fantasma de cabezal vacío (< 0.50)
console.log("\n[23] Probando que detección fantasma de cabezal (< 0.50) no interrumpe el temporizador de salida...");
const ghostShieldService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10,
  emptyChairTimeoutMs: 30000
});

const personSitting = {
  trackId: 970,
  consecutiveChairFrames: 10,
  currentQuadrant: { id: "silla_corte_ghost", label: "Silla Ghost", type: "barber_chair" }
};
await ghostShieldService.processTrack(personSitting);
const activeGhostSession = ghostShieldService.activeSessions.get(970);
activeGhostSession.photos.push({
  thumbnailBase64: "data:image/jpeg;base64,sample_client",
  sharpnessScore: 85
});
activeGhostSession.startedAtEpoch = 1000000;

// Cliente se levanta a t = 2000000
await ghostShieldService.checkChairTimeouts(2000000, []);
assert.strictEqual(activeGhostSession.status, "esperando_liberacion", "Debe entrar en espera de liberación tras levantarse");

// A los 15s (t = 2015000), el cabezal de cuero vacío genera una detección débil de YOLO (score: 0.38 < 0.50)
const ghostHeadrestTrack = {
  trackId: 999,
  confidence: 0.38, // Detección fantasma del cabezal vacío
  currentQuadrant: { id: "silla_corte_ghost", label: "Silla Ghost", type: "barber_chair" }
};
await ghostShieldService.checkChairTimeouts(2015000, [ghostHeadrestTrack]);
// El estado NO debe haberse reseteado a 'en_corte'
assert.strictEqual(activeGhostSession.status, "esperando_liberacion", "Detección de 38% del cabezal no debe interrumpir el temporizador de salida");

// A los 30s cumplidos (t = 2030000), con el cabezal fantasma aún presente a 38%
const closedGhostAppts = await ghostShieldService.checkChairTimeouts(2030000, [ghostHeadrestTrack]);
assert.strictEqual(closedGhostAppts.length, 1, "La atención debe cerrarse tras 30s a pesar de detección fantasma del cabezal");
console.log("-> Blindaje contra detecciones fantasma del cabezal (< 0.50) en checkChairTimeouts validado exitosamente.");

// [24] Auto-reconciliación y purga automática de perfiles 'to_verify' del Barbero u huérfanos
console.log("\n[24] Probando reconcileOrphanedProvisionalProfiles (auto-eliminación de barberos y huérfanos)...");
const autoPurgeService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  emptyChairTimeoutMs: 30000
});

// Registrar barbero conocido
const barberStaffAutoPurge = {
  id: "staff_barbero",
  name: "Barbero Principal",
  role: "barber",
  isStaff: true,
  embeddings: [barberVector]
};
custService.saveOrUpdateCustomer(barberStaffAutoPurge);

// Perfil 1: Barbero en to_verify (similitud >= 0.35 con barberVector)
const barberToVerify = {
  id: "to_verify_barber_leak",
  name: "Cliente (Por verificar)",
  status: "to_verify",
  embeddings: [barberVector],
  firstSeen: new Date(1000).toISOString(),
  lastSeen: new Date(2000).toISOString()
};
custService.saveOrUpdateCustomer(barberToVerify);

// Perfil 2: Huérfano abandonado (sin atención activa, inactivo > 30s)
const orphanedToVerify = {
  id: "to_verify_abandoned",
  name: "Cliente (Por verificar)",
  status: "to_verify",
  firstSeen: new Date(10000).toISOString(),
  lastSeen: new Date(20000).toISOString()
};
custService.saveOrUpdateCustomer(orphanedToVerify);

// Ejecutar reconciliación automática a t = 60000 (40s después del huérfano)
const purgedCount = await autoPurgeService.reconcileOrphanedProvisionalProfiles(60000);
assert.strictEqual(purgedCount, 2, "Debe auto-eliminar 2 perfiles: el del barbero y el abandonado huérfano");

// Verificar que fueron eliminados de la base
assert.strictEqual(custService.getCustomerData("to_verify_barber_leak"), null, "El perfil del barbero debe haberse auto-eliminado");
assert.strictEqual(custService.getCustomerData("to_verify_abandoned"), null, "El perfil huérfano debe haberse auto-eliminado");
// [25] Blindaje de bestFace consumido (eliminar replay obsoleto y no reinyectar en espaldas/reclinado)
console.log("\n[25] Probando blindaje de bestFace consumido (eliminar replay obsoleto)...");
const consumedFaceService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService
});

const tConsStart = 5000000;
const faceVecA = new Array(512).fill(0);
faceVecA[10] = 1.0;
const testTrack25 = {
  trackId: 1025,
  consecutiveChairFrames: 10,
  chairEnteredAt: tConsStart,
  currentQuadrant: { id: "silla_corte_25", label: "Silla 25", type: "barber_chair" },
  bestFace: {
    sharpnessScore: 85,
    thumbnailBase64: "data:image/jpeg;base64,faceA",
    embedding: faceVecA,
    pose: "frontal"
  }
};

const session25 = await consumedFaceService.processTrack(testTrack25, { now: tConsStart });
assert.ok(session25, "Debe iniciar sesión para track 1025");
assert.strictEqual(testTrack25.bestFace._consumedByVisit, true, "bestFace debe ser marcado como consumido de inmediato");
assert.strictEqual(session25.photos.length, 1, "Debe tener 1 foto inicial");

// Cuadro posterior sin rostro nuevo (cliente de espaldas o reclinado): latestFace es null, bestFace ya consumido
await consumedFaceService.processTrack(testTrack25, { now: tConsStart + 5000 });
assert.strictEqual(session25.photos.length, 1, "NO debe reinyectar bestFace consumido en cuadros posteriores");

// Llega una cara de rotación (vector B ortogonal) en cuadro 3
const faceVecB = new Array(512).fill(0);
faceVecB[20] = 1.0;
testTrack25.latestFace = {
  sharpnessScore: 88,
  thumbnailBase64: "data:image/jpeg;base64,faceB",
  embedding: faceVecB,
  pose: "frontal"
};
// Simulamos que pasaron 6 minutos para permitir candidatos de rotación
session25.lastMatchedClientFaceEpoch = tConsStart - 6 * 60 * 1000;
await consumedFaceService.processTrack(testTrack25, { now: tConsStart + 6 * 60 * 1000 });
assert.strictEqual(session25.rotationCandidates.length, 1, "Candidato de rotación debe acumularse en el buffer");

// En el siguiente cuadro, latestFace vuelve a ser null (cliente de espaldas): el buffer de rotación NO debe resetearse
await consumedFaceService.processTrack(testTrack25, { now: tConsStart + 6 * 60 * 1000 + 1000 });
assert.strictEqual(session25.rotationCandidates.length, 1, "El buffer de rotación NO debe resetearse por falta de rostro");
console.log("-> Blindaje de bestFace consumido y persistencia de rotationCandidates validados exitosamente.");

// [26] Blindaje de Rotación por el Factor Tiempo Real (In-Place Rotation)
console.log("\n[26] Probando rotación por factor tiempo (< 5 min tolera ángulos; > 5 min permite rotar)...");
const timeGatedService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

const tTimeStart = 6000000;
const clientFrontalVec = new Array(512).fill(0);
clientFrontalVec[100] = 1.0;
const testTrack26 = {
  trackId: 1026,
  consecutiveChairFrames: 10,
  chairEnteredAt: tTimeStart,
  currentQuadrant: { id: "silla_corte_26", label: "Silla 26", type: "barber_chair" },
  latestFace: {
    sharpnessScore: 80,
    thumbnailBase64: "data:image/jpeg;base64,frontal26",
    embedding: clientFrontalVec,
    pose: "frontal"
  }
};

const session26 = await timeGatedService.processTrack(testTrack26, { now: tTimeStart });
assert.ok(session26, "Sesión 26 iniciada");
assert.strictEqual(session26.status, "en_corte");
assert.strictEqual(session26.photos.length, 1);

// A los 2 minutos (presencia continua en silla, !pendingRotationSplitEpoch, < 5 min transcurridos):
// Cliente cambia de ángulo/pose a semi-perfil compatible con similitud de mismo cliente (sim = 0.70 >= 0.58)
const clientAngledVec = new Array(512).fill(0);
clientAngledVec[100] = 0.70;
clientAngledVec[101] = Math.sqrt(1 - 0.70 * 0.70); // vector normalizado unitario, sim = 0.70 en pose compatible
const t2Min = tTimeStart + 2 * 60 * 1000;
testTrack26.latestFace = {
  sharpnessScore: 85,
  thumbnailBase64: "data:image/jpeg;base64,semi_left26",
  embedding: clientAngledVec,
  pose: "semi_left"
};

const resAngled = await timeGatedService.processTrack(testTrack26, { now: t2Min });
assert.ok(resAngled, "La sesión debe continuar activa");
assert.strictEqual(resAngled.status, "en_corte", "NO debe haber cerrado la sesión ni iniciado rotación");
assert.strictEqual(resAngled.photos.length, 2, "La nueva pose debe haberse incorporado a la galería del cliente");
assert.strictEqual(resAngled.rotationCandidates.length, 0, "No debe haber candidatos de rotación para el mismo cliente");

// A los 3 minutos: muestra ortogonal (similitud < 0.20, ej. 0.05)
const noiseVec = new Array(512).fill(0);
noiseVec[100] = 0.05;
noiseVec[102] = Math.sqrt(1 - 0.05 * 0.05);
const t3Min = tTimeStart + 3 * 60 * 1000;
testTrack26.latestFace = {
  sharpnessScore: 70,
  thumbnailBase64: "data:image/jpeg;base64,noise26",
  embedding: noiseVec,
  pose: "frontal"
};
const resNoise = await timeGatedService.processTrack(testTrack26, { now: t3Min });
assert.strictEqual(resNoise.photos.length, 2, "Muestra ortogonal (sim < 0.20) no debe contaminar las fotos del cliente actual");
assert.strictEqual(resNoise.rotationCandidates.length, 1, "Muestra ortogonal debe quedar en buffer de rotación para verificar consenso");
assert.strictEqual(resNoise.status, "en_corte", "1 sola muestra aislada no debe rotar el corte");

// A los 3 minutos y 1 segundo: llega una 2da muestra confirmatoria del nuevo cliente (consenso >= 2)
testTrack26.latestFace = {
  sharpnessScore: 75,
  thumbnailBase64: "data:image/jpeg;base64,newClient26_b",
  embedding: noiseVec,
  pose: "frontal"
};
const resRotated = await timeGatedService.processTrack(testTrack26, { now: t3Min + 1000 });
assert.ok(resRotated, "Debe iniciar la nueva sesión tras confirmar consenso ortogonal");
assert.notStrictEqual(resRotated.id, session26.id, "Debe haber formalizado el cierre de la sesión previa y abierto una nueva");
assert.strictEqual(resRotated.rotatedFromPrevSession, true, "La nueva sesión debe estar marcada como rotada");

console.log("-> Ortogonalidad Biométrica (inmunidad a 1 cuadro de ruido y rotación inmediata con 2 muestras) validada exitosamente.");

// [27] Consolidación Robusta de Tramos del Mismo Cliente y Descarte de < minMinutes no consolidados
console.log("\n[27] Probando consolidación robusta de tramos (gap <= 10 min, maxS >= 0.45) y descarte de citas < minMinutes...");
const mergeService = new VisitSessionService({
  db: mockDb,
  sqliteClient: sqlite,
  customerService: custService,
  minAppointmentMinutes: 10
});

const tMergeStart = 7000000;
const mergeVec = new Array(512).fill(0);
mergeVec[150] = 1.0;

// Tramo 1: Cliente formaliza cita de 20 minutos
const trackM1 = {
  trackId: 1027,
  consecutiveChairFrames: 10,
  chairEnteredAt: tMergeStart,
  currentQuadrant: { id: "silla_merge", label: "Silla Merge", type: "barber_chair" },
  latestFace: {
    sharpnessScore: 88,
    thumbnailBase64: "data:image/jpeg;base64,m1",
    embedding: mergeVec,
    pose: "frontal"
  }
};
await mergeService.processTrack(trackM1, { now: tMergeStart });
const appt1 = await mergeService.closeSession(1027, {
  endedAtEpoch: tMergeStart + 20 * 60 * 1000,
  durationMinutes: 20
});
assert.ok(appt1, "Tramo 1 de 20 min debe registrarse exitosamente");
assert.strictEqual(appt1.durationMinutes, 20);
const initialApptCount = mergeService.completedAppointments.length;

// Tramo 2: Misma persona en la misma silla 4 minutos después (gap = 4 min <= 10 min), duración 5 min (< 10 min)
// Misma persona: similitud maxS = 0.50 >= 0.45, topAvgS = 0.50 >= 0.32
const tMerge2Start = tMergeStart + 24 * 60 * 1000; // brecha de 4 min
const trackM2 = {
  trackId: 1028,
  consecutiveChairFrames: 10,
  chairEnteredAt: tMerge2Start,
  currentQuadrant: { id: "silla_merge", label: "Silla Merge", type: "barber_chair" },
  latestFace: {
    sharpnessScore: 91,
    thumbnailBase64: "data:image/jpeg;base64,m2",
    embedding: mergeVec,
    pose: "semi_right"
  }
};
await mergeService.processTrack(trackM2, { now: tMerge2Start });
const mergedAppt = await mergeService.closeSession(1028, {
  endedAtEpoch: tMerge2Start + 5 * 60 * 1000,
  durationMinutes: 5
});
assert.strictEqual(mergedAppt.id, appt1.id, "Debe consolidarse dentro de la cita previa appt1");
assert.strictEqual(mergedAppt.durationMinutes, 29, "Duración total consolidada debe ser ~29 min (20 + 4 gap + 5)");
assert.strictEqual(mergeService.completedAppointments.length, initialApptCount, "NO debe haber creado una nueva cita en completedAppointments");

// Tramo 3: Sesión corta de 2 minutos que NO se consolida (persona diferente, vector ortogonal)
const tMerge3Start = tMergeStart + 40 * 60 * 1000;
const diffPersonVec = new Array(512).fill(0);
diffPersonVec[200] = 1.0;
const trackM3 = {
  trackId: 1029,
  consecutiveChairFrames: 10,
  chairEnteredAt: tMerge3Start,
  currentQuadrant: { id: "silla_merge", label: "Silla Merge", type: "barber_chair" },
  latestFace: {
    sharpnessScore: 85,
    thumbnailBase64: "data:image/jpeg;base64,m3",
    embedding: diffPersonVec,
    pose: "frontal"
  }
};
const sessionM3 = await mergeService.processTrack(trackM3, { now: tMerge3Start });
const unmergedResult = await mergeService.closeSession(1029, {
  endedAtEpoch: tMerge3Start + 2 * 60 * 1000,
  durationMinutes: 2
});
assert.strictEqual(unmergedResult, null, "Sesión de 2 min no consolidada DEBE ser descartada (retornar null)");
assert.strictEqual(mergeService.completedAppointments.length, initialApptCount, "completedAppointments no debe haber aumentado");
assert.strictEqual(custService.getCustomerData(sessionM3.tempClientId), null, "El perfil temporal to_verify de la sesión descartada debe haber sido eliminado físicamente");
console.log("-> Consolidación robusta y descarte de tramos < minMinutes validados exitosamente.");

sqlite.close();
console.log("\n🎉 ¡Todas las pruebas del pipeline de Atenciones pasaron al 100%!");

