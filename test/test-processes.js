import assert from "assert";
import fs from "fs";
import sharp from "sharp";
import {
  computeOccupancy,
  matchIdentitiesToTracks,
  updateVisits,
  extractClientCrops,
  runProcessCycle,
  acquireClearFrame,
  reidentifyPeople,
  enrichCropsWithClearStream
} from "../src/services/processes.js";
import { enrichCropsWithClearStream as enrichCropsDirect } from "../src/services/pipeline/clear_stream_step.js";
import { CaptureOrchestrator } from "../src/services/capture_orchestrator.js";
import { PersonTracker } from "../src/core/person_tracker.js";
import { identifyFace, extractFaceEmbedding } from "../src/face_recognizer.js";
import { evaluateFaceQuality } from "../src/services/face_quality_service.js";
import { processPeopleRecognition, resetPendingCandidates, getPendingCandidates, enrichPersonAngles, matchStaffFace } from "../src/services/people_service.js";
import { customerService } from "../src/services/customer_service.js";

console.log("=== Test de Pipeline Funcional de Procesos (processes.js) ===");

// Configurar SQLite en memoria para pruebas para proteger data/barberia.db
customerService.initForDatabase("test", { dbPath: ":memory:" });

// 1. computeOccupancy (función pura)
console.log("\n[1] Probando cálculo puro de ocupación (computeOccupancy)...");
const sampleQuadrants = [
  { id: "silla_1", label: "Silla 1", type: "barber_chair", status: "en_corte" },
  { id: "silla_2", label: "Silla 2", type: "barber_chair", status: "libre" },
  { id: "silla_3", label: "Silla 3", type: "barber_chair", status: "ocupada" },
  { id: "espera_1", label: "Silla Espera 1", type: "waiting_chair", status: "en_espera" },
  { id: "espera_2", label: "Silla Espera 2", type: "waiting_chair", status: "libre" },
  { id: "transito_1", label: "Pasillo", type: "transit", status: "en_espera" } // Zona de tránsito no cuenta como espera
];
const sampleIdentified = [
  { name: "Carlos", isStaff: true },
  { name: "Juan", isStaff: false }
];
const sampleRawDets = [
  { class: "person", score: 0.9 },
  { class: "person", score: 0.85 },
  { class: "person", score: 0.8 },
  { class: "chair", score: 0.7 }
];

const occ = computeOccupancy({
  quadrants: sampleQuadrants,
  identifiedPeople: sampleIdentified,
  rawDetections: sampleRawDets
});

assert.strictEqual(occ.clientsInCut, 2, "Debe contar 2 clientes en corte (en_corte y ocupada)");
assert.strictEqual(occ.clientsWaiting, 2, "Debe contar 2 en sillas de espera (sin contar zona de tránsito)");
assert.strictEqual(occ.activeBarbers, 1, "Debe contar 1 barbero activo identificado como staff");
assert.strictEqual(occ.totalHumans, 3, "Debe contar 3 personas totales");
console.log("-> Métricas de ocupación validadas:", occ);

// 2. matchIdentitiesToTracks (asociación espacial IoU)
console.log("\n[2] Probando asociación espacial IoU (matchIdentitiesToTracks)...");
const identityCalls = [];
const mockTracker = {
  updateIdentityAndFace: (trackId, data) => {
    identityCalls.push({ trackId, data });
  }
};

const activeTracks = [
  { trackId: 1, box: [100, 100, 200, 200] },
  { trackId: 2, box: [300, 300, 400, 400] }
];

const identified = [
  // Coincide fuertemente con trackId 1 (IoU alto)
  {
    name: "Alex",
    box: [105, 105, 195, 195],
    faceBuffer: Buffer.from("face1"),
    faceBoxNorm: [0.1, 0.1, 0.2, 0.2],
    sharpnessScore: 85
  },
  // Caja lejana (IoU 0 con todos los tracks)
  {
    name: "Fantasma",
    box: [800, 800, 900, 900]
  }
];

const matchedIds = matchIdentitiesToTracks({
  tracker: mockTracker,
  activeTracks,
  identifiedPeople: identified,
  iouThreshold: 0.20
});

