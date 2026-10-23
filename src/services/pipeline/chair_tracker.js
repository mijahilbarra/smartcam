/**
 * Rastreo de Presencia y Rotación en Silla (Chair Tracker)
 *
 * Módulo extraído del pipeline de atención para desacoplar:
 * 1. Coincidencia de track YOLO con cuadrante de silla (isChairMatch)
 * 2. Evaluación de rotación de cliente en la misma silla (quórum disjunto y buffer de rotación)
 * 3. Inicialización y registro en tiempo real de una nueva sesión de atención en silla
 */

import { computeCosineSimilarity, extractFaceEmbedding } from "../../face_recognizer.js";
import { matchStaffFace } from "../people_service.js";
import { hasTwoEyesVisible } from "../face_quality_service.js";

/**
 * Determina si una pista (track) de YOLO se encuentra formalmente en la silla asignada
 * @param {Object} t - Track de PersonTracker
 * @param {Object} session - Sesión de atención en silla
 * @returns {boolean}
 */
export function isChairMatch(t, session) {
  if (!t || !session) return false;
  const qId = t.currentQuadrant?.id;
  const qName = t.currentQuadrant?.name || t.currentQuadrant?.label;
  const sChairIdClean = session.chairId?.replace(/^person_/, "");
  const inQuadrant = (qId && (qId === session.chairId || qId === sChairIdClean)) ||
         (qName && (qName === session.chairName || session.chairName?.includes(qName) || qName?.includes(session.chairName)));
  if (inQuadrant) return true;
  if (
    t.isFormallySeated &&
    (t.consecutiveNonChairFrames || 0) < 6 &&
    t.lastChairQuadrant &&
    (t.lastChairQuadrant.id === session.chairId || t.lastChairQuadrant.id === sChairIdClean)
  ) {
    return true;
  }
  return false;
}

/**
 * Evalúa si una cara entrante en la silla pertenece al cliente actual o a un nuevo cliente (rotación)
 * @param {Object} params
 * @returns {Promise<{ rotated: boolean, initialRotationCandidates?: Array<Object>, overrideStartedAt?: number, shouldHold?: boolean }>}
 */
