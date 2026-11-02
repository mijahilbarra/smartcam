/**
 * Módulo Canónico de Configuración del Pipeline
 * Carga config/pipeline_config.json y permite sobrescritura limpia vía variables de entorno.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_CONFIG_DEFAULTS = {
  faceDetection: {
    minConfidence: 0.70,
    minSharpness: 20.0,
    skinRatioMin: 0.18,
    warmRatioMin: 0.22,
    validFacePoses: [
      "frontal",
      "tilted_up",
      "tilted_down",
      "semi_left",
      "semi_right",
      "tilted_up_left",
      "tilted_up_right",
      "tilted_down_left",
      "tilted_down_right"
    ]
  },
  staffFilter: {
    staffExclusionThreshold: 0.46,
    staffMaxBarberRatio: 0.50
  },
  tracking: {
    iouThreshold: 0.30,
    minChairFrames: 10,
    leaveDebounceFrames: 10,
    minChairDurationMs: 2000,
    leaveDebounceDurationMs: 2000,
    blockInactivityTimeoutMs: 20000
  },
  sessions: {
    emptyChairTimeoutMs: 45000,
    minAppointmentMinutes: 8,
    minAppointmentPhotos: 3,
    maxGalleryPhotos: 20,
    rotationQuorumPhotos: 8,
    rotationQuorumSpanMs: 60000,
    rotationDisjunctionSim: 0.44
  },
  consolidation: {
    maxMergeGapMs: 2700000,
    minMergeGapMs: -300000,
    minSimilarity: 0.42
  },
  biometrics: {
    samePoseThreshold: 0.60,
    crossPoseThreshold: 0.48,
    chimeraThreshold: 0.38
  }
};

function loadRawConfigFile() {
  const possiblePaths = [
    path.resolve(__dirname, "../../config/pipeline_config.json"),
    path.resolve(process.cwd(), "config/pipeline_config.json")
  ];

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`[PipelineConfig] Aviso leyendo ${p}:`, err.message);
    }
  }

  return BASE_CONFIG_DEFAULTS;
}

function buildConfig() {
  const fileConfig = loadRawConfigFile();

  const faceDetection = {
    ...BASE_CONFIG_DEFAULTS.faceDetection,
    ...(fileConfig.faceDetection || {}),
    minConfidence: process.env.MIN_CONFIDENCE ? parseFloat(process.env.MIN_CONFIDENCE) : (fileConfig.faceDetection?.minConfidence ?? BASE_CONFIG_DEFAULTS.faceDetection.minConfidence),
    minSharpness: process.env.MIN_SHARPNESS ? parseFloat(process.env.MIN_SHARPNESS) : (fileConfig.faceDetection?.minSharpness ?? BASE_CONFIG_DEFAULTS.faceDetection.minSharpness)
  };

  const staffFilter = {
    ...BASE_CONFIG_DEFAULTS.staffFilter,
    ...(fileConfig.staffFilter || {}),
    staffExclusionThreshold: process.env.STAFF_EXCLUSION_THRESHOLD ? parseFloat(process.env.STAFF_EXCLUSION_THRESHOLD) : (fileConfig.staffFilter?.staffExclusionThreshold ?? BASE_CONFIG_DEFAULTS.staffFilter.staffExclusionThreshold),
    staffMaxBarberRatio: process.env.STAFF_MAX_BARBER_RATIO ? parseFloat(process.env.STAFF_MAX_BARBER_RATIO) : (fileConfig.staffFilter?.staffMaxBarberRatio ?? BASE_CONFIG_DEFAULTS.staffFilter.staffMaxBarberRatio)
  };

  const tracking = {
    ...BASE_CONFIG_DEFAULTS.tracking,
    ...(fileConfig.tracking || {}),
    iouThreshold: process.env.IOU_THRESHOLD ? parseFloat(process.env.IOU_THRESHOLD) : (fileConfig.tracking?.iouThreshold ?? BASE_CONFIG_DEFAULTS.tracking.iouThreshold),
    minChairFrames: process.env.MIN_CHAIR_FRAMES ? parseInt(process.env.MIN_CHAIR_FRAMES, 10) : (fileConfig.tracking?.minChairFrames ?? BASE_CONFIG_DEFAULTS.tracking.minChairFrames),
    leaveDebounceFrames: process.env.LEAVE_DEBOUNCE_FRAMES ? parseInt(process.env.LEAVE_DEBOUNCE_FRAMES, 10) : (fileConfig.tracking?.leaveDebounceFrames ?? BASE_CONFIG_DEFAULTS.tracking.leaveDebounceFrames),
    minChairDurationMs: process.env.MIN_CHAIR_DURATION_MS ? parseInt(process.env.MIN_CHAIR_DURATION_MS, 10) : (fileConfig.tracking?.minChairDurationMs ?? BASE_CONFIG_DEFAULTS.tracking.minChairDurationMs),
    leaveDebounceDurationMs: process.env.LEAVE_DEBOUNCE_DURATION_MS ? parseInt(process.env.LEAVE_DEBOUNCE_DURATION_MS, 10) : (fileConfig.tracking?.leaveDebounceDurationMs ?? BASE_CONFIG_DEFAULTS.tracking.leaveDebounceDurationMs),
    blockInactivityTimeoutMs: process.env.BLOCK_INACTIVITY_TIMEOUT_MS ? parseInt(process.env.BLOCK_INACTIVITY_TIMEOUT_MS, 10) : (fileConfig.tracking?.blockInactivityTimeoutMs ?? BASE_CONFIG_DEFAULTS.tracking.blockInactivityTimeoutMs)
  };

  const sessions = {
    ...BASE_CONFIG_DEFAULTS.sessions,
    ...(fileConfig.sessions || {}),
    emptyChairTimeoutMs: process.env.EMPTY_CHAIR_TIMEOUT_MS ? parseInt(process.env.EMPTY_CHAIR_TIMEOUT_MS, 10) : (fileConfig.sessions?.emptyChairTimeoutMs ?? BASE_CONFIG_DEFAULTS.sessions.emptyChairTimeoutMs),
    minAppointmentMinutes: process.env.MIN_APPOINTMENT_MINUTES ? parseInt(process.env.MIN_APPOINTMENT_MINUTES, 10) : (fileConfig.sessions?.minAppointmentMinutes ?? BASE_CONFIG_DEFAULTS.sessions.minAppointmentMinutes),
    minAppointmentPhotos: process.env.MIN_APPOINTMENT_PHOTOS ? parseInt(process.env.MIN_APPOINTMENT_PHOTOS, 10) : (fileConfig.sessions?.minAppointmentPhotos ?? BASE_CONFIG_DEFAULTS.sessions.minAppointmentPhotos),
    maxGalleryPhotos: process.env.MAX_GALLERY_PHOTOS ? parseInt(process.env.MAX_GALLERY_PHOTOS, 10) : (fileConfig.sessions?.maxGalleryPhotos ?? BASE_CONFIG_DEFAULTS.sessions.maxGalleryPhotos),
    rotationQuorumPhotos: process.env.ROTATION_QUORUM_PHOTOS ? parseInt(process.env.ROTATION_QUORUM_PHOTOS, 10) : (fileConfig.sessions?.rotationQuorumPhotos ?? BASE_CONFIG_DEFAULTS.sessions.rotationQuorumPhotos),
    rotationQuorumSpanMs: process.env.ROTATION_QUORUM_SPAN_MS ? parseInt(process.env.ROTATION_QUORUM_SPAN_MS, 10) : (fileConfig.sessions?.rotationQuorumSpanMs ?? BASE_CONFIG_DEFAULTS.sessions.rotationQuorumSpanMs),
    rotationDisjunctionSim: process.env.ROTATION_DISJUNCTION_SIM ? parseFloat(process.env.ROTATION_DISJUNCTION_SIM) : (fileConfig.sessions?.rotationDisjunctionSim ?? BASE_CONFIG_DEFAULTS.sessions.rotationDisjunctionSim)
  };

  const consolidation = {
    ...BASE_CONFIG_DEFAULTS.consolidation,
    ...(fileConfig.consolidation || {}),
    maxMergeGapMs: process.env.MAX_MERGE_GAP_MS ? parseInt(process.env.MAX_MERGE_GAP_MS, 10) : (fileConfig.consolidation?.maxMergeGapMs ?? BASE_CONFIG_DEFAULTS.consolidation.maxMergeGapMs),
    minMergeGapMs: process.env.MIN_MERGE_GAP_MS ? parseInt(process.env.MIN_MERGE_GAP_MS, 10) : (fileConfig.consolidation?.minMergeGapMs ?? BASE_CONFIG_DEFAULTS.consolidation.minMergeGapMs),
    minSimilarity: process.env.MIN_SIMILARITY ? parseFloat(process.env.MIN_SIMILARITY) : (fileConfig.consolidation?.minSimilarity ?? BASE_CONFIG_DEFAULTS.consolidation.minSimilarity)
  };

  const biometrics = {
    ...BASE_CONFIG_DEFAULTS.biometrics,
    ...(fileConfig.biometrics || {}),
    samePoseThreshold: process.env.SAME_POSE_THRESHOLD ? parseFloat(process.env.SAME_POSE_THRESHOLD) : (fileConfig.biometrics?.samePoseThreshold ?? BASE_CONFIG_DEFAULTS.biometrics.samePoseThreshold),
    crossPoseThreshold: process.env.CROSS_POSE_THRESHOLD ? parseFloat(process.env.CROSS_POSE_THRESHOLD) : (fileConfig.biometrics?.crossPoseThreshold ?? BASE_CONFIG_DEFAULTS.biometrics.crossPoseThreshold),
    chimeraThreshold: process.env.CHIMERA_THRESHOLD ? parseFloat(process.env.CHIMERA_THRESHOLD) : (fileConfig.biometrics?.chimeraThreshold ?? BASE_CONFIG_DEFAULTS.biometrics.chimeraThreshold)
  };

  const config = {
    faceDetection: Object.freeze(faceDetection),
    staffFilter: Object.freeze(staffFilter),
    tracking: Object.freeze(tracking),
    sessions: Object.freeze(sessions),
    consolidation: Object.freeze(consolidation),
    biometrics: Object.freeze(biometrics)
  };

  return Object.freeze(config);
}

export const PIPELINE_CONFIG = buildConfig();

export const FACE_DETECTION_CONFIG = PIPELINE_CONFIG.faceDetection;
export const STAFF_FILTER_CONFIG = PIPELINE_CONFIG.staffFilter;
export const TRACKING_CONFIG = PIPELINE_CONFIG.tracking;
export const SESSIONS_CONFIG = PIPELINE_CONFIG.sessions;
export const CONSOLIDATION_CONFIG = PIPELINE_CONFIG.consolidation;
export const BIOMETRICS_CONFIG = PIPELINE_CONFIG.biometrics;

export default PIPELINE_CONFIG;