assert.strictEqual(matchedIds.size, 1);
assert.strictEqual(matchedIds.has(1), true);
assert.strictEqual(identityCalls.length, 1);
assert.strictEqual(identityCalls[0].trackId, 1);
assert.strictEqual(identityCalls[0].data.identity.name, "Alex");
console.log("-> Asociación espacial por IoU validada exitosamente.");

// 3. updateVisits
console.log("\n[3] Probando actualización de visitas (updateVisits)...");
const processedTracks = [];
const closedTracks = [];
const mockVisitService = {
  processTrack: async (track) => {
    processedTracks.push(track.trackId);
  },
  closeSession: async (trackId) => {
    closedTracks.push(trackId);
  }
};

const trackerWithHistory = {
  historyTracks: [{ trackId: 99 }]
};

await updateVisits({
  visitService: mockVisitService,
  tracker: trackerWithHistory,
  activeTracks: [{ trackId: 10 }, { trackId: 20 }]
});

assert.deepStrictEqual(processedTracks, [10, 20], "Debe procesar tracks activos");
assert.deepStrictEqual(closedTracks, [99], "Debe cerrar sesiones para tracks perdidos");
assert.strictEqual(trackerWithHistory.historyTracks.length, 0, "Debe vaciar historyTracks");
console.log("-> Ciclo de vida de sesiones de visita validado exitosamente.");

// 4. extractClientCrops
console.log("\n[4] Probando extracción de recortes de clientes (extractClientCrops)...");
const uploadedCrops = [];
const mockBucket = {
  file: (dest) => ({
    save: async (buf) => uploadedCrops.push({ dest, buf })
  })
};

const crops = [
  { id: "crop_a", buffer: Buffer.from("img_a"), box: [1, 2, 3, 4], confidence: 0.95 }
];

// Caso manual: debe subir a storage
const manualRecords = await extractClientCrops({
  bucket: mockBucket,
  clientCrops: crops,
  docId: "test_doc",
  isManual: true
});
assert.strictEqual(manualRecords.length, 1);
assert.ok(manualRecords[0].storagePath.includes("test_doc_client_1.jpg"));

// Caso realtime: no debe subir a storage
const realtimeRecords = await extractClientCrops({
  bucket: mockBucket,
  clientCrops: crops,
  docId: "test_doc",
  isManual: false
});
assert.strictEqual(realtimeRecords.length, 1);
assert.strictEqual(realtimeRecords[0].storagePath, null);
console.log("-> Manejo de recortes manual vs realtime validado exitosamente.");

// 5. runProcessCycle en modo 'realtime' sin frame disponible
console.log("\n[5] Probando runProcessCycle cuando el stream no tiene frame en tiempo real...");
const waitingResult = await runProcessCycle({
  streamServer: { getLatestFrame: () => null }
}, { triggerSource: "realtime" });
assert.strictEqual(waitingResult.status, "waiting_for_frame");
console.log("-> Estado 'waiting_for_frame' retornado correctamente.");

// 6. CaptureOrchestrator delega a runProcessCycle y maneja concurrencia
console.log("\n[6] Probando CaptureOrchestrator y bloqueo de concurrencia...");
const orchestrator = new CaptureOrchestrator({
  streamServer: { getLatestFrame: () => null }
});

orchestrator.isCapturing = true;
const busyResult = await orchestrator.execute("realtime");
assert.strictEqual(busyResult.status, "already_running");
orchestrator.isCapturing = false;
console.log("-> Mutex de captura en CaptureOrchestrator validado exitosamente.");

// 7. acquireClearFrame: retorno null en fallo sin romper el proceso
console.log("\n[7] Probando acquireClearFrame ante desconexión / fallo RTSP...");
const failedClear = await acquireClearFrame({
  rtspUrl: "rtsp://127.0.0.1:9999/non_existent_stream",
  timeoutMs: 500
});
assert.strictEqual(failedClear, null, "Debe retornar null cuando RTSP no está disponible o falla");
console.log("-> acquireClearFrame maneja fallos RTSP de forma transparente retornando null.");

// 8. runProcessCycle con adquisición reactiva de stream Clear
console.log("\n[8] Probando adquisición reactiva de Stream Clear en runProcessCycle...");
const dummyLightweightFrame = await sharp({
  create: { width: 640, height: 360, channels: 3, background: { r: 50, g: 50, b: 50 } }
}).jpeg().toBuffer();