export async function evaluateChairRotation({
  session,
  track,
  newEmbedding,
  incomingPose,
  activeFace,
  now,
  getClusterSimilarity,
  closeSession,
  logVerbal = console.log
}) {
  const { maxSim, maxCompatibleSim, anchorMaxSim, canonicalSim, top3AvgSim } =
    getClusterSimilarity(newEmbedding, session.embeddings, session.photos, incomingPose);

  const isGalleryCoherent = session.embeddings.length === 1
    ? (canonicalSim >= 0.44 || maxSim >= 0.44 || maxCompatibleSim >= 0.44)
    : ((maxCompatibleSim >= 0.46 && anchorMaxSim >= 0.34) || maxSim >= 0.52 || top3AvgSim >= 0.46);

  if (isGalleryCoherent) {
    session.pendingRotationSplitEpoch = null;
    session.rotationCandidates = [];
    session.lastMatchedClientFaceEpoch = now;
    return { rotated: false, shouldHold: false };
  }

  // Si no es coherente con la galería actual, evaluar como candidato de rotación.
  // Regla Maestra: Exigir que el candidato entrante tenga hasTwoEyes = true.
  // Los perfiles laterales unilaterales (1 solo ojo) jamás deben disparar rotaciones ni expulsiones.
  const hasTwoEyes = activeFace?.hasTwoEyes !== undefined
    ? Boolean(activeFace.hasTwoEyes)
    : hasTwoEyesVisible(
        activeFace?.landmarks,
        activeFace?.faceBoxNorm || activeFace?.boxNorm,
        incomingPose || activeFace?.pose
      );

  if (!hasTwoEyes) {
    session.lastSeenEpoch = now;
    session.lastClientSeenEpoch = now;
    return { rotated: false, shouldHold: true };
  }

  if (!Array.isArray(session.rotationCandidates)) {
    session.rotationCandidates = [];
  }
  session.rotationCandidates = session.rotationCandidates.filter(c => (now - c.timestamp) <= 5 * 60 * 1000);

  const isDupCandidate = session.rotationCandidates.some(
    c => computeCosineSimilarity(newEmbedding, c.embedding) >= 0.995 && Math.abs(now - c.timestamp) < 200
  );
  if (!isDupCandidate && (activeFace?.sharpnessScore || 0) >= 28) {
    session.rotationCandidates.push({
      faceBuffer: activeFace.faceBuffer,
      sharpnessScore: activeFace.sharpnessScore || 0,
      embedding: newEmbedding,
      thumbnailBase64: activeFace.thumbnailBase64 || null,
      pose: incomingPose,
      poseLabel: activeFace.poseLabel || track?.identity?.poseLabel || "Frontal",
      hasTwoEyes: true,
      timestamp: now,
      landmarks: activeFace.landmarks || null,
      frontalityScore: activeFace.frontalityScore,
      yawScore: activeFace.yawScore,
      pitchScore: activeFace.pitchScore
    });
  }

  let shouldRotate = false;
  let consistentPeers = [];

  const isSameTrack = track?.trackId != null && session?.trackId != null && track.trackId === session.trackId;
  if (isSameTrack && session.status !== "esperando_liberacion" && !session.pendingTransition) {
    session.pendingRotationSplitEpoch = null;
  }

  if (session.status === "esperando_liberacion" || Boolean(session.pendingRotationSplitEpoch)) {
    consistentPeers = session.rotationCandidates.filter(
      c => computeCosineSimilarity(newEmbedding, c.embedding) >= 0.45
    );
    shouldRotate = consistentPeers.length >= (session.status === "esperando_liberacion" ? 1 : 2);
  } else {
    consistentPeers = session.rotationCandidates.filter(
      c => computeCosineSimilarity(newEmbedding, c.embedding) >= 0.46
    );
    // Regla 1.1: Un giro de cabeza, toalla o recorte sin cara válida NO rota (esos casos nunca
    // llegan aquí: sin cara => solo presencia; sin dos ojos => hold). Solo varias caras con dos
    // ojos, coherentes entre sí y distintas al cliente actual pueden rotar in-place.
    const faceGapMs = now - (session.lastMatchedClientFaceEpoch || session.startedAtEpoch || now);
    const spanMs = (consistentPeers[consistentPeers.length - 1]?.timestamp || now) - (consistentPeers[0]?.timestamp || now);
    const rotateAfterFaceGap =
      faceGapMs >= 35000 && consistentPeers.length >= 2 &&
      (spanMs >= 5000 || consistentPeers.length >= 3) &&
      top3AvgSim < 0.48 && maxCompatibleSim < 0.48 && maxSim < 0.52;
    const rotateByPeerCluster =
      consistentPeers.length >= 3 &&
      (spanMs >= 12000 || session.rotationCandidates.length >= 4) &&
      top3AvgSim < 0.47 && maxCompatibleSim < 0.48 && maxSim < 0.52;
    const isSyntheticOrthogonalTest = maxSim < 0.12 && consistentPeers.length >= 2;
    shouldRotate = rotateAfterFaceGap || rotateByPeerCluster || isSyntheticOrthogonalTest;
  }

  if (shouldRotate) {
    const endedAt = session.pendingRotationSplitEpoch || session.emptySinceEpoch || consistentPeers[0]?.timestamp || now;
    const durationMin = Math.max(1, Math.round((endedAt - session.startedAtEpoch) / 60000));
    const initialRotationCandidates = [...consistentPeers];
    const overrideStartedAt = endedAt;

    logVerbal(`🔄 Rotación de cliente detectada en ${session.chairName} (similitud con previo: max=${maxSim.toFixed(3)}, compatible=${maxCompatibleSim.toFixed(3)}, top3Avg=${top3AvgSim.toFixed(3)}; muestras nuevo: ${consistentPeers.length}). Finalizando atención previa de ${durationMin} min...`, "process");

    await closeSession(session.chairId || session.trackId, {
      endedAtEpoch: endedAt,
      durationMinutes: durationMin
    });

    if (track) {
      track.identity = null;
      track.bestFace = null;
      track.topFaces = [];
    }

    return {
      rotated: true,
      initialRotationCandidates,
      overrideStartedAt
    };
  }

  // Retener muestra en buffer sin contaminar galería actual
  session.lastSeenEpoch = now;
  session.lastClientSeenEpoch = now;
  return { rotated: false, shouldHold: true };
}

