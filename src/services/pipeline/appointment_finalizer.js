/**
 * Finalizador y Consolidador de Atenciones (Appointment Finalizer)
 *
 * Módulo extraído del pipeline de atención para desacoplar:
 * 1. Consolidación cronológica de tramos contiguos en la misma silla (continuidad del cliente)
 * 2. Formalización final del cliente (recurrente vs nuevo)
 * 3. Persistencia de la atención (Appointment) en SQLite y Firestore
 * 4. Generación de auditorías de fotos antes y después del cierre
 */

import { PIPELINE_CONFIG } from "../../core/pipeline_config.js";
import { computeCosineSimilarity } from "../../face_recognizer.js";
import { computeSetToSetMetrics } from "./biometrics_math.js";
import { mergePhotosAndEmbeddings, deduplicateSessionPhotos } from "./gallery_curator.js";
import { computeFrontalityScore, hasTwoEyesVisible, isValidFaceGeometry } from "../face_quality_service.js";
import {
  findChimeraSplit,
  splitChimeraSession,
  prepareAndFilterSessionForClosure,
  validateBiometricsForFinalization,
  validatePostConsolidationNoise,
  isCapeBarrierSeparating
} from "./closure_rules.js";

export const isVector = (v) => Array.isArray(v) || ArrayBuffer.isView(v);

/**
 * Extractor de Rostro Representante para un conjunto de fotos y vectores.
 * Elige la mejor foto por frontalityScore (dos ojos visibles) combinada con nitidez.
 * Prioriza poses con dos ojos visibles (hasTwoEyes = true).
 * Si ninguna foto supera dos ojos visibles, selecciona la más nítida pero marca
 * el segmento con hasFrontalAnchor = false.
 *
 * @param {Array<Object>} photos
 * @param {Array<Array<number>|Object>} embeddings
 * @returns {{ photo: Object, vector: Array<number>, score: number, frontalityScore: number, hasFrontalAnchor: boolean }|null}
 */