const dummyClearFrame = await sharp({
  create: { width: 2560, height: 1440, channels: 3, background: { r: 200, g: 100, b: 50 } }
}).jpeg().toBuffer();

let clearCalls = 0;
const mockAcquireClear = async () => {
  clearCalls++;
  return dummyClearFrame;
};

const customTracker = new PersonTracker();
const mockZone = {
  id: "silla_corte_1",
  name: "Silla 1",
  type: "barber_chair",
  capturePerson: true,
  role: "client",
  boxNorm: [0.1, 0.1, 0.8, 0.8]
};

customTracker.activeTracks.set(10, {
  trackId: 10,
  box: [64, 36, 512, 288],
  boxNorm: [0.1, 0.1, 0.8, 0.8],
  confidence: 0.95,
  currentQuadrant: mockZone,
  sharpnessScore: 35,
  bestFace: null
});

const mockVisit = { processTrack: async () => {}, closeSession: async () => {} };
const mockStream = { getLatestFrame: () => dummyLightweightFrame };

// Ciclo 1: debe invocar Clear Stream para el track con baja nitidez
await runProcessCycle({
  streamServer: mockStream,
  tracker: customTracker,
  visitService: mockVisit,
  acquireClearFrame: mockAcquireClear
}, { triggerSource: "realtime" });

assert.strictEqual(clearCalls, 1, "Debe haber llamado a acquireClearFrame en el ciclo 1");
const updatedTrack = customTracker.getTrack(10);
assert.ok(updatedTrack.lastClearCaptureTime > 0, "Debe haber registrado lastClearCaptureTime");

// Ciclo 2 inmediatamente: debe estar en cooldown (no debe llamar de nuevo)
await runProcessCycle({
  streamServer: mockStream,
  tracker: customTracker,
  visitService: mockVisit,
  acquireClearFrame: mockAcquireClear
}, { triggerSource: "realtime" });

assert.strictEqual(clearCalls, 1, "No debe llamar a acquireClearFrame mientras esté en cooldown");
console.log("-> Rate limiting / cooldown de Clear stream validado exitosamente.");

// Ciclo 3: Fallo en acquireClearFrame no debe romper la ejecución
let fallbackWorked = false;
try {
  updatedTrack.lastClearCaptureTime = 0; // reset cooldown
  await runProcessCycle({
    streamServer: mockStream,
    tracker: customTracker,
    visitService: mockVisit,
    acquireClearFrame: async () => { throw new Error("RTSP timeout"); }
  }, { triggerSource: "realtime" });
  fallbackWorked = true;
} catch (e) {
  fallbackWorked = false;
}
assert.strictEqual(fallbackWorked, true, "Fallo en frame Clear debe degradar transparentemente sin error");
console.log("-> Fallback transparente a frame ligero validado exitosamente.");

// Ciclo 4: Soporte de asyncClear: true no bloqueante
let asyncClearCalled = false;
updatedTrack.lastClearCaptureTime = 0;
await runProcessCycle({
  streamServer: mockStream,
  tracker: customTracker,
  visitService: mockVisit,
  acquireClearFrame: async () => {
    asyncClearCalled = true;
    return dummyClearFrame;
  }
}, { triggerSource: "realtime", asyncClear: true });
assert.strictEqual(asyncClearCalled, true, "asyncClear debe disparar la captura reactiva");
console.log("-> asyncClear no bloqueante en runProcessCycle validado exitosamente.");

// 8b. enrichCropsWithClearStream (prueba unitaria aislada de la etapa)
console.log("\n[8b] Probando enrichCropsWithClearStream como función pura y desacoplada...");
assert.strictEqual(typeof enrichCropsWithClearStream, "function", "enrichCropsWithClearStream debe ser re-exportada desde processes.js");
assert.strictEqual(enrichCropsWithClearStream, enrichCropsDirect, "La función re-exportada debe ser idéntica a la del step");

const testIsolatedTrack = {
  trackId: 77,
  box: [64, 36, 512, 288],
  confidence: 0.90,
  currentQuadrant: {
    id: "silla_corte_aislada",
    name: "Silla Aislada",
    type: "barber_chair",
    capturePerson: true,
    role: "client"
  },
  sharpnessScore: 30,
  bestFace: null
};

const isolatedMlResult = {
  origWidth: 640,
  origHeight: 360,
  clientCrops: []
};

