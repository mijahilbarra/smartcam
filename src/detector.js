import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

sharp.cache(false);

const DEFAULT_MODEL = fs.existsSync(path.join(__dirname, "models", "yolov8n.onnx"))
  ? path.join(__dirname, "models", "yolov8n.onnx")
  : path.join(__dirname, "models", "yolov8s.onnx");

const MODEL_PATH = process.env.ML_MODEL_PATH || DEFAULT_MODEL;

// COCO Class mappings of interest
const COCO_CLASSES = {
  0: "person",
  2: "car",
  24: "backpack",
  56: "chair",
  62: "tv",
  67: "cell phone"
};

// Physical quadrant definitions based on 1024x576 camera view
export const BARBERSHOP_QUADRANTS = {
  puerta_entrada: {
    id: "puerta_entrada",
    name: "Entrada / Pasillo peatonal",
    boxNorm: [0.30, 0.40, 0.88, 0.60], // [ymin, xmin, ymax, xmax]
    type: "walking_zone"
  },
  silla_barbero_puesto1: {
    id: "silla_barbero_puesto1",
    name: "Silla de barbero (Puesto 1)",
    boxNorm: [0.65, 0.80, 1.00, 1.00],
    type: "barber_chair"
  },
  silla_barbero_puesto2: {
    id: "silla_barbero_puesto2",
    name: "Silla de barbero (Frente)",
    boxNorm: [0.80, 0.36, 1.00, 0.67],
    type: "barber_chair"
  },
  silla_espera: {
    id: "silla_espera",
    name: "Silla de espera",
    boxNorm: [0.55, 0.73, 0.92, 0.90],
    type: "waiting_chair"
  },
  zona_barbero: {
    id: "zona_barbero",
    name: "Zona de trabajo de barbero",
    boxNorm: [0.45, 0.65, 0.95, 0.82],
    type: "barber_workstation"
  }
};

let inferenceSession = null;
let lastFrameThumbnail = null;
let lastDetectionResult = null;

/**
 * Calculate image difference against previous frame using a 64x36 grayscale thumbnail (takes ~2ms)
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
 * Initialize or get cached ONNX inference session (capped to 1 thread for max 15-20% CPU)
 */
export async function getInferenceSession() {
  if (!inferenceSession) {
    console.log(`[Detector] Cargando modelo ONNX desde: ${MODEL_PATH}...`);
    const t0 = Date.now();
    inferenceSession = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "basic",
      intraOpNumThreads: 1, // Cap CPU usage to 1 thread (max ~15-20%)
      interOpNumThreads: 1
    });
    console.log(`[Detector] Modelo ONNX inicializado en ${Date.now() - t0} ms (1 hilo CPU).`);
  }
  return inferenceSession;
}

/**
 * Calculate Intersection Over Union (IoU) between two [x1, y1, x2, y2] boxes
 */
