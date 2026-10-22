/**
 * Reglas de Negocio de la Barbería y Mapeo de Cuadrantes
 * Define las zonas predeterminadas y clasifica detecciones en estados de negocio
 * (en_corte, disponible, ocupada, en_transito, etc.)
 */

import {
  toPointObject,
  boxNormToPolygonNorm,
  polygonNormToBoundingBoxNorm,
  isPointInsideZone,
  calculateIoU
} from "./geometry.js";

// Cuadrantes físicos por defecto: objeto vacío para que todo provenga dinámicamente de Firestore
export const BARBERSHOP_QUADRANTS = {};


/**
 * Determina si una detección [x1, y1, x2, y2] solapa espacialmente con una zona configurada
 * @param {[number, number, number, number]} detBox
 * @param {Object} zone
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
export function doesDetectionOverlapZone(detBox, zone, width, height) {
  const [x1, y1, x2, y2] = detBox;
  const isChair = isChairZone(zone);

  if (isChair) {
    // Para sillas de barbero: la cabeza puede estar por fuera (arriba de la zona).
    // Se muestrea a lo largo del torso y cuerpo sentado (38%, 50%, 65%, 80%, 90% de la altura).
    const h = y2 - y1;
    const bodyHeights = [0.38, 0.50, 0.65, 0.80, 0.90];
    const xWeights = [
      [0.50, 0.50],
      [0.65, 0.35],
      [0.35, 0.65]
    ];

    const bodySamples = [];
    for (const bh of bodyHeights) {
      const sy = (y1 + h * bh) / height;
      for (const [w1, w2] of xWeights) {
        const sx = (x1 * w1 + x2 * w2) / width;
        bodySamples.push([sx, sy]);
      }
    }

    if (bodySamples.some(([px, py]) => isPointInsideZone(px, py, zone))) {
      return true;
    }

    // Fallback si la zona solo tiene caja en píxeles (sin polygonNorm)
    if (zone.box) {
      const [qx1, qy1, qx2, qy2] = zone.box;
      if (bodySamples.some(([px, py]) => {
        const pxPx = px * width;
        const pyPx = py * height;
        return pxPx >= qx1 && pxPx <= qx2 && pyPx >= qy1 && pyPx <= qy2;
      })) {
        return true;
      }
    } else if (zone.boxNorm) {
      const [by1, bx1, by2, bx2] = zone.boxNorm;
      if (bodySamples.some(([px, py]) => px >= bx1 && px <= bx2 && py >= by1 && py <= by2)) {
        return true;
      }
    }

    // Para sillas de barbero NO se permite IoU de caja completa.
    // Esto evita que transeúntes de paso o el barbero de pie inclinado activen la silla.
    return false;
  }

  // Muestreo multipunto general para pasillos, tránsito y áreas generales
  const samples = [
    [(x1 + x2) / (2 * width), (y1 + y2) / (2 * height)],
    [(x1 * 0.75 + x2 * 0.25) / width, (y1 + y2) / (2 * height)],
    [(x1 * 0.25 + x2 * 0.75) / width, (y1 + y2) / (2 * height)],
    [(x1 + x2) / (2 * width), (y1 * 0.60 + y2 * 0.40) / height],
    [(x1 * 0.75 + x2 * 0.25) / width, (y1 * 0.60 + y2 * 0.40) / height],
    [(x1 * 0.25 + x2 * 0.75) / width, (y1 * 0.60 + y2 * 0.40) / height],
    [(x1 + x2) / (2 * width), (y1 * 0.25 + y2 * 0.75) / height]
  ];

  if (samples.some(([px, py]) => isPointInsideZone(px, py, zone))) {
    return true;
  }

  // Comprobación adicional de IoU solo para áreas de tránsito / zonas que no son sillas
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
 * Infiere el tipo semántico de una zona según sus metadatos o nombre
 * @param {Object} zone
 * @returns {string}
 */
