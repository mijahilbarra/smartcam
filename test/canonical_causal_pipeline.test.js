import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateCropStep,
  ingestSampleStep,
  evaluateInactiveBlocksStep,
  dispatchConfirmedBlocksStep,
  heartbeatStep,
  executeCausalCycle,
  flushCausalPipeline
} from "../src/services/pipeline/canonical_causal_pipeline.js";
import { TrackBlockManager } from "../src/services/pipeline/track_block_manager.js";

describe("Pipeline Causal Canónico Componible (canonical_causal_pipeline.js)", () => {
  test("evaluateCropStep maneja recortes nulos o inválidos adecuadamente", () => {
    const res = evaluateCropStep(null);
    assert.strictEqual(res.passed, false);
    assert.strictEqual(res.reason, "sin_recorte");
  });

  test("evaluateCropStep evalúa un recorte con 7 etapas", () => {
    const crop = {
      box: [200, 260, 400, 520],
      faceDetected: true,
      sharpnessScore: 60,
      pose: "frontal",
      vector: new Array(512).fill(0.05),
      hasTwoEyes: true
    };
    const res = evaluateCropStep(crop);
    assert.strictEqual(typeof res.passed, "boolean");
    assert.ok(res.stage >= 1);
  });

  test("ingestSampleStep ingesta una muestra atómica en TrackBlockManager", () => {
    const mgr = new TrackBlockManager();
    const block = ingestSampleStep({
      sample: {
        trackId: 101,
        chairId: "chair_1",
        timestampEpoch: 1000000,
        videoSecond: 1000,
        box: [200, 260, 400, 520]
      },
      trackBlockManager: mgr
    });
    assert.ok(block);
    assert.strictEqual(block.trackId, 101);
    assert.strictEqual(mgr.activeBlocks.size, 1);
  });

  test("evaluateInactiveBlocksStep y dispatchConfirmedBlocksStep procesan bloques confirmados", async () => {
    const mgr = new TrackBlockManager();
    const start = 100000;
    
    // Ingestar muestras de cliente sentado para calificar como CONFIRMED_CLIENT_BLOCK
    for (let i = 0; i < 10; i++) {
      mgr.ingestTrackSample({
        trackId: 202,
        chairId: "chair_1",
        timestampEpoch: start + i * 60000,
        videoSecond: 100 + i * 60,
        box: [200, 260, 400, 520],
        faceData: {
          vector: new Array(512).fill(0.04),
          sharpnessScore: 65,
          pose: "frontal",
          hasTwoEyes: true,
          thumbnailBase64: "data:image/jpeg;base64,mock"
        }
      });
    }

    const tCurrent = start + 600000 + 30000; // Inactividad > 20s tras la última muestra
    const confirmed = evaluateInactiveBlocksStep({
      trackBlockManager: mgr,
      timestampEpoch: tCurrent,
      inactivityTimeoutMs: 20000
    });

    assert.strictEqual(confirmed.length, 1);
    assert.strictEqual(confirmed[0].trackId, 202);

    const processedAppts = [];
    const mockVisitService = {
      processConfirmedBlock: async (block, opts) => {
        processedAppts.push({ block, opts });
        return { id: "appt_test", clientName: "Cliente Test" };
      }
    };

    const dispatched = await dispatchConfirmedBlocksStep({
      confirmedBlocks: confirmed,
      visitService: mockVisitService,
      timestampEpoch: tCurrent
    });

    assert.strictEqual(dispatched.length, 1);
    assert.strictEqual(processedAppts.length, 1);
  });

  test("heartbeatStep ejecuta avances temporales y checkChairTimeouts", async () => {
    const checkedTimes = [];
    const mockVisitService = {
      checkChairTimeouts: async (ts, activeTracks) => {
        checkedTimes.push({ ts, activeTracks });
        return [];
      }
    };
    const mgr = new TrackBlockManager();

    await heartbeatStep({
      currentTs: 5000,
      lastTimestamp: 2000,
      trackBlockManager: mgr,
      visitService: mockVisitService,
      options: { stepIntervalMs: 1000 }
    });

    assert.ok(checkedTimes.length >= 2);
  });

  test("executeCausalCycle ejecuta el pipeline lineal y llama a los hooks", async () => {
    const mgr = new TrackBlockManager();
    let hookCropCalled = false;
    let hookSampleCalled = false;

    const mockVisitService = {
      checkChairTimeouts: async () => []
    };

    const row = {
      track_id: 303,
      chair_id: "chair_1",
      timestamp_epoch: 2000000,
      video_second: 2000,
      box_json: JSON.stringify([200, 260, 400, 520]),
      face_detected: 1,
      sharpness_score: 55,
      pose: "frontal",
      vector: new Array(512).fill(0.03)
    };

    const res = await executeCausalCycle({
      cropInput: row,
      trackBlockManager: mgr,
      visitService: mockVisitService,
      hooks: {
        onCropEvaluated: (evalRes) => {
          hookCropCalled = true;
          assert.ok(evalRes);
        },
        onSampleIngested: (block) => {
          hookSampleCalled = true;
          assert.ok(block);
        }
      }
    });

    assert.ok(hookCropCalled);
    assert.ok(hookSampleCalled);
    assert.ok(res.sample);
    assert.strictEqual(res.sample.trackId, 303);
  });

  test("flushCausalPipeline vacía bloques y cierra sesiones activas", async () => {
    const mgr = new TrackBlockManager();
    const start = 100000;
    for (let i = 0; i < 10; i++) {
      mgr.ingestTrackSample({
        trackId: 404,
        chairId: "chair_1",
        timestampEpoch: start + i * 60000,
        videoSecond: 100 + i * 60,
        box: [200, 260, 400, 520],
        faceData: {
          vector: new Array(512).fill(0.04),
          sharpnessScore: 70,
          pose: "frontal",
          hasTwoEyes: true
        }
      });
    }

    let closedSessionsCount = 0;
    const mockVisitService = {
      activeSessions: new Map([["chair_1", { id: "sess_active" }]]),
      checkChairTimeouts: async () => [],
      processConfirmedBlock: async () => ({ id: "appt_flushed" }),
      closeSession: async () => {
        closedSessionsCount++;
      }
    };

    await flushCausalPipeline({
      lastTimestamp: start + 600000,
      trackBlockManager: mgr,
      visitService: mockVisitService,
      options: { emptyChairTimeoutMs: 1000 }
    });

    assert.strictEqual(mgr.activeBlocks.size, 0);
    assert.strictEqual(closedSessionsCount, 1);
  });

  test("evaluateInactiveBlocksStep y flushCausalPipeline extraen pendingConfirmedBlocks salvados", async () => {
    const mgr = new TrackBlockManager();
    const salvagedBlock = {
      trackId: 505,
      chairId: "chair_1",
      startedAtEpoch: 1000,
      lastSeenEpoch: 100000,
      seatedFrames: 25,
      crops: [{ isStaffMatch: false }]
    };
    mgr.pendingConfirmedBlocks.push(salvagedBlock);

    // evaluateInactiveBlocksStep debe vaciar pendingConfirmedBlocks
    const confirmed = evaluateInactiveBlocksStep({
      trackBlockManager: mgr,
      timestampEpoch: 105000
    });

    assert.strictEqual(confirmed.length, 1);
    assert.strictEqual(confirmed[0].trackId, 505);
    assert.strictEqual(mgr.pendingConfirmedBlocks.length, 0);

    // flushCausalPipeline también debe despachar pendingConfirmedBlocks si existiesen remanentes
    const processed = [];
    const mockVisitService = {
      activeSessions: new Map(),
      checkChairTimeouts: async () => [],
      processConfirmedBlock: async (b) => {
        processed.push(b);
        return { id: "appt_salvaged" };
      },
      closeSession: async () => {}
    };

    mgr.pendingConfirmedBlocks.push({ trackId: 606, chairId: "chair_1" });
    await flushCausalPipeline({
      lastTimestamp: 200000,
      trackBlockManager: mgr,
      visitService: mockVisitService
    });

    assert.strictEqual(processed.length, 1);
    assert.strictEqual(processed[0].trackId, 606);
    assert.strictEqual(mgr.pendingConfirmedBlocks.length, 0);
  });
});
