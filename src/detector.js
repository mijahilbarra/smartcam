/**
 * Módulo Detector de Visión por Computadora (ONNX Runtime + YOLOv8)
 * Gestiona la carga de la red neuronal, pre/postprocesamiento con Sharp,
 * supresión de no-máximos y extracción de recortes de personas.
 * 
 * Re-exporta primitivas de geometría y reglas de barbería para compatibilidad total.
 */

import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Re-exportar dominio geométrico
export {
  toPointTuple,
  toPointObject,
  boxNormToPolygonNorm,
  polygonNormToBoundingBoxNorm,
  isPointInPolygon,
  isPointInsideZone,
  calculateIoU,
  applyNMS
} from "./core/geometry.js";

// Re-exportar sanitizador para Firestore
export { sanitizeForFirestore } from "./infrastructure/firebase/firestore_sanitizer.js";

// Re-exportar reglas de la barbería
export {
  BARBERSHOP_QUADRANTS,
  doesDetectionOverlapZone,
  mapDetectionsToBarbershopQuadrants,
  inferZoneType,
  isTransitZone,
  isChairZone,
  isServiceChair
} from "./core/barbershop_rules.js";

import {
  toPointTuple,
  toPointObject,
  boxNormToPolygonNorm,
  applyNMS
} from "./core/geometry.js";

import {
  BARBERSHOP_QUADRANTS,
  mapDetectionsToBarbershopQuadrants,
  isTransitZone,
  isChairZone
} from "./core/barbershop_rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

sharp.cache(false);

const DEFAULT_MODEL = fs.existsSync(path.join(__dirname, "models", "yolov8n.onnx"))
  ? path.join(__dirname, "models", "yolov8n.onnx")
  : path.join(__dirname, "models", "yolov8s.onnx");

const MODEL_PATH = process.env.ML_MODEL_PATH || DEFAULT_MODEL;

// Clases de interés COCO
const COCO_CLASSES = {
  0: "person",
  2: "car",
  24: "backpack",
  56: "chair",
  62: "tv",
  67: "cell phone"
};

let dynamicQuadrants = null;

/**
 * Actualiza los cuadrantes en memoria en tiempo real (Single Source of Truth)
 * @param {Array|Object} newQuadrants
 */
export function setCustomQuadrants(newQuadrants) {
  if (newQuadrants === null || newQuadrants === undefined) return;
  const list = Array.isArray(newQuadrants) ? newQuadrants : Object.values(newQuadrants);
  const map = {};
  for (const rawQ of list) {
    if (rawQ && rawQ.id) {
      const q = { ...rawQ };
      if (q.polygonNorm && Array.isArray(q.polygonNorm)) {
        q.polygonNorm = q.polygonNorm.map(toPointObject);
      } else if (q.boxNorm && Array.isArray(q.boxNorm) && q.boxNorm.length === 4) {
        q.polygonNorm = boxNormToPolygonNorm(q.boxNorm);
      }
      map[q.id] = q;
    }
  }
  dynamicQuadrants = map;
  const count = Object.keys(dynamicQuadrants).length;
  if (count === 0) {
    console.log(`[Detector] Cuadrantes actualizados: 0 zonas configuradas. Se requiere calibración inicial desde el Calibrador Visual.`);
  } else {
    console.log(`[Detector] Cuadrantes actualizados dinámicamente (${count}): ${Object.keys(dynamicQuadrants).join(", ")}`);
  }
}

export function getActiveQuadrants() {
  return dynamicQuadrants !== null ? dynamicQuadrants : {};
}

export function getDefaultQuadrantsArray() {
  return [];
}

let inferenceSession = null;
let lastFrameThumbnail = null;
let lastDetectionResult = null;

/**
 * Compara el fotograma contra el anterior usando un thumbnail escala de grises de 64x36 (~2ms)
 * @param {Buffer} imageBuffer
 * @param {number} thresholdPercent
 * @returns {Promise<{hasChanged: boolean, diffPercent: number}>}
 */
export async function checkFrameDifference(imageBuffer, thresholdPercent = 2.5) {
  const { data } = await sharp(imageBuffer)
    .resize(64, 36, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!lastFrameThumbnail) {
    lastFrameThumbnail = data;
    return { hasChanged: true, diffPercent: 100 };
  }

  let totalDiff = 0;
  const len = data.length;
  for (let i = 0; i < len; i++) {
    totalDiff += Math.abs(data[i] - lastFrameThumbnail[i]);
  }

  const maxPossibleDiff = len * 255;
  const diffPercent = (totalDiff / maxPossibleDiff) * 100;
  const hasChanged = diffPercent >= thresholdPercent;

  if (hasChanged) {
    lastFrameThumbnail = data;
  }

  return { hasChanged, diffPercent: Number(diffPercent.toFixed(2)) };
}