await enrichCropsWithClearStream({
  activeTracks: [testIsolatedTrack],
  mlResult: isolatedMlResult,
  options: {
    acquireClearFrame: async () => dummyClearFrame
  },
  docId: "test_doc_isolated"
});

assert.strictEqual(isolatedMlResult.clientCrops.length, 1, "Debe haber generado 1 clientCrop de alta resolución");
assert.strictEqual(isolatedMlResult.clientCrops[0].isHighRes, true, "El recorte generado debe tener isHighRes: true");
assert.ok(isolatedMlResult.clientCrops[0].buffer, "El recorte debe tener buffer generado con Sharp");
console.log("-> enrichCropsWithClearStream procesó y generó recortes de alta resolución de forma aislada.");

// 9. identifyFace: Galería Multi-Ángulo y umbral por defecto 0.50
console.log("\n[9] Probando comparación multi-ángulo en identifyFace...");
const createUnitVector = (dim, index) => {
  const v = new Array(dim).fill(0);
  v[index] = 1;
  return v;
};

const vFrontal = createUnitVector(512, 0);
const vProfile = createUnitVector(512, 1);
const vTilted = createUnitVector(512, 2);
const vOther = createUnitVector(512, 10);

// Perfil con galería de vectores planos
const profileWithGallery = {
  id: "client_miguel",
  name: "Miguel Ángel",
  isStaff: false,
  embeddings: [vFrontal, vProfile]
};

// Perfil con galería de objetos { vector: [...] }
const profileWithObjects = {
  id: "client_diego",
  name: "Diego Rivera",
  isStaff: false,
  embeddings: [{ vector: vTilted }]
};

// Perfil tradicional con vector único embedding
const profileLegacy = {
  id: "client_carlos",
  name: "Carlos Legacy",
  isStaff: false,
  embedding: vOther
};

const knownProfiles = [profileWithGallery, profileWithObjects, profileLegacy];

// Caso A: Consulta coincide con el segundo ángulo de la galería de Miguel (vProfile)
const matchProfileAngle = identifyFace(vProfile, knownProfiles);
assert.strictEqual(matchProfileAngle.matched, true, "Debe hacer match con el perfil multi-ángulo");
assert.strictEqual(matchProfileAngle.profile.id, "client_miguel", "Debe identificar a Miguel vía su segundo vector");
assert.strictEqual(matchProfileAngle.similarity, 1.0);

// Caso B: Consulta coincide con el perfil empaquetado en objeto { vector }
const matchObjectAngle = identifyFace(vTilted, knownProfiles);
assert.strictEqual(matchObjectAngle.matched, true);
assert.strictEqual(matchObjectAngle.profile.id, "client_diego");

// Caso C: Fallback a perfil con embedding simple tradicional
const matchLegacy = identifyFace(vOther, knownProfiles);
assert.strictEqual(matchLegacy.matched, true);
assert.strictEqual(matchLegacy.profile.id, "client_carlos");

// Caso D: Umbral por defecto es 0.50
// Vector sintético que comparte producto escalar ~0.55 con vFrontal
const vPartial = new Array(512).fill(0);
vPartial[0] = 0.55;
vPartial[3] = Math.sqrt(1 - 0.55 * 0.55);
const matchPartial = identifyFace(vPartial, [profileWithGallery]);
assert.strictEqual(matchPartial.matched, true, "Debe hacer match con umbral por defecto 0.50 (similitud ~0.55)");

const noMatchStrict = identifyFace(vPartial, [profileWithGallery], 0.65);
assert.strictEqual(noMatchStrict.matched, false, "No debe hacer match si se exige umbral estricto 0.65");
console.log("-> Identificación de galería multi-ángulo y umbral 0.50 validados exitosamente.");

// 10. processPeopleRecognition: Gobernanza por Sesión Temporal y Acumulación de Galería
console.log("\n[10] Probando gobernanza temporal de sesión en processPeopleRecognition...");
resetPendingCandidates();

const barberImgBuffer = fs.readFileSync("test/barber_crop.jpg");

