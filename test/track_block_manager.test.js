import test from "node:test";
import assert from "node:assert/strict";
import { TrackBlockManager } from "../src/services/pipeline/track_block_manager.js";

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
});
