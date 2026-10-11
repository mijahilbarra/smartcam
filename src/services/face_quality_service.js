/**
 * Servicio de Calidad y Detección de Rostros (Face Quality & Sharpness Service)
 * Utiliza el modelo ONNX Ultra-Lightweight (version-RFB-320) para detectar caras frontales
 * y rechazar nucas, orejas y espaldas.
 * Calcula la nitidez (sharpness) mediante análisis de gradiente nativo de Sharp.
 */

import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const RFB_MODEL_PATH = process.env.RFB_MODEL_PATH || path.join(PROJECT_ROOT, "src", "models", "version-RFB-320.onnx");

let rfbSession = null;
let priors = null;

const INPUT_WIDTH = 320;
const INPUT_HEIGHT = 240;

/**
 * Genera los 4420 anchor priors para el detector RFB-320
 */
function generatePriors() {
  if (priors) return priors;
  const strides = [8, 16, 32, 64];
  const minBoxes = [
    [10, 16, 24],
    [32, 48],
    [64, 96],
    [128, 256, 512]
  ];
  const generated = [];
  for (let i = 0; i < strides.length; i++) {
    const stride = strides[i];
    const h = Math.ceil(INPUT_HEIGHT / stride);
    const w = Math.ceil(INPUT_WIDTH / stride);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (const minBox of minBoxes[i]) {
          const cx = (x + 0.5) * stride / INPUT_WIDTH;
          const cy = (y + 0.5) * stride / INPUT_HEIGHT;
          const bw = minBox / INPUT_WIDTH;
          const bh = minBox / INPUT_HEIGHT;
          generated.push([cx, cy, bw, bh]);
        }
      }
    }
  }
  priors = generated;
  return priors;
}

/**
 * Inicializa o reutiliza la sesión ONNX de RFB-320 (limitado a 1 hilo para mantener bajo uso de CPU)
 */
export async function getRfbInferenceSession() {
  if (!rfbSession) {
    if (!fs.existsSync(RFB_MODEL_PATH)) {
      throw new Error(`Modelo RFB-320 no encontrado en: ${RFB_MODEL_PATH}`);
    }
    rfbSession = await ort.InferenceSession.create(RFB_MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "basic",
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false
    });
  }
  return rfbSession;
}

/**
 * Detecta si existe un rostro frontal o semi-perfil en el recorte.
 * Retorna null si la persona está de espaldas o solo se ve nuca/oreja.
 * @param {Buffer} imageBuffer - Recorte de la persona o fotograma
 * @param {number} minConfidence - Umbral mínimo (por defecto 0.70)
 * @returns {Promise<{ hasFace: boolean, faceBoxNorm?: number[], confidence?: number }>}
 */