// Mock de Firestore en memoria para personas
const firestoreStorage = new Map();
const mockDb = {
  collection: (name) => ({
    get: async () => {
      const docs = [];
      for (const [id, data] of firestoreStorage.entries()) {
        docs.push({ id, data: () => data });
      }
      return docs;
    }
  }),
  doc: (path) => ({
    get: async () => {
      const id = path.replace("camera_catcher_people/", "").replace("camera_catcher/staff", "staff");
      const data = firestoreStorage.get(id);
      return { exists: !!data, data: () => data };
    },
    set: async (val, opts) => {
      const id = path.replace("camera_catcher_people/", "");
      if (opts?.merge && firestoreStorage.has(id)) {
        firestoreStorage.set(id, { ...firestoreStorage.get(id), ...val });
      } else {
        firestoreStorage.set(id, val);
      }
    },
    update: async (val) => {
      const id = path.replace("camera_catcher_people/", "");
      const current = firestoreStorage.get(id) || {};
      firestoreStorage.set(id, { ...current, ...val });
    }
  })
};

// Guardamos cliente existente en Firestore con un ángulo canónico de Enrique (similitud 0.75 con barber_crop.jpg)
const enriqueQuality = await evaluateFaceQuality(barberImgBuffer);
const enriqueEmbedding = await extractFaceEmbedding(enriqueQuality.faceBuffer);

const createSimilarVector = (baseVector, targetSimilarity = 0.75) => {
  let v = new Array(baseVector.length).fill(0);
  v[0] = 1.0;
  if (Math.abs(baseVector[0]) > 0.8) {
    v[0] = 0.0;
    v[1] = 1.0;
  }
  let dot = 0;
  for (let i = 0; i < baseVector.length; i++) dot += v[i] * baseVector[i];
  let u = new Array(baseVector.length);
  let normU = 0;
  for (let i = 0; i < baseVector.length; i++) {
    u[i] = v[i] - dot * baseVector[i];
    normU += u[i] * u[i];
  }
  normU = Math.sqrt(normU);
  for (let i = 0; i < baseVector.length; i++) u[i] /= normU;

  const s = targetSimilarity;
  const orthoScale = Math.sqrt(Math.max(0, 1 - s * s));
  const res = new Array(baseVector.length);
  for (let i = 0; i < baseVector.length; i++) {
    res[i] = s * baseVector[i] + orthoScale * u[i];
  }
  return res;
};

const canonicalEnrique = createSimilarVector(enriqueEmbedding, 0.75);
const initialClient = {
  id: "client_enrique",
  name: "Enrique Gómez",
  isStaff: false,
  visitCount: 3,
  bestFaceScore: 50,
  embeddings: [canonicalEnrique],
  photos: [{
    thumbnailBase64: "data:image/jpeg;base64,mock_thumb",
    sharpnessScore: 50,
    capturedAt: new Date().toISOString(),
    pose: "frontal",
    poseLabel: "Frontal"
  }]
};
firestoreStorage.set("client_enrique", initialClient);

// Sesión activa para la silla de corte 1 asociada a Enrique
const activeSessions = [{
  visitId: "visit_session_99",
  chairId: "silla_corte_1",
  personId: "client_enrique",
  personName: "Enrique Gómez",
  isStaff: false,
  visitCount: 3,
  bestFaceScore: 50
}];

const sampleClientCrop = {
  id: "crop_silla_1",
  zoneId: "silla_corte_1",
  zoneType: "barber_chair",
  box: [50, 50, 200, 200],
  confidence: 0.95,
  status: "en_corte",
  capturePerson: true,
  buffer: barberImgBuffer
};

// Ejecución 1: En sesión activa, el rostro DEBE asociarse directamente a Enrique (cero clientes nuevos)
const recognizedSession1 = await processPeopleRecognition(
  mockDb,
  [{ id: "crop_silla_1", storagePath: null }],
  [sampleClientCrop],
  activeSessions
);

assert.strictEqual(recognizedSession1.length, 1);
assert.strictEqual(recognizedSession1[0].personId, "client_enrique", "Debe gobernar la identidad de la sesión activa");
assert.strictEqual(recognizedSession1[0].sessionGoverned, true, "Debe marcar sessionGoverned: true");
assert.strictEqual(recognizedSession1[0].name, "Enrique Gómez");