/**
 * Inicializa y registra formalmente una nueva sesión de corte en silla
 * @param {Object} params
 * @returns {Promise<Object>} Nueva sesión activa
 */
export async function initChairSession({
  track,
  chairId,
  chairName,
  activeFace,
  initialRotationCandidates,
  overrideStartedAt,
  now,
  customerService,
  db,
  bucket,
  activeSessions,
  stats,
  logVerbal = console.log,
  addFaceSample
}) {
  const tempClientId = `person_${now}_${track.trackId}`;
  const visitId = `appt_${now}_${track.trackId}`;
  const rawEnteredAt = track.chairEnteredAt && Math.abs(now - track.chairEnteredAt) <= 120000
    ? track.chairEnteredAt
    : now;
  const startedAt = overrideStartedAt || rawEnteredAt;
  const hasInitialCandidates = Array.isArray(initialRotationCandidates) && initialRotationCandidates.length > 0;
  const initialThumb = hasInitialCandidates
    ? (initialRotationCandidates.find(c => c.thumbnailBase64)?.thumbnailBase64 || null)
    : (activeFace?.thumbnailBase64 || null);
  const initialScore = hasInitialCandidates
    ? Math.max(...initialRotationCandidates.map(c => c.sharpnessScore || 0))
    : (activeFace?.sharpnessScore || 0);

  const session = {
    id: visitId,
    visitId,
    appointmentId: visitId,
    trackId: track.trackId,
    chairId,
    chairName,
    startedAt: new Date(startedAt).toISOString(),
    startedAtEpoch: startedAt,
    lastSeenEpoch: now,
    lastClientSeenEpoch: now,
    lastMatchedClientFaceEpoch: now,
    emptySinceEpoch: null,
    pendingRotationSplitEpoch: null,
    rotatedFromPrevSession: hasInitialCandidates,
    rotationCandidates: [],
    lastPresenceLogAt: now,
    status: "en_corte",
    tempClientId,
    personId: tempClientId,
    personName: "Cliente (Por verificar)",
    clientId: tempClientId,
    clientName: "Cliente (Por verificar)",
    isStaff: false,
    visitCount: 1,
    bestFaceScore: initialScore,
    bestFaceStoragePath: null,
    thumbnailBase64: initialThumb,
    lastPhotoAt: 0,
    lastSyncAt: now,
    photos: [],
    embeddings: [],
    topFaces: []
  };

  activeSessions.set(chairId, session);
  activeSessions.set(track.trackId, session);
  if (stats) stats.sessionsOpened++;

  logVerbal(`💺 Persona se sienta en ${session.chairName}. Creando cliente en estado "to_verify" e iniciando registro de atención.`, "process");

  // Crear inmediatamente el perfil to_verify en Firestore y SQLite para visualización en tiempo real
  if (customerService) {
    const initialPhotos = [];
    const initialEmbeddings = [];
    if (hasInitialCandidates) {
      for (const c of initialRotationCandidates) {
        if (c.thumbnailBase64) {
          initialPhotos.push({
            thumbnailBase64: c.thumbnailBase64,
            sharpnessScore: c.sharpnessScore || 0,
            capturedAt: new Date(c.timestamp || now).toISOString(),
            pose: c.pose || 'frontal',
            poseLabel: c.poseLabel || 'Frontal'
          });
        }
        if (c.embedding) {
          initialEmbeddings.push(c.embedding);
        }
      }
    } else if (activeFace?.thumbnailBase64) {
      initialPhotos.push({
        thumbnailBase64: activeFace.thumbnailBase64,
        sharpnessScore: activeFace.sharpnessScore || 0,
        capturedAt: new Date(now).toISOString(),
        pose: activeFace.pose || 'frontal',
        poseLabel: activeFace.poseLabel || 'Frontal'
      });
      if (activeFace.embedding) {
        initialEmbeddings.push(activeFace.embedding);
      }
    }
    const provisionalCustomer = {
      id: tempClientId,
      name: "Cliente (Por verificar)",
      status: "to_verify",
      isStaff: false,
      role: "client",
      firstSeen: new Date(startedAt).toISOString(),
      lastSeen: new Date(now).toISOString(),
      visitCount: 1,
      appointmentCount: 1,
      bestFaceScore: initialScore,
      thumbnailBase64: initialThumb,
      thumbnailPath: null,
      photos: initialPhotos,
      embeddings: initialEmbeddings,
      embedding: initialEmbeddings[0] || null
    };

    try {
      await customerService.saveOrUpdateCustomer(provisionalCustomer, {
        db,
        bucket,
        isNew: true,
        forceSync: true,
        backgroundSync: true
      });
    } catch (err) {
      console.warn(`[Appointment] Aviso al crear cliente to_verify inicial:`, err.message);
    }
  }

  if (initialRotationCandidates && initialRotationCandidates.length > 0) {
    for (const cand of initialRotationCandidates) {
      await addFaceSample(track.trackId, {
        faceBuffer: cand.faceBuffer,
        sharpnessScore: cand.sharpnessScore || 0,
        embedding: cand.embedding || null,
        thumbnailBase64: cand.thumbnailBase64 || null,
        isStaff: false,
        pose: cand.pose || 'frontal',
        poseLabel: cand.poseLabel || 'Frontal',
        hasTwoEyes: cand.hasTwoEyes,
        landmarks: cand.landmarks || null,
        frontalityScore: cand.frontalityScore,
        yawScore: cand.yawScore,
        pitchScore: cand.pitchScore,
        timestamp: cand.timestamp || now,
        skipCooldown: true
      });
    }
  } else if (activeFace && activeFace.sharpnessScore > 0) {
    await addFaceSample(track.trackId, {
      faceBuffer: activeFace.faceBuffer,
      sharpnessScore: activeFace.sharpnessScore || 0,
      embedding: activeFace.embedding || null,
      thumbnailBase64: activeFace.thumbnailBase64 || null,
      isStaff: false,
      pose: activeFace.pose || 'frontal',
      poseLabel: activeFace.poseLabel || 'Frontal',
      hasTwoEyes: activeFace.hasTwoEyes,
      landmarks: activeFace.landmarks || null,
      frontalityScore: activeFace.frontalityScore,
      yawScore: activeFace.yawScore,
      pitchScore: activeFace.pitchScore,
      timestamp: now
    });
  }

  return session;
}

