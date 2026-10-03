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

// Helper to convert vertex representations (array [x,y] or object {x,y}) to [x, y]
export function toPointTuple(p) {
  if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
  if (p && typeof p === "object") return [Number(p.x ?? 0), Number(p.y ?? 0)];
  return [0, 0];
}

// Helper to convert [ymin, xmin, ymax, xmax] to polygon vertices [[x,y], ...]
export function boxNormToPolygonNorm([ymin, xmin, ymax, xmax]) {
  return [
    [xmin, ymin], // P0: Top-Left
    [xmax, ymin], // P1: Top-Right
    [xmax, ymax], // P2: Bottom-Right
    [xmin, ymax]  // P3: Bottom-Left
  ];
}

export function polygonNormToBoundingBoxNorm(polygon) {
  const xs = polygon.map(p => toPointTuple(p)[0]);
  const ys = polygon.map(p => toPointTuple(p)[1]);
  return [
    Math.min(...ys),
    Math.min(...xs),
    Math.max(...ys),
    Math.max(...xs)
  ];
}

/**
 * Ray-casting algorithm to test if point [px, py] is inside a polygon [[x,y], ...] or [{x,y}, ...]
 */
export function isPointInPolygon([px, py], polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = toPointTuple(polygon[i]);
    const [xj, yj] = toPointTuple(polygon[j]);
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointInsideZone(cx, cy, zone) {
  if (!zone) return false;
  if (zone.polygonNorm && Array.isArray(zone.polygonNorm) && zone.polygonNorm.length >= 3) {
    return isPointInPolygon([cx, cy], zone.polygonNorm);
  }
  if (zone.boxNorm && Array.isArray(zone.boxNorm) && zone.boxNorm.length === 4) {
    return cy >= zone.boxNorm[0] && cx >= zone.boxNorm[1] && cy <= zone.boxNorm[2] && cx <= zone.boxNorm[3];
  }
  return false;
}

// Physical quadrant definitions based on 1024x576 camera view
export const BARBERSHOP_QUADRANTS = {
  puerta_entrada: {
    id: "puerta_entrada",
    name: "Entrada / Pasillo peatonal",
    boxNorm: [0.30, 0.40, 0.88, 0.60], // [ymin, xmin, ymax, xmax]
    polygonNorm: [{ x: 0.40, y: 0.30 }, { x: 0.60, y: 0.30 }, { x: 0.60, y: 0.88 }, { x: 0.40, y: 0.88 }],
    type: "walking_zone",
    color: "#007BFF"
  },
  silla_barbero_puesto1: {
    id: "silla_barbero_puesto1",
    name: "Silla de barbero (Puesto 1)",
    boxNorm: [0.65, 0.80, 1.00, 1.00],
    polygonNorm: [{ x: 0.80, y: 0.65 }, { x: 1.00, y: 0.65 }, { x: 1.00, y: 1.00 }, { x: 0.80, y: 1.00 }],
    type: "barber_chair",
    color: "#FFD700"
  },
  silla_barbero_puesto2: {
    id: "silla_barbero_puesto2",
    name: "Silla de barbero (Frente)",
    boxNorm: [0.80, 0.36, 1.00, 0.67],
    polygonNorm: [{ x: 0.36, y: 0.80 }, { x: 0.67, y: 0.80 }, { x: 0.67, y: 1.00 }, { x: 0.36, y: 1.00 }],
    type: "barber_chair",
    color: "#FFD700"
  },
  silla_espera: {
    id: "silla_espera",
    name: "Silla de espera",
    boxNorm: [0.55, 0.73, 0.92, 0.90],
    polygonNorm: [{ x: 0.73, y: 0.55 }, { x: 0.90, y: 0.55 }, { x: 0.90, y: 0.92 }, { x: 0.73, y: 0.92 }],
    type: "waiting_chair",
    color: "#D250DC"
  },
  zona_barbero: {
    id: "zona_barbero",
    name: "Zona de trabajo de barbero",
    boxNorm: [0.45, 0.65, 0.95, 0.82],
    polygonNorm: [{ x: 0.65, y: 0.45 }, { x: 0.82, y: 0.45 }, { x: 0.82, y: 0.95 }, { x: 0.65, y: 0.95 }],
    type: "barber_workstation",
    color: "#FF4500"
  }
};

let dynamicQuadrants = { ...BARBERSHOP_QUADRANTS };

/**
 * Update dynamic quadrants in memory (received from Firestore: camera_catcher/quadrants)
 */
export function setCustomQuadrants(newQuadrants) {
  if (!newQuadrants) return;
  const list = Array.isArray(newQuadrants) ? newQuadrants : Object.values(newQuadrants);
  const map = {};
  for (const rawQ of list) {
    if (rawQ && rawQ.id) {
      const q = { ...rawQ };
      if (q.polygonNorm && Array.isArray(q.polygonNorm)) {
        q.polygonNorm = q.polygonNorm.map(toPointTuple);
      } else if (q.boxNorm && Array.isArray(q.boxNorm) && q.boxNorm.length === 4) {
        q.polygonNorm = boxNormToPolygonNorm(q.boxNorm);
      }
      map[q.id] = q;
    }
  }
  dynamicQuadrants = map;
  console.log(`[Detector] Cuadrantes actualizados dinámicamente (${Object.keys(dynamicQuadrants).length}): ${Object.keys(dynamicQuadrants).join(", ")}`);
}

export function getActiveQuadrants() {
  return dynamicQuadrants || BARBERSHOP_QUADRANTS;
}

export function getDefaultQuadrantsArray() {
  return Object.values(BARBERSHOP_QUADRANTS);
}

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
 * Evaluates whether a normalized point (cx, cy) is within a boxNorm [ymin, xmin, ymax, xmax]
 */
function isPointInNormBox(cx, cy, boxNorm) {
  if (!boxNorm || boxNorm.length < 4) return false;
  return cy >= boxNorm[0] && cx >= boxNorm[1] && cy <= boxNorm[2] && cx <= boxNorm[3];
}

/**
 * Test whether a detection bounding box [x1, y1, x2, y2] intersects or falls into a semantic zone
 */
export function doesDetectionOverlapZone(detBox, zone, width, height) {
  if (!detBox || !zone || !width || !height) return false;
  const [x1, y1, x2, y2] = detBox;

  // Multi-point sampling across the bounding box (head/torso/center/hips/sides)
  const samples = [
    [(x1 + x2) / (2 * width), (y1 + y2) / (2 * height)],              // Geometric center
    [(x1 * 0.75 + x2 * 0.25) / width, (y1 + y2) / (2 * height)],        // Left-center
    [(x1 * 0.25 + x2 * 0.75) / width, (y1 + y2) / (2 * height)],        // Right-center
    [(x1 + x2) / (2 * width), (y1 * 0.60 + y2 * 0.40) / height],        // Torso-center
    [(x1 * 0.75 + x2 * 0.25) / width, (y1 * 0.60 + y2 * 0.40) / height],// Torso-left
    [(x1 * 0.25 + x2 * 0.75) / width, (y1 * 0.60 + y2 * 0.40) / height],// Torso-right
    [(x1 + x2) / (2 * width), (y1 * 0.25 + y2 * 0.75) / height]         // Base / lower body
  ];

  if (samples.some(([px, py]) => isPointInsideZone(px, py, zone))) {
    return true;
  }

  // Also check bounding box IoU if zone has boxNorm or polygonNorm
  let bNorm = zone.boxNorm;
  if (!bNorm && zone.polygonNorm && zone.polygonNorm.length >= 3) {
    bNorm = polygonNormToBoundingBoxNorm(zone.polygonNorm);
  }
  if (bNorm && bNorm.length === 4) {
    const zonePixelBox = [
      Math.round(bNorm[1] * width),
      Math.round(bNorm[0] * height),
      Math.round(bNorm[3] * width),
      Math.round(bNorm[2] * height)
    ];
    if (calculateIoU(detBox, zonePixelBox) > 0.25) {
      return true;
    }
  }

  return false;
}

/**
 * Classify detected objects into semantic barber shop quadrants dynamically.
 * Iterates through all zones configured by the user, respecting custom polygons,
 * types, names, additions, and deletions.
 */
export function mapDetectionsToBarbershopQuadrants(detections, width, height, customQuadrants = null) {
  const quadrants = [];
  const activeCfg = customQuadrants || getActiveQuadrants();

  let configuredZones = [];
  if (Array.isArray(activeCfg)) {
    configuredZones = activeCfg;
  } else if (activeCfg && typeof activeCfg === "object") {
    configuredZones = Object.values(activeCfg);
  }

  // Fallback to default quadrants if no zones are configured
  if (!configuredZones || configuredZones.length === 0) {
    configuredZones = Object.values(BARBERSHOP_QUADRANTS);
  }

  // Normalize each zone (polygonNorm points, boxNorm)
  const normalizedZones = configuredZones.filter(z => z && z.id).map(rawZ => {
    const z = { ...rawZ };
    if (z.polygonNorm && Array.isArray(z.polygonNorm) && z.polygonNorm.length >= 3) {
      z.polygonNorm = z.polygonNorm.map(toPointTuple);
    } else if (z.boxNorm && Array.isArray(z.boxNorm) && z.boxNorm.length === 4) {
      z.polygonNorm = boxNormToPolygonNorm(z.boxNorm);
    }
    if (!z.boxNorm && z.polygonNorm) {
      z.boxNorm = polygonNormToBoundingBoxNorm(z.polygonNorm);
    }
    return z;
  });

  const matchedPersonIndices = new Set();

  for (const zone of normalizedZones) {
    const bNorm = zone.boxNorm || [0, 0, 1, 1];
    const zonePixelBox = [
      Math.round(bNorm[1] * width),
      Math.round(bNorm[0] * height),
      Math.round(bNorm[3] * width),
      Math.round(bNorm[2] * height)
    ];

    // Find detections inside this zone
    const matchingPersonDets = [];
    const matchingPhoneDets = [];
    const matchingChairDets = [];

    detections.forEach((det, idx) => {
      if (det.class === "person" && doesDetectionOverlapZone(det.box, zone, width, height)) {
        matchingPersonDets.push(det);
        matchedPersonIndices.add(idx);
      } else if (det.class === "cell phone" && doesDetectionOverlapZone(det.box, zone, width, height)) {
        matchingPhoneDets.push(det);
      } else if (det.class === "chair" && calculateIoU(det.box, zonePixelBox) > 0.35) {
        matchingChairDets.push(det);
      }
    });

    const zoneType = zone.type || "custom_zone";
    const zoneColor = zone.color || "#007BFF";

    switch (zoneType) {
      case "barber_chair": {
        const isOccupied = matchingPersonDets.length > 0 || matchingPhoneDets.length > 0 || matchingChairDets.length > 0;
        const primaryPerson = matchingPersonDets[0];

        // Register the chair quadrant itself
        quadrants.push({
          id: zone.id,
          label: zone.name || zone.id,
          category: "silla_barbero",
          type: "barber_chair",
          color: zoneColor,
          box: zonePixelBox,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          description: isOccupied ? `Sillón de barbero ocupado en corte` : `Sillón de barbero disponible`
        });

        // If occupied, add the seated client occupant
        if (isOccupied) {
          const clientBox = primaryPerson ? primaryPerson.box : [zonePixelBox[0] + 15, zonePixelBox[1] + 10, zonePixelBox[2] - 15, zonePixelBox[3] - 10];
          quadrants.push({
            id: `cliente_sentado_${zone.id}`,
            zoneId: zone.id,
            label: `Cliente sentado (${zone.name || "Silla"})`,
            category: "cliente",
            color: "#32DC32", // Green
            confidence: primaryPerson ? primaryPerson.score : 0.85,
            box: clientBox,
            status: "en_corte",
            description: `Cliente sentado recibiendo servicio en ${zone.name || zone.id}`
          });
        }
        break;
      }

      case "barber_workstation": {
        const isWorking = matchingPersonDets.length > 0;
        if (isWorking) {
          // Register the active barber staff
          const barberDet = matchingPersonDets[0];
          quadrants.push({
            id: `barbero_${zone.id}`,
            zoneId: zone.id,
            label: zone.name || "Barbero",
            category: "personal",
            type: "barber_workstation",
            color: zoneColor || "#FF4500",
            confidence: barberDet.score,
            box: barberDet.box,
            polygonNorm: zone.polygonNorm,
            status: "en_servicio",
            description: `Barbero / Personal activo atendiendo en ${zone.name}`
          });
        } else {
          // Register available workstation
          quadrants.push({
            id: zone.id,
            label: zone.name || zone.id,
            category: "personal",
            type: "barber_workstation",
            color: zoneColor || "#FF4500",
            box: zonePixelBox,
            polygonNorm: zone.polygonNorm,
            status: "disponible",
            description: `Puesto de barbero libre`
          });
        }
        break;
      }

      case "waiting_chair": {
        const isOccupied = matchingPersonDets.length > 0;
        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `cliente_espera_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: `Cliente en espera (${zone.name})`,
              category: "cliente",
              color: "#D250DC",
              confidence: pDet.score,
              box: pDet.box,
              status: "en_espera",
              description: `Cliente esperando turno en ${zone.name}`
            });
          });
        }
        quadrants.push({
          id: zone.id,
          label: zone.name || zone.id,
          category: "silla_espera",
          type: "waiting_chair",
          color: zoneColor || "#D250DC",
          box: zonePixelBox,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          description: isOccupied ? `Banca de espera ocupada (${matchingPersonDets.length})` : `Banca de espera disponible`
        });
        break;
      }

      case "walking_zone": {
        if (matchingPersonDets.length > 0) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `transito_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: `Tránsito en ${zone.name}`,
              category: "transito",
              type: "walking_zone",
              color: zoneColor || "#007BFF",
              confidence: pDet.score,
              box: pDet.box,
              polygonNorm: zone.polygonNorm,
              status: "en_transito",
              description: `Persona en tránsito por ${zone.name}`
            });
          });
        } else {
          quadrants.push({
            id: zone.id,
            label: zone.name || zone.id,
            category: "transito",
            type: "walking_zone",
            color: zoneColor || "#007BFF",
            box: zonePixelBox,
            polygonNorm: zone.polygonNorm,
            status: "despejado",
            description: `Zona peatonal despejada`
          });
        }
        break;
      }

      default: {
        // Custom or generic zone
        const isOccupied = matchingPersonDets.length > 0;
        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `persona_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: `Presencia en ${zone.name}`,
              category: zone.category || "custom",
              type: zoneType,
              color: zoneColor || "#10B981",
              confidence: pDet.score,
              box: pDet.box,
              status: "ocupada",
              description: `Persona detectada en ${zone.name}`
            });
          });
        }
        quadrants.push({
          id: zone.id,
          label: zone.name || zone.id,
          category: zone.category || "custom",
          type: zoneType,
          color: zoneColor || "#10B981",
          box: zonePixelBox,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          description: isOccupied ? `Zona ${zone.name} ocupada` : `Zona ${zone.name} disponible`
        });
        break;
      }
    }
  }

  // Any detected person outside all defined zones
  detections.forEach((det, idx) => {
    if (det.class === "person" && !matchedPersonIndices.has(idx)) {
      quadrants.push({
        id: `persona_sin_zona_${idx + 1}`,
        label: "Persona fuera de zonas",
        category: "otro",
        color: "#6C757D",
        confidence: det.score,
        box: det.box,
        status: "detectada",
        description: "Persona en área no delimitada"
      });
    }
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

    // Draw polygon if polygonNorm exists, otherwise fallback to bounding rect
    if (q.polygonNorm && Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3) {
      const pts = q.polygonNorm.map(p => {
        const [px, py] = toPointTuple(p);
        return `${Math.round(px * width)},${Math.round(py * height)}`;
      }).join(" ");
      svgOverlays += `<polygon points="${pts}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="3" stroke-linejoin="round" />`;
    } else {
      svgOverlays += `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="${color}" fill-opacity="0.20" stroke="${color}" stroke-width="3" rx="4" />`;
    }

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
  const shouldAnnotate = typeof options === "object" && options.generateAnnotated !== undefined ? options.generateAnnotated : false;

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
  const quadrants = mapDetectionsToBarbershopQuadrants(detections, origWidth, origHeight, options.quadrants);

  // Extract cropped images for people (seated clients and active barber)
  const clientCrops = [];
  const personQuadrants = quadrants.filter(q => 
    q.category === "cliente" || 
    q.category === "personal" || 
    q.id.startsWith("cliente_sentado") || 
    q.id.startsWith("cliente_espera") || 
    q.id.startsWith("barbero_") || 
    q.id.startsWith("staff_")
  );

  for (let i = 0; i < personQuadrants.length; i++) {
    const q = personQuadrants[i];
    const isStaffZone = q.category === "personal" || q.id.startsWith("barbero_");
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
      box: q.box,
      confidence: q.confidence || 0.85,
      status: q.status || (isStaffZone ? "en_servicio" : "en_corte"),
      buffer: cropBuffer
    });
  }

  // Generate annotated image only if explicitly requested (saves CPU and eliminates duplicate storage)
  const annotatedBuffer = shouldAnnotate
    ? await generateAnnotatedImage(imageBuffer, quadrants, origWidth, origHeight)
    : null;

  lastDetectionResult = {
    inferenceMs,
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