export function inferZoneType(zone) {
  if (!zone) return "custom_zone";
  if (zone.type) return zone.type;
  const name = (zone.name || zone.label || zone.id || "").toLowerCase();
  if (/transito|tránsito|pasillo|puerta|entrada|walking|corredor|hallway/.test(name)) {
    return "walking_zone";
  }
  if (/espera|waiting/.test(name)) {
    return "waiting_chair";
  }
  if (/silla|chair|corte|puesto_corte|sillon|sillón/.test(name)) {
    return "barber_chair";
  }
  if (/barbero|barber|workstation|puesto/.test(name)) {
    return "barber_workstation";
  }
  return "custom_zone";
}

/**
 * Determina si una zona corresponde a área de tránsito peatonal
 * @param {Object} zone
 * @returns {boolean}
 */
export function isTransitZone(zone) {
  if (!zone) return false;
  if (zone.type) {
    const t = zone.type.toLowerCase();
    return t === "walking_zone" || t === "transit" || t === "transito";
  }
  const name = (zone.name || zone.label || zone.id || "").toLowerCase();
  return /transito|tránsito|pasillo|puerta|entrada|walking|corredor|hallway/.test(name);
}

/**
 * Determina si una zona corresponde a cualquier tipo de silla (corte o espera)
 * @param {Object} zone
 * @returns {boolean}
 */
export function isChairZone(zone) {
  if (!zone) return false;
  if (isTransitZone(zone)) return false;
  if (zone.type) {
    const t = zone.type.toLowerCase();
    return t === "barber_chair" || t === "waiting_chair";
  }
  const name = (zone.name || zone.label || zone.id || "").toLowerCase();
  return /silla|chair|corte|espera|banca|sillon|sillón/.test(name);
}

/**
 * Determina si una zona corresponde específicamente a una silla de barbero para servicio
 * @param {Object} zone
 * @returns {boolean}
 */
export function isServiceChair(zone) {
  if (!zone) return false;
  if (isTransitZone(zone)) return false;
  if (zone.type) {
    const t = zone.type.toLowerCase();
    return t === "barber_chair";
  }
  const name = (zone.name || zone.label || zone.id || "").toLowerCase();
  if (/espera|waiting/.test(name)) return false;
  return /silla|chair|corte|puesto|sillon|sillón/.test(name);
}

/**
 * Clasifica detecciones de objetos en cuadrantes semánticos de la barbería
 * @param {Array} detections
 * @param {number} width
 * @param {number} height
 * @param {Object|Array} configuredZonesMap
 * @returns {Array}
 */
