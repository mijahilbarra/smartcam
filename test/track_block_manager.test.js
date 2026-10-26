import test from "node:test";
import assert from "node:assert/strict";
import { TrackBlockManager, extractPoseCategory } from "../src/services/pipeline/track_block_manager.js";

test("TrackBlockManager - Bloques de TrackId", async (t) => {
  await t.test("Descarta bloque de barbero de pie con alta similitud de staff", () => {
    const manager = new TrackBlockManager({
      staffThreshold: 0.46,
      staffProfiles: [{ name: "Barbero 1", vector: new Array(512).fill(0.1) }]
    });

    // Ingestar muestras del barbero
    manager.ingestTrackSample({
      trackId: 101,
      chairId: "chair_1",
      timestampEpoch: 1000,
      videoSecond: 1,
      box: [100, 50, 250, 400], // De pie
      faceData: {
        vector: new Array(512).fill(0.1), // Coincide con staff
        sharpnessScore: 65,
        pose: "frontal",
        hasTwoEyes: true
      }
    });

    const result = manager.evaluateAndCloseBlock(101, 2000);
    assert.equal(result.valid, false);
    assert.equal(result.verdict, "DISCARDED_BARBER");
  });

  await t.test("Descarta bloque de nuca / pelo sin rostros anatómicos con dos ojos", () => {
    const manager = new TrackBlockManager();

    // Ingestar 3 muestras de nuca (pose tilted_down_left, sin dos ojos)
    for (let i = 0; i < 3; i++) {
      manager.ingestTrackSample({
        trackId: 202,
        chairId: "chair_1",
        timestampEpoch: 10000 + i * 5000,
        videoSecond: 10 + i * 5,
        box: [200, 260, 400, 520], // Sentado (boxTop = 260 > 0.22 * 720)
        faceData: {
          vector: new Array(512).fill(0.05),
          sharpnessScore: 67,
          pose: "tilted_down_left",
          hasTwoEyes: false // Nuca/oreja
        }
      });
    }

    const result = manager.evaluateAndCloseBlock(202, 30000);
    assert.equal(result.valid, false);
    assert.equal(result.verdict, "DISCARDED_NO_ANATOMICAL_FACE");
    assert.match(result.reason, /falso positivo de nuca\/pelo/);
  });

  await t.test("Descarta bloque efímero de paso (< 90s con pocas fotos)", () => {
    const manager = new TrackBlockManager();

    manager.ingestTrackSample({
      trackId: 303,
      chairId: "chair_1",
      timestampEpoch: 5000,
      videoSecond: 5,
      box: [200, 260, 400, 520], // Sentado
      faceData: {
        vector: new Array(512).fill(0.05),
        sharpnessScore: 55,
        pose: "frontal",
        hasTwoEyes: true
      }
    });

    const result = manager.evaluateAndCloseBlock(303, 15000); // 10 segundos
    assert.equal(result.valid, false);
    assert.equal(result.verdict, "DISCARDED_EPHEMERAL_PASSING");
  });

  await t.test("Aprueba cliente humano sentado con rostros anatómicos válidos", () => {
    const manager = new TrackBlockManager();

    // 15 minutos de atención con fotos frontales
    const start = 100000;
    for (let i = 0; i < 10; i++) {
      manager.ingestTrackSample({
        trackId: 404,
        chairId: "chair_1",
        timestampEpoch: start + i * 60000,
        videoSecond: 100 + i * 60,
        box: [200, 260, 400, 520], // Sentado
        faceData: {
          vector: new Array(512).fill(0.2),
          sharpnessScore: 75,
          pose: "frontal",
          hasTwoEyes: true
        }
      });
    }

    const result = manager.evaluateAndCloseBlock(404, start + 600000);
    assert.equal(result.valid, true);
    assert.equal(result.verdict, "CONFIRMED_CLIENT_BLOCK");
    assert.equal(result.block.trackId, 404);
    assert.equal(result.block.anatomicalFacesCount, 10);
    assert.equal(result.block.durationMinutes, 9);
  });

  await t.test("Aprueba cliente sentado aunque el barbero se asome en fotos esporádicas y purga las fotos del barbero", () => {
    const staffVector = new Array(512).fill(0);
    staffVector[0] = 1.0;
    const clientVector = new Array(512).fill(0);
    clientVector[1] = 1.0;

    const manager = new TrackBlockManager({
      staffThreshold: 0.46,
      staffProfiles: [{ name: "Barbero 1", vector: staffVector }]
    });

    const start = 100000;
    // 10 muestras del cliente sentado
    for (let i = 0; i < 10; i++) {
      manager.ingestTrackSample({
        trackId: 505,
        chairId: "chair_1",
        timestampEpoch: start + i * 60000,
        videoSecond: 100 + i * 60,
        box: [200, 260, 400, 520], // Sentado
        faceData: {
          vector: clientVector,
          sharpnessScore: 70,
          pose: "frontal",
          hasTwoEyes: true,
          thumbnailBase64: "data:image/jpeg;base64,client_thumb"
        }
      });
    }

    // 2 muestras donde el barbero se inclina sobre el cliente
    for (let i = 0; i < 2; i++) {
      manager.ingestTrackSample({
        trackId: 505,
        chairId: "chair_1",
        timestampEpoch: start + 600000 + i * 1000,
        videoSecond: 700 + i,
        box: [200, 260, 400, 520],
        faceData: {
          vector: staffVector, // Barbero
          sharpnessScore: 95, // Más nítido que el cliente
          pose: "frontal",
          hasTwoEyes: true
        }
      });
    }

    const result = manager.evaluateAndCloseBlock(505, start + 620000);
    assert.equal(result.valid, true, "El bloque del cliente debe confirmarse por mayoría");
    assert.equal(result.verdict, "CONFIRMED_CLIENT_BLOCK");
    assert.equal(result.block.trackId, 505);
    // Verificar que las fotos del barbero fueron purgadas de crops y photos
    assert.equal(result.block.crops.length, 10, "Deben quedar solo las 10 fotos del cliente");
    assert.equal(result.block.crops.every(c => !c.isStaffMatch), true, "Ningún crop debe ser del staff");
    assert.equal(result.block.photos.length, 10);
  });

  await t.test("No acumula ni confirma muestras del acompañante en sofá de espera (track_id: 3325)", () => {
    const quadrantsFixture = [
      {
        id: "silla_barbero_puesto2",
        name: "Silla de barbero (Frente)",
        type: "barber_chair",
        boxNorm: [0.48, 0.34, 1.0, 0.74]
      }
    ];

    const manager = new TrackBlockManager({
      quadrants: quadrantsFixture,
      width: 1280,
      height: 720
    });

    // Ingestar muestra del acompañante (caja en el sofá a la izquierda: [363, 217, 614, 499], insideRatio=38.7% < 50%)
    manager.ingestTrackSample({
      trackId: 3325,
      chairId: "silla_barbero_puesto2",
      timestampEpoch: 25810000,
      videoSecond: 25810,
      box: [363, 217, 614, 499],
      faceData: {
        vector: new Array(512).fill(0.2),
        sharpnessScore: 70,
        pose: "frontal",
        hasTwoEyes: true
      }
    });

    // La muestra con insideRatio < 0.50 no debe acumularse en activeBlocks
    assert.equal(manager.activeBlocks.has(3325), false, "Muestra con insideRatio < 0.50 no debe acumularse");

    const result = manager.evaluateAndCloseBlock(3325, 25820000);
    assert.equal(result.valid, false);
    assert.equal(result.verdict, "NOT_FOUND");
  });

  await t.test("Multi-Pose Representative Bank acumula los mejores representantes por posición", () => {
    // 1. Validar extractPoseCategory
    assert.equal(extractPoseCategory("frontal"), "frontal");
    assert.equal(extractPoseCategory("semi_left"), "left");
    assert.equal(extractPoseCategory("profile_left"), "left");
    assert.equal(extractPoseCategory("tilted_down_left"), "tilted");
    assert.equal(extractPoseCategory("semi_right"), "right");
    assert.equal(extractPoseCategory("profile_right"), "right");
    assert.equal(extractPoseCategory("tilted_down_right"), "tilted");
    assert.equal(extractPoseCategory("tilted_down"), "tilted");
    assert.equal(extractPoseCategory("tilted_up"), "tilted");

    const manager = new TrackBlockManager();
    const trackId = 505;

    // Ingestar muestra frontal baja nitidez
    manager.ingestTrackSample({
      trackId,
      chairId: "chair_1",
      timestampEpoch: 1000,
      videoSecond: 1,
      box: [200, 260, 400, 520],
      faceData: {
        vector: new Array(512).fill(0.1),
        sharpnessScore: 60,
        pose: "frontal",
        hasTwoEyes: true
      }
    });

    // Ingestar muestra frontal mayor nitidez -> debe reemplazar slot frontal
    manager.ingestTrackSample({
      trackId,
      chairId: "chair_1",
      timestampEpoch: 2000,
      videoSecond: 2,
      box: [200, 260, 400, 520],
      faceData: {
        vector: new Array(512).fill(0.2),
        sharpnessScore: 85,
        pose: "frontal",
        hasTwoEyes: true
      }
    });

    // Ingestar perfil izquierdo
    manager.ingestTrackSample({
      trackId,
      chairId: "chair_1",
      timestampEpoch: 3000,
      videoSecond: 3,
      box: [200, 260, 400, 520],
      faceData: {
        vector: new Array(512).fill(0.3),
        sharpnessScore: 78,
        pose: "profile_left",
        hasTwoEyes: true
      }
    });

    // Ingestar perfil derecho
    manager.ingestTrackSample({
      trackId,
      chairId: "chair_1",
      timestampEpoch: 4000,
      videoSecond: 4,
      box: [200, 260, 400, 520],
      faceData: {
        vector: new Array(512).fill(0.4),
        sharpnessScore: 82,
        pose: "semi_right",
        hasTwoEyes: true
      }
    });

    const block = manager.activeBlocks.get(trackId);
    assert.ok(block.representatives, "block.representatives debe existir");
    assert.equal(block.representatives.frontal.score, 85);
    assert.equal(block.representatives.frontal.vector[0], 0.2);
    assert.equal(block.representatives.left.score, 78);
    assert.equal(block.representatives.left.vector[0], 0.3);
    assert.equal(block.representatives.right.score, 82);
    assert.equal(block.representatives.right.vector[0], 0.4);
    assert.equal(block.representatives.tilted, null);

    // Retrocompatibilidad
    assert.equal(block.bestFaceScore, 85);
    assert.equal(block.bestFaceVector[0], 0.2);
  });
});