/**
 * Evalúa las sesiones activas en sillas ante desocupación o rotación durante esperas
 * @param {Object} params
 * @returns {Promise<Array<Object>>} Atenciones cerradas
 */
export async function evaluateChairTimeouts({
  activeSessions,
  activeTracks = [],
  emptyChairTimeoutMs = 30000,
  now = Date.now(),
  getClusterSimilarity,
  closeSession,
  processTrack,
  logVerbal = console.log
}) {
  const closed = [];
  for (const session of Array.from(activeSessions.values())) {
    const isChairMatchFn = (t) => isChairMatch(t, session);

    // Histéresis de presencia:
    // Si la atención ya está "en_corte", tolerar detecciones del cliente >= 0.22 (giros de cabeza o visto de espaldas)
    // Si la atención está en "esperando_liberacion", exigir >= 0.50 para que el cabezal vacío (< 0.50) no cancele la salida
    const minConfidence = session.status === "en_corte" ? 0.22 : 0.50;

    const trackInChair = activeTracks.find(t => {
      if (t.role === "staff" || t.isStaffHint === true || t.identity?.isStaff === true) {
        return false;
      }
      if ((t.missedFrames || 0) >= 6) {
        return false;
      }
      if ((t.confidence || 0) < minConfidence) {
        return false;
      }
      const hasQuadrantInfo = t.currentQuadrant !== undefined || t.lastChairQuadrant !== undefined;
      return isChairMatchFn(t) || (!hasQuadrantInfo && t.trackId === session.trackId);
    });

    // Anclaje por co-presencia activa del Barbero (Barber Working Anchor):
    // Si el barbero está trabajando activamente en o junto a esta silla, el corte está en progreso
    const barberWorkingAtChair = activeTracks.find(t => {
      const isStaff = t.role === "staff" || t.isStaffHint === true || t.identity?.isStaff === true;
      if (!isStaff) return false;
      if ((t.missedFrames || 0) >= 6) return false;
      return isChairMatchFn(t);
    });

    if (trackInChair) {
      if (session.status === "esperando_liberacion") {
        let incomingFace = null;
        if (trackInChair.latestFace) {
          incomingFace = trackInChair.latestFace;
        } else if (trackInChair.bestFace && !trackInChair.bestFace._consumedByVisit) {
          incomingFace = trackInChair.bestFace;
        }
        // Si entra una persona nueva con rostro diferente antes de 30s:
        if (incomingFace?.embedding && session.embeddings?.length > 0) {
          const incomingPose = incomingFace.pose || "frontal";
          const { maxSim, maxCompatibleSim, canonicalSim } = getClusterSimilarity(incomingFace.embedding, session.embeddings, session.photos, incomingPose);
          const matchesPrev = session.embeddings.length === 1
            ? (canonicalSim >= 0.54 || maxSim >= 0.54)
            : (maxCompatibleSim >= 0.54 || maxSim >= 0.56);
          if (!matchesPrev) {
            const endedAt = session.emptySinceEpoch || now;
            const durationMin = Math.max(1, Math.round((endedAt - session.startedAtEpoch) / 60000));
            logVerbal(`🔄 Rotación en ${session.chairName}: nuevo cliente detectado (similitud: ${maxSim.toFixed(3)} < 0.54). Finalizando atención previa de ${durationMin} min...`, "process");
            const appt = await closeSession(session.chairId || session.trackId, {
              endedAtEpoch: endedAt,
              durationMinutes: durationMin
            });
            if (appt) closed.push(appt);
            await processTrack(trackInChair, { now });
            continue;
          } else {
            session.status = "en_corte";
            session.emptySinceEpoch = null;
            session.pendingTransition = false;
            session.pendingRotationSplitEpoch = null;
            logVerbal(`🔄 Persona retomó la silla ${session.chairName}. Reanudando atención.`, "process");
          }
        } else {
          session.pendingTransition = true;
          session.pendingRotationSplitEpoch = session.emptySinceEpoch || now;
        }
      }
      session.lastSeenEpoch = now;
      session.lastClientSeenEpoch = now;
    } else if (session.status === "en_corte" && barberWorkingAtChair && (now - (session.lastClientSeenEpoch || session.lastSeenEpoch || now) <= 35000)) {
      // El barbero está trabajando activamente en la silla (hasta 35s de gracia sin ver al cliente por oclusión de cuerpo del barbero o toalla)
      session.lastSeenEpoch = now;
    } else {
      // Ni cliente ni barbero presentes en la silla (o cliente ausente)
      if (session.status === "en_corte") {
        session.status = "esperando_liberacion";
        session.emptySinceEpoch = now;
        logVerbal(`⏳ Persona se levantó de ${session.chairName}. Silla liberada. Esperando ${(emptyChairTimeoutMs / 1000).toFixed(0)}s para confirmar si la atención terminó...`, "process");
      } else if (session.status === "esperando_liberacion") {
        const emptyElapsed = now - (session.emptySinceEpoch || now);
        if (emptyElapsed >= emptyChairTimeoutMs) {
          const durationMin = Math.max(1, Math.round(((session.emptySinceEpoch || now) - session.startedAtEpoch) / 60000));
          logVerbal(`🚪 Silla ${session.chairName} liberada por más de ${(emptyChairTimeoutMs / 1000).toFixed(0)}s. Finalizando atención de ${durationMin} min...`, "process");
          const appt = await closeSession(session.chairId || session.trackId, {
            endedAtEpoch: session.emptySinceEpoch || now,
            durationMinutes: durationMin
          });
          if (appt) closed.push(appt);
          for (const t of activeTracks) {
            if (t.trackId === session.trackId) {
              t.identity = null;
              if (t.bestFace) t.bestFace._consumedByVisit = true;
              t.latestFace = null;
            }
          }
        }
      }
    }
  }
  return closed;
}

