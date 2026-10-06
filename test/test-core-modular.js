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
import { doesDetectionOverlapZone, mapDetectionsToBarbershopQuadrants } from "../src/core/barbershop_rules.js";
import { WorkingHoursManager } from "../src/core/working_hours.js";

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

// 2b. Mapeo dinámico de cuadrantes (mapDetectionsToBarbershopQuadrants) y desacoplamiento de "Cliente sentado"
const configuredZonesFixture = [
  {
    id: "chair_vip",
    name: "Silla VIP",
    type: "barber_chair",
    capturePerson: true,
    role: "staff",
    labelOnOccupied: "Barbero Maestro (Silla VIP)",
    boxNorm: [0.65, 0.80, 1.00, 1.00]
  },
  {
    id: "transit_hall",
    name: "Pasillo Central",
    type: "walking_zone",
    capturePerson: false,
    boxNorm: [0.10, 0.10, 0.50, 0.50]
  }
];

const mockDetections = [
  { class: "person", score: 0.94, box: [820, 380, 1000, 560] }, // En Silla VIP
  { class: "person", score: 0.88, box: [150, 150, 250, 250] }  // En Pasillo
];

const mappedQuadrants = mapDetectionsToBarbershopQuadrants(mockDetections, 1024, 576, configuredZonesFixture);

// Verificar Silla VIP
const vipZone = mappedQuadrants.find(q => q.id === "chair_vip");
assert.ok(vipZone, "Debe existir la zona configurada Silla VIP");
assert.strictEqual(vipZone.status, "ocupada");
assert.strictEqual(vipZone.capturePerson, true);
assert.strictEqual(vipZone.role, "staff");
assert.strictEqual(vipZone.requiresClearCapture, true);

const vipPerson = mappedQuadrants.find(q => q.id === "person_chair_vip");
assert.ok(vipPerson, "Debe existir el cuadrante de persona person_chair_vip (sin 'cliente_sentado')");
assert.strictEqual(vipPerson.label, "Barbero Maestro (Silla VIP)");
assert.strictEqual(vipPerson.role, "staff");
assert.strictEqual(vipPerson.capturePerson, true);
assert.strictEqual(vipPerson.requiresClearCapture, true);

// Verificar Pasillo (sin captura)
const transitZone = mappedQuadrants.find(q => q.id === "transit_hall");
assert.ok(transitZone, "Debe existir la zona Pasillo Central");
assert.strictEqual(transitZone.capturePerson, false);
assert.strictEqual(transitZone.requiresClearCapture, false);

const transitPerson = mappedQuadrants.find(q => q.id === "transito_transit_hall_1");
assert.ok(transitPerson, "Debe existir la persona en tránsito");
assert.strictEqual(transitPerson.capturePerson, false);
assert.strictEqual(transitPerson.requiresClearCapture, false);

// Verificar ausencia total de IDs o etiquetas rígidas de "cliente_sentado"
const hasOldClienteSentado = mappedQuadrants.some(q => q.id.includes("cliente_sentado"));
assert.strictEqual(hasOldClienteSentado, false, "Queda erradicado 'cliente_sentado' de los IDs");

console.log("✓ Reglas de barbería y zonas dinámicas (capturePerson, roles, etiquetas) validadas exitosamente");

// 3. WorkingHoursManager
const workingHours = new WorkingHoursManager({
  defaultStart: "08:00",
  defaultEnd: "20:00",
  defaultTz: "America/Lima"
});
assert.strictEqual(workingHours.workStart, "08:00");
workingHours.updateWorkingHours("09:00", "22:00", "America/Lima");
assert.strictEqual(workingHours.workStart, "09:00");
assert.strictEqual(workingHours.workEnd, "22:00");
const state = workingHours.getState();
assert.strictEqual(state.workStart, "09:00");
assert.strictEqual(state.workEnd, "22:00");
assert.strictEqual(state.timezone, "America/Lima");
console.log("✓ WorkingHoursManager inicializado y gestionado correctamente");

console.log("\n🎉 ¡Todos los tests de los nuevos módulos modulares pasaron exitosamente!");
process.exit(0);
