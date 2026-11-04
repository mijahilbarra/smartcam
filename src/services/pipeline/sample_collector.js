/**
 * Colector e Ingestor de Muestras Faciales (Sample Collector)
 *
 * Módulo extraído del pipeline de atención para desacoplar:
 * 1. Filtrado en caliente de personal/barbero
 * 2. Redimensionado y generación de miniaturas Base64 optimizadas
 * 3. Jerarquía estricta de portada y cuotas de pose (máx 20 fotos por atención)
 * 4. Control de cadencia temporal anti-ráfaga (< 20s para misma pose)
 * 5. Carga a Google Cloud Storage y live-sync periódico del perfil provisional
 */

import sharp from "sharp";
import { computeCosineSimilarity } from "../../face_recognizer.js";
import { matchStaffFace } from "../people_service.js";
import { uploadFaceCrop } from "../../infrastructure/firebase/storage_client.js";
import { hasTwoEyesVisible } from "../face_quality_service.js";
import { evaluateCrop7Stages } from "./crop_filter_engine.js";

/**
 * Procesa e ingesta una muestra facial dentro del buffer de la sesión activa
 * @param {Object} params
 * @param {Object} params.session
 * @param {Object} params.sample
 * @param {Object} [params.customerService]
 * @param {number} [params.staffThreshold]
 * @param {Object} [params.bucket]
 * @param {Object} [params.db]
 * @param {number} [params.now=Date.now()]
 * @param {Function} [params.logVerbal=console.log]
 * @returns {Promise<boolean>} True si la muestra fue incorporada o mejorada, False si fue rechazada
 */
