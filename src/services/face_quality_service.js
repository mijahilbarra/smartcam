/**
 * Servicio de Calidad y Detección de Rostros (Face Quality & Sharpness Service)
 * Incorpora el detector facial ultraligero SCRFD-500M con 5 landmarks (InsightFace)
 * para detección precisa de rostros, orientación geométrica y descarte natural
 * de nucas, orejas, tijeras y manos sin reglas heurísticas arbitrarias.
 * Mantiene compatibilidad y fallback configurable hacia RFB-320 mediante FACE_DETECTOR.
 */

import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const SCRFD_MODEL_PATH = process.env.SCRFD_MODEL_PATH || path.join(PROJECT_ROOT, "src", "models", "scrfd_500m.onnx");
const RFB_MODEL_PATH = process.env.RFB_MODEL_PATH || path.join(PROJECT_ROOT, "src", "models", "version-RFB-320.onnx");

const DEFAULT_DETECTOR = (process.env.FACE_DETECTOR || "scrfd").toLowerCase();

let scrfdSession = null;
let rfbSession = null;
let scrfdAnchors = null;
let priors = null;

const SCRFD_INPUT_SIZE = 640;
const RFB_INPUT_WIDTH = 320;
const RFB_INPUT_HEIGHT = 240;

/**
 * Precalcula y cachea los anchor centers para SCRFD-500M a resolución 640x640 (strides 8, 16, 32).
 * 2 anchors por posición en el grid.
 */
function getScrfdAnchors() {
  if (scrfdAnchors) return scrfdAnchors;
  const strides = [8, 16, 32];
  const anchorsByStride = [];
  for (const stride of strides) {
    const featH = SCRFD_INPUT_SIZE / stride;
    const featW = SCRFD_INPUT_SIZE / stride;
    const count = featH * featW * 2;
    const centers = new Float32Array(count * 2);
    let idx = 0;
    for (let y = 0; y < featH; y++) {
      const cy = y * stride;
      for (let x = 0; x < featW; x++) {
        const cx = x * stride;
        // 2 anchors por celda
        centers[idx * 2] = cx;
        centers[idx * 2 + 1] = cy;
        idx++;
        centers[idx * 2] = cx;
        centers[idx * 2 + 1] = cy;
        idx++;
      }
    }
    anchorsByStride.push({ stride, centers, count });
  }
  scrfdAnchors = anchorsByStride;
  return scrfdAnchors;
}

/**
 * Genera los 4420 anchor priors para el detector RFB-320 (modo legacy)
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
    const h = Math.ceil(RFB_INPUT_HEIGHT / stride);
    const w = Math.ceil(RFB_INPUT_WIDTH / stride);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (const minBox of minBoxes[i]) {
          const cx = (x + 0.5) * stride / RFB_INPUT_WIDTH;
          const cy = (y + 0.5) * stride / RFB_INPUT_HEIGHT;
          const bw = minBox / RFB_INPUT_WIDTH;
          const bh = minBox / RFB_INPUT_HEIGHT;
          generated.push([cx, cy, bw, bh]);
        }
      }
    }
  }
  priors = generated;
  return priors;
}

/**
 * Inicializa o reutiliza la sesión ONNX de SCRFD-500M
 */
export async function getScrfdInferenceSession() {
  if (!scrfdSession) {
    if (!fs.existsSync(SCRFD_MODEL_PATH)) {
      throw new Error(`Modelo SCRFD-500M no encontrado en: ${SCRFD_MODEL_PATH}`);
    }
    scrfdSession = await ort.InferenceSession.create(SCRFD_MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: Number(process.env.ONNX_THREADS) || 1,
      interOpNumThreads: Number(process.env.ONNX_THREADS) || 1,
      enableCpuMemArena: false,
      enableMemPattern: false
    });
  }
  return scrfdSession;
}

/**
 * Inicializa o reutiliza la sesión ONNX de RFB-320
 */
export async function getRfbInferenceSession() {
  if (!rfbSession) {
    if (!fs.existsSync(RFB_MODEL_PATH)) {
      throw new Error(`Modelo RFB-320 no encontrado en: ${RFB_MODEL_PATH}`);
    }
    rfbSession = await ort.InferenceSession.create(RFB_MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "basic",
      intraOpNumThreads: Number(process.env.ONNX_THREADS) || 1,
      interOpNumThreads: Number(process.env.ONNX_THREADS) || 1,
      enableCpuMemArena: false,
      enableMemPattern: false
    });
  }
  return rfbSession;
}

