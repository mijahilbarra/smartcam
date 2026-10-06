import assert from "assert";
import {
  computeOccupancy,
  matchIdentitiesToTracks,
  updateVisits,
  extractClientCrops,
  runProcessCycle
} from "../src/services/processes.js";
import { CaptureOrchestrator } from "../src/services/capture_orchestrator.js";
import { PersonTracker } from "../src/core/person_tracker.js";

console.log("=== Test de Pipeline Funcional de Procesos (processes.js) ===");

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

console.log("\n🎉 ¡Todos los tests del pipeline funcional de procesos pasaron exitosamente!");