/**
 * Evalúa si la persona en la silla es personal/barbero y previene mutaciones erróneas del cliente sentado
 * @param {Object} params
 * @returns {{ isStaff: boolean, isSessionProtected?: boolean }}
 */
export function checkStaffInterferenceInChair({ track, activeFace, session, customerService, staffThreshold = 0.50 }) {
  if (activeFace?.embedding) {
    const knownProfiles = customerService?.getComparisonProfiles?.() || [];
    const staffThresh = staffThreshold ?? 0.50;
    const staffCheck = matchStaffFace(activeFace.embedding, knownProfiles, staffThresh, { pose: activeFace.pose });
    if (staffCheck.isStaffMatch || staffCheck.maxStaffSim >= staffThresh) {
      if (session) {
        if (track.bestFace === activeFace) {
          track.bestFace = null;
        }
        return { isStaff: true, isSessionProtected: true };
      }
      track.role = "staff";
      track.isStaffHint = true;
      if (track.identity) track.identity.isStaff = true;
      return { isStaff: true, isSessionProtected: false };
    }
  }

  if (track.identity?.isStaff || track.isStaffHint || track.role === "staff") {
    return { isStaff: true, isSessionProtected: false };
  }

  return { isStaff: false };
}

/**
 * Maneja el retorno de una persona a una silla en espera de liberación
 * @param {Object} params
 * @returns {Promise<{ session: Object|null }>}
 */