export function getRepresentativeFace(photos = [], embeddings = []) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return null;
  }

  const MIN_FRONTAL_SCORE = 0.20;

  // Emparejar cada foto con su vector, nitidez y frontalidad
  const candidates = [];
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    if (!photo) continue;

    const embEntry = embeddings?.[i];
    let vector = isVector(embEntry)
      ? embEntry
      : (embEntry?.vector || photo?.embedding || photo?.vector || null);

    // Fallback: si solo hay 1 embedding disponible para todas las fotos
    if (!vector && embeddings && embeddings.length === 1) {
      const single = embeddings[0];
      vector = isVector(single) ? single : (single?.vector || null);
    }

    if (!vector) continue;

    const score = Number(photo.sharpnessScore ?? photo.score ?? 0);
    const pose = photo.pose || photo.poseLabel || 'frontal';

    const hasValidLandmarks = Array.isArray(photo.landmarks) && photo.landmarks.length === 5 && isValidFaceGeometry(photo.landmarks, photo.boxNorm);
    const hasTwoEyes = photo.hasTwoEyes !== undefined
      ? Boolean(photo.hasTwoEyes)
      : (hasValidLandmarks ? hasTwoEyesVisible(photo.landmarks, photo.boxNorm, pose) : false);

    let frontality = typeof photo.frontalityScore === 'number' ? photo.frontalityScore : null;
    if (frontality === null && hasValidLandmarks) {
      frontality = computeFrontalityScore(photo.landmarks, photo.boxNorm, photo.yawScore, photo.pitchScore);
    }
    // Calibración anatómica de frontalidad:
    // Poses frontales y semi-perfiles con 2 ojos y landmarks válidos son anclas de identidad superiores a poses reclinadas/tilted
    if (hasValidLandmarks && hasTwoEyes) {
      if (pose === 'frontal') {
        frontality = Math.max(frontality ?? 0, 0.85);
      } else if (pose === 'semi_left' || pose === 'semi_right') {
        frontality = Math.max(frontality ?? 0, 0.50);
      } else if (pose.startsWith('tilted')) {
        frontality = Math.min(frontality ?? 0.25, 0.30);
      }
    } else {
      frontality = 0.0;
    }

    candidates.push({
      photo,
      vector,
      score,
      pose,
      frontalityScore: frontality,
      hasTwoEyes,
      compositeScore: frontality * 0.60 + Math.min(1.0, score / 100) * 0.40
    });
  }


  if (candidates.length === 0) {
    if (embeddings && embeddings.length > 0) {
      const firstVec = isVector(embeddings[0]) ? embeddings[0] : (embeddings[0]?.vector || null);
      if (firstVec) {
        let bestPhoto = photos[0];
        let bestScore = Number(bestPhoto?.sharpnessScore ?? 0);
        for (const p of photos) {
          const s = Number(p?.sharpnessScore ?? 0);
          if (s > bestScore) {
            bestScore = s;
            bestPhoto = p;
          }
        }
        return {
          photo: bestPhoto,
          vector: firstVec,
          score: bestScore,
          frontalityScore: 0,
          hasFrontalAnchor: false
        };
      }
    }
    return null;
  }

  // 1. Jerarquía de selección de foto representativa:
  // Nivel A: Foto erguida con dos ojos visibles (frontal, semi_left, semi_right)
  //          SIEMPRE gana sobre cualquier cara reclinada/tilted aunque la reclinada tenga mayor nitidez.
  // Nivel B: Foto con dos ojos visibles aunque sea reclinada/tilted.
  // Nivel C: Cualquier foto válida restante (perfiles o 1 ojo).
  const isUprightWithTwoEyes = (c) => c.hasTwoEyes && ['frontal', 'semi_left', 'semi_right'].includes(c.pose);
  const uprightCandidates = candidates.filter(isUprightWithTwoEyes);
  const twoEyesCandidates = candidates.filter(c => c.hasTwoEyes);

  if (uprightCandidates.length > 0) {
    uprightCandidates.sort((a, b) => b.compositeScore - a.compositeScore);
    const best = uprightCandidates[0];
    return {
      photo: best.photo,
      vector: best.vector,
      score: best.score,
      frontalityScore: best.frontalityScore,
      hasFrontalAnchor: true
    };
  }

  if (twoEyesCandidates.length > 0) {
    twoEyesCandidates.sort((a, b) => b.compositeScore - a.compositeScore);
    const best = twoEyesCandidates[0];
    return {
      photo: best.photo,
      vector: best.vector,
      score: best.score,
      frontalityScore: best.frontalityScore,
      hasFrontalAnchor: false
    };
  }

  // 2. Solo se recurre a fotos de 1 ojo si la sesión carece por completo de fotos de 2 ojos
  candidates.sort((a, b) => b.score - a.score);
  const sharpest = candidates[0];
  return {
    photo: sharpest.photo,
    vector: sharpest.vector,
    score: sharpest.score,
    frontalityScore: sharpest.frontalityScore || 0,
    hasFrontalAnchor: false
  };
}

/**
 * Intenta consolidar un segmento cerrado dentro de la atención previa en la misma silla si hay continuidad
 * @param {Object} params
 * @returns {Promise<Object|null>} Retorna la cita previa consolidada si hubo unión, o null si es independiente
 */
