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

// 2. Probar recorte de espaldas / nuca (test/test-client-1-crop.jpg)
console.log("\n[2] Probando recorte de cliente de espaldas / nuca (test/test-client-1-crop.jpg)...");
const client1Img = fs.readFileSync("test/test-client-1-crop.jpg");
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

console.log("\n🎉 ¡Todos los tests de Face Quality, Nitidez y Estimación de Pose pasaron exitosamente!");