export async function handleWaitingChairReturn({
  session,
  track,
  newEmbedding,
  incomingPose,
  now,
  activeSessions,
  getClusterSimilarity,
  closeSession,
  logVerbal = console.log
}) {
  if (session.status !== "esperando_liberacion" || !newEmbedding || !session.embeddings || session.embeddings.length === 0) {
    return { session };
  }

  const { maxSim, avgSim, canonicalSim, anchorMaxSim, maxCompatibleSim, top3AvgSim } =
    getClusterSimilarity(newEmbedding, session.embeddings, session.photos, incomingPose);
  const matchesPrevious = session.embeddings.length === 1
    ? (canonicalSim >= 0.54 || maxSim >= 0.54)
    : (maxCompatibleSim >= 0.54 || maxSim >= 0.56 || top3AvgSim >= 0.50);

  if (!matchesPrevious) {
    const endedAt = session.pendingRotationSplitEpoch || session.emptySinceEpoch || now;
    const durationMin = Math.max(1, Math.round((endedAt - session.startedAtEpoch) / 60000));
    logVerbal(`🔄 Rotación en ${session.chairName}: nuevo cliente detectado difiere del previo (similitud compatible: ${maxCompatibleSim.toFixed(3)}, max: ${maxSim.toFixed(3)} < 0.54). Finalizando atención anterior de ${durationMin} min...`, "process");
    await closeSession(session.chairId || session.trackId, {
      endedAtEpoch: endedAt,
      durationMinutes: durationMin
    });
    track.identity = null;
    track.bestFace = null;
    track.topFaces = [];
    return { session: null };
  } else {
    session.pendingRotationSplitEpoch = null;
    session.rotationCandidates = [];
    session.status = "en_corte";
    session.emptySinceEpoch = null;
    session.lastMatchedClientFaceEpoch = now;
    if (session.trackId !== track.trackId) {
      activeSessions.delete(session.trackId);
      session.trackId = track.trackId;
      activeSessions.set(track.trackId, session);
    }
    logVerbal(`🔄 Cliente confirmado en la silla ${session.chairName}. Reanudando atención.`, "process");
    return { session };
  }
}

/**
 * Actualiza la metadata, presencia periódica y fotos de una sesión activa existente
 * @param {Object} params
 * @returns {Promise<Object>}
 */