export async function consolidateChairAppointment({
  session,
  prevSameChairAppt,
  durationMinutes,
  now,
  customerService,
  sqliteClient,
  db,
  bucket,
  logVerbal = console.log,
  stats
}) {
  if (
    session._blockPrevChairMerge ||
    !prevSameChairAppt ||
    prevSameChairAppt.chairId !== session.chairId ||
    !session.embeddings ||
    session.embeddings.length === 0
  ) {
    return null;
  }

  // Barrera dura de capa: retiro formal de capa impide fusión de tramos
  if (isCapeBarrierSeparating(prevSameChairAppt, session)) {
    logVerbal(`[Appointment] 🛑 Consolidación bloqueada por barrera de capa (isCapeBarrierSeparating).`);
    return null;
  }

  const prevEndedMs = new Date(prevSameChairAppt.endedAt).getTime();
  const gapMs = session.startedAtEpoch - prevEndedMs;
  const minMergeGap = PIPELINE_CONFIG.consolidation?.minMergeGapMs ?? -300000;
  const maxMergeGap = 30 * 60 * 1000; // a) Brecha de ausencia <= 30 minutos

  if (gapMs < minMergeGap || gapMs > maxMergeGap) {
    return null;
  }

  const prevStartMs = new Date(prevSameChairAppt.startedAt).getTime();
  const consolidatedDurationMin = Math.max(
    (prevSameChairAppt.durationMinutes || 0) + durationMinutes,
    Math.round((now - prevStartMs) / 60000)
  );

  const prevClient = customerService?.getCustomerData?.(prevSameChairAppt.clientId) ||
                     sqliteClient?.getCustomerById?.(prevSameChairAppt.clientId);

  let prevVecs = Array.isArray(prevSameChairAppt._allSegmentEmbeddings) && prevSameChairAppt._allSegmentEmbeddings.length > 0
    ? prevSameChairAppt._allSegmentEmbeddings.map(e => isVector(e) ? e : e?.vector).filter(Boolean)
    : (Array.isArray(prevClient?.embeddings)
      ? prevClient.embeddings.map(e => isVector(e) ? e : e?.vector).filter(Boolean)
      : []);

  if (prevVecs.length === 0 && Array.isArray(prevSameChairAppt.embeddings)) {
    prevVecs = prevSameChairAppt.embeddings.map(e => isVector(e) ? e : e?.vector).filter(Boolean);
  }

  const prevPhotos = Array.isArray(prevSameChairAppt._allSegmentPhotos) && prevSameChairAppt._allSegmentPhotos.length > 0
    ? prevSameChairAppt._allSegmentPhotos
    : (Array.isArray(prevClient?.photos) && prevClient.photos.length > 0
      ? prevClient.photos
      : (prevSameChairAppt.photos || []));

  if (prevVecs.length === 0) {
    return null;
  }

  const repA = getRepresentativeFace(prevPhotos, prevVecs);
  const repB = getRepresentativeFace(session.photos || [], session.embeddings || []);

  if (!repA?.vector || !repB?.vector) {
    return null;
  }

  const repSim = computeCosineSimilarity(repA.vector, repB.vector);

  // c) Coincidencia biométrica adaptativa por pose/landmarks:
  const isLandmarkAligned = (
    repA?.photo?.yawScore !== undefined && repB?.photo?.yawScore !== undefined &&
    Math.abs(repA.photo.yawScore - repB.photo.yawScore) < 0.35 &&
    Math.abs((repA.photo.pitchScore || 0) - (repB.photo.pitchScore || 0)) < 0.35
  );

  const isSamePose = Boolean(
    repA?.photo?.pose && repB?.photo?.pose &&
    repA.photo.pose === repB.photo.pose &&
    (repA.photo.yawScore !== undefined ? isLandmarkAligned : true)
  );

  const reqThresh = isSamePose
    ? (PIPELINE_CONFIG.biometrics?.samePoseThreshold ?? 0.60)
    : (PIPELINE_CONFIG.biometrics?.crossPoseThreshold ?? 0.48);

  const setToSet = computeSetToSetMetrics(prevVecs, prevPhotos, session.embeddings || [], session.photos || []);
  const avgFrontality = ((repA.frontalityScore || 0) + (repB.frontalityScore || 0)) / 2;
  const frontalityWeighted = repSim * Math.min(1.0, avgFrontality + 0.20);
  const weightedSim = Math.max(
    setToSet.top3AvgSim,
    setToSet.maxCompatiblePoseSim,
    setToSet.maxSim,
    frontalityWeighted,
    repSim
  );

  const isBiometricMatch = (repSim >= reqThresh) || (repSim >= (reqThresh - 0.04) && weightedSim >= reqThresh);
  if (!isBiometricMatch) {
    return null;
  }

  // Regla 1.6: Pureza de la Galería en fusiones:
  // solo ingresan a la galería fotos con hasTwoEyes = true y similitud con el representante >= 0.40
  const repRef = repA?.vector ? repA : repB;
  const filteredNewPhotos = [];
  const filteredNewEmbeddings = [];
  for (let k = 0; k < (session.photos || []).length; k++) {
    const ph = session.photos[k];
    const emb = session.embeddings?.[k] || null;
    const v = isVector(emb) ? emb : (emb?.vector || null);
    const hasTwo = ph?.hasTwoEyes !== undefined
      ? Boolean(ph.hasTwoEyes)
      : hasTwoEyesVisible(ph?.landmarks, ph?.boxNorm, ph?.pose);
    if (!hasTwo) continue;
    if (repRef?.vector && v) {
      const sim = computeCosineSimilarity(v, repRef.vector);
      if (sim < 0.40) continue;
    }
    filteredNewPhotos.push(ph);
    filteredNewEmbeddings.push(emb);
  }

  // Consolidar este tramo dentro de prevSameChairAppt y su cliente sin crear cita duplicada
  prevSameChairAppt._tramoA_photo = repA?.photo || prevPhotos[0];
  prevSameChairAppt._tramoB_photo = repB?.photo || (session.photos && session.photos[0]);
  prevSameChairAppt._allSegmentPhotos = [...prevPhotos, ...filteredNewPhotos];
  prevSameChairAppt._allSegmentEmbeddings = [...prevVecs, ...filteredNewEmbeddings];
  const merged = mergePhotosAndEmbeddings(
    prevSameChairAppt.photos || [],
    filteredNewPhotos,
    prevSameChairAppt.embeddings || prevVecs,
    filteredNewEmbeddings
  );
  const deduped = deduplicateSessionPhotos(merged.photos, merged.embeddings, 20);

  prevSameChairAppt.endedAt = new Date(now).toISOString();
  prevSameChairAppt.durationMinutes = consolidatedDurationMin;
  prevSameChairAppt.photos = deduped.photos;
  prevSameChairAppt.embeddings = deduped.embeddings;
  if ((session.bestFaceScore || 0) > (prevSameChairAppt.bestFaceScore || 0)) {
    prevSameChairAppt.bestFaceScore = session.bestFaceScore;
    prevSameChairAppt.thumbnailBase64 = session.thumbnailBase64 || prevSameChairAppt.thumbnailBase64;
  }

  if (prevClient) {
    prevClient.lastSeen = new Date(now).toISOString();
    prevClient.photos = deduped.photos;
    prevClient.embeddings = deduped.embeddings;
    prevClient.bestFaceScore = prevSameChairAppt.bestFaceScore;
    await customerService?.saveOrUpdateCustomer?.(prevClient, {
      db,
      bucket,
      galleryUpdated: true,
      forceSync: true
    });
  }

  if (session.tempClientId && session.tempClientId !== prevSameChairAppt.clientId) {
    await customerService?.deleteCustomer?.(session.tempClientId, { db });
  }
  if (session.personId && session.personId !== prevSameChairAppt.clientId && session.personId !== session.tempClientId) {
    await customerService?.deleteCustomer?.(session.personId, { db });
  }

  const sqlite = sqliteClient || (customerService?.sqliteClient);
  if (sqlite?.saveAppointment) {
    try { sqlite.saveAppointment(prevSameChairAppt); } catch (_) {}
  }
  if (db) {
    try { await db.doc(`camera_catcher_appointments/${prevSameChairAppt.id}`).set(prevSameChairAppt); } catch (_) {}
  }

  try {
    const fs = await import("fs");
    const path = await import("path");
    const reportDir = path.resolve(process.cwd(), "data/audit_reports");
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const combinedBefore = [
      ...(prevSameChairAppt._photosBeforeClose || prevSameChairAppt.photos || []),
      ...(session.photosBeforeClose || [])
    ];
    prevSameChairAppt._photosBeforeClose = combinedBefore;
    const auditPayload = {
      appointmentId: prevSameChairAppt.id,
      clientId: prevSameChairAppt.clientId,
      clientName: prevSameChairAppt.clientName,
      clientStatus: prevSameChairAppt.clientStatus,
      matchedClient: null,
      durationMinutes: prevSameChairAppt.durationMinutes,
      photosBeforeClose: combinedBefore.map((p, i) => ({
        idx: i + 1,
        pose: p.pose,
        poseLabel: p.poseLabel,
        sharpnessScore: p.sharpnessScore,
        thumbnailBase64: p.thumbnailBase64
      })),
      photosAfterClose: (prevSameChairAppt.photos || []).map((p, i) => ({
        idx: i + 1,
        pose: p.pose,
        poseLabel: p.poseLabel,
        sharpnessScore: p.sharpnessScore,
        thumbnailBase64: p.thumbnailBase64
      }))
    };
    fs.writeFileSync(path.join(reportDir, `audit_${prevSameChairAppt.id}.json`), JSON.stringify(auditPayload, null, 2));
  } catch (_) {}

  logVerbal(`🔗 Tramo de ${durationMinutes} min consolidado en la atención en curso ${prevSameChairAppt.id} (${prevSameChairAppt.clientName}, duración total: ${consolidatedDurationMin} min, brecha: ${Math.round(gapMs / 1000)}s).`, "success");
  if (stats) {
    stats.continuousMergesCount = (stats.continuousMergesCount || 0) + 1;
    stats.consolidated = (stats.consolidated || 0) + 1;
  }
  return prevSameChairAppt;
}

