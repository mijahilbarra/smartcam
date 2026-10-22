/**
 * Dominio Geométrico Puro
 * Algoritmos y cálculos espaciales (IoU, NMS, normalización de polígonos, intersección de puntos).
 */

/**
 * Convierte representaciones de vértices ([x, y] o {x, y}) a una tupla [x, y]
 * @param {Array|Object} p
 * @returns {[number, number]}
 */
export function toPointTuple(p) {
  if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
  if (p && typeof p === "object") return [Number(p.x ?? 0), Number(p.y ?? 0)];
  return [0, 0];
}

/**
 * Convierte representaciones de vértices ([x, y] o {x, y}) a un objeto { x, y } (compatible con Firestore)
 * @param {Array|Object} p
 * @returns {{ x: number, y: number }}
 */
export function toPointObject(p) {
  if (Array.isArray(p)) return { x: Number(p[0] ?? 0), y: Number(p[1] ?? 0) };
  if (p && typeof p === "object") return { x: Number(p.x ?? 0), y: Number(p.y ?? 0) };
  return { x: 0, y: 0 };
}

/**
 * Convierte un bounding box normalizado [ymin, xmin, ymax, xmax] a un polígono [{x, y}, ...]
 * @param {[number, number, number, number]} param0
 * @returns {Array<{x: number, y: number}>}
 */
export function boxNormToPolygonNorm([ymin, xmin, ymax, xmax]) {
  return [
    { x: Number(xmin), y: Number(ymin) }, // Top-Left
    { x: Number(xmax), y: Number(ymin) }, // Top-Right
    { x: Number(xmax), y: Number(ymax) }, // Bottom-Right
    { x: Number(xmin), y: Number(ymax) }  // Bottom-Left
  ];
}

/**
 * Convierte un polígono [{x, y}, ...] a un bounding box normalizado [ymin, xmin, ymax, xmax]
 * @param {Array} polygon
 * @returns {[number, number, number, number]}
 */
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
 * Algoritmo Ray-Casting para determinar si el punto [px, py] está dentro de un polígono
 * @param {[number, number]} param0
 * @param {Array} polygon
 * @returns {boolean}
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

/**
 * Evalúa si un punto normalizado (cx, cy) se encuentra dentro de una zona (polígono o box)
 * @param {number} cx
 * @param {number} cy
 * @param {Object} zone
 * @returns {boolean}
 */
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

/**
 * Calcula la Intersección sobre la Unión (IoU) entre dos cajas [x1, y1, x2, y2]
 * @param {[number, number, number, number]} boxA
 * @param {[number, number, number, number]} boxB
 * @returns {number}
 */
export function calculateIoU(boxA, boxB) {
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
 * Supresión de No Máximos (NMS) para eliminar detecciones duplicadas
 * @param {Array<{box: Array<number>, score: number}>} boxes
 * @param {number} iouThreshold
 * @returns {Array}
 */
export function applyNMS(boxes, iouThreshold = 0.45) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const selected = [];
  const active = new Array(sorted.length).fill(true);

  for (let i = 0; i < sorted.length; i++) {
    if (!active[i]) continue;
    selected.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (!active[j]) continue;
      if (calculateIoU(sorted[i].box, sorted[j].box) > iouThreshold) {
        active[j] = false;
      }
    }
  }
  return selected;
}

/**
 * Determina si una persona está en postura de pie según proporciones de su bounding box
 * @param {Array<number>} box - [x1, y1, x2, y2]
 * @param {number} imgHeight - Altura de la imagen en píxeles (defecto 720)
 * @returns {boolean}
 */
export function isStandingPosture(box, imgHeight = 720) {
  if (typeof box === "string") {
    try { box = JSON.parse(box); } catch (_) { return false; }
  }
  if (!box || !Array.isArray(box) || box.length < 4 || imgHeight <= 0) return false;
  const boxTop = box[1];
  const boxH = box[3] - box[1];
  return (boxTop / imgHeight <= 0.22 || boxH / imgHeight >= 0.55);
}