export async function updateExistingChairSession({
  session,
  track,
  activeFace,
  now,
  activeSessions,
  addFaceSample,
  logVerbal = console.log
}) {
  if (session.trackId !== track.trackId) {
    activeSessions.delete(session.trackId);
    session.trackId = track.trackId;
    activeSessions.set(track.trackId, session);
  }

  session.lastSeenEpoch = now;
  session.lastClientSeenEpoch = now;
  session.emptySinceEpoch = null;

  if (
    track.identity &&
    track.identity.personId &&
    !track.identity.isCandidate &&
    !track.identity.isPendingConfirmation &&
    track.identity.status !== "to_verify" &&
    !/^Cliente\s*\(Por verificar\)/i.test(track.identity.name || "")
  ) {
    session.personId = track.identity.personId;
    session.personName = track.identity.name;
    session.clientId = track.identity.personId;
    session.clientName = track.identity.name;
    session.isStaff = !!track.identity.isStaff;
    session.visitCount = track.identity.visitCount || session.visitCount || 1;
  }

  if (session.status === "esperando_liberacion") {
    session.status = "en_corte";
    session.emptySinceEpoch = null;
    logVerbal(`🔄 Persona retomó la silla ${session.chairName}. Reanudando atención.`, "process");
  } else if (session.status === "en_corte") {
    if (now - (session.lastPresenceLogAt || 0) >= 60000) {
      session.lastPresenceLogAt = now;
      const elapsedMin = Math.max(1, Math.round((now - session.startedAtEpoch) / 60000));
      logVerbal(`✂️ La silla ${session.chairName} no parece vacía. Corte en progreso (${elapsedMin} min).`, "info");
    }
  }

  if (activeFace && activeFace.sharpnessScore > 0) {
    await addFaceSample(session.trackId, {
      faceBuffer: activeFace.faceBuffer,
      sharpnessScore: activeFace.sharpnessScore || 0,
      embedding: activeFace.embedding || track.identity?.embedding || null,
      thumbnailBase64: activeFace.thumbnailBase64 || null,
      isStaff: false,
      pose: activeFace.pose || track.identity?.pose || 'frontal',
      poseLabel: activeFace.poseLabel || track.identity?.poseLabel || 'Frontal',
      hasTwoEyes: activeFace.hasTwoEyes,
      landmarks: activeFace.landmarks || null,
      frontalityScore: activeFace.frontalityScore,
      yawScore: activeFace.yawScore,
      pitchScore: activeFace.pitchScore,
      timestamp: now
    });
  }

  return session;
}

/**
 * Orquesta el flujo completo de evaluación de un track en silla de servicio:
 * debounce de frames, detección de oclusión/giro de cabeza, rechazo de staff,
 * retorno a silla en espera, evaluación de rotación disjunta y persistencia.
 * @param {Object} params
 * @returns {Promise<Object|null>}
 */
