import assert from "assert";
import fs from "fs";
import sharp from "sharp";
import { detectFace, computeSharpness, evaluateFaceQuality, estimateFacePose } from "../src/services/face_quality_service.js";

console.log("=== Test de Detección de Rostros y Score de Nitidez (RFB-320) ===");

// 1. Probar rostro frontal de barbero
console.log("\n[1] Probando recorte frontal de barbero (test/barber_crop.jpg)...");
const barberImg = fs.readFileSync("test/barber_crop.jpg");
const barberFace = await detectFace(barberImg);
console.log("-> Detección de cara:", barberFace);
assert.strictEqual(barberFace.hasFace, true, "Debe detectar la cara frontal");
assert.ok(barberFace.confidence > 0.9, "Confianza debe ser mayor a 0.9");

const barberQuality = await evaluateFaceQuality(barberImg, { minSharpness: 40 });
console.log("-> Evaluación de calidad:", {
  isValid: barberQuality.isValid,
  confidence: barberQuality.confidence,
  sharpnessScore: barberQuality.sharpnessScore,
  reason: barberQuality.reason
});
assert.strictEqual(barberQuality.isValid, true, "Debe ser un rostro válido y nítido");
assert.ok(barberQuality.faceBuffer.length > 0, "Debe contener el buffer de la cara recortada");

// 2. Probar recorte de espaldas / nuca (test/test-client-1-crop.jpg o sintético)
console.log("\n[2] Probando recorte de cliente de espaldas / nuca...");
let client1Img;
if (fs.existsSync("test/test-client-1-crop.jpg")) {
  client1Img = fs.readFileSync("test/test-client-1-crop.jpg");
} else {
  client1Img = await sharp({
    create: { width: 150, height: 200, channels: 3, background: { r: 35, g: 30, b: 25 } }
  }).jpeg().toBuffer();
}
const client1Quality = await evaluateFaceQuality(client1Img);
console.log("-> Evaluación de nuca/espalda:", client1Quality);
assert.strictEqual(client1Quality.isValid, false, "La nuca no debe ser considerada un rostro válido");
assert.strictEqual(client1Quality.reason, "no_face_detected_or_back_of_head", "Debe rechazar por no ser cara frontal");

// 3. Probar rostro moderadamente borroso (detecta cara pero rechaza por nitidez)
console.log("\n[3] Probando rostro moderadamente borroso...");
const mildBlurred = await sharp(barberImg).blur(3).toBuffer();
const mildQuality = await evaluateFaceQuality(mildBlurred, { minSharpness: 50 });
console.log("-> Evaluación de rostro moderadamente borroso:", {
  isValid: mildQuality.isValid,
  sharpnessScore: mildQuality.sharpnessScore,
  reason: mildQuality.reason
});
assert.strictEqual(mildQuality.isValid, false, "Rostro borroso debe ser rechazado");
assert.strictEqual(mildQuality.reason, "blurry_face", "Razón debe ser blurry_face");
assert.ok(mildQuality.sharpnessScore < 50, "Puntaje de nitidez debe ser bajo");

// 4. Probar rostro severamente borroso (no detecta cara)
console.log("\n[4] Probando rostro severamente borroso...");
const severeBlurred = await sharp(barberImg).blur(15).toBuffer();
const severeQuality = await evaluateFaceQuality(severeBlurred);
assert.strictEqual(severeQuality.isValid, false);
assert.strictEqual(severeQuality.reason, "no_face_detected_or_back_of_head");

