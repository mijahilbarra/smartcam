import assert from "node:assert";
import {
  parseDateMs,
  normalizeSharpness,
  extractPersonPhotos,
  rankPhotosByPoseDiversity,
  computeMergedPersonData,
  toFirestoreEmbeddings
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
    { thumbnailBase64: "data:image/jpeg;base64,1", sharpnessScore: 80, capturedAt: "2026-10-01T10:00:00Z", pose: "frontal", poseLabel: "Frontal" },
    { thumbnailBase64: "data:image/jpeg;base64,2", sharpnessScore: 0.95, capturedAt: "2026-10-01T10:05:00Z", pose: "profile_left", poseLabel: "Perfil Izquierdo" }
  ]
};
const extracted1 = extractPersonPhotos(pWithPhotos);
assert.strictEqual(extracted1.length, 2);
assert.strictEqual(extracted1[0].sharpnessScore, 80);
assert.strictEqual(extracted1[0].pose, "frontal");
assert.strictEqual(extracted1[1].sharpnessScore, 95);
assert.strictEqual(extracted1[1].pose, "profile_left");

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
assert.strictEqual(extracted2[0].pose, "frontal");

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
    { thumbnailBase64: "data:image/jpeg;base64,carlos_1", sharpnessScore: 85, capturedAt: "2026-10-01T09:00:00Z", pose: "frontal" },
    { thumbnailBase64: "data:image/jpeg;base64,carlos_2", sharpnessScore: 70, capturedAt: "2026-10-01T09:10:00Z", pose: "profile_left" }
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
    { thumbnailBase64: "data:image/jpeg;base64,carlos_3", sharpnessScore: 92, capturedAt: "2026-09-25T14:00:00Z", pose: "semi_right" },
    { thumbnailBase64: "data:image/jpeg;base64,carlos_1", sharpnessScore: 85, capturedAt: "2026-10-01T09:00:00Z", pose: "frontal" } // Duplicado de profileA
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
// Embeddings combinados: deben ser un array de objetos { vector: [...] } y NUNCA matrices anidadas directas
assert.strictEqual(result.mergedData.photos.length, 3);
assert.strictEqual(result.mergedData.embeddings.length, 3);
assert.ok(result.mergedData.embeddings.every(e => e && Array.isArray(e.vector)), "Cada elemento de embeddings debe ser { vector: [...] }");
assert.ok(!result.mergedData.embeddings.some(e => Array.isArray(e)), "Firestore rechaza matrices anidadas directas");
assert.deepStrictEqual(result.mergedData.embedding, [0.5, 0.6], "embedding principal debe ser un vector 1D");

console.log("✔ computeMergedPersonData verificó selección de targetId más antiguo, fechas extremas, suma de visitas, deduplicación de fotos y embeddings compatibles con Firestore.");

// 4. Test rankPhotosByPoseDiversity garantizando al menos 1 foto por posición única
console.log("\n[4] Probando rankPhotosByPoseDiversity (garantía de pose única y tope 20)...");
const diversityCandidates = [
  // Múltiples fotos frontales de alta nitidez
  { photo: { thumbnailBase64: "front_1", sharpnessScore: 99, pose: "frontal" } },
  { photo: { thumbnailBase64: "front_2", sharpnessScore: 95, pose: "frontal" } },
  { photo: { thumbnailBase64: "front_3", sharpnessScore: 92, pose: "frontal" } },
  { photo: { thumbnailBase64: "front_4", sharpnessScore: 90, pose: "frontal" } },
  // Fotos de ángulos específicos con nitidez menor que las frontales
  { photo: { thumbnailBase64: "left_1", sharpnessScore: 42, pose: "profile_left" } },
  { photo: { thumbnailBase64: "right_1", sharpnessScore: 48, pose: "profile_right" } },
  { photo: { thumbnailBase64: "down_1", sharpnessScore: 50, pose: "tilted_down" } },
  { photo: { thumbnailBase64: "up_1", sharpnessScore: 55, pose: "tilted_up" } }
];

