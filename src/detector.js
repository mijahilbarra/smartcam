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

// Clases de interés COCO (optimizado: detección exclusiva de personas)
const COCO_CLASSES = {
  0: "person"
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
let consecutiveStaticSkips = 0;
const MAX_CONSECUTIVE_STATIC_SKIPS = 5;

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

const PREALLOC_FLOAT_DATA = new Float32Array(3 * 640 * 640);

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
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false
    });
    console.log(`[Detector] Modelo ONNX inicializado en ${Date.now() - t0} ms (1 hilo CPU).`);
  }
  return inferenceSession;
}

/**
 * Preprocesa el buffer a tensor CHW Float32Array [1, 3, 640, 640]
 */
async function preprocessImage(imageBuffer) {
  const pipeline = sharp(imageBuffer);
  const meta = await pipeline.metadata();
  const origWidth = meta.width;
  const origHeight = meta.height;

  const { data } = await pipeline
    .resize(640, 640, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channelSize = 640 * 640;
  const INV_255 = 1.0 / 255.0;

  for (let i = 0; i < channelSize; i++) {
    PREALLOC_FLOAT_DATA[i] = data[i * 3] * INV_255;
    PREALLOC_FLOAT_DATA[channelSize + i] = data[i * 3 + 1] * INV_255;
    PREALLOC_FLOAT_DATA[2 * channelSize + i] = data[i * 3 + 2] * INV_255;
  }

  const tensor = new ort.Tensor("float32", PREALLOC_FLOAT_DATA, [1, 3, 640, 640]);
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

    if (collides || !q.isConfiguredZone) {
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
  const defaultConf = process.env.ML_CONF_THRESHOLD ? parseFloat(process.env.ML_CONF_THRESHOLD) : 0.35;
  const confThreshold = typeof options === "number" ? options : (options.confThreshold !== undefined ? options.confThreshold : defaultConf);
  const forceRecheck = typeof options === "object" && options.forceRecheck === true;
  const isRealtime = typeof options === "object" && options.isRealtime === true;
  const changeThreshold = typeof options === "object" && options.changeThreshold ? options.changeThreshold : (isRealtime ? 1.0 : 2.5);
  const shouldAnnotate = typeof options === "object" && options.generateAnnotated !== undefined ? options.generateAnnotated : false;
  // En modo realtime continuo permitir reutilizar detecciones si la escena está inmóvil (ahorra CPU en e2-micro)
  const skipAllowed = typeof options === "object" && options.skipStatic !== undefined ? options.skipStatic : true;
  const hasHumansInLastResult = (lastDetectionResult?.rawDetections || []).some(d => d.class === "person");
  // Modo centinela: si no hay personas en la escena y la escena está inmóvil, permitir hasta 25 saltos (~30s a 0% CPU)
  // Si hay personas en la escena, permitir hasta 5 saltos para mantener reactividad en el tracking
  const maxSkips = isRealtime
    ? (hasHumansInLastResult ? 5 : 25)
    : MAX_CONSECUTIVE_STATIC_SKIPS;

  // Comparación contra fotograma previo
  const diff = await checkFrameDifference(imageBuffer, changeThreshold);
  const canSkip = !forceRecheck &&
    skipAllowed &&
    !diff.hasChanged &&
    lastDetectionResult &&
    consecutiveStaticSkips < maxSkips;

  if (canSkip) {
    consecutiveStaticSkips++;
    console.log(`[Detector] Escena estática (variación ${diff.diffPercent}% < umbral ${changeThreshold}%). Reutilizando análisis previo (0% CPU / 0 ms) [${consecutiveStaticSkips}/${maxSkips}].`);
    return {
      ...lastDetectionResult,
      inferenceMs: 0,
      skippedDueToNoChange: true,
      diffPercent: diff.diffPercent
    };
  }
  consecutiveStaticSkips = 0;

  const session = await getInferenceSession();
  const { tensor, origWidth, origHeight } = await preprocessImage(imageBuffer);

  const t0 = Date.now();
  const results = await session.run({ images: tensor });
  const inferenceMs = Date.now() - t0;

  const output = results[session.outputNames[0]].data;
  const numAnchors = 8400;
  const targetThreshold = typeof options === "object" && options.confThreshold !== undefined
    ? options.confThreshold
    : Math.min(confThreshold, 0.38);
  const scaleX = origWidth / 640;
  const scaleY = origHeight / 640;
  const rawDetections = [];

  for (let a = 0; a < numAnchors; a++) {
    const score = output[4 * numAnchors + a];
    if (score >= targetThreshold) {
      const cx = output[0 * numAnchors + a];
      const cy = output[1 * numAnchors + a];
      const w = output[2 * numAnchors + a];
      const h = output[3 * numAnchors + a];

      const x1 = Math.max(0, Math.round((cx - w / 2) * scaleX));
      const y1 = Math.max(0, Math.round((cy - h / 2) * scaleY));
      const x2 = Math.min(origWidth, Math.round((cx + w / 2) * scaleX));
      const y2 = Math.min(origHeight, Math.round((cy + h / 2) * scaleY));

      const boxW = x2 - x1;
      const boxH = y2 - y1;

      if (boxW >= 24 && boxH >= 38) {
        rawDetections.push({
          class: "person",
          classId: 0,
          score: Math.round(score * 100) / 100,
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

  // Extraer recortes de personas en zonas donde capturePerson está habilitado o según rol/semántica
  // (Descarta por completo transeúntes en zonas de tránsito y zonas con capturePerson: false)
  const clientCrops = [];
  const personQuadrants = quadrants.filter(q => {
    if (!q || !q.box || q.isConfiguredZone) return false;
    // Si capturePerson está explícitamente desactivado, ignorar
    if (q.capturePerson === false) return false;
    // Si es zona de tránsito y no tiene captura explícita, descartar
    if (isTransitZone(q) && q.capturePerson !== true) return false;
    // Si la zona está disponible o despejada, no hay persona real
    if (q.status === "disponible" || q.status === "despejado") return false;

    // Acepta si capturePerson es true o si coincide con rol semántico de atención/trabajo
    const isClient = q.role === "client" || q.category === "cliente" || q.type === "barber_chair" || q.type === "waiting_chair";
    const isStaff = q.role === "staff" || q.category === "personal" || q.type === "barber_workstation";
    const isVisitor = q.role === "visitor";

    return q.capturePerson === true || isClient || isStaff || isVisitor;
  });

  for (let i = 0; i < personQuadrants.length; i++) {
    const q = personQuadrants[i];
    const isStaffZone = q.role === "staff" || q.type === "barber_workstation" || q.category === "personal";
    const [x1, y1, x2, y2] = q.box;
    const cropW = Math.max(10, Math.min(origWidth - x1, x2 - x1));
    const cropH = Math.max(10, Math.min(origHeight - y1, y2 - y1));

    const cropBuffer = await sharp(imageBuffer)
      .extract({ left: x1, top: y1, width: cropW, height: cropH })
      .jpeg({ quality: 92 })
      .toBuffer();

    const role = q.role || (isStaffZone ? "staff" : "client");

    clientCrops.push({
      id: `${role}_${i + 1}`,
      role: role,
      isStaffHint: role === "staff",
      zoneId: q.zoneId || q.id,
      zoneType: q.type,
      box: q.box,
      confidence: q.confidence !== undefined ? q.confidence : null,
      status: q.status || (role === "staff" ? "en_servicio" : "en_corte"),
      capturePerson: q.capturePerson !== false,
      requiresClearCapture: q.requiresClearCapture === true,
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