export function mapDetectionsToBarbershopQuadrants(detections, width, height, configuredZonesMap = null) {
  const quadrants = [];

  let configuredZones = [];
  if (Array.isArray(configuredZonesMap)) {
    configuredZones = configuredZonesMap;
  } else if (configuredZonesMap && typeof configuredZonesMap === "object") {
    configuredZones = Object.values(configuredZonesMap);
  }

  // Las zonas provienen ÚNICAMENTE de la configuración dinámica de Firestore.
  // Si no hay zonas configuradas por el usuario, opera con lista vacía [].
  if (configuredZonesMap === null || configuredZonesMap === undefined) {
    configuredZones = [];
  }

  // Normalizar cada zona
  const normalizedZones = configuredZones.filter(z => z && z.id).map(rawZ => {
    const z = { ...rawZ };
    if (z.polygonNorm && Array.isArray(z.polygonNorm) && z.polygonNorm.length >= 3) {
      z.polygonNorm = z.polygonNorm.map(toPointObject);
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

    // Ocupación basada EXCLUSIVAMENTE en personas reales detectadas
    const matchingPersonDets = [];
    const zoneType = zone.type && zone.type !== "custom_zone" ? zone.type : inferZoneType(zone);
    const zoneColor = zone.color || "#007BFF";

    detections.forEach((det, idx) => {
      if (det.class === "person" && doesDetectionOverlapZone(det.box, zone, width, height)) {
        // En sillas de corte, exigir confianza >= 0.50 para evitar falsos positivos de cabezales/respaldos vacíos (35%-38%)
        const isChair = zoneType === "barber_chair" || isChairZone(zone);
        if (isChair && (det.score || 0) < 0.50) {
          return;
        }
        matchingPersonDets.push(det);
        matchedPersonIndices.add(idx);
      }
    });

    // Propiedades dinámicas de la zona con valores por defecto basados en tipo semántico
    const isTransit = isTransitZone(zone) || zoneType === "walking_zone";
    const shouldCapture = zone.capturePerson !== undefined
      ? Boolean(zone.capturePerson)
      : (zoneType === "barber_chair" || zoneType === "waiting_chair" || zoneType === "barber_workstation");
    const role = zone.role || (zoneType === "barber_workstation" ? "staff" : (isTransit ? "visitor" : "client"));
    const defaultLabelOnOcc = (role === "staff" ? "Personal activo" : "Cliente") + ` (${zone.name || zone.id})`;
    const labelOnOcc = zone.labelOnOccupied || defaultLabelOnOcc;

    switch (zoneType) {
      case "barber_chair": {
        // Una silla SOLO está ocupada si hay una PERSONA real detectada dentro de la zona
        const isOccupied = matchingPersonDets.length > 0;
        // Si hay más de una persona solapando la silla (ej. barbero de pie + cliente sentado),
        // priorizar a la persona sentada (menor elongación vertical y cabeza más baja en el encuadre)
        const sortedChairDets = matchingPersonDets.length > 1
          ? [...matchingPersonDets].sort((a, b) => {
              const hA = a.box ? (a.box[3] - a.box[1]) : 0;
              const hB = b.box ? (b.box[3] - b.box[1]) : 0;
              return hA - hB;
            })
          : matchingPersonDets;
        const primaryPerson = sortedChairDets[0];

        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: role === "staff" ? "personal" : "silla_barbero",
          type: "barber_chair",
          isConfiguredZone: true,
          color: zoneColor,
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          capturePerson: shouldCapture,
          role,
          labelOnOccupied: zone.labelOnOccupied || null,
          requiresClearCapture: isOccupied && shouldCapture,
          description: isOccupied ? `Sillón de barbero ocupado (${labelOnOcc})` : `Sillón de barbero disponible`
        });

        // Generar persona(s) detectada(s) en la zona (primaria y secundarias si coexisten en el ROI)
        if (isOccupied && primaryPerson) {
          sortedChairDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: pIdx === 0 ? `person_${zone.id}` : `person_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: pIdx === 0 ? labelOnOcc : `${labelOnOcc} (${pIdx + 1})`,
              category: role === "staff" ? "personal" : "cliente",
              type: "barber_chair",
              isConfiguredZone: false,
              color: role === "staff" ? "#FF4500" : "#32DC32",
              confidence: pDet.score,
              box: pDet.box,
              role,
              capturePerson: shouldCapture,
              requiresClearCapture: shouldCapture,
              status: "en_corte",
              description: `${labelOnOcc} recibiendo servicio en ${zone.name || zone.id}`
            });
          });
        }
        break;
      }

      case "barber_workstation": {
        const isWorking = matchingPersonDets.length > 0;
        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: "personal",
          type: "barber_workstation",
          isConfiguredZone: true,
          color: zoneColor || "#FF4500",
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isWorking ? "en_servicio" : "disponible",
          capturePerson: shouldCapture,
          role,
          labelOnOccupied: zone.labelOnOccupied || null,
          requiresClearCapture: isWorking && shouldCapture,
          description: isWorking ? `${labelOnOcc} atendiendo en ${zone.name}` : `Puesto de barbero libre`
        });

        if (isWorking) {
          const barberDet = matchingPersonDets[0];
          quadrants.push({
            id: `person_${zone.id}`,
            zoneId: zone.id,
            label: labelOnOcc,
            category: "personal",
            type: "barber_workstation",
            isConfiguredZone: false,
            color: zoneColor || "#FF4500",
            confidence: barberDet.score,
            box: barberDet.box,
            role,
            capturePerson: shouldCapture,
            requiresClearCapture: shouldCapture,
            status: "en_servicio",
            description: `${labelOnOcc} atendiendo en ${zone.name}`
          });
        }
        break;
      }

      case "waiting_chair": {
        const isOccupied = matchingPersonDets.length > 0;
        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: "silla_espera",
          type: "waiting_chair",
          isConfiguredZone: true,
          color: zoneColor || "#D250DC",
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          capturePerson: shouldCapture,
          role,
          labelOnOccupied: zone.labelOnOccupied || null,
          requiresClearCapture: isOccupied && shouldCapture,
          description: isOccupied ? `Banca de espera ocupada (${matchingPersonDets.length})` : `Banca de espera disponible`
        });

        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            const personLabel = zone.labelOnOccupied
              ? (matchingPersonDets.length > 1 ? `${zone.labelOnOccupied} (${pIdx + 1})` : zone.labelOnOccupied)
              : `${role === "staff" ? "Personal activo" : "Cliente en espera"} (${zone.name || zone.id})${matchingPersonDets.length > 1 ? ` #${pIdx + 1}` : ""}`;

            quadrants.push({
              id: `person_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: personLabel,
              category: role === "staff" ? "personal" : "cliente",
              type: "waiting_chair",
              isConfiguredZone: false,
              color: "#D250DC",
              confidence: pDet.score,
              box: pDet.box,
              role,
              capturePerson: shouldCapture,
              requiresClearCapture: shouldCapture,
              status: "en_espera",
              description: `${personLabel} en ${zone.name || zone.id}`
            });
          });
        }
        break;
      }

      case "walking_zone": {
        const isOccupied = matchingPersonDets.length > 0;
        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: "transito",
          type: "walking_zone",
          isConfiguredZone: true,
          color: zoneColor || "#007BFF",
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "en_transito" : "despejado",
          capturePerson: shouldCapture,
          role,
          labelOnOccupied: zone.labelOnOccupied || null,
          requiresClearCapture: isOccupied && shouldCapture,
          description: isOccupied ? `Persona en tránsito por ${zone.name || zone.id}` : `Zona peatonal despejada`
        });

        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `transito_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: zone.labelOnOccupied
                ? (matchingPersonDets.length > 1 ? `${zone.labelOnOccupied} (${pIdx + 1})` : zone.labelOnOccupied)
                : `Tránsito en ${zone.name || zone.id}${matchingPersonDets.length > 1 ? ` #${pIdx + 1}` : ""}`,
              category: "transito",
              type: "walking_zone",
              isConfiguredZone: false,
              color: zoneColor || "#007BFF",
              confidence: pDet.score,
              box: pDet.box,
              role,
              capturePerson: shouldCapture,
              requiresClearCapture: shouldCapture,
              status: "en_transito",
              description: `Persona en tránsito por ${zone.name || zone.id}`
            });
          });
        }
        break;
      }

      default: {
        const isOccupied = matchingPersonDets.length > 0;
        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: zone.category || (role === "staff" ? "personal" : "custom"),
          type: zoneType,
          isConfiguredZone: true,
          color: zoneColor || "#10B981",
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          capturePerson: shouldCapture,
          role,
          labelOnOccupied: zone.labelOnOccupied || null,
          requiresClearCapture: isOccupied && shouldCapture,
          description: isOccupied ? `Zona ${zone.name || zone.id} ocupada` : `Zona ${zone.name || zone.id} disponible`
        });

        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            const personLabel = zone.labelOnOccupied
              ? (matchingPersonDets.length > 1 ? `${zone.labelOnOccupied} (${pIdx + 1})` : zone.labelOnOccupied)
              : `${labelOnOcc}${matchingPersonDets.length > 1 ? ` #${pIdx + 1}` : ""}`;

            quadrants.push({
              id: `person_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: personLabel,
              category: zone.category || (role === "staff" ? "personal" : "custom"),
              type: zoneType,
              isConfiguredZone: false,
              color: zoneColor || "#10B981",
              confidence: pDet.score,
              box: pDet.box,
              role,
              capturePerson: shouldCapture,
              requiresClearCapture: shouldCapture,
              status: "ocupada",
              description: `Persona detectada en ${zone.name || zone.id}`
            });
          });
        }
        break;
      }
    }
  }

  // Personas fuera de zonas definidas
  detections.forEach((det, idx) => {
    if (det.class === "person" && !matchedPersonIndices.has(idx)) {
      quadrants.push({
        id: `persona_sin_zona_${idx + 1}`,
        label: "Persona fuera de zonas",
        category: "otro",
        isConfiguredZone: false,
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
