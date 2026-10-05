/**
 * Converts various point structures ({x, y} or [x, y]) into a normalized [x, y] tuple
 */
export function toPointTuple(p) {
  if (Array.isArray(p)) return [Number(p[0]) || 0, Number(p[1]) || 0];
  if (p && typeof p === "object") return [Number(p.x) || 0, Number(p.y) || 0];
  return [0, 0];
}

/**
 * Converts a normalized bounding box [ymin, xmin, ymax, xmax] (0 to 1000) to a 4-point polygon
 */
export function boxNormToPolygonNorm([ymin, xmin, ymax, xmax]) {
  return [
    [xmin, ymin], // Top-Left
    [xmax, ymin], // Top-Right
    [xmax, ymax], // Bottom-Right
    [xmin, ymax]  // Bottom-Left
  ];
}

/**
 * Computes bounding box [ymin, xmin, ymax, xmax] from a polygon array
 */
export function polygonNormToBoundingBoxNorm(polygon) {
  if (!polygon || polygon.length === 0) return [0, 0, 0, 0];
  const pts = polygon.map(toPointTuple);
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return [
    Math.round(Math.min(...ys)),
    Math.round(Math.min(...xs)),
    Math.round(Math.max(...ys)),
    Math.round(Math.max(...xs))
  ];
}

/**
 * Ensures backwards compatibility and normalization across raw quadrant data
 */
export function normalizeQuadrants(quads) {
  if (!quads || typeof quads !== "object") return [];
  const list = Array.isArray(quads) ? quads : (quads.zones || quads.quadrants || []);
  
  return list.map((q, idx) => {
    let polygonNorm = [];
    if (Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3) {
      polygonNorm = q.polygonNorm.map(toPointTuple);
    } else if (Array.isArray(q.boxNorm) && q.boxNorm.length === 4) {
      polygonNorm = boxNormToPolygonNorm(q.boxNorm);
    } else {
      polygonNorm = boxNormToPolygonNorm([100, 100, 400, 400]);
    }

    const boxNorm = polygonNormToBoundingBoxNorm(polygonNorm);
    return {
      id: q.id || `quad_${idx + 1}`,
      name: q.name || `Zona ${idx + 1}`,
      badge: q.badge || q.name || `Z${idx + 1}`,
      color: q.color || "#3b82f6",
      polygonNorm,
      boxNorm
    };
  });
}

/**
 * Serializes quadrants array for Firestore saving
 */
export function serializeQuadrantsForFirestore(quads) {
  return quads.map(q => {
    const polygonNorm = (q.polygonNorm || boxNormToPolygonNorm(q.boxNorm)).map(toPointTuple);
    const boxNorm = polygonNormToBoundingBoxNorm(polygonNorm);
    return {
      id: q.id,
      name: q.name,
      badge: q.badge || q.name,
      color: q.color || "#3b82f6",
      polygonNorm,
      boxNorm
    };
  });
}

/**
 * Convert Hex color string to rgba() CSS string
 */
export function hexToRgba(hex, alpha = 0.2) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) {
    return `rgba(59, 130, 246, ${alpha})`;
  }
  let c = hex.substring(1);
  if (c.length === 3) {
    c = c.split("").map(ch => ch + ch).join("");
  }
  const num = parseInt(c, 16);
  if (isNaN(num)) return `rgba(59, 130, 246, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