// Si pedimos 5 fotos: DEBE incluir las 5 poses únicas (frontal, profile_left, profile_right, tilted_down, tilted_up)
// a pesar de que front_2, front_3 y front_4 tienen mayor nitidez que las otras poses.
const ranked5 = rankPhotosByPoseDiversity(diversityCandidates, 5);
assert.strictEqual(ranked5.length, 5, "Debe retornar 5 fotos");
const posesInRanked5 = new Set(ranked5.map(item => item.photo.pose));
assert.strictEqual(posesInRanked5.size, 5, "Debe contener las 5 poses únicas distintas");
assert.ok(posesInRanked5.has("frontal"));
assert.ok(posesInRanked5.has("profile_left"));
assert.ok(posesInRanked5.has("profile_right"));
assert.ok(posesInRanked5.has("tilted_down"));
assert.ok(posesInRanked5.has("tilted_up"));

// Si pedimos 7 fotos: debe tener las 5 poses únicas + las 2 siguientes mejores frontales (front_2 95, front_3 92)
const ranked7 = rankPhotosByPoseDiversity(diversityCandidates, 7);
assert.strictEqual(ranked7.length, 7);
const thumbs7 = ranked7.map(item => item.photo.thumbnailBase64);
assert.ok(thumbs7.includes("front_1"));
assert.ok(thumbs7.includes("front_2"));
assert.ok(thumbs7.includes("front_3"));
assert.ok(thumbs7.includes("left_1"));
assert.ok(thumbs7.includes("right_1"));
assert.ok(thumbs7.includes("down_1"));
assert.ok(thumbs7.includes("up_1"));

console.log("✔ rankPhotosByPoseDiversity garantiza al menos 1 foto por posición única antes de completar por nitidez.");

// 5. Test con más de 20 fotos -> tope de 20 conservando diversidad y mayor nitidez
console.log("\n[5] Probando límite ampliado de galería a 20 fotos y embeddings...");
const createManyPhotosProfile = (idPrefix, count, startSharpness, pose = "frontal") => {
  const photos = [];
  const embeddings = [];
  for (let i = 0; i < count; i++) {
    photos.push({
      thumbnailBase64: `thumb_${idPrefix}_${i}`,
      sharpnessScore: startSharpness - i,
      pose
    });
    embeddings.push([i, i + 1]);
  }
  return {
    id: `profile_${idPrefix}`,
    name: `Cliente ${idPrefix}`,
    firstSeen: "2026-10-01T10:00:00.000Z",
    photos,
    embeddings
  };
};

const prof1 = createManyPhotosProfile("A", 15, 90, "frontal");
const prof2 = createManyPhotosProfile("B", 15, 80, "semi_right");

const result20 = computeMergedPersonData([prof1, prof2]);
assert.strictEqual(result20.mergedData.photos.length, 20, "Debe acotar a máximo 20 fotos");
assert.strictEqual(result20.mergedData.embeddings.length, 20, "Debe acotar a máximo 20 embeddings");
assert.ok(result20.mergedData.embeddings.every(e => e && Array.isArray(e.vector)), "Embeddings deben ser { vector: [...] }");
assert.ok(!result20.mergedData.embeddings.some(e => Array.isArray(e)), "Debe evitar arrays anidados directos");

// Verificar que contiene fotos de ambas poses
const resultPoses = new Set(result20.mergedData.photos.map(p => p.pose));
assert.ok(resultPoses.has("frontal"), "Debe incluir fotos frontales");
assert.ok(resultPoses.has("semi_right"), "Debe incluir fotos semi_right");

console.log("✔ Verificado tope ampliado de 20 fotos y embeddings con diversidad posicional.");
console.log("🎉 ¡Todos los tests de fusión de perfiles y diversidad de poses pasaron exitosamente!");
