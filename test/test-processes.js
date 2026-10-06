import assert from "assert";
import sharp from "sharp";
import {
  computeOccupancy,
  matchIdentitiesToTracks,
  updateVisits,
  extractClientCrops,
  runProcessCycle,
  acquireClearFrame
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

console.log("\n🎉 ¡Todos los tests del pipeline funcional de procesos pasaron exitosamente!");
