import assert from "assert";
import fs from "fs";
import sharp from "sharp";
import { detectFace, computeSharpness, evaluateFaceQuality } from "../src/services/face_quality_service.js";

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

console.log("\n🎉 ¡Todos los tests de Face Quality y Nitidez pasaron exitosamente!");