/**
 * Calibra el score crudo de SCRFD preservando la escala suave continua.
 * SCRFD produce probabilidades sigmoidales donde el umbral nominal es 0.50.
 * Esta calibración mapea la certeza de detección a un rango compatible con el pipeline:
 * - rawScore < 0.35 -> confidence < 0.20
 * - rawScore = 0.50 -> confidence = 0.55
 * - rawScore >= 0.70 -> confidence >= 0.90
 * - rawScore >= 0.80 -> confidence >= 0.96
 */
export function calibrateScrfdConfidence(rawScore) {
  const centered = (rawScore - 0.48) * 10;
  const calibrated = 1 / (1 + Math.exp(-centered));
  return Number(calibrated.toFixed(3));
}

/**
 * Algoritmo estándar Non-Maximum Suppression (NMS)
 */
function nms(detections, iouThreshold = 0.40) {
  if (detections.length <= 1) return detections;
  detections.sort((a, b) => b.score - a.score);
  const selected = [];
  const active = new Array(detections.length).fill(true);

  for (let i = 0; i < detections.length; i++) {
    if (!active[i]) continue;
    const best = detections[i];
    selected.push(best);
    const b1 = best.box;
    const area1 = (b1[2] - b1[0]) * (b1[3] - b1[1]);

    for (let j = i + 1; j < detections.length; j++) {
      if (!active[j]) continue;
      const b2 = detections[j].box;
      const xx1 = Math.max(b1[0], b2[0]);
      const yy1 = Math.max(b1[1], b2[1]);
      const xx2 = Math.min(b1[2], b2[2]);
      const yy2 = Math.min(b1[3], b2[3]);
      const w = Math.max(0, xx2 - xx1);
      const h = Math.max(0, yy2 - yy1);
      const inter = w * h;
      if (inter > 0) {
        const area2 = (b2[2] - b2[0]) * (b2[3] - b2[1]);
        const iou = inter / (area1 + area2 - inter);
        if (iou > iouThreshold) {
          active[j] = false;
        }
      }
    }
  }
  return selected;
}

/**
 * Valida la consistencia anatómica real de los 5 landmarks faciales:
 * [ojo_izq, ojo_der, nariz, boca_izq, boca_der].
 * Descarta naturalmente falsos positivos en tijeras, manos, orejas y ropa
 * donde los puntos no forman una estructura facial coherente.
 * @param {Array<Array<number>>} landmarks - 5 puntos normalizados [x, y]
 * @param {Array<number>} [boxNorm] - Caja delimitadora normalizada [x1, y1, x2, y2]
 * @returns {boolean}
 */
export function isValidFaceGeometry(landmarks, boxNorm) {
  if (!Array.isArray(landmarks) || landmarks.length !== 5) return false;
  const [leftEye, rightEye, nose, leftMouth, rightMouth] = landmarks;

  // 1. Coherencia horizontal de ojos: el ojo derecho debe estar a la derecha del ojo izquierdo
  // (se permite ligera tolerancia para inclinaciones de cabeza)
  const eyeDx = rightEye[0] - leftEye[0];
  if (eyeDx < -0.02) return false;

  // 2. Coherencia horizontal de comisuras de la boca
  const mouthDx = rightMouth[0] - leftMouth[0];
  if (mouthDx < -0.02) return false;

  // 3. Jerarquía vertical: ojos arriba, nariz al medio, boca abajo
  const yEye = (leftEye[1] + rightEye[1]) / 2;
  const yMouth = (leftMouth[1] + rightMouth[1]) / 2;

  // La boca debe ubicarse debajo de los ojos
  const verticalSpan = yMouth - yEye;
  if (verticalSpan <= 0.005) return false;

  // La nariz debe situarse verticalmente en la franja entre ojos y boca
  if (nose[1] < yEye - 0.03 || nose[1] > yMouth + 0.03) return false;

  // 4. Proporciones relativas al bounding box si está disponible
  if (Array.isArray(boxNorm) && boxNorm.length === 4 && boxNorm.every(v => typeof v === 'number' && v >= 0 && v <= 1.5)) {
    const boxW = boxNorm[2] - boxNorm[0];
    const boxH = boxNorm[3] - boxNorm[1];
    if (boxW <= 0 || boxH <= 0) return false;

    // La distancia vertical ojos-boca debe ser entre el 10% y el 95% de la altura de la caja
    if (verticalSpan < boxH * 0.10 || verticalSpan > boxH * 0.95) return false;

    // La separación entre ojos debe ser entre el 10% y el 110% del ancho de la caja
    const eyeDist = Math.hypot(rightEye[0] - leftEye[0], rightEye[1] - leftEye[1]);
    if (eyeDist < boxW * 0.10 || eyeDist > boxW * 1.10) return false;
  }

  return true;
}