// 5. Probar estimación de orientación / pose facial (estimateFacePose)
console.log("\n[5] Probando estimación de orientación/pose facial (estimateFacePose)...");
const validPoses = [
  'frontal', 'profile_left', 'profile_right', 'semi_left', 'semi_right',
  'tilted_down', 'tilted_up', 'tilted_up_left', 'tilted_up_right', 'tilted_down_left', 'tilted_down_right'
];
const poseResult = await estimateFacePose({ faceBuffer: barberQuality.faceBuffer });
console.log("-> Estimación de pose para rostro de barbero:", poseResult);
assert.ok(validPoses.includes(poseResult.pose), `Pose debe ser una pose canónica válida: ${poseResult.pose}`);
assert.ok(typeof poseResult.label === "string" && poseResult.label.length > 0, "Debe tener una etiqueta legible en español");
assert.strictEqual(typeof poseResult.yawScore, "number", "yawScore debe ser un número");
assert.strictEqual(typeof poseResult.pitchScore, "number", "pitchScore debe ser un número");

// Verificar que evaluateFaceQuality adjuntó pose y poseLabel
assert.strictEqual(barberQuality.pose, poseResult.pose, "evaluateFaceQuality debe incluir el pose estimado");
assert.strictEqual(barberQuality.poseLabel, poseResult.label, "evaluateFaceQuality debe incluir la etiqueta de pose");

// Probar estimación geométrica con vector embedding
const embeddingPose = await estimateFacePose({ embedding: [0.1, 0.8, -0.5, 0.2] });
console.log("-> Estimación de pose con embedding sintético:", embeddingPose);
assert.ok(validPoses.includes(embeddingPose.pose));
assert.strictEqual(typeof embeddingPose.label, "string");

// Probar estimación con bounding box
const boxPose = await estimateFacePose({ faceBoxNorm: [0.1, 0.2, 0.3, 0.4] });
console.log("-> Estimación de pose con faceBoxNorm sintético:", boxPose);
assert.ok(validPoses.includes(boxPose.pose));

// 6. Probar estimación geométrica directa con 5 Landmarks (SCRFD)
console.log("\n[6] Probando estimación geométrica directa con 5 landmarks (SCRFD)...");
const frontalLandmarks = [
  [0.35, 0.30], // ojo izq
  [0.65, 0.30], // ojo der
  [0.50, 0.45], // nariz
  [0.38, 0.60], // boca izq
  [0.62, 0.60]  // boca der
];
const frontalPose = await estimateFacePose({ landmarks: frontalLandmarks });
console.log("-> Pose frontal desde landmarks:", frontalPose);
assert.strictEqual(frontalPose.pose, "frontal", "Landmarks simétricos deben estimar pose frontal");
assert.strictEqual(frontalPose.label, "Frontal");
assert.ok(Math.abs(frontalPose.yawScore) < 0.1, "Yaw debe ser cercano a 0 en frontal");

const leftProfileLandmarks = [
  [0.579, 0.089],
  [0.661, 0.094],
  [0.573, 0.119],
  [0.580, 0.142],
  [0.643, 0.146]
];
const leftProfilePose = await estimateFacePose({ landmarks: leftProfileLandmarks });
console.log("-> Pose perfil izquierdo desde landmarks:", leftProfilePose);
assert.strictEqual(leftProfilePose.pose, "profile_left", "Debe clasificar perfil izquierdo correctamente");
assert.ok(leftProfilePose.yawScore <= -0.35, "yawScore debe indicar giro hacia la izquierda");

// 7. Probar validación anatómica con isValidFaceGeometry (descarte de tijeras/orejas/manos)
console.log("\n[7] Probando descarte de geometrías no faciales con isValidFaceGeometry...");
const { isValidFaceGeometry } = await import("../src/services/face_quality_service.js");

// Caso válido:
assert.strictEqual(isValidFaceGeometry(frontalLandmarks, [0.2, 0.2, 0.8, 0.7]), true, "Geometría facial simétrica debe ser válida");

// Caso inválido: ojos invertidos horizontalmente (artefacto de tijera o textura cruzada)
const invertedEyesLandmarks = [
  [0.65, 0.30], // ojo izq a la derecha
  [0.35, 0.30], // ojo der a la izquierda
  [0.50, 0.45],
  [0.38, 0.60],
  [0.62, 0.60]
];
assert.strictEqual(isValidFaceGeometry(invertedEyesLandmarks), false, "Ojos invertidos deben ser rechazados");