/**
 * Obtiene o inicializa la sesión ONNX (limitada a 1 hilo para mantener uso de CPU < 20%)
 */
export async function getInferenceSession() {
  if (!inferenceSession) {
    console.log(`[Detector] Cargando modelo ONNX desde: ${MODEL_PATH}...`);
    const t0 = Date.now();
    inferenceSession = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "basic",
      intraOpNumThreads: 1,
      interOpNumThreads: 1
    });
    console.log(`[Detector] Modelo ONNX inicializado en ${Date.now() - t0} ms (1 hilo CPU).`);
  }
  return inferenceSession;
}

/**
 * Preprocesa el buffer a tensor CHW Float32Array [1, 3, 640, 640]
 */
async function preprocessImage(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const origWidth = meta.width;
  const origHeight = meta.height;

  const { data } = await sharp(imageBuffer)
    .resize(640, 640, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floatData = new Float32Array(3 * 640 * 640);
  const channelSize = 640 * 640;

  for (let i = 0; i < channelSize; i++) {
    floatData[i] = data[i * 3] / 255.0;                   // R
    floatData[channelSize + i] = data[i * 3 + 1] / 255.0;   // G
    floatData[2 * channelSize + i] = data[i * 3 + 2] / 255.0; // B
  }

  const tensor = new ort.Tensor("float32", floatData, [1, 3, 640, 640]);
  return { tensor, origWidth, origHeight };
}

/**
 * Genera una imagen con anotaciones SVG sobre el JPEG
 */
export async function generateAnnotatedImage(imageBuffer, quadrants, width, height) {
  let svgOverlays = "";
  const occupiedYSlots = [];

  for (const q of quadrants) {
    const [x1, y1, x2, y2] = q.box;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    const color = q.color || "#00FF00";
    const label = q.label;

    if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3) {
      const pts = q.polygonNorm.map(p => {
        const [px, py] = toPointTuple(p);
        return `${Math.round(px * width)},${Math.round(py * height)}`;
      }).join(" ");
      svgOverlays += `<polygon points="${pts}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="3" stroke-linejoin="round" />`;
    } else {
      svgOverlays += `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="${color}" fill-opacity="0.20" stroke="${color}" stroke-width="3" rx="4" />`;
    }

    const badgeW = Math.max(130, label.length * 9 + 18);
    const badgeH = 24;
    let badgeY = Math.max(4, y1 - badgeH - 3);

    const collides = occupiedYSlots.some(slot => 
      Math.abs(slot.x - x1) < 160 && Math.abs(slot.y - badgeY) < 28
    );

    if (collides || q.id === "cliente_sentado") {
      badgeY = y1 + 8;
    }

    occupiedYSlots.push({ x: x1, y: badgeY });

    svgOverlays += `
      <rect x="${x1}" y="${badgeY}" width="${badgeW}" height="${badgeH}" fill="${color}" rx="3" />
      <text x="${x1 + 8}" y="${badgeY + 17}" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="bold" fill="#000000">${label}</text>
    `;
  }

  const svgBuffer = Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${svgOverlays}
    </svg>
  `);

  const annotatedBuffer = await sharp(imageBuffer)
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return annotatedBuffer;
}

/**
 * Pipeline principal de inferencia visual con YOLOv8
 * @param {Buffer} imageBuffer
 * @param {Object|number} options
 */
export async function detectObjectsAndQuadrants(imageBuffer, options = {}) {
  const confThreshold = typeof options === "number" ? options : (options.confThreshold || 0.52);
  const forceRecheck = typeof options === "object" && options.forceRecheck === true;
  const changeThreshold = typeof options === "object" && options.changeThreshold ? options.changeThreshold : 2.5;
  const shouldAnnotate = typeof options === "object" && options.generateAnnotated !== undefined ? options.generateAnnotated : false;

  // Comparación contra fotograma previo
  const diff = await checkFrameDifference(imageBuffer, changeThreshold);
  if (!forceRecheck && !diff.hasChanged && lastDetectionResult) {
    console.log(`[Detector] Escena estática (variación ${diff.diffPercent}% < umbral ${changeThreshold}%). Reutilizando análisis previo (0% CPU / 0 ms).`);
    return {
      ...lastDetectionResult,
      inferenceMs: 0,
      skippedDueToNoChange: true,
      diffPercent: diff.diffPercent
    };
  }

  const session = await getInferenceSession();
  const { tensor, origWidth, origHeight } = await preprocessImage(imageBuffer);

  const t0 = Date.now();
  const results = await session.run({ images: tensor });
  const inferenceMs = Date.now() - t0;

  const output = results[session.outputNames[0]].data;
  const numClasses = 80;
  const numAnchors = 8400;

  const rawDetections = [];

  for (let a = 0; a < numAnchors; a++) {
    let maxScore = 0;
    let maxClass = -1;

    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * numAnchors + a];
      if (score > maxScore) {
        maxScore = score;
        maxClass = c;
      }
    }

    // Para personas, exigir mínimo 0.52 de confianza para erradicar falsos positivos de siluetas de sillas y sombras
    const targetThreshold = COCO_CLASSES[maxClass] === "person"
      ? Math.max(0.52, confThreshold)
      : confThreshold;

    if (maxScore >= targetThreshold && COCO_CLASSES[maxClass]) {
      const cx = output[0 * numAnchors + a];
      const cy = output[1 * numAnchors + a];
      const w = output[2 * numAnchors + a];
      const h = output[3 * numAnchors + a];

      const scaleX = origWidth / 640;
      const scaleY = origHeight / 640;

      const x1 = Math.max(0, Math.round((cx - w / 2) * scaleX));
      const y1 = Math.max(0, Math.round((cy - h / 2) * scaleY));
      const x2 = Math.min(origWidth, Math.round((cx + w / 2) * scaleX));
      const y2 = Math.min(origHeight, Math.round((cy + h / 2) * scaleY));

      const boxW = x2 - x1;
      const boxH = y2 - y1;

      // Descartar manchas diminutas (<24px ancho o <38px alto) que corresponden a gente a 50m en la calle de enfrente
      if (boxW >= 24 && boxH >= 38) {
        rawDetections.push({
          class: COCO_CLASSES[maxClass],
          classId: maxClass,
          score: Math.round(maxScore * 100) / 100,
          box: [x1, y1, x2, y2]
        });
      }
    }
  }

  // Filtrar detecciones con NMS
  const detections = applyNMS(rawDetections, 0.45);

  // Mapear a cuadrantes de la barbería
  const quadrants = mapDetectionsToBarbershopQuadrants(
    detections,
    origWidth,
    origHeight,
    options.quadrants || getActiveQuadrants()
  );

  // Extraer recortes de personas ÚNICAMENTE si provienen de personas reales dentro de cuadrantes de silla o puesto
  // (Descarta por completo a peatones, transeúntes, áreas de circulación y sillas vacías/disponibles)
  const clientCrops = [];
  const personQuadrants = quadrants.filter(q => {
    if (!q || !q.box || isTransitZone(q)) return false;
    // Si la zona está disponible o despejada, es una silla vacía (no hay persona real)
    if (q.status === "disponible" || q.status === "despejado") return false;

    // Solo cuadrantes de persona real sentada o staff trabajando guiados por su tipo semántico y estado
    const isClientSeated = (q.type === "barber_chair" || q.type === "waiting_chair" || q.category === "cliente") &&
      (q.status === "en_corte" || q.status === "en_espera");
    const isStaffWorking = (q.type === "barber_workstation" || q.category === "personal") &&
      q.status === "en_servicio";

    return isClientSeated || isStaffWorking;
  });

  for (let i = 0; i < personQuadrants.length; i++) {
    const q = personQuadrants[i];
    const isStaffZone = q.type === "barber_workstation" || q.category === "personal";
    const [x1, y1, x2, y2] = q.box;
    const cropW = Math.max(10, Math.min(origWidth - x1, x2 - x1));
    const cropH = Math.max(10, Math.min(origHeight - y1, y2 - y1));

    const cropBuffer = await sharp(imageBuffer)
      .extract({ left: x1, top: y1, width: cropW, height: cropH })
      .jpeg({ quality: 92 })
      .toBuffer();

    clientCrops.push({
      id: isStaffZone ? `staff_${i + 1}` : `client_${i + 1}`,
      role: isStaffZone ? "staff" : "client",
      isStaffHint: isStaffZone,
      zoneId: q.zoneId || q.id,
      zoneType: q.type,
      box: q.box,
      confidence: q.confidence !== undefined ? q.confidence : null,
      status: q.status || (isStaffZone ? "en_servicio" : "en_corte"),
      buffer: cropBuffer
    });
  }

  const annotatedBuffer = shouldAnnotate
    ? await generateAnnotatedImage(imageBuffer, quadrants, origWidth, origHeight)
    : null;

  lastDetectionResult = {
    inferenceMs,
    origWidth,
    origHeight,
    imageDimensions: { width: origWidth, height: origHeight },
    rawDetections: detections,
    quadrants,
    clientCrops,
    annotatedBuffer,
    diffPercent: diff.diffPercent,
    skippedDueToNoChange: false
  };

  return lastDetectionResult;
}
