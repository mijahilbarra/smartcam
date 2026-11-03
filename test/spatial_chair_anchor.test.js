import test, { describe, it } from "node:test";
import assert from "node:assert";
import {
  validateSpatialChairAnchor,
  resolveChairZone,
  prepareAndFilterSessionForClosure
} from "../src/services/pipeline/closure_rules.js";

describe("Validación Espacial de Caja Humano vs Caja de la Silla de Firebase", () => {
  const firebaseChairZone = {
    id: "silla_barbero_puesto2",
    name: "Silla de barbero (Frente)",
    type: "barber_chair",
    boxNorm: [0.48, 0.34, 1.0, 0.74],
    polygonNorm: [
      { x: 0.34, y: 0.48 },
      { x: 0.74, y: 0.48 },
      { x: 0.74, y: 1.0 },
      { x: 0.34, y: 1.0 }
    ]
  };

  const hallwayZone = {
    id: "puerta_entrada",
    name: "Entrada / Pasillo peatonal",
    type: "walking_zone",
    boxNorm: [0.037, 0.138, 0.51, 0.608],
    polygonNorm: [
      { x: 0.138, y: 0.037 },
      { x: 0.608, y: 0.037 },
      { x: 0.608, y: 0.51 },
      { x: 0.138, y: 0.51 }
    ]
  };

  describe("resolveChairZone", () => {
    it("devuelve el objeto zone si ya está provisto directamente", () => {
      const res = resolveChairZone(firebaseChairZone);
      assert.strictEqual(res.id, "silla_barbero_puesto2");
      assert.strictEqual(res.type, "barber_chair");
    });

    it("resuelve la zona por id buscando en la lista suministrada", () => {
      const res = resolveChairZone("silla_barbero_puesto2", [hallwayZone, firebaseChairZone]);
      assert.strictEqual(res.id, "silla_barbero_puesto2");
    });

    it("hace fallback a data/quadrants.json si no se pasa lista", () => {
      const res = resolveChairZone("silla_barbero_puesto2");
      assert.ok(res, "Debe resolver cuadrante desde data/quadrants.json");
      assert.strictEqual(res.type, "barber_chair");
    });
  });

  describe("validateSpatialChairAnchor", () => {
    it("aprueba una caja humana centrada en la silla de barbero de Firebase (píxeles 1280x720)", () => {
      // Caja típica de cliente sentado en la silla: x in [579, 701], y in [221, 563]
      const session = {
        chairId: "silla_barbero_puesto2",
        boxes: [
          [579, 221, 701, 563],
          [511, 218, 663, 586]
        ]
      };

      const result = validateSpatialChairAnchor(session, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.reason, "dentro_de_caja_silla");
      assert.strictEqual(result.insideCount, 2);
      assert.strictEqual(result.totalBoxes, 2);
      assert.strictEqual(result.overlapRatio, 1.0);
    });

    it("aprueba una caja en coordenadas normalizadas (0 a 1)", () => {
      // Torso sentado centrado en x=0.54, y entre 0.30 y 0.75
      const session = {
        chairId: "silla_barbero_puesto2",
        boxes: [
          [0.45, 0.30, 0.65, 0.78]
        ]
      };

      const result = validateSpatialChairAnchor(session, firebaseChairZone);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.reason, "dentro_de_caja_silla");
    });

    it("descarta con fuera_de_caja_silla_firebase si la persona está en el pasillo / puerta de entrada", () => {
      // Caja ubicada en el pasillo (x: [100, 250], y: [50, 300])
      const session = {
        chairId: "silla_barbero_puesto2",
        boxes: [
          [100, 50, 250, 300],
          [120, 60, 260, 310]
        ]
      };

      const result = validateSpatialChairAnchor(session, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.reason, "fuera_de_caja_silla_firebase");
      assert.strictEqual(result.insideCount, 0);
      assert.strictEqual(result.overlapRatio, 0);
    });

    it("descarta si la mayoría de las cajas están fuera de la caja de la silla de Firebase", () => {
      const session = {
        chairId: "silla_barbero_puesto2",
        boxes: [
          [100, 50, 250, 300], // fuera
          [110, 55, 260, 310], // fuera
          [120, 60, 270, 320], // fuera
          [579, 221, 701, 563]  // dentro (1 de 4 = 25% < 50%)
        ]
      };

      const result = validateSpatialChairAnchor(session, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.reason, "fuera_de_caja_silla_firebase");
      assert.strictEqual(result.insideCount, 1);
      assert.strictEqual(result.totalBoxes, 4);
      assert.strictEqual(result.overlapRatio, 0.25);
    });

    it("extrae cajas desde session.crops y session.photos transparentemente", () => {
      const session = {
        chairId: "silla_barbero_puesto2",
        crops: [
          { box: [579, 221, 701, 563] }
        ],
        photos: [
          { box: [511, 218, 663, 586] }
        ]
      };

      const result = validateSpatialChairAnchor(session, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.totalBoxes, 2);
      assert.strictEqual(result.insideCount, 2);
    });

    it("descarta al acompañante en sofá de espera (track_id: 3325, insideRatio=38.7%, y2=499)", () => {
      // Caso empírico de track 3325 en barberia_stream_10h_oct17
      const companionSession = {
        trackId: 3325,
        chairId: "silla_barbero_puesto2",
        boxes: [
          [363, 217, 614, 499],
          [361, 217, 615, 500],
          [365, 231, 602, 495]
        ]
      };

      const result = validateSpatialChairAnchor(companionSession, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.reason, "fuera_de_caja_silla_firebase");
      assert.strictEqual(result.insideCount, 0);
      assert.ok(result.avgInsideRatio < 0.50, `avgInsideRatio (${result.avgInsideRatio}) debe ser < 0.50`);
      assert.ok(result.avgY2 < 550, `avgY2 (${result.avgY2}) debe ser < 550`);
    });

    it("maneja sesiones sin cajas registradas respetando allowEmptyBoxes", () => {
      const emptySession = { chairId: "silla_barbero_puesto2" };
      const defaultPass = validateSpatialChairAnchor(emptySession, firebaseChairZone);
      assert.strictEqual(defaultPass.isValid, true);
      assert.strictEqual(defaultPass.reason, "sin_cajas_registradas");

      const strictFail = validateSpatialChairAnchor(emptySession, firebaseChairZone, { allowEmptyBoxes: false });
      assert.strictEqual(strictFail.isValid, false);
      assert.strictEqual(strictFail.reason, "fuera_de_caja_silla_firebase");
    });

    it("descarta sesión del barbero de pie con rostro erguido por encima del plano de la silla (fcy < 330)", () => {
      // Barbero de pie junto a la silla: caja grande y2=680, pero rostro a y=220 (muy alto para un cliente sentado)
      const barberSession = {
        chairId: "silla_barbero_puesto2",
        crops: [
          {
            box: [450, 150, 750, 680],
            faceData: {
              boxNorm: [0.10, 0.20, 0.25, 0.50] // fcy ~ 150 + 0.175 * 530 = 242px (< 340px)
            }
          }
        ]
      };

      const result = validateSpatialChairAnchor(barberSession, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.insideCount, 0);
      assert.strictEqual(result.reason, "fuera_de_caja_silla_firebase");
    });

    it("descarta detección con rostro fuera de la columna horizontal de la silla (fcx < cx1 - 40)", () => {
      // Persona en pasillo x=250 (fuera de la columna de la silla cx1=435)
      const hallwayFaceSession = {
        chairId: "silla_barbero_puesto2",
        crops: [
          {
            box: [200, 320, 360, 680],
            faceData: {
              landmarks: [[270, 380], [290, 380], [280, 400], [270, 420], [290, 420]] // fcx=280 < 435 - 40
            }
          }
        ]
      };

      const result = validateSpatialChairAnchor(hallwayFaceSession, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, false);
      assert.strictEqual(result.insideCount, 0);
      assert.strictEqual(result.reason, "fuera_de_caja_silla_firebase");
    });

    it("aprueba cliente sentado con rostro dentro de la columna y altura de la silla (fcx en columna, fcy >= 340)", () => {
      const clientSession = {
        chairId: "silla_barbero_puesto2",
        crops: [
          {
            box: [550, 240, 700, 620],
            faceData: {
              boxNorm: [0.25, 0.30, 0.55, 0.70] // fcy ~ 240 + 0.40 * 380 = 392px (>= 340px), fcx ~ 550 + 0.50 * 150 = 625px
            }
          }
        ]
      };

      const result = validateSpatialChairAnchor(clientSession, firebaseChairZone, { width: 1280, height: 720 });
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.insideCount, 1);
      assert.strictEqual(result.reason, "dentro_de_caja_silla");
    });
  });

  describe("Integración con prepareAndFilterSessionForClosure", () => {
    it("descarta la sesión antes del filtro de ruido si las cajas están fuera de la silla de Firebase", async () => {
      const outsideSession = {
        trackId: 999,
        chairId: "silla_barbero_puesto2",
        chairName: "Silla 2",
        isStaff: false,
        boxes: [
          [50, 50, 150, 250],
          [60, 60, 160, 260]
        ],
        photos: [
          { pose: "frontal", hasTwoEyes: true, sharpnessScore: 80 }
        ]
      };

      const stats = { noiseDiscarded: 0 };
      const res = await prepareAndFilterSessionForClosure({
        session: outsideSession,
        trackId: 999,
        durationMinutes: 30,
        minMinutes: 10,
        stats,
        options: { chairZone: firebaseChairZone, width: 1280, height: 720 },
        logVerbal: () => {}
      });

      assert.strictEqual(res.shouldDiscard, true);
      assert.strictEqual(res.reason, "fuera_de_caja_silla_firebase");
      assert.strictEqual(stats.noiseDiscarded, 1);
    });

    it("permite continuar al filtro de ruido si las cajas están dentro de la silla de Firebase", async () => {
      const insideSession = {
        trackId: 1000,
        chairId: "silla_barbero_puesto2",
        chairName: "Silla 2",
        isStaff: false,
        boxes: [
          [579, 221, 701, 563],
          [511, 218, 663, 586]
        ],
        photos: [
          { pose: "frontal", hasTwoEyes: true, sharpnessScore: 80 }
        ],
        embeddings: [
          new Array(512).fill(0.1)
        ]
      };

      const stats = { noiseDiscarded: 0 };
      const res = await prepareAndFilterSessionForClosure({
        session: insideSession,
        trackId: 1000,
        durationMinutes: 30,
        minMinutes: 10,
        stats,
        options: { chairZone: firebaseChairZone, width: 1280, height: 720 },
        logVerbal: () => {}
      });

      assert.strictEqual(res.shouldDiscard, false);
      assert.strictEqual(stats.noiseDiscarded, 0);
    });
  });
});
