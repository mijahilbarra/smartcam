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

// Cuadrantes físicos por defecto basados en resolución 1024x576
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

  if (configuredZonesMap === null || configuredZonesMap === undefined) {
    configuredZones = Object.values(BARBERSHOP_QUADRANTS);
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

        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: "silla_barbero",
          type: "barber_chair",
          color: zoneColor,
          box: zonePixelBox,
          boxNorm: zone.boxNorm,
          polygonNorm: zone.polygonNorm,
          status: isOccupied ? "ocupada" : "disponible",
          description: isOccupied ? `Sillón de barbero ocupado en corte` : `Sillón de barbero disponible`
        });

        if (isOccupied) {
          const clientBox = primaryPerson ? primaryPerson.box : [zonePixelBox[0] + 15, zonePixelBox[1] + 10, zonePixelBox[2] - 15, zonePixelBox[3] - 10];
          quadrants.push({
            id: `cliente_sentado_${zone.id}`,
            zoneId: zone.id,
            label: `Cliente sentado (${zone.name || "Silla"})`,
            category: "cliente",
            color: "#32DC32",
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
        quadrants.push({
          id: zone.id,
          name: zone.name || zone.id,
          label: zone.name || zone.id,
          category: "personal",
          type: "barber_workstation",
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
