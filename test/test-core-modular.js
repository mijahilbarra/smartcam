import assert from "assert";
import {
  toPointTuple,
  toPointObject,
  boxNormToPolygonNorm,
  polygonNormToBoundingBoxNorm,
  isPointInPolygon,
  calculateIoU,
  applyNMS
} from "../src/core/geometry.js";
import { doesDetectionOverlapZone } from "../src/core/barbershop_rules.js";
import { SchedulerService } from "../src/services/scheduler_service.js";

console.log("=== Test de Módulos Core y Servicios Refactorizados ===");

// 1. Geometría
assert.deepStrictEqual(toPointTuple({ x: 10, y: 20 }), [10, 20]);
assert.deepStrictEqual(toPointObject([10, 20]), { x: 10, y: 20 });

const poly = boxNormToPolygonNorm([0, 0, 1, 1]);
assert.strictEqual(poly.length, 4);
assert.deepStrictEqual(polygonNormToBoundingBoxNorm(poly), [0, 0, 1, 1]);

// Point in polygon
const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
assert.strictEqual(isPointInPolygon([5, 5], square), true);
assert.strictEqual(isPointInPolygon([15, 5], square), false);

// IoU
const b1 = [0, 0, 10, 10];
const b2 = [0, 0, 10, 10];
assert.strictEqual(calculateIoU(b1, b2), 1.0);

const b3 = [10, 10, 20, 20];
assert.strictEqual(calculateIoU(b1, b3), 0.0);

// NMS
const dets = [
  { box: [0, 0, 10, 10], score: 0.9 },
  { box: [1, 1, 10, 10], score: 0.8 }, // overlapping
  { box: [50, 50, 60, 60], score: 0.85 } // distinct
];
const nmsResult = applyNMS(dets, 0.5);
assert.strictEqual(nmsResult.length, 2);
assert.strictEqual(nmsResult[0].score, 0.9);
assert.strictEqual(nmsResult[1].score, 0.85);
console.log("✓ Geometría pura (IoU, NMS, polígonos) validada exitosamente");

// 2. Reglas de Barbería (fixture de prueba local: las zonas reales vienen del Setup en Firestore)
const chairZone = {
  id: "fixture_chair",
  name: "Silla de prueba",
  type: "barber_chair",
  boxNorm: [0.65, 0.80, 1.00, 1.00]
};
// Detection in the lower-right quadrant: [x1, y1, x2, y2]
// chairZone boxNorm is [0.65, 0.80, 1.00, 1.00] in 1024x576 -> y: ~374-576, x: ~819-1024
const personInChair = [820, 380, 1000, 560];
assert.strictEqual(doesDetectionOverlapZone(personInChair, chairZone, 1024, 576), true);

const personFarAway = [100, 100, 200, 200];
assert.strictEqual(doesDetectionOverlapZone(personFarAway, chairZone, 1024, 576), false);
console.log("✓ Reglas de barbería y solapamiento de cuadrantes validadas exitosamente");

// 3. SchedulerService
const scheduler = new SchedulerService({
  defaultIntervalMinutes: 5,
  defaultStart: "08:00",
  defaultEnd: "20:00",
  defaultTz: "America/Lima"
});
assert.strictEqual(scheduler.currentIntervalMinutes, 5);
scheduler.updateWorkingHours("09:00", "22:00", "America/Lima");
assert.strictEqual(scheduler.workStart, "09:00");
assert.strictEqual(scheduler.workEnd, "22:00");
const state = scheduler.getState();
assert.strictEqual(state.workStart, "09:00");
assert.strictEqual(state.currentIntervalMinutes, 5);
console.log("✓ SchedulerService inicializado y gestionado correctamente");

console.log("\n🎉 ¡Todos los tests de los nuevos módulos modulares pasaron exitosamente!");
process.exit(0);