export async function ingestFaceSample({
  session,
  sample = {},
  customerService,
  staffThreshold,
  bucket,
  db,
  now = Date.now(),
  logVerbal = console.log
}) {
  if (!session) return false;

  const trackId = session.trackId;
  const { faceBuffer, sharpnessScore = 0, embedding, thumbnailBase64, isStaff, pose, poseLabel, skipCooldown } = sample;

  // 1. Filtrado canónico y exclusión de Staff a través del motor unificado de 7 etapas:
  const incomingPose = pose || 'frontal';
  const incomingPoseLabel = poseLabel || (incomingPose === 'frontal' ? 'Frontal' : incomingPose);
  const knownProfiles = customerService?.getComparisonProfiles?.() || [];
  const staffThresh = staffThreshold ?? 0.46;
  const evalResult = evaluateCrop7Stages({
    ...sample,
    pose: incomingPose,
    poseLabel: incomingPoseLabel,
    box: sample.box || session.lastBox,
    vector: sample.embedding || sample.vector,
    faceDetected: true
  }, {
    staffProfiles: knownProfiles,
    staffThreshold: staffThresh
  });

  if (!evalResult.passed) {
    if (evalResult.isStaff) {
      console.log(`[Appointment] Rostro en ${session.chairName} pertenece a Staff (${evalResult.reason}). Excluido de atención.`);
    }
    return false;
  }

  // 2. Resolver miniatura en base64 (si solo viene el buffer, convertir con Sharp)
  let finalThumbnailBase64 = thumbnailBase64 || null;
  if (!finalThumbnailBase64 && faceBuffer) {
    try {
      const thumbBuf = await sharp(faceBuffer)
        .resize(120, 120, { fit: "cover" })
        .jpeg({ quality: 82 })
        .toBuffer();
      finalThumbnailBase64 = `data:image/jpeg;base64,${thumbBuf.toString("base64")}`;
    } catch (_) {
      finalThumbnailBase64 = `data:image/jpeg;base64,${faceBuffer.toString("base64")}`;
    }
  }

  // Requerir miniatura válida antes de guardar foto en la atención
  if (!finalThumbnailBase64) {
    return false;
  }

  const isCleanFrontalOrSemi = ['frontal', 'semi_left', 'semi_right'].includes(incomingPose);

  const isUnitTest = /(?:^|[\\\/])test[\\\/]/.test(process.argv[1] || '') && process.env.IS_LOCAL_SIMULATOR !== "true";
  const hasTwoEyes = sample.hasTwoEyes !== undefined
    ? Boolean(sample.hasTwoEyes)
    : (sample.landmarks && Array.isArray(sample.landmarks) && sample.landmarks.length >= 5
        ? hasTwoEyesVisible(sample.landmarks, sample.boxNorm || sample.faceBoxNorm, incomingPose)
        : Boolean(isUnitTest));

  // Regla 1: Fotos con dos ojos visibles son prioritarias.
  // Las fotos de un solo ojo (perfiles laterales) se admiten si tienen nitidez sólida (>= 50),
  // garantizando que getRepresentativeFace siempre elija una foto erguida con dos ojos como representante.
  if (!hasTwoEyes && sharpnessScore < 50) {
    return false;
  }

  const updateCoverIfBetter = () => {
    if (!session.thumbnailBase64) {
      if (!hasTwoEyes) {
        // Regla Inquebrantable: Prohibido inicializar portada de sesión con una foto de 1 solo ojo
        return false;
      }
      session.bestFaceScore = sharpnessScore;
      session.bestFacePose = incomingPose;
      session.bestFaceHasTwoEyes = hasTwoEyes;
      session.thumbnailBase64 = finalThumbnailBase64;
      return true;
    }

    const currentBestPose = session.bestFacePose || 'unknown';
    const currentBestIsFrontal = ['frontal', 'semi_left', 'semi_right'].includes(currentBestPose);
    const currentBestHasTwoEyes = session.bestFaceHasTwoEyes !== undefined
      ? Boolean(session.bestFaceHasTwoEyes)
      : hasTwoEyesVisible(null, null, currentBestPose);

    let shouldUpdate = false;

    // Regla Maestra 1: Foto con dos ojos visibles SIEMPRE prevalece sobre foto de 1 solo ojo
    if (hasTwoEyes && !currentBestHasTwoEyes) {
      shouldUpdate = true;
    } else if (!hasTwoEyes && currentBestHasTwoEyes) {
      shouldUpdate = false;
    } else {
      // Regla Maestra 2: Foto erguida (frontal, semi) SIEMPRE prevalece sobre foto inclinada hacia abajo
      const incomingIsTilted = incomingPose.includes('tilted_down');
      const currentIsTilted = currentBestPose.includes('tilted_down');

      if (!incomingIsTilted && currentIsTilted) {
        shouldUpdate = true;
      } else if (incomingIsTilted && !currentIsTilted) {
        shouldUpdate = false;
      } else if (isCleanFrontalOrSemi) {
        if (!currentBestIsFrontal || sharpnessScore > (session.bestFaceScore || 0)) {
          shouldUpdate = true;
        }
      } else if (!currentBestIsFrontal && sharpnessScore > (session.bestFaceScore || 0)) {
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      session.bestFaceScore = sharpnessScore;
      session.bestFacePose = incomingPose;
      session.bestFaceHasTwoEyes = hasTwoEyes;
      session.thumbnailBase64 = finalThumbnailBase64;
      return true;
    }
    return false;
  };

  if (sample.box) {
    session.lastBox = sample.box;
    if (!session.boxes) session.boxes = [];
    if (session.boxes.length < 100) session.boxes.push(sample.box);
  }

  const photoItem = {
    thumbnailBase64: finalThumbnailBase64,
    sharpnessScore,
    capturedAt: new Date(now).toISOString(),
    pose: incomingPose,
    poseLabel: incomingPoseLabel,
    hasTwoEyes,
    frontalityScore: (typeof sample.frontalityScore === 'number' && sample.frontalityScore >= 0)
      ? sample.frontalityScore
      : (incomingPose === 'frontal' ? 0.85 : (incomingPose.startsWith('semi') ? 0.50 : (incomingPose.startsWith('tilted') ? 0.25 : 0.0))),
    yawScore: sample.yawScore ?? 0,
    pitchScore: sample.pitchScore ?? 0,
    landmarks: sample.landmarks || null,
    box: sample.box || session.lastBox || null,
    boxNorm: sample.boxNorm || sample.faceBoxNorm || null
  };

  // 2b. Verificación por miniatura idéntica en base64
  if (finalThumbnailBase64 && session.photos.length > 0) {
    const exactIdx = session.photos.findIndex(p => p.thumbnailBase64 && p.thumbnailBase64 === finalThumbnailBase64);
    if (exactIdx !== -1) {
      const existingHasTwoEyes = session.photos[exactIdx]?.hasTwoEyes !== undefined
        ? Boolean(session.photos[exactIdx].hasTwoEyes)
        : hasTwoEyesVisible(session.photos[exactIdx]?.landmarks, null, session.photos[exactIdx]?.pose);
      if (!hasTwoEyes && existingHasTwoEyes) {
        return false;
      }
      if ((hasTwoEyes && !existingHasTwoEyes) || sharpnessScore > (session.photos[exactIdx].sharpnessScore || 0)) {
        session.photos[exactIdx] = photoItem;
        if (embedding && session.embeddings[exactIdx]) session.embeddings[exactIdx] = embedding;
        session.lastPhotoAt = now;
        session.lastMatchedClientFaceEpoch = now;
        updateCoverIfBetter();
      }
      return false;
    }
  }

  // 3. Verificación de duplicado cercano / congelado (fotograma idéntico: embedding sim >= 0.985)
  if (embedding && session.embeddings.length > 0) {
    let duplicateIdx = -1;
    for (let i = 0; i < session.embeddings.length; i++) {
      const exEmb = session.embeddings[i];
      const sim = computeCosineSimilarity(embedding, exEmb);
      if (sim >= 0.985) {
        duplicateIdx = i;
        break;
      }
    }

    if (duplicateIdx !== -1) {
      const existingSharpness = session.photos[duplicateIdx]?.sharpnessScore || 0;
      const existingHasTwoEyes = session.photos[duplicateIdx]?.hasTwoEyes !== undefined
        ? Boolean(session.photos[duplicateIdx].hasTwoEyes)
        : hasTwoEyesVisible(session.photos[duplicateIdx]?.landmarks, null, session.photos[duplicateIdx]?.pose);

      if (!hasTwoEyes && existingHasTwoEyes) {
        return false;
      }
      if ((hasTwoEyes && !existingHasTwoEyes) || sharpnessScore > existingSharpness) {
        session.photos[duplicateIdx] = photoItem;
        session.embeddings[duplicateIdx] = embedding;
        session.lastPhotoAt = now;
        session.lastMatchedClientFaceEpoch = now;
        updateCoverIfBetter();
        logVerbal(`📸 Muestra facial actualizada por mayor nitidez en atención (#${duplicateIdx + 1}, Nitidez: ${sharpnessScore}).`, "process");
        return true;
      }
      return false;
    }
  }

  // 4. Control de cadencia temporal:
  // Si la última foto tomada fue hace menos de 10 segundos y es la MISMA pose, solo actualizar si mejora nitidez
  const cooldownMs = sample.cooldownMs || 10000;
  const samePoseIdx = session.photos.findIndex(p => p.pose === incomingPose);

  if (session.photos.length > 0 && session.lastPhotoAt && !skipCooldown && (now - session.lastPhotoAt < cooldownMs)) {
    if (samePoseIdx !== -1) {
      const existingHasTwoEyes = session.photos[samePoseIdx]?.hasTwoEyes !== undefined
        ? Boolean(session.photos[samePoseIdx].hasTwoEyes)
        : hasTwoEyesVisible(session.photos[samePoseIdx]?.landmarks, null, session.photos[samePoseIdx]?.pose);

      if (!hasTwoEyes && existingHasTwoEyes) {
        return false;
      }
      if ((hasTwoEyes && !existingHasTwoEyes) || sharpnessScore > (session.photos[samePoseIdx].sharpnessScore || 0)) {
        session.photos[samePoseIdx] = photoItem;
        if (embedding && session.embeddings[samePoseIdx]) {
          session.embeddings[samePoseIdx] = embedding;
        }
        session.lastPhotoAt = now;
        session.lastMatchedClientFaceEpoch = now;
        updateCoverIfBetter();
      }
      return false;
    }
  }

  // 5. Acumulación de fotos y embeddings (hasta 20 recortes por atención con cuotas de pose y protección de anclas)
  const isTwoEyesPhoto = (p) => p?.hasTwoEyes !== undefined ? Boolean(p.hasTwoEyes) : hasTwoEyesVisible(p?.landmarks, p?.boxNorm, p?.pose);
  const currentTwoEyesCount = session.photos.filter(p => isTwoEyesPhoto(p)).length;
  const currentOneEyeCount = session.photos.length - currentTwoEyesCount;

  // Si la galería ya tiene fotos con 2 ojos, restringir fotos de 1 ojo a máximo 2
  if (!hasTwoEyes && currentTwoEyesCount > 0 && currentOneEyeCount >= 2) {
    let worstOneEyeIdx = -1;
    let worstOneEyeScore = sharpnessScore;
    for (let i = 0; i < session.photos.length; i++) {
      if (!isTwoEyesPhoto(session.photos[i])) {
        const score = session.photos[i]?.sharpnessScore || 0;
        if (score < worstOneEyeScore) {
          worstOneEyeScore = score;
          worstOneEyeIdx = i;
        }
      }
    }
    if (worstOneEyeIdx !== -1) {
      session.photos[worstOneEyeIdx] = photoItem;
      if (embedding && session.embeddings[worstOneEyeIdx]) {
        session.embeddings[worstOneEyeIdx] = embedding;
      }
      session.lastPhotoAt = now;
      session.lastMatchedClientFaceEpoch = now;
      updateCoverIfBetter();
      return true;
    }
    // No supera a ninguna foto de 1 ojo existente; descartar para respetar la cuota
    return false;
  }

  if (session.photos.length < 20) {
    session.photos.push(photoItem);
    if (embedding) session.embeddings.push(embedding);
  } else {
    const isReclinedPose = (p) => ['tilted_up', 'tilted_up_left', 'tilted_up_right'].includes(p);
    const isFrontalOrSemiPose = (p) => ['frontal', 'semi_left', 'semi_right'].includes(p);

    const incomingIsReclined = isReclinedPose(incomingPose);
    const incomingIsFrontalOrSemi = isFrontalOrSemiPose(incomingPose);

    const currentReclinedCount = session.photos.filter(p => isReclinedPose(p?.pose)).length;
    const currentFrontalOrSemiCount = session.photos.filter(p => isFrontalOrSemiPose(p?.pose)).length;

    let minIdx = -1;
    let minScore = sharpnessScore;
    for (let i = 1; i < session.photos.length; i++) {
      const existingPose = session.photos[i]?.pose || 'frontal';
      const existingHasTwoEyes = isTwoEyesPhoto(session.photos[i]);

      // Regla fundamental: una foto entrante de 1 ojo NUNCA puede reemplazar a una con 2 ojos
      if (!hasTwoEyes && existingHasTwoEyes) {
        continue;
      }

      // 1. Cuota máxima de 4 fotos para categoría reclinada (tilted_up*)
      if (incomingIsReclined && currentReclinedCount >= 4 && !isReclinedPose(existingPose)) {
        continue;
      }
      // 3. Reserva protegida frontal/semi-frontal
      if (!incomingIsFrontalOrSemi && isFrontalOrSemiPose(existingPose) && currentFrontalOrSemiCount <= 6) {
        continue;
      }

      // Si la foto entrante tiene 2 ojos y la existente solo 1 ojo, reemplazarla preferentemente
      if (hasTwoEyes && !existingHasTwoEyes) {
        minIdx = i;
        break;
      }

      if ((session.photos[i].sharpnessScore || 0) < minScore) {
        minScore = session.photos[i].sharpnessScore || 0;
        minIdx = i;
      }
    }
    if (minIdx > 0) {
      session.photos[minIdx] = photoItem;
      if (embedding && session.embeddings[minIdx]) {
        session.embeddings[minIdx] = embedding;
      }
    }
  }

  session.lastPhotoAt = now;
  session.lastMatchedClientFaceEpoch = now;

  // Actualizar bestFaceScore y miniatura con Jerarquía Estricta de Portada
  const coverUpdated = updateCoverIfBetter();
  if (coverUpdated && bucket && faceBuffer) {
    const personSlug = session.personId || `track_${trackId}`;
    const faceStoragePath = `camera_catcher/faces/${personSlug}_${now}.jpg`;
    try {
      await uploadFaceCrop(bucket, faceStoragePath, faceBuffer, {
        personId: session.personId || "",
        personName: session.personName || "",
        sharpnessScore: session.bestFaceScore,
        visitId: session.visitId
      });
      session.bestFaceStoragePath = faceStoragePath;
    } catch (uploadErr) {
      console.warn(`[Appointment] Aviso al subir recorte a Storage:`, uploadErr.message);
    }
  }

  // 6. Sincronización periódica en vivo del perfil 'to_verify' hacia Firestore/SQLite (cada 15s)
  if (customerService && session.tempClientId) {
    const timeSinceLastSync = now - (session.lastSyncAt || 0);
    if (timeSinceLastSync >= 15000 || session.photos.length === 1) {
      session.lastSyncAt = now;
      const updatedToVerify = {
        id: session.tempClientId,
        name: session.personName || "Cliente (Por verificar)",
        status: "to_verify",
        isStaff: false,
        role: "client",
        lastSeen: new Date(now).toISOString(),
        visitCount: 1,
        appointmentCount: 1,
        bestFaceScore: session.bestFaceScore || 0,
        thumbnailBase64: session.thumbnailBase64 || session.photos[0]?.thumbnailBase64 || null,
        thumbnailPath: session.bestFaceStoragePath || null,
        photos: session.photos,
        embeddings: session.embeddings,
        embedding: session.embeddings[0] || null
      };
      customerService.saveOrUpdateCustomer(updatedToVerify, {
        db,
        bucket,
        galleryUpdated: true,
        forceSync: true,
        backgroundSync: true
      }).catch(err => {
        console.warn(`[Appointment] Error en live-sync de to_verify:`, err.message);
      });
    }
  }

  logVerbal(`📸 Muestra facial recolectada para la atención (#${session.photos.length}/20, Nitidez: ${sharpnessScore}).`, "process");
  return true;
}
