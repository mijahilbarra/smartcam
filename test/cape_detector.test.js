import { test, describe } from "node:test";
import assert from "node:assert";
import sharp from "sharp";
import {
  analyzeCapeState,
  trackCapeLifecycle,
  isCapeBarrierSeparating,
  CAPE_STATES
} from "../src/services/pipeline/cape_detector.js";
import {
  analyzeCapeState as analyzeFromClosure,
  trackCapeLifecycle as trackFromClosure,
  isCapeBarrierSeparating as isBarrierFromClosure,
  CAPE_STATES as STATES_FROM_CLOSURE
} from "../src/services/pipeline/closure_rules.js";
import {
  analyzeCapeState as analyzeFromProcesses,
  trackCapeLifecycle as trackFromProcesses,
  isCapeBarrierSeparating as isBarrierFromProcesses,
  CAPE_STATES as STATES_FROM_PROCESSES
} from "../src/services/processes.js";

describe("Cape Detector Module (cape_detector.js)", () => {
  describe("Exports and Declarative Re-exports", () => {
    test("re-exports from closure_rules.js and processes.js match original functions", () => {
      assert.strictEqual(analyzeCapeState, analyzeFromClosure);
      assert.strictEqual(trackCapeLifecycle, trackFromClosure);
      assert.strictEqual(isCapeBarrierSeparating, isBarrierFromClosure);
      assert.deepStrictEqual(CAPE_STATES, STATES_FROM_CLOSURE);

      assert.strictEqual(analyzeCapeState, analyzeFromProcesses);
      assert.strictEqual(trackCapeLifecycle, trackFromProcesses);
      assert.strictEqual(isCapeBarrierSeparating, isBarrierFromProcesses);
      assert.deepStrictEqual(CAPE_STATES, STATES_FROM_PROCESSES);
    });

    test("CAPE_STATES contains expected state machine values", () => {
      assert.strictEqual(CAPE_STATES.NO_CAPE, "NO_CAPE");
      assert.strictEqual(CAPE_STATES.CAPE_ON, "CAPE_ON");
      assert.strictEqual(CAPE_STATES.CAPE_ACTIVE, "CAPE_ACTIVE");
      assert.strictEqual(CAPE_STATES.CAPE_REMOVED, "CAPE_REMOVED");
    });
  });

  describe("analyzeCapeState", () => {
    test("returns invalid_buffer when given null, empty or invalid buffer", async () => {
      const resNull = await analyzeCapeState(null);
      assert.strictEqual(resNull.hasCape, false);
      assert.strictEqual(resNull.capeConfidence, 0);
      assert.strictEqual(resNull.colorUniformity, 0);
      assert.strictEqual(resNull.details.error, "invalid_buffer");

      const resEmpty = await analyzeCapeState(Buffer.alloc(0));
      assert.strictEqual(resEmpty.hasCape, false);
      assert.strictEqual(resEmpty.details.error, "invalid_buffer");

      const resNonBuffer = await analyzeCapeState("not_a_buffer");
      assert.strictEqual(resNonBuffer.hasCape, false);
      assert.strictEqual(resNonBuffer.details.error, "invalid_buffer");
    });

    test("detects cape on synthetic uniform dark cape image", async () => {
      // Crear recorte simulando tela sintética lisa monocromática con ligera variación de pliegues (+/- 4)
      const width = 200;
      const height = 300;
      const raw = Buffer.alloc(width * height * 3);
      for (let i = 0; i < raw.length; i += 3) {
        const noise = (Math.random() - 0.5) * 8;
        raw[i] = Math.min(255, Math.max(0, 30 + noise));     // R
        raw[i + 1] = Math.min(255, Math.max(0, 32 + noise)); // G
        raw[i + 2] = Math.min(255, Math.max(0, 35 + noise)); // B
      }
      const jpegBuffer = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();

      const result = await analyzeCapeState(jpegBuffer);
      assert.strictEqual(typeof result.hasCape, "boolean");
      assert.strictEqual(result.hasCape, true);
      assert.ok(result.capeConfidence >= 0.60, `Confianza esperada >= 0.60, obtenida: ${result.capeConfidence}`);
      assert.ok(result.colorUniformity >= 0.60, `Uniformidad esperada >= 0.60, obtenida: ${result.colorUniformity}`);
      assert.ok(result.details.avgStdev <= 30, `avgStdev esperado <= 30, obtenido: ${result.details.avgStdev}`);
      assert.strictEqual(typeof result.details.dominantColor.r, "number");
    });

    test("rejects cape on highly textured / noisy clothing image", async () => {
      // Crear imagen con alta textura y varianza cromática (ropa casual, estampados, rayas)
      const width = 200;
      const height = 300;
      const raw = Buffer.alloc(width * height * 3);
      for (let i = 0; i < raw.length; i += 3) {
        raw[i] = Math.floor(Math.random() * 256);
        raw[i + 1] = Math.floor(Math.random() * 256);
        raw[i + 2] = Math.floor(Math.random() * 256);
      }
      const jpegBuffer = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();

      const result = await analyzeCapeState(jpegBuffer);
      assert.strictEqual(result.hasCape, false);
      assert.ok(result.capeConfidence < 0.50, `Confianza esperada < 0.50, obtenida: ${result.capeConfidence}`);
      assert.ok(result.colorUniformity < 0.50, `Uniformidad esperada < 0.50, obtenida: ${result.colorUniformity}`);
      assert.ok(result.details.avgStdev > 40, `avgStdev esperado > 40, obtenido: ${result.details.avgStdev}`);
    });

    test("handles explicit bounding box (normalized and pixel formats)", async () => {
      const width = 400;
      const height = 600;
      const raw = Buffer.alloc(width * height * 3, 25);
      const jpegBuffer = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();

      // Formato objeto normalizado { x, y, width, height }
      const resObjNorm = await analyzeCapeState(jpegBuffer, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
      assert.strictEqual(resObjNorm.hasCape, true);
      assert.ok(resObjNorm.details.cropBounds.width > 0);

      // Formato array [x1, y1, x2, y2]
      const resArr = await analyzeCapeState(jpegBuffer, [40, 60, 360, 540]);
      assert.strictEqual(resArr.hasCape, true);
      assert.ok(resArr.details.cropBounds.height > 0);
    });
  });

  describe("trackCapeLifecycle State Machine", () => {
    test("starts in NO_CAPE and transitions through full lifecycle: NO_CAPE -> CAPE_ON -> CAPE_ACTIVE -> CAPE_REMOVED", () => {
      const session = { id: "session_test_01", chairId: "chair_1" };
      const t0 = 1700000000000;

      // 1. Estado inicial sin capa
      const step1 = trackCapeLifecycle(session, { hasCape: false, capeConfidence: 0.1 }, t0);
      assert.strictEqual(session.capeState, CAPE_STATES.NO_CAPE);
      assert.strictEqual(session.hasCapeRemoved, false);
      assert.strictEqual(step1.transitioned, false);

      // 2. Barbero coloca la capa: detección inicial -> CAPE_ON
      const t1 = t0 + 5000;
      const step2 = trackCapeLifecycle(session, { hasCape: true, capeConfidence: 0.85 }, t1);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_ON);
      assert.strictEqual(step2.transitioned, true);
      assert.strictEqual(session.capeStats.firstCapeOnAt, t1);
      assert.strictEqual(session.capeHistory.length, 1);
      assert.strictEqual(session.capeHistory[0].to, CAPE_STATES.CAPE_ON);

      // 3. Confirmación de capa sostenida durante el corte -> CAPE_ACTIVE
      const t2 = t1 + 5000;
      const step3 = trackCapeLifecycle(session, { hasCape: true, capeConfidence: 0.90 }, t2);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_ACTIVE);
      assert.strictEqual(step3.transitioned, true);
      assert.strictEqual(session.capeStats.capeActiveAt, t2);

      // 4. Servicio en progreso (continúa en CAPE_ACTIVE)
      const t3 = t2 + 60000;
      const step4 = trackCapeLifecycle(session, { hasCape: true, capeConfidence: 0.88 }, t3);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_ACTIVE);
      assert.strictEqual(step4.transitioned, false);

      // 5. Fin del corte: barbero sacude y retira la capa -> CAPE_REMOVED
      const t4 = t3 + 30000;
      const step5 = trackCapeLifecycle(session, { hasCape: false, capeConfidence: 0.10 }, t4);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_REMOVED);
      assert.strictEqual(session.hasCapeRemoved, true);
      assert.strictEqual(step5.transitioned, true);
      assert.strictEqual(session.capeStats.capeRemovedAt, t4);
      assert.strictEqual(session.capeHistory.some(e => e.to === CAPE_STATES.CAPE_REMOVED), true);
    });

    test("handles string and boolean inputs flexibly", () => {
      const session = {};
      trackCapeLifecycle(session, "CAPE_ON", 1000);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_ON);

      trackCapeLifecycle(session, "CAPE_ACTIVE", 2000);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_ACTIVE);

      trackCapeLifecycle(session, false, 3000);
      assert.strictEqual(session.capeState, CAPE_STATES.CAPE_REMOVED);
      assert.strictEqual(session.hasCapeRemoved, true);
    });

    test("handles invalid session input gracefully without throwing", () => {
      const res = trackCapeLifecycle(null, true);
      assert.strictEqual(res.state, CAPE_STATES.NO_CAPE);
      assert.strictEqual(res.hasCapeRemoved, false);
      assert.strictEqual(res.transitioned, false);
    });
  });

  describe("isCapeBarrierSeparating", () => {
    test("returns true when earlier session experienced a confirmed cape removal (hasCapeRemoved: true)", () => {
      const sessionA = {
        id: "session_A",
        startedAtEpoch: 1000,
        endedAtEpoch: 2000,
        hasCapeRemoved: true,
        capeState: CAPE_STATES.CAPE_REMOVED
      };
      const sessionB = {
        id: "session_B",
        startedAtEpoch: 2500,
        endedAtEpoch: 3500,
        hasCapeRemoved: false,
        capeState: CAPE_STATES.CAPE_ON
      };

      assert.strictEqual(isCapeBarrierSeparating(sessionA, sessionB), true);
    });

    test("returns true regardless of argument order when chronological timestamps indicate removal in earlier session", () => {
      const sessionA = {
        id: "session_A",
        startedAtEpoch: 1000,
        hasCapeRemoved: true,
        capeState: CAPE_STATES.CAPE_REMOVED
      };
      const sessionB = {
        id: "session_B",
        startedAtEpoch: 3000,
        hasCapeRemoved: false,
        capeState: CAPE_STATES.CAPE_ON
      };

      // Invertir orden de argumentos
      assert.strictEqual(isCapeBarrierSeparating(sessionB, sessionA), true);
    });

    test("returns true if earlier session has capeRemovedAt recorded in capeStats", () => {
      const sessionA = {
        id: "session_A",
        startedAtEpoch: 1000,
        capeStats: { capeRemovedAt: 1800 }
      };
      const sessionB = {
        id: "session_B",
        startedAtEpoch: 2000
      };
      assert.strictEqual(isCapeBarrierSeparating(sessionA, sessionB), true);
    });

    test("returns false when neither session experienced a cape removal (continuous client attention)", () => {
      const sessionSegment1 = {
        id: "segment_1",
        startedAtEpoch: 1000,
        hasCapeRemoved: false,
        capeState: CAPE_STATES.CAPE_ACTIVE
      };
      const sessionSegment2 = {
        id: "segment_2",
        startedAtEpoch: 1500,
        hasCapeRemoved: false,
        capeState: CAPE_STATES.CAPE_ACTIVE
      };

      assert.strictEqual(isCapeBarrierSeparating(sessionSegment1, sessionSegment2), false);
    });

    test("returns false when comparing the same session against itself", () => {
      const session = { id: "same_session", hasCapeRemoved: true };
      assert.strictEqual(isCapeBarrierSeparating(session, session), false);
    });

    test("returns false when given null or undefined sessions", () => {
      assert.strictEqual(isCapeBarrierSeparating(null, {}), false);
      assert.strictEqual(isCapeBarrierSeparating({}, null), false);
      assert.strictEqual(isCapeBarrierSeparating(null, null), false);
    });
  });
});
