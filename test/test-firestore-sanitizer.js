import assert from "assert";
import { sanitizeForFirestore, toPointObject, boxNormToPolygonNorm } from "../src/detector.js";
import { daemonReporter } from "../src/daemon_reporter.js";

console.log("=== Test de Sanitización para Firestore (Evitar Matrices Anidadas) ===");

// 1. toPointObject
assert.deepStrictEqual(toPointObject([0.25, 0.75]), { x: 0.25, y: 0.75 });
assert.deepStrictEqual(toPointObject({ x: 0.1, y: 0.9 }), { x: 0.1, y: 0.9 });
console.log("✓ toPointObject correcto");

// 2. boxNormToPolygonNorm
const poly = boxNormToPolygonNorm([0.1, 0.2, 0.8, 0.9]);
assert.strictEqual(poly.length, 4);
assert.deepStrictEqual(poly[0], { x: 0.2, y: 0.1 });
assert.deepStrictEqual(poly[1], { x: 0.9, y: 0.1 });
assert.deepStrictEqual(poly[2], { x: 0.9, y: 0.8 });
assert.deepStrictEqual(poly[3], { x: 0.2, y: 0.8 });
console.log("✓ boxNormToPolygonNorm genera [{x, y}, ...] sin arrays anidados");

// 3. sanitizeForFirestore
const nestedObj = {
  id: "test_doc",
  undefinedField: undefined,
  dateField: new Date("2026-10-04T12:00:00Z"),
  clients: [
    {
      id: "crop_1",
      box: [100, 200, 300, 400], // 1D array of numbers is valid
      polygonNorm: [ [0.1, 0.2], [0.3, 0.4], [0.5, 0.6] ] // NESTED ARRAY! Must be converted
    }
  ],
  ml: {
    quadrants: [
      {
        id: "silla_1",
        polygonNorm: [ [0.4, 0.3], [0.6, 0.3], [0.6, 0.88], [0.4, 0.88] ] // NESTED ARRAY!
      },
      {
        id: "silla_2",
        polygonNorm: [ { x: 0.8, y: 0.65 }, { x: 1.0, y: 0.65 } ] // Already objects
      }
    ],
    rawDetections: [
      { class: "person", score: 0.95, box: [10, 20, 30, 40] }
    ]
  }
};

const clean = sanitizeForFirestore(nestedObj);

// Check undefined stripped
assert.strictEqual("undefinedField" in clean, false);

// Check Date preserved
assert.strictEqual(clean.dateField instanceof Date, true);

// Check 1D array of numbers preserved
assert.deepStrictEqual(clean.clients[0].box, [100, 200, 300, 400]);
assert.deepStrictEqual(clean.ml.rawDetections[0].box, [10, 20, 30, 40]);

// Check nested coordinate arrays were converted to { x, y } objects
assert.deepStrictEqual(clean.clients[0].polygonNorm, [
  { x: 0.1, y: 0.2 },
  { x: 0.3, y: 0.4 },
  { x: 0.5, y: 0.6 }
]);

assert.deepStrictEqual(clean.ml.quadrants[0].polygonNorm, [
  { x: 0.4, y: 0.3 },
  { x: 0.6, y: 0.3 },
  { x: 0.6, y: 0.88 },
  { x: 0.4, y: 0.88 }
]);

assert.deepStrictEqual(clean.ml.quadrants[1].polygonNorm, [
  { x: 0.8, y: 0.65 },
  { x: 1.0, y: 0.65 }
]);

// Verify NO arrays contain arrays in entire structure
function verifyNoNestedArrays(obj, path = "") {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (Array.isArray(obj[i])) {
        throw new Error(`Encontrado array anidado en ${path}[${i}]`);
      }
      verifyNoNestedArrays(obj[i], `${path}[${i}]`);
    }
  } else if (obj && typeof obj === "object" && !(obj instanceof Date)) {
    for (const [k, v] of Object.entries(obj)) {
      verifyNoNestedArrays(v, `${path}.${k}`);
    }
  }
}

verifyNoNestedArrays(clean);
console.log("✓ sanitizeForFirestore elimina arrays anidados y campos undefined con éxito!");

// 4. Test daemonReporter with mockDb
const mockDb = {
  doc: (path) => ({
    set: async (payload, opts) => {
      verifyNoNestedArrays(payload, path);
      return Promise.resolve();
    }
  })
};

daemonReporter.init(mockDb);
await daemonReporter.reportQuadrantsActive([
  { id: "z1", polygonNorm: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]] }
]);
console.log("✓ daemonReporter.reportQuadrantsActive sincroniza a Firestore sin arrays anidados!");

console.log("\n🎉 ¡Todos los tests de sanitización pasaron exitosamente!");
