/**
 * Motor Unificado de Filtrado de Recortes y Biometría (Las 7 Etapas Canónicas)
 * 
 * Fuente Única de la Verdad para:
 * 1. Modo 2 Pasos (Benchmark de Cosecha / step2_causal_replay.js)
 * 2. Modo Streaming (Simulador Local / processes.js)
 * 3. Modo Producción (Cámara en Vivo Neolink / processes.js)
 */

import { isStandingPosture } from "../../core/geometry.js";
import { hasTwoEyesVisible, computeFrontalityScore } from "../face_quality_service.js";
import { matchStaffFace } from "../people_service.js";
import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";
import { blobToVector } from "../../infrastructure/storage/sqlite_client.js";

const DEFAULT_MIN_SHARPNESS = PIPELINE_CONFIG.faceDetection?.minSharpness ?? 20;
const DEFAULT_STAFF_THRESHOLD = PIPELINE_CONFIG.biometrics?.staffThreshold ?? 0.46;
const DEFAULT_VALID_POSES = PIPELINE_CONFIG.faceDetection?.validFacePoses ?? [
  'frontal', 'semi_left', 'semi_right', 'tilted_down', 'tilted_down_left', 'tilted_down_right'
];

/**
 * Normaliza los datos de entrada ya sea que provengan de un recorte en vivo (processes.js)
 * o de un registro cosechado en SQLite (step2_causal_replay.js).
 */
function normalizeCropInput(cropInput) {
  let box = null;
  if (cropInput.box) {
    box = Array.isArray(cropInput.box) ? cropInput.box : null;
  } else if (cropInput.box_json) {
    try {
      box = typeof cropInput.box_json === "string" ? JSON.parse(cropInput.box_json) : cropInput.box_json;
    } catch (_) {}
  }

  let vector = null;
  const rawVec = cropInput.vector || cropInput.embedding;
  if (Array.isArray(rawVec)) {
    vector = rawVec;
  } else if (rawVec && ArrayBuffer.isView(rawVec)) {
    vector = Array.from(rawVec);
  } else if (cropInput.embedding_blob) {
    vector = blobToVector(cropInput.embedding_blob);
  }

  let sharpness = Number(cropInput.sharpnessScore ?? cropInput.sharpness_score ?? cropInput.quality?.sharpnessScore ?? 0);
  let pose = cropInput.pose || cropInput.quality?.pose || "unknown";
  let poseLabel = cropInput.poseLabel || cropInput.pose_label || cropInput.quality?.poseLabel || pose;
  let skinRatio = Number(cropInput.skinRatio ?? cropInput.skin_ratio ?? cropInput.quality?.skinRatio ?? 0);
  let warmRatio = Number(cropInput.warmRatio ?? cropInput.warm_ratio ?? cropInput.quality?.warmRatio ?? 0);
  const explicitFaceDetected = cropInput.faceDetected !== undefined
    ? cropInput.faceDetected
    : (cropInput.face_detected !== undefined ? cropInput.face_detected === 1 : undefined);
  let faceDetected = Boolean(
    explicitFaceDetected ??
    cropInput.quality?.isValid ??
    (cropInput.faceBuffer || cropInput.thumbnailBase64 || cropInput.embedding || cropInput.vector || vector)
  );

  let landmarks = null;
  if (cropInput.landmarks) {
    landmarks = cropInput.landmarks;
  } else if (cropInput.landmarks_json) {
    try {
      landmarks = typeof cropInput.landmarks_json === "string" ? JSON.parse(cropInput.landmarks_json) : cropInput.landmarks_json;
    } catch (_) {}
  } else if (cropInput.quality?.landmarks) {
    landmarks = cropInput.quality.landmarks;
  }

  let faceBoxNorm = null;
  if (cropInput.faceBoxNorm) {
    faceBoxNorm = cropInput.faceBoxNorm;
  } else if (cropInput.face_box_json) {
    try {
      const parsed = typeof cropInput.face_box_json === "string" ? JSON.parse(cropInput.face_box_json) : cropInput.face_box_json;
      if (Array.isArray(parsed) && parsed.length === 4) faceBoxNorm = parsed;
    } catch (_) {}
  } else if (cropInput.quality?.faceBoxNorm) {
    faceBoxNorm = cropInput.quality.faceBoxNorm;
  }

  let thumbnailBase64 = cropInput.thumbnailBase64 || cropInput.faceThumbnailBase64 || null;
  if (!thumbnailBase64 && cropInput.face_crop_blob) {
    thumbnailBase64 = `data:image/jpeg;base64,${cropInput.face_crop_blob.toString("base64")}`;
  }

  return {
    raw: cropInput,
    box,
    vector,
    sharpness,
    pose,
    poseLabel,
    skinRatio,
    warmRatio,
    faceDetected,
    landmarks,
    faceBoxNorm,
    thumbnailBase64,
    chairId: cropInput.chairId || cropInput.chair_id || cropInput.raw?.chair_id || null,
    yawScore: cropInput.yawScore ?? cropInput.yaw_score ?? cropInput.quality?.yawScore ?? 0,
    pitchScore: cropInput.pitchScore ?? cropInput.pitch_score ?? cropInput.quality?.pitchScore ?? 0,
    frontalityScore: cropInput.frontalityScore ?? cropInput.frontality_score ?? cropInput.quality?.frontalityScore ?? 0
  };
}