export async function detectFace(imageBuffer, minConfidence = 0.80) {
  try {
    const session = await getRfbInferenceSession();
    const anchors = generatePriors();

    const { data } = await sharp(imageBuffer)
      .resize(INPUT_WIDTH, INPUT_HEIGHT, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const floatData = new Float32Array(3 * INPUT_WIDTH * INPUT_HEIGHT);
    const channelSize = INPUT_WIDTH * INPUT_HEIGHT;

    for (let i = 0; i < channelSize; i++) {
      floatData[i] = (data[i * 3] - 127.0) / 128.0;
      floatData[channelSize + i] = (data[i * 3 + 1] - 127.0) / 128.0;
      floatData[2 * channelSize + i] = (data[i * 3 + 2] - 127.0) / 128.0;
    }

    const tensor = new ort.Tensor("float32", floatData, [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);
    const results = await session.run({ input: tensor });

    const scores = results.scores.data;
    const boxes = results.boxes.data;

    let bestFace = null;
    const totalPriors = anchors.length;

    for (let i = 0; i < totalPriors; i++) {
      const faceScore = scores[i * 2 + 1];
      if (faceScore >= minConfidence && (!bestFace || faceScore > bestFace.confidence)) {
        const p = anchors[i];
        const bx = boxes[i * 4];
        const by = boxes[i * 4 + 1];
        const bw = boxes[i * 4 + 2];
        const bh = boxes[i * 4 + 3];

        const cx = p[0] + bx * 0.1 * p[2];
        const cy = p[1] + by * 0.1 * p[3];
        const w = p[2] * Math.exp(bw * 0.2);
        const h = p[3] * Math.exp(bh * 0.2);

        const x1 = Math.max(0, cx - w / 2);
        const y1 = Math.max(0, cy - h / 2);
        const x2 = Math.min(1, cx + w / 2);
        const y2 = Math.min(1, cy + h / 2);

        bestFace = {
          hasFace: true,
          confidence: Number(faceScore.toFixed(3)),
          faceBoxNorm: [x1, y1, x2, y2]
        };
      }
    }

    return bestFace || { hasFace: false };
  } catch (err) {
    console.warn("[FaceQuality] Error detectando cara con RFB-320:", err.message);
    return { hasFace: false };
  }
}

/**
 * Calcula el puntaje de nitidez (0 a 100) utilizando la medición de alta frecuencia nativa de Sharp.
 * Utiliza una calibración no lineal continua que evita la saturación artificial al 100% ante texturas de ropa o codos.
 * @param {Buffer} faceBuffer
 * @param {number} minAcceptableScore - Umbral mínimo aceptable (por defecto 40)
 * @returns {Promise<{ sharpnessScore: number, isSharp: boolean }>}
 */
export async function computeSharpness(faceBuffer, minAcceptableScore = 40) {
  try {
    const stats = await sharp(faceBuffer).stats();
    const rawMetric = stats.sharpness || 0;
    // Escala continua suave 0..100 basada en saturación exponencial:
    // rawMetric ~0.25 (borroso) -> ~13
    // rawMetric ~1.2 (aceptable) -> ~48
    // rawMetric ~2.0 (buen rostro) -> ~67
    // rawMetric ~3.5 (muy nítido) -> ~86
    // rawMetric > 6.0 (ultra HD) -> ~97-100
    const sharpnessScore = Math.min(100, Math.max(0, Math.round(100 * (1 - Math.exp(-rawMetric / 1.8)))));
    return {
      sharpnessScore,
      isSharp: sharpnessScore >= minAcceptableScore
    };
  } catch (err) {
    return { sharpnessScore: 0, isSharp: false };
  }
}

/**
 * Estima la orientación/pose facial (yaw y pitch) a partir del faceBuffer, faceBoxNorm o embedding.
 * @param {Object} params
 * @param {Buffer} [params.faceBuffer] - Buffer de la imagen recortada del rostro
 * @param {Array<number>} [params.faceBoxNorm] - Bounding box normalizada [x1, y1, x2, y2]
 * @param {Array<number>} [params.embedding] - Vector biométrico
 * @returns {Promise<{ pose: string, label: string, yawScore: number, pitchScore: number }>}
 */
export async function estimateFacePose({ faceBuffer, faceBoxNorm, embedding } = {}) {
  let yawScore = 0;
  let pitchScore = 0;

  if (faceBuffer && Buffer.isBuffer(faceBuffer)) {
    try {
      const { data } = await sharp(faceBuffer)
        .resize(32, 32, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      let leftLum = 0, rightLum = 0;
      let topLum = 0, bottomLum = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const val = data[y * 32 + x];
          if (x < 16) leftLum += val;
          else rightLum += val;
          if (y < 16) topLum += val;
          else bottomLum += val;
        }
      }
      const count = 16 * 32;
      const leftMean = leftLum / count;
      const rightMean = rightLum / count;
      const topMean = topLum / count;
      const bottomMean = bottomLum / count;

      const avgLumH = (leftMean + rightMean) / 2 || 1;
      const avgLumV = (topMean + bottomMean) / 2 || 1;

      yawScore = Number(((rightMean - leftMean) / avgLumH).toFixed(3));
      pitchScore = Number(((bottomMean - topMean) / avgLumV).toFixed(3));
    } catch (_) {
      yawScore = 0;
      pitchScore = 0;
    }
  } else if (Array.isArray(embedding) && embedding.length >= 4) {
    yawScore = Number(((embedding[1] || 0) - (embedding[0] || 0)).toFixed(3));
    pitchScore = Number(((embedding[2] || 0) - (embedding[3] || 0)).toFixed(3));
  } else if (Array.isArray(faceBoxNorm) && faceBoxNorm.length === 4) {
    const cx = (faceBoxNorm[0] + faceBoxNorm[2]) / 2;
    const cy = (faceBoxNorm[1] + faceBoxNorm[3]) / 2;
    yawScore = Number(((cx - 0.5) * 2).toFixed(3));
    pitchScore = Number(((cy - 0.5) * 2).toFixed(3));
  }

  let pose = "frontal";
  let label = "Frontal";

  if (yawScore <= -0.35) {
    pose = "profile_left";
    label = "Perfil Izquierdo";
  } else if (yawScore <= -0.12) {
    pose = "semi_left";
    label = "Semi-perfil Izquierdo";
  } else if (yawScore >= 0.35) {
    pose = "profile_right";
    label = "Perfil Derecho";
  } else if (yawScore >= 0.12) {
    pose = "semi_right";
    label = "Semi-perfil Derecho";
  } else if (pitchScore >= 0.18) {
    pose = "tilted_down";
    label = "Inclinado Abajo";
  } else if (pitchScore <= -0.18) {
    pose = "tilted_up";
    label = "Inclinado Arriba";
  } else {
    pose = "frontal";
    label = "Frontal";
  }

  return {
    pose,
    label,
    yawScore,
    pitchScore
  };
}

/**
 * Evalúa un recorte de persona:
 * 1. Verifica si tiene rostro frontal (RFB-320 con umbral >= 0.70).
 * 2. Si no es rostro frontal (nuca/espalda/oreja), retorna isValid = false.
 * 3. Valida la relación de aspecto del rostro (0.65 - 1.35) descartando parches de brazos/codos alargados.
 * 4. Valida tamaño mínimo (mínimo 48x48 píxeles).
 * 5. Si tiene rostro, recorta exactamente la cara con margen y calcula nitidez calibrada.
 * 6. Estima pose/orientación del rostro (frontal, perfil, semi-perfil, inclinaciones).
 * @param {Buffer} personCropBuffer
 * @param {Object} options
 * @returns {Promise<{ isValid: boolean, faceBuffer?: Buffer, faceBoxNorm?: number[], confidence?: number, sharpnessScore?: number, pose?: string, poseLabel?: string, yawScore?: number, pitchScore?: number, reason?: string }>}
 */
export async function evaluateFaceQuality(personCropBuffer, options = {}) {
  const minConfidence = options.minConfidence || 0.80;
  const minSharpness = options.minSharpness || 40;

  const detection = await detectFace(personCropBuffer, minConfidence);
  if (!detection.hasFace) {
    return {
      isValid: false,
      reason: "no_face_detected_or_back_of_head"
    };
  }

  // Validar relación de aspecto del rostro detectado (un rostro humano tiene aspect ratio cercano a 0.75 - 1.25)
  // Rechaza parches alargados de brazos, codos o pliegues
  const [x1Norm, y1Norm, x2Norm, y2Norm] = detection.faceBoxNorm;
  const wNorm = x2Norm - x1Norm;
  const hNorm = y2Norm - y1Norm;
  if (hNorm <= 0 || wNorm <= 0) {
    return { isValid: false, reason: "invalid_face_box" };
  }
  const faceAspect = wNorm / hNorm;
  if (faceAspect < 0.65 || faceAspect > 1.35) {
    return { isValid: false, reason: "invalid_aspect_ratio" };
  }

  // Recortar la cara exacta con margen del 15%
  const meta = await sharp(personCropBuffer).metadata();
  const marginX = wNorm * 0.15;
  const marginY = hNorm * 0.15;

  const left = Math.max(0, Math.round((x1Norm - marginX) * meta.width));
  const top = Math.max(0, Math.round((y1Norm - marginY) * meta.height));
  const width = Math.min(meta.width - left, Math.round((wNorm + marginX * 2) * meta.width));
  const height = Math.min(meta.height - top, Math.round((hNorm + marginY * 2) * meta.height));

  // Exigir tamaño mínimo de rostro de al menos 48x48 píxeles
  if (width < 48 || height < 48) {
    return { isValid: false, reason: "face_too_small" };
  }

  const faceBuffer = await sharp(personCropBuffer)
    .extract({ left, top, width, height })
    .jpeg({ quality: 95 })
    .toBuffer();

  const { sharpnessScore, isSharp } = await computeSharpness(faceBuffer, minSharpness);

  const poseData = await estimateFacePose({
    faceBuffer,
    faceBoxNorm: detection.faceBoxNorm
  });

  const validPoses = ['frontal', 'semi_left', 'semi_right'];
  const isFrontalOrSemi = validPoses.includes(poseData.pose);
  const isConfidenceOk = (detection.confidence || 0) >= minConfidence;

  // Si la pose no es frontal o semi-perfil válida, o la nitidez es insuficiente, o la confianza es baja:
  const isValid = isSharp && isFrontalOrSemi && isConfidenceOk;

  let reason = "ok";
  if (!isSharp) {
    reason = "blurry_face";
  } else if (!isFrontalOrSemi) {
    reason = "non_frontal_pose_or_back_of_head";
  } else if (!isConfidenceOk) {
    reason = "low_confidence_face";
  }

  return {
    isValid,
    faceBuffer,
    faceBoxNorm: detection.faceBoxNorm,
    confidence: detection.confidence,
    sharpnessScore,
    pose: poseData.pose,
    poseLabel: poseData.label,
    isFrontalOrSemi,
    yawScore: poseData.yawScore,
    pitchScore: poseData.pitchScore,
    reason
  };
}