/**
 * Formaliza el cliente final (recurrente o nuevo), actualiza su galería y persiste el registro de Appointment
 * @param {Object} params
 * @returns {Promise<Object>} Registro del appointment completado
 */
export async function finalizeCustomerAndAppointment({
  session,
  matchedClient,
  durationMinutes,
  now,
  customerService,
  sqliteClient,
  db,
  bucket,
  completedAppointments = [],
  completedVisits = [],
  maxCompletedAppointments,
  logVerbal = console.log
}) {
  let finalClient = null;
  const trackId = session.trackId;

  if (matchedClient) {
    // Coincidencia con cliente recurrente existente
    finalClient = matchedClient;
    finalClient.visitCount = (matchedClient.visitCount || 1) + 1;
    finalClient.appointmentCount = (matchedClient.appointmentCount || (matchedClient.visitCount - 1) || 1) + 1;
    finalClient.status = "frequent";
    finalClient.lastSeen = new Date(now).toISOString();

    logVerbal(`✅ Cliente identificado como recurrente: "${finalClient.name}" (Visita #${finalClient.visitCount}). Atención vinculada sin alterar su galería previa.`, "success");

    // Preservar la galería previa intacta (hidratar fotos desde SQLite si finalClient vino de caché podada)
    const fullExisting = customerService?.getCustomerData?.(finalClient.id) ||
                         sqliteClient?.getCustomerById?.(finalClient.id);
    if (fullExisting && Array.isArray(fullExisting.photos) && fullExisting.photos.length > 0) {
      finalClient.photos = fullExisting.photos;
      finalClient.thumbnailBase64 = finalClient.thumbnailBase64 || fullExisting.thumbnailBase64;
    }

    if (customerService) {
      await customerService.saveOrUpdateCustomer(finalClient, {
        db,
        bucket,
        galleryUpdated: false,
        forceSync: true
      });
    }

    if (session.tempClientId && session.tempClientId !== finalClient.id) {
      await customerService?.deleteCustomer?.(session.tempClientId, { db });
    }
    if (session.personId && session.personId !== finalClient.id && session.personId !== session.tempClientId) {
      await customerService?.deleteCustomer?.(session.personId, { db });
    }

    session.personId = finalClient.id;
    session.personName = finalClient.name;
    session.clientId = finalClient.id;
    session.clientName = finalClient.name;
    session.visitCount = finalClient.visitCount;
  } else if ((!session.embeddings || session.embeddings.length === 0) && session.personName && session.personName !== "Cliente (Por verificar)") {
    // Identidad pre-establecida en pruebas o integración sin embeddings
    finalClient = {
      id: session.personId,
      name: session.personName,
      status: (session.visitCount || 1) > 1 ? "frequent" : "new",
      isStaff: false,
      role: "client",
      firstSeen: session.startedAt,
      lastSeen: new Date(now).toISOString(),
      visitCount: session.visitCount || 1,
      appointmentCount: session.visitCount || 1,
      bestFaceScore: session.bestFaceScore || 0,
      thumbnailBase64: session.thumbnailBase64 || session.photos?.[0]?.thumbnailBase64 || null,
      thumbnailPath: session.bestFaceStoragePath || null,
      photos: session.photos || [],
      embeddings: session.embeddings || []
    };

    const tempIdToDelete = session.tempClientId && session.tempClientId !== finalClient.id ? session.tempClientId : null;
    if (tempIdToDelete) {
      await customerService?.deleteCustomer?.(tempIdToDelete, { db });
    }

    session.personId = finalClient.id;
    session.personName = finalClient.name;
    session.clientId = finalClient.id;
    session.clientName = finalClient.name;
    session.visitCount = finalClient.visitCount;

    logVerbal(`✅ Atención completada para identidad establecida: "${finalClient.name}".`, "success");
  } else {
    // NO coincidió con clientes previos: Es un nuevo cliente legítimo
    const clientId = session.tempClientId || `person_${now}_${trackId}`;
    const allKnown = customerService?.getComparisonProfiles?.() || [];
    const clientCount = allKnown.filter(p => !p.isStaff && !p.name?.includes("confirmación") && p.status !== "to_verify" && p.id !== clientId).length;
    const finalName = `Cliente #${clientCount + 1}`;

    const rep = getRepresentativeFace(session.photos || [], session.embeddings || []);
    const repThumbnail = rep?.photo?.thumbnailBase64 || null;
    const repScore = rep?.score ?? (session.bestFaceScore || 0);
    const repVector = rep?.vector || session.embeddings?.[0] || null;

    finalClient = {
      id: clientId,
      name: finalName,
      status: "new",
      isStaff: false,
      role: "client",
      firstSeen: session.startedAt,
      lastSeen: new Date(now).toISOString(),
      visitCount: 1,
      appointmentCount: 1,
      bestFaceScore: repScore || session.bestFaceScore || 0,
      thumbnailBase64: repThumbnail || session.thumbnailBase64 || session.photos[0]?.thumbnailBase64 || null,
      thumbnailPath: session.bestFaceStoragePath || null,
      photos: session.photos,
      embeddings: session.embeddings,
      embedding: repVector || session.embeddings[0] || null
    };

    session.personId = finalClient.id;
    session.personName = finalClient.name;
    session.clientId = finalClient.id;
    session.clientName = finalClient.name;
    session.visitCount = 1;

    logVerbal(`🆕 Nuevo cliente formalizado: "${finalClient.name}" con galería de ${session.photos.length} fotos.`, "success");

    if (customerService) {
      await customerService.saveOrUpdateCustomer(finalClient, {
        db,
        bucket,
        isNew: false,
        galleryUpdated: true,
        forceSync: true
      });
    }
  }

  const repAppt = getRepresentativeFace(session.photos || [], session.embeddings || []);
  const repApptThumbnail = repAppt?.photo?.thumbnailBase64 || null;
  const repApptScore = repAppt?.score ?? (session.bestFaceScore || 0);

  const appointmentRecord = {
    id: session.appointmentId || session.visitId,
    trackId: session.trackId,
    personId: finalClient.id,
    personName: finalClient.name,
    clientId: finalClient.id,
    clientName: finalClient.name,
    role: "client",
    isStaff: false,
    isFrequent: (session.visitCount || 1) > 1,
    visitCount: session.visitCount || 1,
    chairId: session.chairId,
    chairName: session.chairName,
    startedAt: session.startedAt,
    endedAt: new Date(now).toISOString(),
    durationMinutes,
    status: "completed",
    clientStatus: finalClient.status,
    bestFaceStoragePath: session.bestFaceStoragePath,
    bestFaceScore: repApptScore || session.bestFaceScore || 0,
    thumbnailPath: session.bestFaceStoragePath || null,
    thumbnailBase64: repApptThumbnail || session.thumbnailBase64 || session.photos[0]?.thumbnailBase64 || null,
    photos: session.photos,
    embeddings: session.embeddings || [],
    createdAt: new Date(now).toISOString()
  };

  completedAppointments.push(appointmentRecord);
  completedVisits.push(appointmentRecord);
  if (maxCompletedAppointments && completedAppointments.length > maxCompletedAppointments) completedAppointments.shift();
  if (maxCompletedAppointments && completedVisits.length > maxCompletedAppointments) completedVisits.shift();

  // Persistir en SQLite si el cliente está disponible
  const sqlite = sqliteClient || (customerService?.sqliteClient);
  if (sqlite?.saveAppointment) {
    try {
      sqlite.saveAppointment(appointmentRecord);
    } catch (sqlErr) {
      console.warn(`[Appointment] Error guardando atención en SQLite:`, sqlErr.message);
    }
  }

  // Persistir en Firestore en camera_catcher_appointments
  if (db) {
    try {
      await db.doc(`camera_catcher_appointments/${appointmentRecord.id}`).set(appointmentRecord);
      logVerbal(`✅ Atención registrada exitosamente en camera_catcher_appointments/${appointmentRecord.id} (${appointmentRecord.clientName}, ${durationMinutes} min, ${session.photos.length} fotos).`, "success");
    } catch (dbErr) {
      console.error(`[Appointment] Error guardando atención en Firestore:`, dbErr.message);
    }
  }

  // Exportar auditoría fotográfica antes/después de closeSession
  try {
    const fs = await import("fs");
    const path = await import("path");
    const reportDir = path.resolve(process.cwd(), "data/audit_reports");
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    const auditPayload = {
      appointmentId: appointmentRecord.id,
      clientId: finalClient.id,
      clientName: finalClient.name,
      clientStatus: finalClient.status,
      matchedClient: matchedClient ? { id: matchedClient.id, name: matchedClient.name, status: matchedClient.status } : null,
      durationMinutes,
      photosBeforeClose: (session.photosBeforeClose || []).map((p, i) => ({
        idx: i + 1,
        pose: p.pose,
        poseLabel: p.poseLabel,
        sharpnessScore: p.sharpnessScore,
        thumbnailBase64: p.thumbnailBase64
      })),
      photosAfterClose: (session.photos || []).map((p, i) => ({
        idx: i + 1,
        pose: p.pose,
        poseLabel: p.poseLabel,
        sharpnessScore: p.sharpnessScore,
        thumbnailBase64: p.thumbnailBase64
      }))
    };
    const filePath = path.join(reportDir, `audit_${appointmentRecord.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(auditPayload, null, 2));
    console.log(`[Appointment] 📑 Reporte de auditoría de cierre exportado a: ${filePath}`);
  } catch (auditErr) {
    console.warn(`[Appointment] Error exportando auditoría:`, auditErr.message);
  }

  return appointmentRecord;
}

/**
 * Orquesta y ejecuta el flujo completo de cierre y finalización de una atención:
 * filtrado inicial, quimera split, validación biométrica, consolidación cronológica,
 * búsqueda de clientes recurrentes y persistencia.
 * @param {Object} params
 * @returns {Promise<Object|null>}
 */
export async function executeSessionClosurePipeline({
  session,
  trackId,
  options = {},
  now,
  minAppointmentMinutes,
  completedAppointments,
  completedVisits,
  maxCompletedAppointments,
  activeSessions,
  customerService,
  sqliteClient,
  db,
  bucket,
  stats,
  closeSession,
  matchSessionAgainstClients,
  logVerbal = console.log
}) {
  const durationMs = now - session.startedAtEpoch;
  const durationMinutes = options.durationMinutes !== undefined
    ? options.durationMinutes
    : Math.max(1, Math.round(durationMs / 60000));
  const minMinutes = options.minMinutes !== undefined ? options.minMinutes : minAppointmentMinutes;

  const prep = await prepareAndFilterSessionForClosure({
    session,
    trackId,
    durationMinutes,
    minMinutes,
    customerService,
    db,
    stats,
    logVerbal
  });
  if (prep.shouldDiscard) return null;

  session.status = "to_verify";

  // Referencia al Cliente Anterior en la misma silla (comparación secuencial)
  const prevSameChairAppt = [...completedAppointments].reverse().find(a => a.chairId === session.chairId) ||
    (completedAppointments.length > 0 ? completedAppointments[completedAppointments.length - 1] : null);

  // Partición Post-Hoc Anti-Quimera
  if (
    !options._isChimeraSplitPart &&
    session.photos &&
    session.photos.length >= 6 &&
    session.embeddings &&
    session.embeddings.length >= 6
  ) {
    const chimeraSplit = findChimeraSplit(session.photos, session.embeddings, session.startedAtEpoch, now);
    if (chimeraSplit) {
      return splitChimeraSession({
        session,
        chimeraSplit,
        trackId,
        durationMinutes,
        now,
        activeSessions,
        closeSession,
        logVerbal
      });
    }
  }

  // Validación de evidencia biométrica y exclusión del barbero
  const bioCheck = await validateBiometricsForFinalization({
    session,
    durationMinutes,
    customerService,
    db,
    stats,
    logVerbal
  });
  if (!bioCheck.isValid) return null;

  // Consolidación cronológica
  const consolidatedAppt = await consolidateChairAppointment({
    session,
    prevSameChairAppt,
    durationMinutes,
    now,
    customerService,
    sqliteClient,
    db,
    bucket,
    logVerbal,
    stats
  });
  if (consolidatedAppt) {
    return consolidatedAppt;
  }

  // Si NO se une al Cliente Anterior: descarte por ruido lateral
  const noiseCheck = await validatePostConsolidationNoise({
    session,
    durationMinutes,
    minMinutes,
    customerService,
    db,
    stats,
    logVerbal
  });
  if (noiseCheck.isNoise) return null;

  logVerbal(`🔍 Analizando biometría acumulada de atención (${session.photos.length} fotos contra base de clientes)...`, "process");

  let matchedClient = null;
  if (session.embeddings && session.embeddings.length > 0) {
    matchedClient = matchSessionAgainstClients(session.embeddings);
    if (matchedClient && (matchedClient.name?.includes("confirmación") || matchedClient.status === "to_verify")) {
      matchedClient = null;
    }
  }

  const appointmentRecord = await finalizeCustomerAndAppointment({
    session,
    matchedClient,
    durationMinutes,
    now,
    customerService,
    sqliteClient,
    db,
    bucket,
    completedAppointments,
    completedVisits,
    maxCompletedAppointments,
    logVerbal
  });

  session.rotatedFromPrevSession = false;
  session._blockPrevChairMerge = false;

  return appointmentRecord;
}

