/**
 * Dominio Geométrico y Normalización para Cuadrantes y Zonas ROI
 * Garantiza compatibilidad universal entre escalas 0..1 (Firestore estándar) y 0..1000 (viewBox SVG).
 */

export function ensureNorm01(val) {
  const num = Number(val) || 0;
  return num > 1.5 ? num / 1000 : num;
}

export function ensureNorm1000(val) {
  const num = Number(val) || 0;
  return num <= 1.5 ? Math.round(num * 1000) : Math.round(num);
}

/**
 * Convierte cualquier formato de punto ({x, y} o [x, y]) a tupla [x, y] en rango 0..1
 */
export function toPointTuple(p) {
  if (Array.isArray(p)) {
    return [ensureNorm01(p[0]), ensureNorm01(p[1])];
  }
  if (p && typeof p === "object") {
    return [ensureNorm01(p.x), ensureNorm01(p.y)];
  }
  return [0, 0];
}

/**
 * Convierte cualquier formato de punto a objeto { x, y } en rango 0..1 (compatible con Firestore)
 */
export function toPointObject(p) {
  if (Array.isArray(p)) {
    return { x: ensureNorm01(p[0]), y: ensureNorm01(p[1]) };
  }
  if (p && typeof p === "object") {
    return { x: ensureNorm01(p.x), y: ensureNorm01(p.y) };
  }
  return { x: 0, y: 0 };
}

/**
 * Convierte un bounding box [ymin, xmin, ymax, xmax] (0..1) a un polígono de 4 esquinas [{x, y}, ...]
 */
export function boxNormToPolygonNorm([ymin, xmin, ymax, xmax]) {
  const y0 = ensureNorm01(ymin);
  const x0 = ensureNorm01(xmin);
  const y1 = ensureNorm01(ymax);
  const x1 = ensureNorm01(xmax);

  return [
    { x: x0, y: y0 }, // Top-Left
    { x: x1, y: y0 }, // Top-Right
    { x: x1, y: y1 }, // Bottom-Right
    { x: x0, y: y1 }  // Bottom-Left
  ];
}

/**
 * Calcula el bounding box [ymin, xmin, ymax, xmax] en rango 0..1 desde un array de vértices
 */
export function polygonNormToBoundingBoxNorm(polygon) {
  if (!polygon || polygon.length === 0) return [0, 0, 1, 1];
  const pts = polygon.map(toPointObject);
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);

  return [
    Number(Math.min(...ys).toFixed(3)),
    Number(Math.min(...xs).toFixed(3)),
    Number(Math.max(...ys).toFixed(3)),
    Number(Math.max(...xs).toFixed(3))
  ];
}

/**
 * Normaliza cualquier formato recibido de Firestore o del editor a la estructura interna estándar:
 * {
 *   id, name, badge, color, type,
 *   boxNorm: [ymin, xmin, ymax, xmax] (0..1),
 *   polygonNorm: [{x, y}, ...] (0..1)
 * }
 */
/**
 * Infiere el tipo semántico de una zona según sus metadatos o nombre
 * @param {Object} zone
 * @returns {string}
 */
export function inferZoneType(zone) {
  if (!zone) return 'custom_zone';
  if (zone.type && zone.type !== 'custom_zone') return zone.type;
  const name = (zone.name || zone.label || zone.id || '').toLowerCase();
  if (/transito|tránsito|pasillo|puerta|entrada|walking|corredor|hallway/.test(name)) {
    return 'walking_zone';
  }
  if (/espera|waiting/.test(name)) {
    return 'waiting_chair';
  }
  if (/silla|chair|corte|puesto_corte|sillon|sillón/.test(name)) {
    return 'barber_chair';
  }
  if (/barbero|barber|workstation|puesto/.test(name)) {
    return 'barber_workstation';
  }
  return 'custom_zone';
}

/**
 * Normaliza cualquier formato recibido de Firestore o del editor a la estructura interna estándar:
 * {
 *   id, name, badge, color, type,
 *   boxNorm: [ymin, xmin, ymax, xmax] (0..1),
 *   polygonNorm: [{x, y}, ...] (0..1)
 * }
 */
export function normalizeQuadrants(quads) {
  if (!quads) return [];
  let list = [];
  if (Array.isArray(quads)) {
    list = quads;
  } else if (typeof quads === "object") {
    const raw = quads.quadrants || quads.zones || quads.items || quads;
    list = Array.isArray(raw) ? raw : Object.values(raw);
  }

  return list.map((q, idx) => {
    let polygonNorm = [];
    if (Array.isArray(q.polygonNorm) && q.polygonNorm.length >= 3) {
      polygonNorm = q.polygonNorm.map(toPointObject);
    } else if (Array.isArray(q.boxNorm) && q.boxNorm.length === 4) {
      polygonNorm = boxNormToPolygonNorm(q.boxNorm);
    } else {
      polygonNorm = boxNormToPolygonNorm([0.2, 0.2, 0.6, 0.6]);
    }

    const boxNorm = polygonNormToBoundingBoxNorm(polygonNorm);
    const resolvedType = q.type && q.type !== 'custom_zone' ? q.type : inferZoneType(q);
    const isTransit = resolvedType === 'walking_zone' || resolvedType === 'transit';
    const capturePerson = q.capturePerson !== undefined
      ? Boolean(q.capturePerson)
      : !isTransit;
    const role = q.role || (resolvedType === 'barber_workstation' ? 'staff' : (isTransit ? 'visitor' : 'client'));
    const labelOnOccupied = q.labelOnOccupied || '';

    return {
      id: q.id || `quad_${idx + 1}`,
      name: q.name || `Zona ${idx + 1}`,
      badge: q.badge || q.name || `Z${idx + 1}`,
      type: resolvedType,
      color: q.color || '#3b82f6',
      capturePerson,
      role,
      labelOnOccupied,
      polygonNorm,
      boxNorm
    };
  });
}

/**
 * Serializa los cuadrantes para persistencia en Firestore (evita arrays anidados y redondea a 3 decimales)
 */
export function serializeQuadrantsForFirestore(quads) {
  return quads.map(q => {
    const rawPoly = (q.polygonNorm && q.polygonNorm.length >= 3)
      ? q.polygonNorm
      : boxNormToPolygonNorm(q.boxNorm || [0.2, 0.2, 0.6, 0.6]);

    const polygonNorm = rawPoly.map(p => {
      const obj = toPointObject(p);
      return {
        x: Number(obj.x.toFixed(3)),
        y: Number(obj.y.toFixed(3))
      };
    });

    const boxNorm = polygonNormToBoundingBoxNorm(polygonNorm);
    const resolvedType = q.type && q.type !== 'custom_zone' ? q.type : inferZoneType(q);
    const isTransit = resolvedType === 'walking_zone' || resolvedType === 'transit';
    const capturePerson = q.capturePerson !== undefined
      ? Boolean(q.capturePerson)
      : !isTransit;
    const role = q.role || (resolvedType === 'barber_workstation' ? 'staff' : (isTransit ? 'visitor' : 'client'));
    const labelOnOccupied = q.labelOnOccupied || '';

    return {
      id: q.id,
      name: q.name || q.id,
      badge: q.badge || q.name || q.id,
      type: resolvedType,
      color: q.color || '#3b82f6',
      capturePerson,
      role,
      labelOnOccupied,
      boxNorm,
      polygonNorm
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