// Verificar que se haya acumulado el nuevo ángulo en la galería de Enrique
const updatedClientDoc = firestoreStorage.get("client_enrique");
assert.ok(Array.isArray(updatedClientDoc.embeddings), "Debe tener galería de embeddings");
assert.ok(updatedClientDoc.embeddings.length >= 2, "Debe haber anexado el nuevo ángulo a la galería");
assert.ok(updatedClientDoc.embeddings.length <= 20, "No debe exceder el límite de 20 ángulos");
assert.ok(Array.isArray(updatedClientDoc.photos), "Debe tener galería de photos");
assert.ok(updatedClientDoc.photos.length >= 1, "Debe haber anexado la foto a la galería de photos");
assert.ok(updatedClientDoc.photos.length <= 20, "No debe exceder el límite de 20 fotos");
console.log(`-> Sesión activa gobernó detección: asignado a ${updatedClientDoc.name} con ${updatedClientDoc.embeddings.length} ángulos en galería.`);

// Verificación de tope máximo de 20 ángulos en galería
const currentDoc = firestoreStorage.get("client_enrique");
currentDoc.embeddings = [canonicalEnrique];
currentDoc.photos = [currentDoc.photos[0]];
for (let k = 1; k < 19; k++) {
  currentDoc.embeddings.push(createUnitVector(512, k));
  currentDoc.photos.push({
    thumbnailBase64: `data:image/jpeg;base64,mock_${k}`,
    sharpnessScore: 20,
    capturedAt: new Date().toISOString(),
    pose: 'profile_left',
    poseLabel: 'Perfil Izquierdo'
  });
}
currentDoc.bestFaceScore = 10; // score bajo para que la captura con score 67 active incorporación
customerService.saveOrUpdateCustomer(currentDoc);

await processPeopleRecognition(
  mockDb,
  [{ id: "crop_silla_1", storagePath: null }],
  [sampleClientCrop],
  activeSessions
);
assert.strictEqual(firestoreStorage.get("client_enrique").embeddings.length, 20, "Debe alcanzar el tope de 20 ángulos");

// Un nuevo ángulo no debe sobrepasar 20
firestoreStorage.get("client_enrique").bestFaceScore = 10;
customerService.saveOrUpdateCustomer(firestoreStorage.get("client_enrique"));
await processPeopleRecognition(
  mockDb,
  [{ id: "crop_silla_1", storagePath: null }],
  [sampleClientCrop],
  activeSessions
);
assert.strictEqual(firestoreStorage.get("client_enrique").embeddings.length, 20, "La galería debe mantenerse estrictamente acotada a máximo 20 ángulos");
console.log("-> Límite máximo de galería de 20 embeddings verificado exitosamente.");

// Caso E: Creación de nuevo cliente inicializa embeddings: [candidate.embedding]
resetPendingCandidates();
const cleanStorage = new Map();
const cleanDb = {
  collection: () => ({
    get: async () => Array.from(cleanStorage.entries()).map(([id, data]) => ({ id, data: () => data }))
  }),
  doc: (path) => ({
    get: async () => ({ exists: false, data: () => null }),
    set: async (val) => {
      const id = path.replace("camera_catcher_people/", "");
      cleanStorage.set(id, val);
    }
  })
};

const newCropInEmptyChair = {
  id: "crop_silla_2",
  zoneId: "silla_corte_2",
  zoneType: "barber_chair",
  box: [250, 50, 400, 200],
  confidence: 0.95,
  status: "en_corte",
  capturePerson: true,
  buffer: barberImgBuffer
};

// 3 ciclos consecutivos de debounce para confirmar nuevo cliente
await processPeopleRecognition(cleanDb, [], [newCropInEmptyChair], []);
await processPeopleRecognition(cleanDb, [], [newCropInEmptyChair], []);
const confirmResult = await processPeopleRecognition(cleanDb, [], [newCropInEmptyChair], []);

assert.strictEqual(confirmResult.length, 1);
assert.strictEqual(confirmResult[0].isPendingConfirmation, true, "Debe marcar isPendingConfirmation: true");
assert.strictEqual(confirmResult[0].isCandidate, true, "Debe ser candidato temporal");
assert.strictEqual(confirmResult[0].name, null, "NO debe inventar nombres como 'Cliente en confirmación'");
assert.strictEqual(cleanStorage.size, 0, "NO debe crear clientes prematuramente en Firestore durante el debounce");