function calculateIoU(boxA, boxB) {
  const xA = Math.max(boxA[0], boxB[0]);
  const yA = Math.max(boxA[1], boxB[1]);
  const xB = Math.min(boxA[2], boxB[2]);
  const yB = Math.min(boxA[3], boxB[3]);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const areaA = Math.max(0, boxA[2] - boxA[0]) * Math.max(0, boxA[3] - boxA[1]);
  const areaB = Math.max(0, boxB[2] - boxB[0]) * Math.max(0, boxB[3] - boxB[1]);

  const unionArea = areaA + areaB - interArea;
  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Non-Maximum Suppression (NMS)
 */
function applyNMS(boxes, iouThreshold = 0.45) {
  boxes.sort((a, b) => b.score - a.score);
  const selected = [];
  const active = new Array(boxes.length).fill(true);

  for (let i = 0; i < boxes.length; i++) {
    if (!active[i]) continue;
    selected.push(boxes[i]);
    for (let j = i + 1; j < boxes.length; j++) {
      if (!active[j]) continue;
      if (calculateIoU(boxes[i].box, boxes[j].box) > iouThreshold) {
        active[j] = false;
      }
    }
  }
  return selected;
}

/**
 * Preprocess image buffer with Sharp to CHW Float32Array [1, 3, 640, 640]
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

  const totalPixels = 640 * 640;
  const float32Data = new Float32Array(3 * totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    float32Data[i] = data[i * 3] / 255.0;                     // R
    float32Data[totalPixels + i] = data[i * 3 + 1] / 255.0;     // G
    float32Data[2 * totalPixels + i] = data[i * 3 + 2] / 255.0; // B
  }

  const tensor = new ort.Tensor("float32", float32Data, [1, 3, 640, 640]);
  return { tensor, origWidth, origHeight };
}

/**
 * Classify detected objects into semantic barber shop quadrants
 */
function mapDetectionsToBarbershopQuadrants(detections, width, height) {
  const quadrants = [];

  // Permanent reference quadrants
  const silla1Box = [
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto1.boxNorm[1] * width),
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto1.boxNorm[0] * height),
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto1.boxNorm[3] * width),
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto1.boxNorm[2] * height)
  ];

  const silla2Box = [
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto2.boxNorm[1] * width),
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto2.boxNorm[0] * height),
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto2.boxNorm[3] * width),
    Math.round(BARBERSHOP_QUADRANTS.silla_barbero_puesto2.boxNorm[2] * height)
  ];

  const esperaBox = [
    Math.round(BARBERSHOP_QUADRANTS.silla_espera.boxNorm[1] * width),
    Math.round(BARBERSHOP_QUADRANTS.silla_espera.boxNorm[0] * height),
    Math.round(BARBERSHOP_QUADRANTS.silla_espera.boxNorm[3] * width),
    Math.round(BARBERSHOP_QUADRANTS.silla_espera.boxNorm[2] * height)
  ];

  let silla1Ocupada = false;
  let clienteSilla1Det = null;

  // Evaluate dynamic detections
  for (const det of detections) {
    const [x1, y1, x2, y2] = det.box;
    const cx = (x1 + x2) / (2 * width);
    const cy = (y1 + y2) / (2 * height);

    if (det.class === "person") {
      // Walking person in door / entrance corridor
      if (cx >= 0.35 && cx <= 0.65 && cy <= 0.85) {
        quadrants.push({
          id: "persona_caminando",
          label: "Persona caminando",
          category: "transito",
          color: "#007BFF", // Blue
          confidence: det.score,
          box: [x1, y1, x2, y2],
          status: "en_transito",
          description: "Persona desplazándose por el acceso peatonal"
        });
      }
      // Seated client on chair 1
      else if (cx >= 0.78 && cy >= 0.60) {
        silla1Ocupada = true;
        clienteSilla1Det = det;
      }
      // Barber standing working next to chair
      else if (cx >= 0.65 && cx < 0.80 && cy >= 0.35) {
        quadrants.push({
          id: "barbero_servicio",
          label: "Barbero",
          category: "personal",
          color: "#FF4500", // OrangeRed
          confidence: det.score,
          box: [x1, y1, x2, y2],
          status: "en_servicio",
          description: "Barbero de pie atendiendo puesto"
        });
      }
    } else if (det.class === "cell phone" && cx >= 0.80 && cy >= 0.60) {
      // Cell phone held by client confirms seated customer presence
      silla1Ocupada = true;
    } else if (det.class === "chair") {
      // If chair detection overlaps with silla 1 and score is high
      const iou = calculateIoU(det.box, silla1Box);
      if (iou > 0.40) {
        silla1Ocupada = true;
      }
    }
  }

  // Register Barber Chair 1
  quadrants.push({
    id: "silla_barbero_puesto1",
    label: "Silla de barbero",
    category: "silla_barbero",
    color: "#FFD700", // Gold
    box: silla1Box,
    status: silla1Ocupada ? "ocupada" : "disponible",
    description: "Sillón hidráulico de servicio principal"
  });

  // If client seated detected or chair occupied with human presence
  if (silla1Ocupada) {
    const clientBox = clienteSilla1Det ? clienteSilla1Det.box : [silla1Box[0] + 18, silla1Box[1] + 15, silla1Box[2], silla1Box[3] - 10];
    quadrants.push({
      id: "cliente_sentado",
      label: "Cliente sentado",
      category: "cliente",
      color: "#32DC32", // Green
      confidence: clienteSilla1Det ? clienteSilla1Det.score : 0.85,
      box: clientBox,
      status: "en_corte",
      description: "Cliente sentado en la silla de barbero"
    });
  }

  // Register Barber Chair 2 (Foreground)
  quadrants.push({
    id: "silla_barbero_puesto2",
    label: "Silla de barbero (Frente)",
    category: "silla_barbero",
    color: "#FFD700",
    box: silla2Box,
    status: "disponible",
    description: "Cabezal y sillón de barbero en primer plano"
  });

  // Register Waiting Chair / Bench
  quadrants.push({
    id: "silla_espera",
    label: "Silla de espera",
    category: "silla_espera",
    color: "#D250DC", // Purple
    box: esperaBox,
    status: "disponible",
    description: "Banca para clientes en espera"
  });

  return quadrants;
}

/**
 * Generate annotated image with SVG overlay on top of JPEG using Sharp
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

    // Semi-transparent box fill
    svgOverlays += `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="${color}" fill-opacity="0.20" stroke="${color}" stroke-width="3" rx="4" />`;

    // Text label badge calculation
    const badgeW = Math.max(130, label.length * 9 + 18);
    const badgeH = 24;
    let badgeY = Math.max(4, y1 - badgeH - 3);

    // If another badge is nearby in X and Y, shift this badge inside or down to avoid overlap
    const collides = occupiedYSlots.some(slot => 
      Math.abs(slot.x - x1) < 160 && Math.abs(slot.y - badgeY) < 28
    );

    if (collides || q.id === "cliente_sentado") {
      badgeY = y1 + 8; // Place inside the box
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
 * Main detection pipeline: analyze image buffer with ONNX Runtime YOLOv8
 * Supports frame differencing to bypass ML completely when scene is static.
 */
export async function detectObjectsAndQuadrants(imageBuffer, options = {}) {
  const confThreshold = typeof options === "number" ? options : (options.confThreshold || 0.18);
  const forceRecheck = typeof options === "object" && options.forceRecheck === true;
  const changeThreshold = typeof options === "object" && options.changeThreshold ? options.changeThreshold : 2.5;

  // Frame differencing gate: Compare against previous frame (~2ms)
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

  // Postprocess YOLOv8 output: [1, 84, 8400]
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

    if (maxScore >= confThreshold && COCO_CLASSES[maxClass]) {
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

      rawDetections.push({
        class: COCO_CLASSES[maxClass],
        classId: maxClass,
        score: Math.round(maxScore * 100) / 100,
        box: [x1, y1, x2, y2]
      });
    }
  }

  // Apply NMS
  const detections = applyNMS(rawDetections, 0.45);

  // Map to barber shop quadrants
  const quadrants = mapDetectionsToBarbershopQuadrants(detections, origWidth, origHeight);

  // Generate annotated image
  const annotatedBuffer = await generateAnnotatedImage(imageBuffer, quadrants, origWidth, origHeight);

  lastDetectionResult = {
    inferenceMs,
    imageDimensions: { width: origWidth, height: origHeight },
    rawDetections: detections,
    quadrants,
    annotatedBuffer,
    diffPercent: diff.diffPercent,
    skippedDueToNoChange: false
  };

  return lastDetectionResult;
}