/**
 * Evalúa un recorte de persona a través de la Cascada Canónica de 7 Etapas.
 *
 * @param {Object} cropInput - Recorte en memoria o registro SQLite
 * @param {Object} options
 * @param {Array<Object>} [options.staffProfiles] - Perfiles de Staff/Barbero
 * @param {number} [options.staffThreshold=0.46] - Umbral coseno de exclusión de staff
 * @param {number} [options.minSharpness=20] - Umbral de nitidez mínima
 * @param {Array<string>} [options.validPoses] - Lista de poses válidas
 * @param {number} [options.imgHeight=720] - Altura del frame
 * @returns {Object} Resultado de la evaluación con diagnóstico por etapa
 */
export function evaluateCrop7Stages(cropInput, options = {}) {
  const norm = normalizeCropInput(cropInput);
  const minSharpness = options.minSharpness ?? DEFAULT_MIN_SHARPNESS;
  const staffThreshold = options.staffThreshold ?? DEFAULT_STAFF_THRESHOLD;
  const validPoses = options.validPoses ?? DEFAULT_VALID_POSES;
  const staffProfiles = options.staffProfiles || [];
  const imgHeight = options.imgHeight || 720;

  // Etapa 1: Postura Física y Anclaje Espacial
  const isChairZone = Boolean(norm.chairId && (norm.chairId.includes('silla') || norm.chairId.includes('chair')));
  const isStanding = isChairZone ? false : (norm.box ? isStandingPosture(norm.box, imgHeight) : false);

  // Filtro de transeúntes de fondo (en puerta o calle exterior)
  if (norm.box && Array.isArray(norm.box) && norm.box.length >= 4) {
    const boxTop = norm.box[1];
    const boxH = norm.box[3] - norm.box[1];
    const boxW = norm.box[2] - norm.box[0];
    if (boxTop < 260 && (boxH / Math.max(1, boxW)) > 1.6) {
      return {
        passed: false,
        stage: 1,
        reason: "transeunte_fondo_exterior",
        isStanding: true,
        isStaff: false,
        faceData: null
      };
    }
  }

  // Etapa 2: Detección facial y Vector 512D (si se proporciona)
  if (!norm.faceDetected || (norm.vector && norm.vector.length !== 512)) {
    return {
      passed: false,
      stage: 2,
      reason: "sin_rostro_o_vector_invalido",
      isStanding,
      isStaff: false,
      faceData: null
    };
  }

  // Etapa 3: Textura Humana y Filtro Anti-Objetos (YCbCr piel)
  const skinRatioMin = PIPELINE_CONFIG.faceDetection?.skinRatioMin ?? 0.18;
  const warmRatioMin = PIPELINE_CONFIG.faceDetection?.warmRatioMin ?? 0.22;
  const hasSkinData = (norm.raw.skinRatio !== undefined || norm.raw.skin_ratio !== undefined || norm.raw.warmRatio !== undefined || norm.raw.warm_ratio !== undefined || norm.raw.quality?.skinRatio !== undefined);
  const isHuman = !hasSkinData || (norm.skinRatio >= skinRatioMin || norm.warmRatio >= warmRatioMin);
  if (!isHuman) {
    return {
      passed: false,
      stage: 3,
      reason: "textura_no_humana_o_pantalla",
      isStanding,
      isStaff: false,
      faceData: null
    };
  }

  // Etapa 4: Nitidez Mínima
  if (norm.sharpness < minSharpness) {
    return {
      passed: false,
      stage: 4,
      reason: `nitidez_insuficiente (${norm.sharpness.toFixed(1)} < ${minSharpness})`,
      isStanding,
      isStaff: false,
      faceData: null
    };
  }

  // Etapa 5: Evaluación Anatómica de 2 Ojos y Poses Válidas
  let pose = norm.pose;
  let poseLabel = norm.poseLabel;
  const hasTwoEyes = (norm.landmarks || norm.faceBoxNorm)
    ? hasTwoEyesVisible(norm.landmarks, norm.faceBoxNorm, pose)
    : (cropInput.hasTwoEyes !== undefined ? Boolean(cropInput.hasTwoEyes) : true);

  // Recalificación anatómica: si tiene 2 ojos visibles en profile, es semi-perfil
  if (hasTwoEyes) {
    if (pose === "profile_right") {
      pose = "semi_right";
      poseLabel = "Semi-perfil Derecho";
    } else if (pose === "profile_left") {
      pose = "semi_left";
      poseLabel = "Semi-perfil Izquierdo";
    }
  }

  const isValidPose = validPoses.includes(pose) || pose.startsWith('angle_') || pose.startsWith('profile_');
  const poseMinSharpness = (pose === "tilted_down_left" || pose === "tilted_down_right") ? 35 : minSharpness;

  if (!isValidPose || norm.sharpness < poseMinSharpness) {
    return {
      passed: false,
      stage: 5,
      reason: `pose_invalida_o_nitidez_baja (${pose}, score=${norm.sharpness.toFixed(1)})`,
      isStanding,
      isStaff: false,
      faceData: null
    };
  }

  // Etapa 6: Clasificación Erguida vs Reclinada
  const UPRIGHT_POSES = ['frontal', 'semi_left', 'semi_right'];
  const isUpright = UPRIGHT_POSES.includes(pose);

  // Etapa 7: Exclusión de Barbero / Staff (Postura de pie + matchStaffFace)
  const isExplicitStaff = norm.raw.isStaff === true;
  let staffCheck = { isStaffMatch: isExplicitStaff, maxStaffSim: isExplicitStaff ? 1.0 : 0 };
  if (!isExplicitStaff && norm.vector && norm.vector.length === 512 && staffProfiles.length > 0) {
    staffCheck = matchStaffFace(norm.vector, staffProfiles, staffThreshold, { pose });
  }
  const isStaffMatch = isExplicitStaff || staffCheck.isStaffMatch || staffCheck.maxStaffSim >= staffThreshold;

  // REGLA FÍSICA INQUEBRANTABLE:
  // Si la persona está de pie junto a la silla (isStanding) O coincide facialmente con el staff,
  // es personal/barbero y NUNCA se asocia como cliente en la silla.
  if (isStanding || isStaffMatch) {
    return {
      passed: false,
      stage: 7,
      reason: isStanding ? "postura_de_pie_excluida_de_silla" : `staff_detectado (sim: ${staffCheck.maxStaffSim.toFixed(3)})`,
      isStanding,
      isStaff: true,
      staffCheck,
      faceData: null
    };
  }

  return {
    passed: true,
    stage: 7,
    isStanding: false,
    isStaff: false,
    staffCheck,
    faceData: {
      vector: norm.vector,
      sharpnessScore: norm.sharpness,
      pose,
      poseLabel,
      landmarks: norm.landmarks,
      hasTwoEyes,
      isUpright,
      isAnatomical: Boolean(hasTwoEyes || isUpright),
      boxNorm: norm.faceBoxNorm,
      thumbnailBase64: norm.thumbnailBase64,
      frontalityScore: norm.frontalityScore,
      yawScore: norm.yawScore,
      pitchScore: norm.pitchScore
    }
  };
}