/**
 * Determina anatómicamente si un rostro tiene dos ojos visibles a partir
 * de los 5 landmarks faciales de SCRFD o de la pose estimada como fallback.
 * Evita que perfiles laterales estrictos (1 solo ojo) definan portadas o identidades.
 *
 * @param {Array<Array<number>>|null} landmarks - 5 puntos [leftEye, rightEye, nose, leftMouth, rightMouth]
 * @param {Array<number>|null} [boxNorm] - Bounding box normalizado [x1, y1, x2, y2]
 * @param {string|null} [pose] - Etiqueta de orientación/pose
 * @returns {boolean} True si ambos ojos son visibles y separados anatómicamente
 */
export function hasTwoEyesVisible(landmarks, boxNorm = null, pose = null) {
  if (Array.isArray(landmarks) && landmarks.length === 5 && landmarks.every(p => Array.isArray(p) && p.length >= 2)) {
    if (!isValidFaceGeometry(landmarks, boxNorm)) {
      return false;
    }
    const [leftEye, rightEye, nose] = landmarks;
    const boxW = (Array.isArray(boxNorm) && boxNorm.length === 4 && boxNorm.every(v => typeof v === 'number' && v >= 0 && v <= 1.5) && (boxNorm[2] - boxNorm[0]) > 0)
      ? (boxNorm[2] - boxNorm[0])
      : 1.0;

    const minEyeX = Math.min(leftEye[0], rightEye[0]);
    const maxEyeX = Math.max(leftEye[0], rightEye[0]);
    const eyeSpan = maxEyeX - minEyeX;
    if (eyeSpan < 0.02 * boxW) return false;

    const dxL = Math.abs(nose[0] - leftEye[0]);
    const dxR = Math.abs(rightEye[0] - nose[0]);

    // Verificación anatómica: la nariz DEBE estar horizontalmente entre ambos ojos
    // y ambos ojos deben tener distancia mínima respecto a la nariz.
    // En un perfil estricto de 1 solo ojo (90°), la nariz sobresale fuera del eje o se colapsa contra el ojo lejano.
    const isNoseBetween = (nose[0] > minEyeX + 0.06 * eyeSpan) && (nose[0] < maxEyeX - 0.06 * eyeSpan);
    const hasBothEyesSeparated = (dxL >= 0.06 * eyeSpan) && (dxR >= 0.06 * eyeSpan);

    return isNoseBetween && hasBothEyesSeparated;
  }

  // Sin landmarks anatómicos válidos (5 puntos de ojos, nariz y boca), no es posible certificar la presencia de dos ojos
  return false;
}

/**
 * Detecta rostro mediante el modelo SCRFD-500M con 5 landmarks.
 */