// Caso inválido: nariz debajo de la boca (manos o tijeras verticales)
const noseBelowMouth = [
  [0.35, 0.30],
  [0.65, 0.30],
  [0.50, 0.75], // nariz por debajo de la boca
  [0.38, 0.60],
  [0.62, 0.60]
];
assert.strictEqual(isValidFaceGeometry(noseBelowMouth), false, "Nariz debajo de boca debe ser rechazada");

// Caso inválido: boca arriba de los ojos
const mouthAboveEyes = [
  [0.35, 0.50],
  [0.65, 0.50],
  [0.50, 0.40],
  [0.38, 0.20], // boca arriba
  [0.62, 0.20]
];
assert.strictEqual(isValidFaceGeometry(mouthAboveEyes), false, "Boca encima de ojos debe ser rechazada");

// 8. Probar conmutación configurable FACE_DETECTOR=rfb vs scrfd
console.log("\n[8] Probando conmutación configurable FACE_DETECTOR=rfb...");
process.env.FACE_DETECTOR = "rfb";
const rfbDetection = await detectFace(barberImg);
console.log("-> Detección con RFB-320:", { hasFace: rfbDetection.hasFace, confidence: rfbDetection.confidence });
assert.strictEqual(rfbDetection.hasFace, true, "RFB-320 debe detectar el rostro");
assert.ok(rfbDetection.confidence > 0.8, "Confianza RFB debe superar 0.8");

delete process.env.FACE_DETECTOR;
const scrfdDetection = await detectFace(barberImg);
console.log("-> Detección por defecto (SCRFD-500M):", {
  hasFace: scrfdDetection.hasFace,
  confidence: scrfdDetection.confidence,
  landmarks: Boolean(scrfdDetection.landmarks)
});
assert.strictEqual(scrfdDetection.hasFace, true, "SCRFD debe detectar el rostro");
// 9. Probar cálculo de frontalidad continua (computeFrontalityScore)
console.log("\n[9] Probando cálculo de frontalidad continua (computeFrontalityScore)...");
const { computeFrontalityScore, hasTwoEyesVisible } = await import("../src/services/face_quality_service.js");
const frontalScore = computeFrontalityScore(frontalLandmarks, [0.2, 0.2, 0.8, 0.7]);
console.log("-> Score de frontalidad para rostro frontal:", frontalScore);
assert.ok(frontalScore >= 0.70, "Rostro frontal debe tener frontalityScore alto (>= 0.70)");

const profileScore = computeFrontalityScore(leftProfileLandmarks, [0.55, 0.05, 0.70, 0.20]);
console.log("-> Score de frontalidad para perfil:", profileScore);
assert.strictEqual(profileScore, 0, "Perfil extremo debe tener frontalityScore = 0");

// 10. Probar regla maestra de Dos Ojos Mínimo (hasTwoEyesVisible)
console.log("\n[10] Probando regla anatómica hasTwoEyesVisible...");
assert.strictEqual(hasTwoEyesVisible(frontalLandmarks, [0.2, 0.2, 0.8, 0.7], "frontal"), true, "Frontal con landmarks válidos debe tener 2 ojos");
assert.strictEqual(hasTwoEyesVisible(leftProfileLandmarks, [0.55, 0.05, 0.70, 0.20], "profile_left"), false, "Perfil unilateral con landmarks debe ser false");
assert.strictEqual(hasTwoEyesVisible(null, null, "frontal"), false, "Sin landmarks no se certifican 2 ojos (rechazo de manos/nucas)");
assert.strictEqual(hasTwoEyesVisible([], null, "frontal"), false, "Landmarks vacíos debe ser false");
assert.strictEqual(hasTwoEyesVisible(null, null, "profile_left"), false, "Perfil unilateral sin landmarks debe ser false");
console.log("-> hasTwoEyesVisible validada exitosamente para landmarks anatómicos estrictos.");

console.log("\n🎉 ¡Todos los tests de Face Quality, Nitidez y Estimación de Pose pasaron exitosamente!");


