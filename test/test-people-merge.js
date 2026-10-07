import assert from "node:assert";
import {
  parseDateMs,
  normalizeSharpness,
  extractPersonPhotos,
  computeMergedPersonData
} from "../web/src/entities/person/model/person-merge.js";

console.log("=== Test de Lógica de Fusión y Normalización de Perfiles (person-merge.js) ===");

// 1. parseDateMs y normalizeSharpness
assert.strictEqual(parseDateMs(null), 0);
assert.strictEqual(parseDateMs("2026-10-01T12:00:00.000Z"), 1790856000000);
assert.strictEqual(parseDateMs({ seconds: 100 }), 100000);
assert.strictEqual(parseDateMs({ toDate: () => new Date(12345) }), 12345);

assert.strictEqual(normalizeSharpness(null), 0);
assert.strictEqual(normalizeSharpness(0.85), 85);
assert.strictEqual(normalizeSharpness(92), 92);
assert.strictEqual(normalizeSharpness("76"), 76);

// 2. extractPersonPhotos
const pWithPhotos = {
  id: "p1",
  photos: [
    { thumbnailBase64: "data:image/jpeg;base64,1", sharpnessScore: 80, capturedAt: "2026-10-01T10:00:00Z" },
    { thumbnailBase64: "data:image/jpeg;base64,2", sharpnessScore: 0.95, capturedAt: "2026-10-01T10:05:00Z" }
  ]
};
const extracted1 = extractPersonPhotos(pWithPhotos);
assert.strictEqual(extracted1.length, 2);
assert.strictEqual(extracted1[0].sharpnessScore, 80);
assert.strictEqual(extracted1[1].sharpnessScore, 95);

const pWithThumbOnly = {
  id: "p2",
  thumbnailBase64: "data:image/jpeg;base64,thumb",
  bestFaceScore: 75,
  firstSeen: "2026-10-02T11:00:00Z"
};
const extracted2 = extractPersonPhotos(pWithThumbOnly);
assert.strictEqual(extracted2.length, 1);
assert.strictEqual(extracted2[0].thumbnailBase64, "data:image/jpeg;base64,thumb");
assert.strictEqual(extracted2[0].sharpnessScore, 75);

// 3. computeMergedPersonData con 2 perfiles
const profileA = {
  id: "person_100",
  name: "Carlos Ruiz",
  isStaff: false,
  role: "client",
  firstSeen: "2026-10-01T09:00:00.000Z",
  lastSeen: "2026-10-01T09:30:00.000Z",
  visitCount: 2,
  bestFaceScore: 85,
  thumbnailBase64: "data:image/jpeg;base64,carlos_1",
  photos: [
    { thumbnailBase64: "data:image/jpeg;base64,carlos_1", sharpnessScore: 85, capturedAt: "2026-10-01T09:00:00Z" },
    { thumbnailBase64: "data:image/jpeg;base64,carlos_2", sharpnessScore: 70, capturedAt: "2026-10-01T09:10:00Z" }
  ],
  embeddings: [[0.1, 0.2], [0.3, 0.4]]
};

const profileB = {
  id: "person_200",
  name: "Carlos R.",
  isStaff: true,
  role: "barber",
  firstSeen: "2026-09-25T14:00:00.000Z", // Más antiguo
  lastSeen: "2026-10-05T18:00:00.000Z", // Más reciente
  visitCount: 4,
  bestFaceScore: 92,
  thumbnailBase64: "data:image/jpeg;base64,carlos_3",
  photos: [
    { thumbnailBase64: "data:image/jpeg;base64,carlos_3", sharpnessScore: 92, capturedAt: "2026-09-25T14:00:00Z" },
    { thumbnailBase64: "data:image/jpeg;base64,carlos_1", sharpnessScore: 85, capturedAt: "2026-10-01T09:00:00Z" } // Duplicado de profileA
  ],
  embeddings: [[0.5, 0.6], [0.1, 0.2]]
};

const result = computeMergedPersonData([profileA, profileB]);

// El perfil más antiguo es profileB (2026-09-25 vs 2026-10-01)
assert.strictEqual(result.targetId, "person_200", "El targetId debe ser el del perfil con firstSeen más antiguo");
assert.deepStrictEqual(result.deleteIds, ["person_100"], "deleteIds debe contener el otro perfil");
assert.strictEqual(result.mergedData.name, "Carlos R.", "Debe conservar el nombre del perfil más antiguo por defecto");
assert.strictEqual(result.mergedData.firstSeen, "2026-09-25T14:00:00.000Z", "firstSeen debe ser el más antiguo");
assert.strictEqual(result.mergedData.lastSeen, "2026-10-05T18:00:00.000Z", "lastSeen debe ser el más reciente");
assert.strictEqual(result.mergedData.visitCount, 6, "visitCount debe ser la suma acumulada (2 + 4)");
assert.strictEqual(result.mergedData.isStaff, true, "Si alguno es staff, el fusionado debe ser staff");
assert.strictEqual(result.mergedData.role, "barber");

// Fotos combinadas: carlos_3 (92), carlos_1 (85), carlos_2 (70) -> 3 fotos únicas sin duplicado
assert.strictEqual(result.mergedData.photos.length, 3, "Debe deduplicar fotos idénticas");
assert.strictEqual(result.mergedData.photos[0].sharpnessScore, 92, "Primera foto debe ser la de mayor nitidez");
assert.strictEqual(result.mergedData.bestFaceScore, 92);
assert.strictEqual(result.mergedData.thumbnailBase64, "data:image/jpeg;base64,carlos_3");

console.log("✔ computeMergedPersonData verificó selección de targetId más antiguo, fechas extremas, suma de visitas y deduplicación de fotos.");

// 4. Test con más de 6 fotos -> tope de 6 conservando las de mayor nitidez
const profileManyPhotos1 = {
  id: "p_many_1",
  name: "Cliente A",
  firstSeen: "2026-10-01T10:00:00.000Z",
  photos: [
    { thumbnailBase64: "img_10", sharpnessScore: 10 },
    { thumbnailBase64: "img_90", sharpnessScore: 90 },
    { thumbnailBase64: "img_50", sharpnessScore: 50 },
    { thumbnailBase64: "img_80", sharpnessScore: 80 }
  ],
  embeddings: [[1], [2], [3], [4]]
};

const profileManyPhotos2 = {
  id: "p_many_2",
  name: "Cliente B",
  firstSeen: "2026-10-02T10:00:00.000Z",
  photos: [
    { thumbnailBase64: "img_95", sharpnessScore: 95 },
    { thumbnailBase64: "img_70", sharpnessScore: 70 },
    { thumbnailBase64: "img_60", sharpnessScore: 60 },
    { thumbnailBase64: "img_40", sharpnessScore: 40 }
  ],
  embeddings: [[5], [6], [7], [8]]
};

const resultMany = computeMergedPersonData([profileManyPhotos1, profileManyPhotos2]);
assert.strictEqual(resultMany.mergedData.photos.length, 6, "Debe acotar a máximo 6 fotos");
assert.deepStrictEqual(
  resultMany.mergedData.photos.map(p => p.sharpnessScore),
  [95, 90, 80, 70, 60, 50],
  "Debe conservar las 6 fotos con mayor nitidez en orden descendente"
);
assert.strictEqual(resultMany.mergedData.embeddings.length, 6, "Debe acotar a máximo 6 embeddings");

console.log("✔ Verificado tope de 6 fotos y embeddings ordenados por nitidez.");
console.log("🎉 ¡Todos los tests de fusión de perfiles pasaron exitosamente!");
