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

  // Muestreo multipunto a lo largo de la caja (cabeza, torso, centro, cadera, laterales)
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

  // Comprobación adicional de IoU
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

    detections.forEach((det, idx) => {
      if (det.class === "person" && doesDetectionOverlapZone(det.box, zone, width, height)) {
        matchingPersonDets.push(det);
        matchedPersonIndices.add(idx);
      }
    });

    const zoneType = zone.type && zone.type !== "custom_zone" ? zone.type : inferZoneType(zone);
    const zoneColor = zone.color || "#007BFF";

    switch (zoneType) {
      case "barber_chair": {
        // Una silla SOLO está ocupada si hay una PERSONA real detectada dentro de la zona
        const isOccupied = matchingPersonDets.length > 0;
        const primaryPerson = matchingPersonDets[0];

        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: "silla_barbero",
          type: "barber_chair",
          isConfiguredZone: true,
          color: zoneColor,
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          description: isOccupied ? `Sillón de barbero ocupado en corte` : `Sillón de barbero disponible`
        });

        // Solo generar cliente sentado si existe una PERSONA REAL con su bounding box y score real
        if (isOccupied && primaryPerson) {
          quadrants.push({
            id: `cliente_sentado_${zone.id}`,
            zoneId: zone.id,
            label: `Cliente sentado (${zone.name || "Silla"})`,
            category: "cliente",
            type: "barber_chair",
            isConfiguredZone: false,
            color: "#32DC32",
            confidence: primaryPerson.score,
            box: primaryPerson.box,
            status: "en_corte",
            description: `Cliente sentado recibiendo servicio en ${zone.name || zone.id}`
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
          description: isWorking ? `Barbero / Personal activo atendiendo en ${zone.name}` : `Puesto de barbero libre`
        });

        if (isWorking) {
          const barberDet = matchingPersonDets[0];
          quadrants.push({
            id: `barbero_${zone.id}`,
            zoneId: zone.id,
            label: zone.name || "Barbero",
            category: "personal",
            type: "barber_workstation",
            isConfiguredZone: false,
            color: zoneColor || "#FF4500",
            confidence: barberDet.score,
            box: barberDet.box,
            status: "en_servicio",
            description: `Barbero / Personal activo atendiendo en ${zone.name}`
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
          description: isOccupied ? `Banca de espera ocupada (${matchingPersonDets.length})` : `Banca de espera disponible`
        });

        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `cliente_espera_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: `Cliente en espera (${zone.name})`,
              category: "cliente",
              type: "waiting_chair",
              isConfiguredZone: false,
              color: "#D250DC",
              confidence: pDet.score,
              box: pDet.box,
              status: "en_espera",
              description: `Cliente esperando turno en ${zone.name}`
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
          description: isOccupied ? `Persona en tránsito por ${zone.name}` : `Zona peatonal despejada`
        });

        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `transito_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: `Tránsito en ${zone.name}`,
              category: "transito",
              type: "walking_zone",
              isConfiguredZone: false,
              color: zoneColor || "#007BFF",
              confidence: pDet.score,
              box: pDet.box,
              status: "en_transito",
              description: `Persona en tránsito por ${zone.name}`
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
          category: zone.category || "custom",
          type: zoneType,
          isConfiguredZone: true,
          color: zoneColor || "#10B981",
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          description: isOccupied ? `Zona ${zone.name} ocupada` : `Zona ${zone.name} disponible`
        });

        if (isOccupied) {
          matchingPersonDets.forEach((pDet, pIdx) => {
            quadrants.push({
              id: `persona_${zone.id}_${pIdx + 1}`,
              zoneId: zone.id,
              label: `Presencia en ${zone.name}`,
              category: zone.category || "custom",
              type: zoneType,
              isConfiguredZone: false,
              color: zoneColor || "#10B981",
              confidence: pDet.score,
              box: pDet.box,
              status: "ocupada",
              description: `Persona detectada en ${zone.name}`
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