async function detectFaceSCRFD(imageBuffer, minConfidence = 0.80) {
  const session = await getScrfdInferenceSession();
  const meta = await sharp(imageBuffer).metadata();
  if (!meta.width || !meta.height) return { hasFace: false };

  const { data } = await sharp(imageBuffer)
    .resize(SCRFD_INPUT_SIZE, SCRFD_INPUT_SIZE, {
      fit: "contain",
      position: "left top",
      background: { r: 0, g: 0, b: 0 }
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channelSize = SCRFD_INPUT_SIZE * SCRFD_INPUT_SIZE;
  const floatData = new Float32Array(3 * channelSize);
  for (let i = 0; i < channelSize; i++) {
    floatData[i] = (data[i * 3] - 127.5) / 128.0;
    floatData[channelSize + i] = (data[i * 3 + 1] - 127.5) / 128.0;
    floatData[2 * channelSize + i] = (data[i * 3 + 2] - 127.5) / 128.0;
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, SCRFD_INPUT_SIZE, SCRFD_INPUT_SIZE]);
  const results = await session.run({ [session.inputNames[0]]: tensor });

  const imRatio = meta.height / meta.width;
  let newW, newH;
  if (imRatio > 1.0) {
    newH = SCRFD_INPUT_SIZE;
    newW = Math.max(1, Math.round(newH / imRatio));
  } else {
    newW = SCRFD_INPUT_SIZE;
    newH = Math.max(1, Math.round(newW * imRatio));
  }
  const detScale = newH / meta.height;

  const strides = [8, 16, 32];
  const scoreKeys = ["443", "468", "493"];
  const bboxKeys = ["446", "471", "496"];
  const kpsKeys = ["449", "474", "499"];

  const candidates = [];
  const anchorsByStride = getScrfdAnchors();

  for (let s = 0; s < strides.length; s++) {
    const stride = strides[s];
    const scores = results[scoreKeys[s]].data;
    const bboxes = results[bboxKeys[s]].data;
    const kpss = results[kpsKeys[s]].data;
    const { centers, count } = anchorsByStride[s];

    for (let i = 0; i < count; i++) {
      const rawScore = scores[i];
      if (rawScore < 0.35) continue;

      const anchorX = centers[i * 2];
      const anchorY = centers[i * 2 + 1];

      const l = bboxes[i * 4] * stride;
      const t = bboxes[i * 4 + 1] * stride;
      const r = bboxes[i * 4 + 2] * stride;
      const b = bboxes[i * 4 + 3] * stride;

      const x1Px = Math.max(0, Math.min(meta.width, (anchorX - l) / detScale));
      const y1Px = Math.max(0, Math.min(meta.height, (anchorY - t) / detScale));
      const x2Px = Math.max(0, Math.min(meta.width, (anchorX + r) / detScale));
      const y2Px = Math.max(0, Math.min(meta.height, (anchorY + b) / detScale));

      if (x2Px <= x1Px || y2Px <= y1Px) continue;

      const landmarks = [];
      for (let k = 0; k < 5; k++) {
        const kxPx = Math.max(0, Math.min(meta.width, (anchorX + kpss[i * 10 + k * 2] * stride) / detScale));
        const kyPx = Math.max(0, Math.min(meta.height, (anchorY + kpss[i * 10 + k * 2 + 1] * stride) / detScale));
        landmarks.push([kxPx / meta.width, kyPx / meta.height]);
      }

      const boxNorm = [x1Px / meta.width, y1Px / meta.height, x2Px / meta.width, y2Px / meta.height];
      const confidence = calibrateScrfdConfidence(rawScore);

      candidates.push({
        score: confidence,
        rawScore,
        confidence,
        box: [x1Px, y1Px, x2Px, y2Px],
        boxNorm,
        landmarks
      });
    }
  }

  const filtered = nms(candidates, 0.40);

  let bestFace = null;
  for (const c of filtered) {
    if (c.confidence < minConfidence) continue;
    if (!isValidFaceGeometry(c.landmarks, c.boxNorm)) continue;
    if (!bestFace || c.confidence > bestFace.confidence) {
      bestFace = c;
    }
  }

  if (bestFace) {
    return {
      hasFace: true,
      confidence: bestFace.confidence,
      faceBoxNorm: bestFace.boxNorm,
      landmarks: bestFace.landmarks,
      rawScore: Number(bestFace.rawScore.toFixed(4))
    };
  }
  return { hasFace: false };
}

/**
 * Detecta rostro mediante el modelo RFB-320 (modo legacy)
 */
async function detectFaceRFB(imageBuffer, minConfidence = 0.80) {
  const session = await getRfbInferenceSession();
  const pipeline = sharp(imageBuffer);
  const meta = await pipeline.metadata();
  const isPersonBodyCrop = Boolean(meta.width && meta.height && (meta.height > meta.width * 1.12 || meta.height >= 260));

  const { data } = await pipeline
    .resize(RFB_INPUT_WIDTH, RFB_INPUT_HEIGHT, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floatData = new Float32Array(3 * RFB_INPUT_WIDTH * RFB_INPUT_HEIGHT);
  const channelSize = RFB_INPUT_WIDTH * RFB_INPUT_HEIGHT;

  for (let i = 0; i < channelSize; i++) {
    floatData[i] = (data[i * 3] - 127.0) / 128.0;
    floatData[channelSize + i] = (data[i * 3 + 1] - 127.0) / 128.0;
    floatData[2 * channelSize + i] = (data[i * 3 + 2] - 127.0) / 128.0;
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, RFB_INPUT_HEIGHT, RFB_INPUT_WIDTH]);
  const results = await session.run({ input: tensor });

  const scores = results.scores.data;
  const boxes = results.boxes.data;

  let bestFace = null;
  const totalBoxes = Math.floor(scores.length / 2);

  for (let i = 0; i < totalBoxes; i++) {
    const faceScore = scores[i * 2 + 1];
    if (faceScore >= minConfidence && (!bestFace || faceScore > bestFace.confidence)) {
      const x1 = Math.max(0, Math.min(1, boxes[i * 4]));
      const y1 = Math.max(0, Math.min(1, boxes[i * 4 + 1]));
      const x2 = Math.max(0, Math.min(1, boxes[i * 4 + 2]));
      const y2 = Math.max(0, Math.min(1, boxes[i * 4 + 3]));

      if (x2 <= x1 || y2 <= y1) continue;

      if (isPersonBodyCrop) {
        const cy = (y1 + y2) / 2;
        if (cy > 0.56 || y1 > 0.44) {
          continue;
        }
        if (meta.width > meta.height * 1.25 && x1 > 0.65 && y1 > 0.08) {
          continue;
        }
      }

      bestFace = {
        hasFace: true,
        confidence: Number(faceScore.toFixed(3)),
        faceBoxNorm: [x1, y1, x2, y2]
      };
    }
  }

  return bestFace || { hasFace: false };
}

/**
 * Detecta si existe un rostro frontal o semi-perfil en el recorte.
 * Retorna { hasFace: false } si la persona está de espaldas o solo se ve nuca/oreja.
 * @param {Buffer} imageBuffer - Recorte de la persona o fotograma
 * @param {number} minConfidence - Umbral mínimo (por defecto 0.80)
 * @returns {Promise<{ hasFace: boolean, faceBoxNorm?: number[], confidence?: number, landmarks?: Array<Array<number>>, rawScore?: number }>}
 */
export async function detectFace(imageBuffer, minConfidence = 0.80) {
  try {
    const detector = (process.env.FACE_DETECTOR || DEFAULT_DETECTOR).toLowerCase();
    if (detector === "rfb") {
      return await detectFaceRFB(imageBuffer, minConfidence);
    }
    // SCRFD con fallback a RFB si scrfd_500m.onnx no estuviera en disco
    try {
      return await detectFaceSCRFD(imageBuffer, minConfidence);
    } catch (scrfdErr) {
      if (fs.existsSync(RFB_MODEL_PATH)) {
        console.warn("[FaceQuality] SCRFD no disponible, usando fallback RFB-320:", scrfdErr.message);
        return await detectFaceRFB(imageBuffer, minConfidence);
      }
      throw scrfdErr;
    }
  } catch (err) {
    console.warn("[FaceQuality] Error detectando cara:", err.message);
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
 * Calcula un puntaje de frontalidad continuo (0.0 a 1.0) a partir de los 5 landmarks faciales:
 * [ojo_izq, ojo_der, nariz, boca_izq, boca_der].
 * Combina:
 * - Bajo |yaw| (simetría horizontal de la nariz entre ambos ojos)
 * - Ambos ojos claramente visibles con distancia interocular suficiente relativa al ancho de la cara
 * - Distancia no nula de ambos ojos a la nariz (descarta perfiles donde un ojo está oculto)
 * - Pitch moderado (cabeza no excesivamente inclinada arriba/abajo)
 *
 * @param {Array<Array<number>>} landmarks - 5 puntos normalizados [x, y]
 * @param {Array<number>} [boxNorm] - Bounding box normalizado [x1, y1, x2, y2]
 * @param {number} [yawScore] - Yaw precalculado opcional
 * @param {number} [pitchScore] - Pitch precalculado opcional
 * @returns {number} Score continuo entre 0.0 y 1.0
 */
export function computeFrontalityScore(landmarks, boxNorm, yawScore = null, pitchScore = null) {
  if (!Array.isArray(landmarks) || landmarks.length !== 5) return 0;
  const [leftEye, rightEye, nose, leftMouth, rightMouth] = landmarks;

  let boxW = 1.0;
  if (Array.isArray(boxNorm) && boxNorm.length === 4) {
    boxW = Math.max(0.001, boxNorm[2] - boxNorm[0]);
  } else {
    const minX = Math.min(leftEye[0], rightEye[0], nose[0], leftMouth[0], rightMouth[0]);
    const maxX = Math.max(leftEye[0], rightEye[0], nose[0], leftMouth[0], rightMouth[0]);
    boxW = Math.max(0.001, (maxX - minX) * 1.4);
  }

  // 1. Distancia interocular relativa al ancho del rostro
  const eyeDist = Math.hypot(rightEye[0] - leftEye[0], rightEye[1] - leftEye[1]);
  const eyeRatio = eyeDist / boxW;

  // 2. Simetría nasal-ocular horizontal
  const dxL = Math.abs(nose[0] - leftEye[0]);
  const dxR = Math.abs(rightEye[0] - nose[0]);
  const yaw = (yawScore !== null && Number.isFinite(yawScore))
    ? yawScore
    : ((dxL + dxR) > 0 ? (dxL - dxR) / (dxL + dxR) : 0);

  // 3. Posición vertical de nariz respecto a ojos y boca (pitch)
  const yEye = (leftEye[1] + rightEye[1]) / 2;
  const yMouth = (leftMouth[1] + rightMouth[1]) / 2;
  const dTop = nose[1] - yEye;
  const dBottom = yMouth - nose[1];
  const pitch = (pitchScore !== null && Number.isFinite(pitchScore))
    ? pitchScore
    : ((dTop + dBottom) > 0 ? (dTop - dBottom) / (dTop + dBottom) : 0);

  // S_yaw: simetría horizontal, penaliza |yaw| > 0.18 y cae a 0 en 0.40
  const absYaw = Math.abs(yaw);
  const sYaw = Math.max(0, 1 - Math.pow(Math.min(1, absYaw / 0.40), 2));

  // S_span: distancia interocular (frontal normal ~0.30 a 0.45 de ancho de caja). Cae a 0 por debajo de 0.14
  const sSpan = Math.min(1, Math.max(0, (eyeRatio - 0.14) / (0.30 - 0.14)));

  // S_eyes: ambos ojos visibles (cada ojo debe estar a al menos 3.5% del ancho de caja de la nariz)
  const minEyeDxNorm = Math.min(dxL, dxR) / boxW;
  const sEyes = Math.min(1, Math.max(0, (minEyeDxNorm - 0.035) / (0.10 - 0.035)));

  // S_pitch: moderación vertical
  const absPitch = Math.abs(pitch);
  const sPitch = Math.max(0, 1 - Math.pow(Math.min(1, absPitch / 0.55), 2));

  const score = sYaw * sSpan * sEyes * sPitch;
  return Number(score.toFixed(3));
}

/**
 * Estima la orientación/pose facial (yaw y pitch) y calcula el frontalityScore continuo.
 * Prioridad:
 * 1. 5 Landmarks faciales geométricos (SCRFD):
 *    - Yaw: relación de distancia horizontal entre la nariz y cada ojo.
 *    - Pitch: posición vertical de la nariz relativa al eje de ojos y boca.
 * 2. Análisis de gradiente lumínico en faceBuffer (fallback)
 * 3. Vector biométrico embedding (fallback)
 * 4. Centroide de faceBoxNorm (fallback)
 *
 * @param {Object} params
 * @param {Array<Array<number>>} [params.landmarks] - 5 landmarks [ojo_izq, ojo_der, nariz, boca_izq, boca_der]
 * @param {Buffer} [params.faceBuffer] - Buffer de la imagen recortada del rostro
 * @param {Array<number>} [params.faceBoxNorm] - Bounding box normalizada [x1, y1, x2, y2]
 * @param {Array<number>} [params.embedding] - Vector biométrico
 * @returns {Promise<{ pose: string, label: string, yawScore: number, pitchScore: number, frontalityScore: number }>}
 */
export async function estimateFacePose({ landmarks, faceBuffer, faceBoxNorm, embedding } = {}) {
  let yawScore = 0;
  let pitchScore = 0;
  let hasLandmarks = false;

  if (Array.isArray(landmarks) && landmarks.length === 5) {
    hasLandmarks = true;
    const [leftEye, rightEye, nose, leftMouth, rightMouth] = landmarks;
    // Yaw: Relación de distancia horizontal de la nariz a cada ojo
    const dX_L = Math.abs(nose[0] - leftEye[0]);
    const dX_R = Math.abs(rightEye[0] - nose[0]);
    yawScore = (dX_L + dX_R) > 0 ? Number(((dX_L - dX_R) / (dX_L + dX_R)).toFixed(3)) : 0;

    // Pitch: Posición vertical de la nariz relativa al eje de ojos y boca
    const yEye = (leftEye[1] + rightEye[1]) / 2;
    const yMouth = (leftMouth[1] + rightMouth[1]) / 2;
    const dTop = nose[1] - yEye;
    const dBottom = yMouth - nose[1];
    pitchScore = (dTop + dBottom) > 0 ? Number(((dTop - dBottom) / (dTop + dBottom)).toFixed(3)) : 0;
  } else if (faceBuffer && Buffer.isBuffer(faceBuffer)) {
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

  // Recalibración rigurosa de umbrales para evitar que perfiles se disfracen de inclinados:
  let isProfileLeft = false;
  let isProfileRight = false;
  let isSemiLeft = false;
  let isSemiRight = false;

  if (hasLandmarks) {
    const [leftEye, rightEye, nose] = landmarks;
    const minEyeX = Math.min(leftEye[0], rightEye[0]);
    const maxEyeX = Math.max(leftEye[0], rightEye[0]);
    const eyeSpan = maxEyeX - minEyeX;
    const isNoseBetween = (nose[0] > minEyeX + 0.06 * eyeSpan) && (nose[0] < maxEyeX - 0.06 * eyeSpan);

    // Un perfil estricto unilateral solo ocurre con rotación profunda (|yawScore| >= 0.65) o cuando la nariz ya sobresale fuera del rango interocular
    isProfileLeft = yawScore <= -0.65 || (!isNoseBetween && yawScore < 0);
    isProfileRight = yawScore >= 0.65 || (!isNoseBetween && yawScore > 0);
    isSemiLeft = (yawScore <= -0.16 && !isProfileLeft);
    isSemiRight = (yawScore >= 0.16 && !isProfileRight);
  } else {
    isProfileLeft = yawScore <= -0.35;
    isProfileRight = yawScore >= 0.35;
    isSemiLeft = (yawScore <= -0.16 && !isProfileLeft);
    isSemiRight = (yawScore >= 0.16 && !isProfileRight);
  }

  const isUp = pitchScore <= -0.18;
  const isDown = pitchScore >= 0.18;

  let pose = "frontal";
  let label = "Frontal";

  // Jerarquía estricta:
  // 1. Si el ángulo yaw es profundo, es PERFIL (independientemente del pitch: solo se ve medio rostro)
  if (isProfileLeft) {
    pose = "profile_left";
    label = "Perfil Izquierdo";
  } else if (isProfileRight) {
    pose = "profile_right";
    label = "Perfil Derecho";
  } else if (isUp && isSemiLeft) {
    pose = "tilted_up_left";
    label = "Inclinado Arriba Izquierda";
  } else if (isUp && isSemiRight) {
    pose = "tilted_up_right";
    label = "Inclinado Arriba Derecha";
  } else if (isDown && isSemiLeft) {
    pose = "tilted_down_left";
    label = "Inclinado Abajo Izquierda";
  } else if (isDown && isSemiRight) {
    pose = "tilted_down_right";
    label = "Inclinado Abajo Derecha";
  } else if (isSemiLeft) {
    pose = "semi_left";
    label = "Semi-perfil Izquierdo";
  } else if (isSemiRight) {
    pose = "semi_right";
    label = "Semi-perfil Derecho";
  } else if (isDown) {
    pose = "tilted_down";
    label = "Inclinado Abajo";
  } else if (isUp) {
    pose = "tilted_up";
    label = "Inclinado Arriba";
  } else {
    pose = "frontal";
    label = "Frontal";
  }

  const frontalityScore = hasLandmarks
    ? computeFrontalityScore(landmarks, faceBoxNorm, yawScore, pitchScore)
    : (pose === 'frontal' ? 0.85 : (pose.startsWith('semi') ? 0.50 : (pose.startsWith('tilted') ? 0.25 : 0.0)));

  return {
    pose,
    label,
    yawScore,
    pitchScore,
    frontalityScore
  };
}

/**
 * Valida tono de piel y calidez humana
 */
export async function validateHumanSkinAndTexture(faceBuffer) {
  const { data } = await sharp(faceBuffer)
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let innerSkin = 0;
  let innerWarm = 0;
  let innerTotal = 0;

  for (let y = 10; y < 54; y++) {
    for (let x = 10; x < 54; x++) {
      const idx = (y * 64 + x) * 3;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      if (cr >= 131 && cr <= 182 && cb >= 75 && cb <= 138 && r > 40) {
        innerSkin++;
      }
      if (r > g + 5 && g >= b - 12 && r > 40) {
        innerWarm++;
      }
      innerTotal++;
    }
  }

  const skinRatio = innerTotal > 0 ? innerSkin / innerTotal : 0;
  const warmRatio = innerTotal > 0 ? innerWarm / innerTotal : 0;
  const isHumanTexture = !(skinRatio < 0.18 && warmRatio < 0.22);

  return {
    isHumanTexture,
    skinRatio: Number(skinRatio.toFixed(3)),
    warmRatio: Number(warmRatio.toFixed(3))
  };
}

/**
 * Normalización lumínica adaptativa CLAHE
 */
export async function normalizeFaceIllumination(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer)) return buffer;
  try {
    const stats = await sharp(buffer).stats();
    const meanLum = stats.channels.reduce((acc, c) => acc + c.mean, 0) / (stats.channels.length || 1);
    if (meanLum < 55 || meanLum > 200) {
      return await sharp(buffer)
        .clahe({ width: 8, height: 8, maxSlope: 3 })
        .toBuffer();
    }
    return buffer;
  } catch (_) {
    return buffer;
  }
}

/**
 * Evalúa un recorte de persona:
 * 1. Detecta rostro mediante SCRFD-500M con 5 landmarks (o RFB fallback).
 * 2. Si no es rostro o es nuca/espalda/oreja, retorna isValid = false.
 * 3. Valida la consistencia anatómica de los landmarks (descartando deformidades y artefactos).
 * 4. Valida relación de aspecto del rostro (0.55 - 1.45) en píxeles reales.
 * 5. Valida tamaño mínimo (mínimo 48x48 píxeles).
 * 6. Recorta exactamente la cara con margen del 15% y calcula nitidez calibrada.
 * 7. Estima pose/orientación del rostro (frontal, perfil, semi-perfil, inclinaciones).
 * @param {Buffer} personCropBuffer
 * @param {Object} options
 * @returns {Promise<{ isValid: boolean, faceBuffer?: Buffer, faceBoxNorm?: number[], landmarks?: Array<Array<number>>, confidence?: number, sharpnessScore?: number, pose?: string, poseLabel?: string, isFrontalOrSemi?: boolean, yawScore?: number, pitchScore?: number, skinRatio?: number, warmRatio?: number, reason?: string }>}
 */
export async function evaluateFaceQuality(personCropBuffer, options = {}) {
  let normalizedBuffer = personCropBuffer;
  if (options.normalizeIllumination) {
    normalizedBuffer = await normalizeFaceIllumination(personCropBuffer);
  }

  const minConfidence = options.minConfidence || 0.80;
  const minSharpness = options.minSharpness || 28;

  const detection = await detectFace(normalizedBuffer, minConfidence);
  if (!detection.hasFace) {
    return {
      isValid: false,
      reason: "no_face_detected_or_back_of_head"
    };
  }

  // Validación anatómica natural mediante landmarks (sin reglas artificiales de tiempo ni boxTop arbitrario)
  if (detection.landmarks && !isValidFaceGeometry(detection.landmarks, detection.faceBoxNorm)) {
    return {
      isValid: false,
      reason: "non_anatomical_face_position_or_object"
    };
  }

  const [x1Norm, y1Norm, x2Norm, y2Norm] = detection.faceBoxNorm;
  const wNorm = x2Norm - x1Norm;
  const hNorm = y2Norm - y1Norm;
  if (hNorm <= 0 || wNorm <= 0) {
    return { isValid: false, reason: "invalid_face_box" };
  }

  const meta = await sharp(normalizedBuffer).metadata();
  const pxW = wNorm * (meta.width || 1);
  const pxH = hNorm * (meta.height || 1);
  const faceAspect = pxW / pxH;
  if (faceAspect < 0.55 || faceAspect > 1.45) {
    return { isValid: false, reason: "invalid_aspect_ratio" };
  }

  // Recortar la cara exacta con margen del 15%
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

  const faceBuffer = await sharp(normalizedBuffer)
    .extract({ left, top, width, height })
    .jpeg({ quality: 95 })
    .toBuffer();

  const { isHumanTexture, skinRatio, warmRatio } = await validateHumanSkinAndTexture(faceBuffer);
  if (!isHumanTexture) {
    return {
      isValid: false,
      reason: "non_human_or_object_texture",
      skinRatio,
      warmRatio
    };
  }

  // Filtro de textura/pantalla de celular
  try {
    const stats = await sharp(faceBuffer).stats();
    const maxStdev = Math.max(...stats.channels.map(c => c.stdev));
    if (maxStdev > 65 && (skinRatio < 0.28 || warmRatio < 0.28)) {
      return {
        isValid: false,
        reason: "specular_reflection_or_object_screen",
        skinRatio,
        warmRatio
      };
    }
  } catch (_) {}

  const { sharpnessScore, isSharp } = await computeSharpness(faceBuffer, minSharpness);

  const poseData = await estimateFacePose({
    landmarks: detection.landmarks,
    faceBuffer,
    faceBoxNorm: detection.faceBoxNorm
  });

  const validPoses = [
    'frontal',
    'semi_left',
    'semi_right',
    'profile_left',
    'profile_right',
    'tilted_up',
    'tilted_down',
    'tilted_up_left',
    'tilted_up_right',
    'tilted_down_left',
    'tilted_down_right'
  ];
  const isValidPose = validPoses.includes(poseData.pose);
  const isFrontalOrSemi = ['frontal', 'semi_left', 'semi_right', 'tilted_up', 'tilted_up_left', 'tilted_up_right'].includes(poseData.pose);
  const isConfidenceOk = (detection.confidence || 0) >= minConfidence;
  const hasTwoEyes = hasTwoEyesVisible(detection.landmarks, detection.faceBoxNorm, poseData.pose);
  const isAnatomicalFace = hasTwoEyes && isFrontalOrSemi;

  const isValid = isSharp && isValidPose && isConfidenceOk;

  let reason = "ok";
  if (!isSharp) {
    reason = "blurry_face";
  } else if (!isValidPose) {
    reason = "non_frontal_pose_or_back_of_head";
  } else if (!isConfidenceOk) {
    reason = "low_confidence_face";
  }

  return {
    isValid,
    isAnatomicalFace,
    faceBuffer,
    faceBoxNorm: detection.faceBoxNorm,
    landmarks: detection.landmarks,
    confidence: detection.confidence,
    rawScore: detection.rawScore,
    sharpnessScore,
    pose: poseData.pose,
    poseLabel: poseData.label,
    isFrontalOrSemi,
    hasTwoEyes,
    yawScore: poseData.yawScore,
    pitchScore: poseData.pitchScore,
    frontalityScore: poseData.frontalityScore,
    skinRatio,
    warmRatio,
    reason
  };
}