const pendingList = getPendingCandidates();
assert.ok(pendingList.length >= 1, "Debe mantenerse el candidato en memoria");
const currentCand = pendingList.find(c => c.tempId === confirmResult[0].personId);
assert.ok(currentCand, "El candidato debe existir en memoria");
assert.strictEqual(currentCand.count, 3, "Debe haber acumulado 3 ciclos de debounce en memoria");
assert.ok(Array.isArray(currentCand.embeddings), "El candidato debe tener array de embeddings");
assert.strictEqual(currentCand.embeddings.length, 1, "Debe iniciar con 1 embedding en embeddings");
assert.ok(Array.isArray(currentCand.photos), "El candidato debe tener array de photos");
assert.strictEqual(currentCand.photos.length, 1, "Debe iniciar con 1 foto en photos");
assert.ok(currentCand.photos[0].thumbnailBase64, "La foto debe tener thumbnailBase64");
assert.strictEqual(typeof currentCand.photos[0].sharpnessScore, "number", "La foto debe tener sharpnessScore numérico");
console.log("-> Debounce en memoria sin creación prematura en Firestore validado exitosamente.");

// 11. enrichPersonAngles: Correspondencia 1:1 y sincronización de perfiles legados
console.log("\n[11] Probando sincronización 1:1 de embeddings y photos en enrichPersonAngles...");
const legacyEmbeddings = [];
for (let k = 0; k < 20; k++) {
  legacyEmbeddings.push(createUnitVector(512, k));
}
const legacyPerson = {
  id: "client_legacy_215",
  name: "Cliente #215",
  isStaff: false,
  thumbnailBase64: "data:image/jpeg;base64,initial_legacy_photo",
  bestFaceScore: 45,
  embeddings: legacyEmbeddings
};

// Agregar fotos 2 a 20 consecutivamente
let currentLegacy = { ...legacyPerson };
for (let photoNum = 2; photoNum <= 20; photoNum++) {
  const newEmb = createUnitVector(512, 20 + photoNum);
  const newThumb = `data:image/jpeg;base64,photo_${photoNum}`;
  const res = enrichPersonAngles(currentLegacy, {
    embedding: newEmb,
    faceThumbnailBase64: newThumb,
    sharpnessScore: 50 + photoNum
  }, { skipCanonicalCheck: true });

  assert.strictEqual(res.photos.length, photoNum, `Debe tener ${photoNum} fotos tras la adición`);
  assert.strictEqual(res.embeddings.length, 20, "Debe mantener 20 embeddings");
  assert.strictEqual(res.photos[photoNum - 1].thumbnailBase64, newThumb, "La miniatura de la foto debe coincidir");
  assert.deepStrictEqual(res.embeddings[photoNum - 1], newEmb, `El embedding en índice ${photoNum - 1} debe corresponder a la foto`);
  currentLegacy.embeddings = res.embeddings;
  currentLegacy.photos = res.photos;
}

// Ahora con 20 fotos y 20 embeddings, añadir la 21va foto debe rotar en paralelo
const rotEmb = createUnitVector(512, 99);
const rotThumb = "data:image/jpeg;base64,photo_21_rotated";
const rotResult = enrichPersonAngles(currentLegacy, {
  embedding: rotEmb,
  faceThumbnailBase64: rotThumb,
  sharpnessScore: 90
}, { skipCanonicalCheck: true });
assert.strictEqual(rotResult.photos.length, 20, "Debe mantener máximo 20 fotos");
assert.strictEqual(rotResult.embeddings.length, 20, "Debe mantener máximo 20 embeddings");
assert.strictEqual(rotResult.photos[0].thumbnailBase64, "data:image/jpeg;base64,initial_legacy_photo", "Debe conservar la foto inicial de referencia en índice 0");
assert.deepStrictEqual(rotResult.embeddings[0], createUnitVector(512, 0), "Debe conservar el embedding inicial de referencia en índice 0");
assert.strictEqual(rotResult.photos[19].thumbnailBase64, rotThumb, "La última foto debe ser la recién incorporada");
assert.deepStrictEqual(rotResult.embeddings[19], rotEmb, "El último embedding debe ser el recién incorporado");
console.log("-> Correspondencia 1:1 y sincronización progresiva de perfiles legados validada exitosamente.");

// 12. Regla de Exclusión del Barbero y Unicidad ("si se parece al barbero, no se guarda")
console.log("\n[12] Probando exclusión estricta del barbero y regla de unicidad...");
resetPendingCandidates();