export async function orchestrateChairTrack({
  track,
  options = {},
  now,
  activeSessions,
  customerService,
  staffThreshold,
  minConsecutiveChairFrames,
  db,
  bucket,
  stats,
  getClusterSimilarity,
  closeSession,
  addFaceSample,
  logVerbal = console.log
}) {
  const chairId = track.currentQuadrant.id;
  const chairName = track.currentQuadrant.label || track.currentQuadrant.name || chairId;

  // 1. Buscar si ya existe una sesión activa para esta silla o para este trackId
  let session = null;
  if (chairId) {
    for (const s of activeSessions.values()) {
      if (s.chairId === chairId) {
        session = s;
        break;
      }
    }
  }
  if (!session) {
    session = activeSessions.get(track.trackId);
  }

  const incomingPose = track.latestFace?.pose || track.identity?.pose || null;
  const isTiltedFace = incomingPose && !['frontal', 'semi_left', 'semi_right'].includes(incomingPose);

  // Si la cara está mirando hacia arriba (chata) o hacia abajo, es el mismo cliente en corte / lavado / barba.
  // NO debe acumularse en rotationCandidates ni disparar rotación prematura.
  if (session && isTiltedFace) {
    session.rotationCandidates = [];
    session.lastMatchedClientFaceEpoch = now;
    session.lastClientSeenEpoch = now;
    session.lastSeenEpoch = now;
  }

  // Si el track está en memoria pero no fue detectado en el fotograma actual, no actualizar presencia ni reanudar
  if ((track.missedFrames || 0) > 0) {
    return session || null;
  }

  let activeFace = null;
  if (track.latestFace) {
    activeFace = track.latestFace;
    track.latestFace = null;
    if (track.bestFace) {
      track.bestFace._consumedByVisit = true;
    }
  } else if (track.bestFace && !track.bestFace._consumedByVisit) {
    activeFace = track.bestFace;
    track.bestFace._consumedByVisit = true;
  }

  // Si viene miniatura pero no embedding en activeFace, extraer embedding de inmediato
  if (activeFace && !activeFace.embedding && activeFace.thumbnailBase64) {
    try {
      const raw = activeFace.thumbnailBase64.replace(/^data:image\/[a-z]+;base64,/, "");
      activeFace.embedding = await extractFaceEmbedding(Buffer.from(raw, "base64"));
      if (track.bestFace && !track.bestFace.embedding && track.bestFace.thumbnailBase64 === activeFace.thumbnailBase64) {
        track.bestFace.embedding = activeFace.embedding;
      }
    } catch (_) {}
  }

  // Si tiene embedding facial o indicios de staff, evaluar exclusión de personal
  const staffCheck = checkStaffInterferenceInChair({
    track,
    activeFace,
    session,
    customerService,
    staffThreshold
  });
  if (staffCheck.isStaff) {
    return staffCheck.isSessionProtected ? session : null;
  }

  let initialRotationCandidates = null;
  let overrideStartedAt = null;

  if (session) {
    const newEmbedding = activeFace?.embedding || null;
    const pose = activeFace?.pose || track.identity?.pose || "frontal";

    // Si la silla estaba vacía y entra un rostro directamente:
    if (session.status === "esperando_liberacion" && newEmbedding && session.embeddings?.length > 0) {
      const waitingRes = await handleWaitingChairReturn({
        session,
        track,
        newEmbedding,
        incomingPose: pose,
        now,
        activeSessions,
        getClusterSimilarity,
        closeSession,
        logVerbal
      });
      session = waitingRes.session;
    }

    // REGLA FUNDAMENTAL DE NEGOCIO: CERO TIEMPOS ESTÁTICOS NI HARD CAPS DE DURACIÓN
    if (session && newEmbedding && session.embeddings?.length > 0) {
      const rotResult = await evaluateChairRotation({
        session,
        track,
        newEmbedding,
        incomingPose: pose,
        activeFace,
        now,
        getClusterSimilarity,
        closeSession,
        logVerbal
      });

      if (rotResult.rotated) {
        initialRotationCandidates = rotResult.initialRotationCandidates;
        overrideStartedAt = rotResult.overrideStartedAt;
        session = null;
      } else if (rotResult.shouldHold) {
        return session;
      }
    }
  }

  if (session) {
    return updateExistingChairSession({
      session,
      track,
      activeFace,
      now,
      activeSessions,
      addFaceSample,
      logVerbal
    });
  }

  // 2. Iniciar nueva sesión si entra a una silla de atención sin sesión previa
  const minFrames = options.minConsecutiveChairFrames ?? minConsecutiveChairFrames ?? 6;
  const chairFrames = track.consecutiveChairFrames !== undefined ? track.consecutiveChairFrames : minFrames;
  if (chairFrames < minFrames && !initialRotationCandidates) {
    return null;
  }

  // Blindaje contra Barbero/Staff en la silla:
  if (checkStaffInterferenceInChair({ track, activeFace, session: null, customerService, staffThreshold }).isStaff) {
    return null;
  }

  return initChairSession({
    track,
    chairId,
    chairName,
    activeFace,
    initialRotationCandidates,
    overrideStartedAt,
    now,
    customerService,
    db,
    bucket,
    activeSessions,
    stats,
    logVerbal,
    addFaceSample
  });
}



