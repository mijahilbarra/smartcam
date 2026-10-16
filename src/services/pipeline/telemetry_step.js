import { telemetryStream } from "../../infrastructure/streaming/telemetry_stream.js";
import { getSystemMemoryMetrics } from "../../core/system_metrics.js";

/**
 * 9. Emisión de telemetría de baja latencia por Server-Sent Events (SSE).
 */
export function broadcastTelemetry({ docId, mlResult, activeTracks = [], identifiedPeople = [], occupancy }) {
  const frameWidth = mlResult.origWidth || mlResult.imageDimensions?.width || 2304;
  const frameHeight = mlResult.origHeight || mlResult.imageDimensions?.height || 1296;

  telemetryStream.broadcast({
    type: "yolo_telemetry",
    docId,
    inferenceMs: mlResult.inferenceMs,
    frameWidth,
    frameHeight,
    humanBoxes: (mlResult.rawDetections || []).filter(d => d.class === "person").map(d => d.box),
    rawDetections: mlResult.rawDetections || [],
    tracks: activeTracks
      .filter(t => (t.missedFrames || 0) <= 1)
      .map(t => ({
        trackId: t.trackId,
        box: t.box,
        boxNorm: t.boxNorm || [
          Number((t.box[1] / frameHeight).toFixed(4)),
          Number((t.box[0] / frameWidth).toFixed(4)),
          Number((t.box[3] / frameHeight).toFixed(4)),
          Number((t.box[2] / frameWidth).toFixed(4))
        ],
        centroid: t.centroid,
        confidence: t.confidence,
        quadrant: t.isStaffHint
          ? (t.currentQuadrant?.name ? `Atendiendo (${t.currentQuadrant.name})` : "Barbero / Staff")
          : (t.currentQuadrant?.label || t.currentQuadrant?.name || null),
        quadrantId: t.currentQuadrant?.id || null,
        identity: t.identity ? {
          name: t.identity.name,
          isStaff: t.identity.isStaff === true || t.isStaffHint === true,
          isFrequent: t.identity.isFrequent === true,
          visitCount: t.identity.visitCount || 1,
          confidence: t.identity.confidence || 0
        } : (t.isStaffHint ? {
          name: "Barbero / Staff",
          isStaff: true,
          confidence: t.confidence
        } : null),
        sharpnessScore: t.sharpnessScore || 0,
        missedFrames: t.missedFrames || 0
      })),
    quadrants: mlResult.quadrants || [],
    peopleIdentified: identifiedPeople !== null
      ? (identifiedPeople || []).map(p => ({
          name: p.name,
          isStaff: p.isStaff === true,
          isFrequent: p.isFrequent === true,
          visitCount: p.visitCount || 1,
          box: p.box
        }))
      : undefined,
    occupancy,
    memory: getSystemMemoryMetrics()
  });
}