const staffBarberProfile = {
  id: "staff_barbero_test",
  name: "Barbero Test",
  isStaff: true,
  role: "barber",
  embedding: enriqueEmbedding,
  embeddings: [enriqueEmbedding],
  photos: [{
    thumbnailBase64: "data:image/jpeg;base64,barber_mock",
    sharpnessScore: 95,
    capturedAt: new Date().toISOString(),
    pose: "frontal",
    poseLabel: "Frontal"
  }]
};

// Mock DB con Barbero registrado
const staffStorage = new Map();
staffStorage.set("staff_barbero_test", staffBarberProfile);
const staffMockDb = {
  collection: () => ({
    get: async () => Array.from(staffStorage.entries()).map(([id, data]) => ({ id, data: () => data }))
  }),
  doc: (path) => ({
    get: async () => {
      const id = path.replace("camera_catcher_people/", "");
      const d = staffStorage.get(id);
      return { exists: !!d, data: () => d };
    },
    set: async (val) => {
      const id = path.replace("camera_catcher_people/", "");
      staffStorage.set(id, val);
    }
  })
};

// Cliente sentado en silla de corte
const clientDocInChair = {
  id: "client_frecuente_100",
  name: "Cliente Frecuente 100",
  isStaff: false,
  role: "client",
  embedding: createUnitVector(512, 100),
  embeddings: [createUnitVector(512, 100)],
  photos: [{
    thumbnailBase64: "data:image/jpeg;base64,client_100",
    sharpnessScore: 90,
    capturedAt: new Date().toISOString(),
    pose: "frontal",
    poseLabel: "Frontal"
  }]
};
staffStorage.set("client_frecuente_100", clientDocInChair);

// Sesión activa del cliente en la silla
const chairSession = [{
  visitId: "visit_client_100",
  chairId: "silla_corte_vip",
  personId: "client_frecuente_100",
  personName: "Cliente Frecuente 100",
  isStaff: false
}];

// El barbero se asoma a la silla_corte_vip (su cara genera crop en la zona de la silla)
const barberCropInClientChair = {
  id: "crop_barbero_inclinado",
  zoneId: "silla_corte_vip",
  zoneType: "barber_chair",
  box: [50, 50, 200, 200],
  confidence: 0.95,
  status: "en_corte",
  capturePerson: true,
  buffer: barberImgBuffer // Rostro del barbero
};

// Ejecución: cuando el barbero se asoma a la silla del cliente:
// DEBE ser clasificado como Barbero (isStaff: true).
// NO debe contaminar al cliente ni agregarle fotos.
const staffRecognitionResult = await processPeopleRecognition(
  staffMockDb,
  [{ id: "crop_barbero_inclinado", storagePath: null }],
  [barberCropInClientChair],
  chairSession
);

assert.strictEqual(staffRecognitionResult.length, 1);
assert.strictEqual(staffRecognitionResult[0].isStaff, true, "Debe ser clasificado como Barbero/Staff");
assert.strictEqual(staffRecognitionResult[0].personId, "staff_barbero_test", "Debe ser el Barbero");

const unpollutedClient = staffStorage.get("client_frecuente_100");
assert.strictEqual(unpollutedClient.photos.length, 1, "La galería del cliente NO debe ser contaminada con fotos del barbero");
assert.strictEqual(unpollutedClient.embeddings.length, 1, "Los embeddings del cliente NO deben ser contaminados con los del barbero");
console.log("-> Exclusión estricta del barbero en silla activa validada: el barbero fue identificado como Staff y la galería del cliente permaneció intacta.");

// Prueba de rechazo de intruso no parecido: Si un rostro no se parece al cliente en la silla ni al barbero:
// "guardar un rostro cuando solo haya una opcion" -> no se inyecta en el cliente
const intruderEmbedding = createUnitVector(512, 250);
const enrichIntruderAttempt = enrichPersonAngles(clientDocInChair, {
  embedding: intruderEmbedding,
  faceThumbnailBase64: "data:image/jpeg;base64,intruder",
  sharpnessScore: 99
});
assert.strictEqual(enrichIntruderAttempt.rejected, true, "Debe rechazar enriquecimiento si no coincide con el rostro canónico");
console.log("-> Candado de anclaje canónico validado: intruso rechazado exitosamente.");

console.log("\n🎉 ¡Todos los tests del pipeline funcional de procesos pasaron exitosamente!");

