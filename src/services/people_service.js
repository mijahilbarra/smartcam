/**
 * Servicio de Reconocimiento y Re-identificación de Personas
 * Gestiona la comparación biométrica de rostros, coincidencia con staff y clientes frecuentes,
 * confirmación temporal (debounce) de nuevos clientes y persistencia de perfiles biométricos en Firestore.
 */

import sharp from "sharp";
import { extractFaceEmbedding, identifyFace, computeCosineSimilarity } from "../face_recognizer.js";
import { evaluateFaceQuality } from "./face_quality_service.js";
import { isChairZone, isTransitZone } from "../core/barbershop_rules.js";
import { customerService } from "./customer_service.js";

/**
 * Añade una foto a la galería de fotos del cliente garantizando compatibilidad hacia atrás y tope de 20 fotos.
 * @param {Object} person - Objeto o documento del cliente
 * @param {string} thumbnailBase64 - Miniatura en base64
 * @param {number} sharpnessScore - Score de nitidez
 * @param {Object} [options] - Opciones adicionales (pose, poseLabel)
 * @returns {Array} Array de fotos resultante (máx 20)
 */
export function enrichPersonPhotos(person, thumbnailBase64, sharpnessScore = 0, options = {}) {
  let existingPhotos = Array.isArray(person?.photos) ? [...person.photos] : [];
  if (existingPhotos.length === 0 && person?.thumbnailBase64) {
    existingPhotos = [{
      thumbnailBase64: person.thumbnailBase64,
      sharpnessScore: person.bestFaceScore || 0,
      capturedAt: person.firstSeen || new Date().toISOString(),
      pose: person.pose || 'frontal',
      poseLabel: person.poseLabel || 'Frontal'
    }];
  }

  if (!thumbnailBase64) return existingPhotos;

  const pose = options?.pose || 'frontal';
  const poseLabel = options?.poseLabel || (pose === 'frontal' ? 'Frontal' : pose);

  const newPhoto = {
    thumbnailBase64,
    sharpnessScore: sharpnessScore || 0,
    capturedAt: new Date().toISOString(),
    pose,
    poseLabel
  };

  if (existingPhotos.length < 20) {
    existingPhotos.push(newPhoto);
  } else {
    // Conserva la foto canónica (índice 0) y reemplaza la de menor nitidez o misma pose
    let replaceIdx = 1;
    let minSharpness = 999;
    for (let k = 1; k < existingPhotos.length; k++) {
      const ph = existingPhotos[k];
      if (ph.pose === pose && (ph.sharpnessScore || 0) < sharpnessScore) {
        replaceIdx = k;
        break;
      }
      if ((ph.sharpnessScore || 0) < minSharpness) {
        minSharpness = ph.sharpnessScore || 0;
        replaceIdx = k;
      }
    }
    existingPhotos[replaceIdx] = newPhoto;
  }

  return existingPhotos;
}

/**
 * Enriquece la galería biométrica y de fotos de un cliente existente con un nuevo ángulo
 * garantizando correspondencia estricta 1:1 entre embeddings y fotos hasta 20 ángulos.
 * Protegido con candado de anclaje canónico para evitar contaminación de perfiles.
 * @param {Object} person - Perfil del cliente
 * @param {Object} data - Datos del nuevo ángulo ({ embedding, faceThumbnailBase64, sharpnessScore, pose, poseLabel })
 * @param {Object} [options] - Opciones (minCanonicalSimilarity, skipCanonicalCheck)
 * @returns {{ embeddings: Array, photos: Array, rejected?: boolean, reason?: string }}
 */
export function enrichPersonAngles(person, { embedding, faceThumbnailBase64, sharpnessScore = 0, pose, poseLabel, nowEpoch }, options = {}) {
  let currentGallery = Array.isArray(person?.embeddings) && person.embeddings.length > 0
    ? [...person.embeddings]
    : (Array.isArray(person?.embedding) ? [person.embedding] : []);

  let existingPhotos = Array.isArray(person?.photos) ? [...person.photos] : [];
  if (existingPhotos.length === 0 && person?.thumbnailBase64) {
    existingPhotos = [{
      thumbnailBase64: person.thumbnailBase64,
      sharpnessScore: person.bestFaceScore || 0,
      capturedAt: person.firstSeen || new Date().toISOString(),
      pose: person.pose || 'frontal',
      poseLabel: person.poseLabel || 'Frontal'
    }];
  }

  // Candado de anclaje canónico: el nuevo embedding DEBE parecerse al rostro canónico original o al cluster de la persona
  if (embedding && currentGallery.length > 0 && !options.skipCanonicalCheck) {
    const canonicalItem = currentGallery[0];
    const canonicalVector = Array.isArray(canonicalItem) ? canonicalItem : (canonicalItem?.vector || null);
    if (canonicalVector) {
      const canonicalSim = computeCosineSimilarity(embedding, canonicalVector);
      const minSim = options.minCanonicalSimilarity || 0.48;

      let maxGallerySim = canonicalSim;
      for (let g = 1; g < currentGallery.length; g++) {
        const gItem = currentGallery[g];
        const gVec = Array.isArray(gItem) ? gItem : (gItem?.vector || null);
        if (gVec) {
          const sim = computeCosineSimilarity(embedding, gVec);
          if (sim > maxGallerySim) maxGallerySim = sim;
        }
      }

      const passesCanonical = canonicalSim >= minSim || (maxGallerySim >= 0.55 && canonicalSim >= 0.42);
      if (!passesCanonical) {
        console.warn(`[PeopleService] Ángulo rechazado para "${person.name || person.id}": similitud con rostro canónico (${canonicalSim.toFixed(3)}) < ${minSim}. Previene contaminación de galería.`);
        return {
          embeddings: currentGallery,
          photos: existingPhotos,
          rejected: true,
          reason: 'canonical_mismatch'
        };
      }
    }
  }

  const poseClean = pose || 'frontal';
  const poseLabelClean = poseLabel || (poseClean === 'frontal' ? 'Frontal' : poseClean);

  const newPhoto = {
    thumbnailBase64: faceThumbnailBase64 || person?.thumbnailBase64,
    sharpnessScore: sharpnessScore || 0,
    capturedAt: new Date().toISOString(),
    pose: poseClean,
    poseLabel: poseLabelClean
  };

  // Deduplicación por fotograma idéntico (misma miniatura base64 o vector congelado >= 0.985)
  if (embedding && currentGallery.length > 0) {
    let duplicateIdx = -1;
    for (let i = 0; i < currentGallery.length; i++) {
      const exThumb = existingPhotos[i]?.thumbnailBase64;
      if (faceThumbnailBase64 && exThumb && exThumb === faceThumbnailBase64) {
        duplicateIdx = i;
        break;
      }
      const exVec = Array.isArray(currentGallery[i]) ? currentGallery[i] : (currentGallery[i]?.vector || null);
      if (!exVec) continue;
      const sim = computeCosineSimilarity(embedding, exVec);
      if (sim >= 0.985) {
        duplicateIdx = i;
        break;
      }
    }

    if (duplicateIdx !== -1) {
      const existingSharpness = existingPhotos[duplicateIdx]?.sharpnessScore || 0;
      let updatedSharpness = false;
      if (sharpnessScore > existingSharpness) {
        currentGallery[duplicateIdx] = embedding;
        if (faceThumbnailBase64 && duplicateIdx < existingPhotos.length) {
          existingPhotos[duplicateIdx] = newPhoto;
        }
        updatedSharpness = true;
      }
      return {
        embeddings: currentGallery,
        photos: existingPhotos,
        duplicate: true,
        updatedSharpness
      };
    }
  }

  // Si se exige control de cadencia temporal y no han transcurrido 20s desde la última foto agregada
  if (options.enforceCooldown && person?.lastPhotoAtEpoch && (nowEpoch - person.lastPhotoAtEpoch < 20000)) {
    const latestIdx = existingPhotos.length - 1;
    let updatedSharpness = false;
    if (latestIdx >= 0 && sharpnessScore > (existingPhotos[latestIdx]?.sharpnessScore || 0)) {
      currentGallery[latestIdx] = embedding;
      if (faceThumbnailBase64) existingPhotos[latestIdx] = newPhoto;
      updatedSharpness = true;
    }
    return {
      embeddings: currentGallery,
      photos: existingPhotos,
      duplicate: true,
      updatedSharpness
    };
  }

  if (embedding) {
    if (currentGallery.length < 20) {
      currentGallery.push(embedding);
      if (faceThumbnailBase64) existingPhotos.push(newPhoto);
    } else if (existingPhotos.length < currentGallery.length) {
      // Perfil legado con más embeddings que fotos:
      const photoIdx = existingPhotos.length;
      if (faceThumbnailBase64) existingPhotos.push(newPhoto);
      if (photoIdx >= 0 && photoIdx < currentGallery.length) {
        currentGallery[photoIdx] = embedding;
      }
    } else {
      // Galería completa (20 ángulos y 20 fotos): conserva la foto canónica (índice 0)
      // y rota los ángulos intermedios en estricto paralelo 1:1, posicionando el nuevo al final
      currentGallery = [currentGallery[0], ...currentGallery.slice(2), embedding];
      if (faceThumbnailBase64) {
        existingPhotos = [existingPhotos[0], ...existingPhotos.slice(2), newPhoto];
      }
    }
  } else if (faceThumbnailBase64) {
    existingPhotos = enrichPersonPhotos(person, faceThumbnailBase64, sharpnessScore, { pose: poseClean, poseLabel: poseLabelClean });
  }

  return {
    embeddings: currentGallery,
    photos: existingPhotos
  };
}

/**
 * Evalúa si un embedding coincide con el Barbero / Staff.
 * Aplica umbral de detección estricto (0.58) para evitar falsos positivos
 * donde clientes de fisonomía similar sean catalogados erróneamente como Staff.
 * @param {Array<number>} embedding
 * @param {Array<Object>} knownProfiles
 * @param {number} [staffThreshold=0.58]
 * @returns {{ isStaffMatch: boolean, maxStaffSim: number, staffProfile: Object|null }}
 */
export function matchStaffFace(embedding, knownProfiles = [], staffThreshold = 0.58) {
  if (!embedding || !Array.isArray(knownProfiles) || knownProfiles.length === 0) {
    return { isStaffMatch: false, maxStaffSim: 0, staffProfile: null };
  }

  const staffProfiles = knownProfiles.filter(p => {
    if (p.name && /^Cliente\s*#\d+/i.test(p.name)) return false;
    if (p.role === "client" || p.isStaff === false) return false;
    return (p.isStaff === true && p.role !== "client") || p.role === "barber" || (String(p.id).startsWith("staff_") && p.role !== "client" && p.isStaff !== false);
  });
  if (staffProfiles.length === 0) {
    return { isStaffMatch: false, maxStaffSim: 0, staffProfile: null };
  }

  let bestStaff = null;
  let maxSim = -1;

  for (const staff of staffProfiles) {
    const vectors = [];
    if (Array.isArray(staff.embeddings)) {
      for (const item of staff.embeddings) {
        if (Array.isArray(item)) vectors.push(item);
        else if (item && Array.isArray(item.vector)) vectors.push(item.vector);
      }
    }
    if (vectors.length === 0 && Array.isArray(staff.embedding)) {
      vectors.push(staff.embedding);
    }

    for (const v of vectors) {
      const s = computeCosineSimilarity(embedding, v);
      if (s > maxSim) {
        maxSim = s;
        bestStaff = staff;
      }
    }
  }

  return {
    isStaffMatch: maxSim >= staffThreshold,
    maxStaffSim: maxSim > -1 ? maxSim : 0,
    staffProfile: maxSim >= staffThreshold ? bestStaff : null
  };
}

// Buffer de candidatos a nuevos clientes para Confirmación Temporal (Debounce)
// Evita crear perfiles falsos en Firestore en el milisegundo 0 (exige al menos 3 ciclos consecutivos)
const pendingNewClients = new Map();

/**
 * Limpia el buffer de candidatos (útil para tests)
 */
export function resetPendingCandidates() {
  pendingNewClients.clear();
  customerService.reset();
}

/**
 * Retorna la lista de candidatos en memoria
 */
export function getPendingCandidates() {
  return Array.from(pendingNewClients.values());
}

/**
 * Limpia de Firestore los perfiles falsos previos ('Cliente #1', 'Cliente #2', etc.)
 * generados por sillas vacías, codos o fallbacks
 * @param {Object} db - Instancia de Firestore
 * @returns {Promise<{ deletedCount: number }>}
 */
export async function cleanupFakeProfiles(db) {
  if (!db) return { deletedCount: 0 };
  let deletedCount = 0;
  try {
    const snap = await db.collection("camera_catcher_people").get();
    const batch = db.batch();
    snap.forEach(docSnap => {
      const data = docSnap.data();
      const isClientNumber = data.name && /^Cliente #\d+$/.test(data.name.trim());
      const isAutoId = docSnap.id.startsWith("person_");
      if ((isClientNumber || isAutoId) && !data.isStaff && data.role !== "barber") {
        batch.delete(docSnap.ref);
        deletedCount++;
        console.log(`[PeopleService] Limpiando perfil falso: ${data.name || docSnap.id} (${docSnap.id})`);
      }
    });
    if (deletedCount > 0) {
      await batch.commit();
      console.log(`[PeopleService] Limpieza completada: ${deletedCount} perfiles falsos eliminados de camera_catcher_people.`);
    }
  } catch (err) {
    console.warn(`[PeopleService] Error limpiando perfiles falsos:`, err.message);
  }
  return { deletedCount };
}

/**
 * Procesa el reconocimiento biométrico para los recortes de personas detectadas
 * @param {Object} db - Instancia de Firestore
 * @param {Array} clientRecords
 * @param {Array} clientCrops
 * @param {Array} activeSessions - Lista de sesiones de visita activas
 * @returns {Promise<Array>}
 */
export async function processPeopleRecognition(db, clientRecords, clientCrops, activeSessions = [], options = {}) {
  if (!db || !clientCrops || clientCrops.length === 0) return [];
  const identifiedPeople = [];
  const custService = options.customerService || customerService;
  const backgroundSync = options?.backgroundSync === true;

  try {
    // 1. Obtener perfiles para comparación biométrica rápida desde customerService (RAM cache / SQLite)
    if (!custService.isLoaded) {
      await custService.loadProfilesIntoMemory({ db });
    }

    const allKnown = custService.getComparisonProfiles();

    // 2. Extracción y análisis biométrico concurrente (ONNX RFB + ArcFace + Sharp en paralelo)
    const analyzedCrops = await Promise.all(clientCrops.map(async (crop, i) => {
      const record = clientRecords ? clientRecords[i] : null;

      // Descartar si proviene de una zona de tránsito peatonal (a menos que el usuario haya habilitado captura explícita)
      if (isTransitZone(crop) && crop.capturePerson !== true) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: zona de tránsito peatonal.`);
        return null;
      }

      // Regla: Solo registrar personas en zonas configuradas para captura (sillas, puestos o zonas de atención)
      const isCandidateForRecognition = crop.capturePerson === true ||
        crop.isStaffHint || 
        crop.role === "staff" ||
        crop.role === "visitor" ||
        crop.zoneType === "barber_workstation" ||
        crop.status === "en_servicio" ||
        crop.zoneType === "barber_chair" ||
        crop.zoneType === "waiting_chair" ||
        isChairZone(crop) ||
        crop.status === "en_corte" || 
        crop.status === "en_espera";

      if (!isCandidateForRecognition) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: zona no configurada para captura biométrica.`);
        return null;
      }

      // Filtro de Cara Frontal y Nitidez (Rechaza nucas, espaldas, orejas y codos con umbral por defecto 0.80)
      const quality = await evaluateFaceQuality(crop.buffer, { minSharpness: 40 });
      if (!quality.isValid) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: ${quality.reason} (No es rostro frontal nítido).`);
        return null;
      }

      const t0 = Date.now();
      const faceBuffer = quality.faceBuffer;
      const embedding = await extractFaceEmbedding(faceBuffer);
      console.log(`[FaceRecognition] Embedding extraído en ${Date.now() - t0} ms (Nitidez: ${quality.sharpnessScore}).`);

      // Generar miniatura JPEG ultra-ligera (120x120) para el frontend
      let faceThumbnailBase64 = null;
      try {
        const thumbBuf = await sharp(faceBuffer)
          .resize(120, 120, { fit: "cover" })
          .jpeg({ quality: 82 })
          .toBuffer();
        faceThumbnailBase64 = `data:image/jpeg;base64,${thumbBuf.toString("base64")}`;
      } catch (_) {
        faceThumbnailBase64 = `data:image/jpeg;base64,${faceBuffer.toString("base64")}`;
      }

      return {
        crop,
        record,
        i,
        quality,
        faceBuffer,
        embedding,
        faceThumbnailBase64
      };
    }));

    for (const analyzed of analyzedCrops) {
      if (!analyzed) continue;
      const { crop, record, i, quality, faceBuffer, embedding, faceThumbnailBase64 } = analyzed;

      // 1. EVALUACIÓN PRIORITARIA Y EXCLUSIVA DEL BARBERO / STAFF
      // Regla: "Si se parece al barbero, no se guarda como cliente ni se asocia a visitas".
      // INMUTABILIDAD TOTAL: El streaming NUNCA sobrescribe, borra ni altera fotos de un perfil de Staff en caliente.
      const staffMatch = matchStaffFace(embedding, allKnown, 0.58);

      if (staffMatch.isStaffMatch) {
        const staff = staffMatch.staffProfile;
        staff.lastSeen = new Date().toISOString();

        console.log(`[FaceRecognition] Barbero / Staff identificado: "${staff.name}" (Similitud: ${staffMatch.maxStaffSim.toFixed(3)}). Excluido de clientes.`);

        identifiedPeople.push({
          cropId: crop.id || `crop_${i + 1}`,
          box: crop.box,
          personId: staff.id,
          name: staff.name,
          isStaff: true,
          role: "Barbero / Staff",
          similarity: staffMatch.maxStaffSim,
          confidence: crop.confidence,
          faceBuffer: quality.faceBuffer,
          faceBoxNorm: quality.faceBoxNorm,
          thumbnailBase64: staff.thumbnailBase64 || staff.photos?.[0]?.thumbnailBase64 || faceThumbnailBase64,
          sharpnessScore: quality.sharpnessScore
        });

        // NUNCA procesar al barbero como cliente, ni en sesión de silla ni en debounce.
        // NUNCA alterar la galería de fotos del personal en streaming.
        continue;
      }

      // 3. GOBERNANZA TEMPORAL DE SESIÓN EN SILLA (PROTEGIDA CONTRA INTRUSIÓN)
      const activeSession = activeSessions.find(s =>
        (s.chairId && crop.zoneId && s.chairId === crop.zoneId) ||
        (s.chairName && crop.zoneId && s.chairName === crop.zoneId)
      );

      let sessionMatched = false;
      if (activeSession && activeSession.personId && !activeSession.isStaff) {
        let p = custService.getCustomerData(activeSession.personId) || allKnown.find(kp => kp.id === activeSession.personId);
        if (!p) {
          const initialPhoto = {
            thumbnailBase64: faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore || activeSession.bestFaceScore || 0,
            capturedAt: new Date().toISOString(),
            pose: quality.pose || 'frontal',
            poseLabel: quality.poseLabel || 'Frontal'
          };
          p = {
            id: activeSession.personId,
            name: activeSession.personName || "Cliente",
            isStaff: false,
            visitCount: activeSession.visitCount || 1,
            bestFaceScore: activeSession.bestFaceScore || 0,
            embedding,
            embeddings: [embedding],
            photos: [initialPhoto],
            thumbnailBase64: faceThumbnailBase64
          };
          allKnown.push(p);
        }

        // Extraer vectores del perfil para calcular similitud contra el cliente en la silla
        const pVectors = [];
        if (Array.isArray(p.embeddings) && p.embeddings.length > 0) {
          for (const item of p.embeddings) {
            if (Array.isArray(item)) pVectors.push(item);
            else if (item && Array.isArray(item.vector)) pVectors.push(item.vector);
          }
        }
        if (pVectors.length === 0 && Array.isArray(p.embedding)) {
          pVectors.push(p.embedding);
        }

        const canonicalVector = pVectors[0] || null;
        const canonicalSim = canonicalVector ? computeCosineSimilarity(embedding, canonicalVector) : 1.0;
        const maxSim = pVectors.length > 0
          ? Math.max(...pVectors.map(v => computeCosineSimilarity(embedding, v)))
          : 1.0;

        // Validar que el rostro en la silla efectivamente corresponda al cliente de la sesión:
        // Exigir similitud canónica >= 0.48 (o maxSim >= 0.55 con canónico >= 0.42)
        const isMatchToSessionClient = canonicalSim >= 0.48 || (maxSim >= 0.55 && canonicalSim >= 0.42);

        if (isMatchToSessionClient) {
          sessionMatched = true;
          let currentGallery = Array.isArray(p.embeddings) && p.embeddings.length > 0
            ? [...p.embeddings]
            : (Array.isArray(p.embedding) ? [p.embedding] : []);
          let galleryUpdated = false;

          const pPhotosCount = Array.isArray(p.photos) ? p.photos.length : 0;
          const pEmbeddingsCount = currentGallery.length;
          const hasMissingPhotos = pPhotosCount < pEmbeddingsCount && pPhotosCount < 20;

          const nowEpoch = Date.now();
          const lastPhotoTime = p.lastPhotoAtEpoch || (p.lastPhotoAt ? new Date(p.lastPhotoAt).getTime() : 0);
          const timeSinceLastPhoto = nowEpoch - lastPhotoTime;
          const cadencePassed = timeSinceLastPhoto >= 20000;
          const canAddMorePhotos = pPhotosCount < 20 && (cadencePassed || pPhotosCount === 0);

          const isNovelAngle = maxSim >= 0.50 && maxSim <= 0.88 && canonicalSim >= 0.48;
          const hasHigherSharpness = quality.sharpnessScore > (p.bestFaceScore || 0) && canonicalSim >= 0.48;

          const currentPoses = new Set((p.photos || []).map(ph => ph.pose || 'frontal'));
          const isUnrepresentedPose = quality.pose && !currentPoses.has(quality.pose) && canonicalSim >= 0.48;

          if (canAddMorePhotos || isNovelAngle || hasHigherSharpness || hasMissingPhotos || isUnrepresentedPose) {
            const enriched = enrichPersonAngles(p, {
              embedding,
              faceThumbnailBase64,
              sharpnessScore: quality.sharpnessScore,
              pose: quality.pose,
              poseLabel: quality.poseLabel,
              nowEpoch
            }, { minCanonicalSimilarity: 0.48, enforceCooldown: !canAddMorePhotos && !hasMissingPhotos });

            if (!enriched.rejected && !enriched.duplicate) {
              p.lastPhotoAtEpoch = nowEpoch;
              p.lastPhotoAt = new Date(nowEpoch).toISOString();
              currentGallery = enriched.embeddings;
              p.photos = enriched.photos;
              galleryUpdated = true;
              console.log(`[FaceRecognition] 📸 Rostro añadido a galería de "${p.name}" (Total fotos: ${p.photos.length}/20, Nitidez: ${quality.sharpnessScore}, Pose: ${quality.pose || 'frontal'}).`);
            } else if (enriched.duplicate && enriched.updatedSharpness) {
              currentGallery = enriched.embeddings;
              p.photos = enriched.photos;
              galleryUpdated = true;
            }
          }

          if (!p.photos || p.photos.length === 0) {
            p.photos = [{
              thumbnailBase64: faceThumbnailBase64,
              sharpnessScore: quality.sharpnessScore || 0,
              capturedAt: new Date().toISOString(),
              pose: quality.pose || 'frontal',
              poseLabel: quality.poseLabel || 'Frontal'
            }];
            p.bestFaceScore = quality.sharpnessScore;
            p.thumbnailBase64 = faceThumbnailBase64;
            p.embedding = embedding;
            galleryUpdated = true;
          } else if (hasHigherSharpness) {
            p.bestFaceScore = quality.sharpnessScore;
            p.thumbnailBase64 = faceThumbnailBase64;
            p.embedding = embedding;
          }

          if (galleryUpdated) {
            p.embeddings = currentGallery;
          }

          // En streaming en tiempo real: actualizar solo en memoria RAM sin llamadas a Firestore cuadro a cuadro
          if (custService?.profilesCache) {
            custService.profilesCache.set(p.id, p);
          }

          console.log(`[FaceRecognition] Rostro confirmado en sesión activa de ${crop.zoneId || 'silla'} -> Cliente: "${p.name}" (${p.id}).`);

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            box: crop.box,
            personId: p.id,
            name: p.name,
            isStaff: false,
            isFrequent: (p.visitCount || 1) > 1,
            visitCount: p.visitCount || 1,
            similarity: maxSim,
            confidence: crop.confidence,
            faceBuffer: quality.faceBuffer,
            faceBoxNorm: quality.faceBoxNorm,
            thumbnailBase64: faceThumbnailBase64 || p.photos?.[0]?.thumbnailBase64 || p.thumbnailBase64,
            sharpnessScore: quality.sharpnessScore,
            sessionGoverned: true,
            photos: p.photos || []
          });

          continue;
        } else {
          console.log(`[FaceRecognition] Rostro en silla (${crop.zoneId}) no coincide con cliente de sesión "${p.name}" (canónico: ${canonicalSim.toFixed(3)} < 0.65). No se asocia a su galería.`);
        }
      }

      // 4. IDENTIFICACIÓN 1:N CONTRA CLIENTES REGISTRADOS
      // Solo clientes (staff ya fue excluido arriba), umbral estricto 0.65
      const clientProfiles = allKnown.filter(p => !p.isStaff && p.role !== "barber");
      const result = identifyFace(embedding, clientProfiles, 0.65);

      if (result.matched && result.profile) {
        const fullCustomer = custService?.getCustomerData?.(result.profile.id);
        const p = fullCustomer || result.profile;

        // Comprobar ausencia de ambigüedad con el barbero
        const isAmbiguousWithStaff = (result.similarity - staffMatch.maxStaffSim < 0.10);
        if (isAmbiguousWithStaff) {
          console.log(`[FaceRecognition] Match con "${p.name}" descartado por ambigüedad con Barbero (Cliente: ${result.similarity.toFixed(3)}, Barbero: ${staffMatch.maxStaffSim.toFixed(3)}). "Si se parece al barbero, no se guarda".`);
          continue;
        }

        // Comprobar coherencia con el rostro canónico del cliente
        const pVectors = [];
        if (Array.isArray(p.embeddings) && p.embeddings.length > 0) {
          for (const item of p.embeddings) {
            if (Array.isArray(item)) pVectors.push(item);
            else if (item && Array.isArray(item.vector)) pVectors.push(item.vector);
          }
        }
        if (pVectors.length === 0 && Array.isArray(p.embedding)) pVectors.push(p.embedding);
        const canonicalVector = pVectors[0] || null;
        const canonicalSim = canonicalVector ? computeCosineSimilarity(embedding, canonicalVector) : result.similarity;

        if (canonicalSim < 0.60) {
          console.log(`[FaceRecognition] Match con "${p.name}" rechazado: similitud con rostro canónico (${canonicalSim.toFixed(3)}) < 0.60. No se guarda.`);
          continue;
        }

        console.log(`[FaceRecognition] Match biométrico confirmado: "${p.name}" (Similitud: ${result.similarity.toFixed(3)}, Canónica: ${canonicalSim.toFixed(3)})`);

        // Cliente existente: durante streaming en tiempo real NO incrementar visitas ni modificar lastSeen cuadro a cuadro
        const count = p.visitCount || 1;
        if (record?.storagePath) {
          p.thumbnailPath = record.storagePath;
        }

        let currentGallery = Array.isArray(p.embeddings) && p.embeddings.length > 0
          ? [...p.embeddings]
          : (Array.isArray(p.embedding) ? [p.embedding] : []);
        let galleryUpdated = false;

        const pPhotosCount = Array.isArray(p.photos) ? p.photos.length : 0;
        const pEmbeddingsCount = currentGallery.length;
        const hasMissingPhotos = pPhotosCount < pEmbeddingsCount && pPhotosCount < 20;

        const nowEpoch = Date.now();
        const lastPhotoTime = p.lastPhotoAtEpoch || (p.lastPhotoAt ? new Date(p.lastPhotoAt).getTime() : 0);
        const timeSinceLastPhoto = nowEpoch - lastPhotoTime;
        const cadencePassed = timeSinceLastPhoto >= 20000;
        const canAddMorePhotos = pPhotosCount < 20 && (cadencePassed || pPhotosCount === 0);

        const isNovelAngle = result.similarity >= 0.50 && result.similarity <= 0.88 && canonicalSim >= 0.48;
        const hasHigherSharpness = quality.sharpnessScore > (p.bestFaceScore || 0) && canonicalSim >= 0.48;

        const currentPoses = new Set((p.photos || []).map(ph => ph.pose || 'frontal'));
        const isUnrepresentedPose = quality.pose && !currentPoses.has(quality.pose) && canonicalSim >= 0.48;

        if (canAddMorePhotos || isNovelAngle || hasHigherSharpness || hasMissingPhotos || isUnrepresentedPose) {
          const enriched = enrichPersonAngles(p, {
            embedding,
            faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore,
            pose: quality.pose,
            poseLabel: quality.poseLabel,
            nowEpoch
          }, { minCanonicalSimilarity: 0.48, enforceCooldown: !canAddMorePhotos && !hasMissingPhotos });

          if (!enriched.rejected && !enriched.duplicate) {
            p.lastPhotoAtEpoch = nowEpoch;
            p.lastPhotoAt = new Date(nowEpoch).toISOString();
            currentGallery = enriched.embeddings;
            p.photos = enriched.photos;
            galleryUpdated = true;
            console.log(`[FaceRecognition] 📸 Rostro complementario añadido a cliente "${p.name}" (Total fotos: ${p.photos.length}/20, Nitidez: ${quality.sharpnessScore}, Pose: ${quality.pose || 'frontal'}).`);
          } else if (enriched.duplicate && enriched.updatedSharpness) {
            currentGallery = enriched.embeddings;
            p.photos = enriched.photos;
            galleryUpdated = true;
          }
        }

        if (!p.photos || p.photos.length === 0) {
          p.photos = [{
            thumbnailBase64: faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore || 0,
            capturedAt: new Date().toISOString(),
            pose: quality.pose || 'frontal',
            poseLabel: quality.poseLabel || 'Frontal'
          }];
          p.bestFaceScore = quality.sharpnessScore;
          p.thumbnailBase64 = faceThumbnailBase64;
          p.embedding = embedding;
          galleryUpdated = true;
        } else if (hasHigherSharpness) {
          p.bestFaceScore = quality.sharpnessScore;
          p.thumbnailBase64 = faceThumbnailBase64;
          p.embedding = embedding;
        }

        if (galleryUpdated) {
          p.embeddings = currentGallery;
        }

        // En streaming en tiempo real: actualizar solo en memoria RAM sin llamadas a Firestore cuadro a cuadro
        if (custService?.profilesCache) {
          custService.profilesCache.set(p.id, p);
        }

        identifiedPeople.push({
          cropId: crop.id || `crop_${i + 1}`,
          box: crop.box,
          personId: p.id,
          name: p.name,
          isStaff: false,
          isFrequent: count > 1,
          visitCount: count,
          similarity: result.similarity,
          confidence: crop.confidence,
          faceBuffer: quality.faceBuffer,
          faceBoxNorm: quality.faceBoxNorm,
          thumbnailBase64: faceThumbnailBase64 || p.photos?.[0]?.thumbnailBase64 || p.thumbnailBase64,
          sharpnessScore: quality.sharpnessScore,
          photos: p.photos || []
        });
      } else {
        // 5. GESTIÓN DE CANDIDATOS EN MEMORIA (TELEMETRÍA)
        // Regla: "si se parece al barbero, no se guarda".
        if (staffMatch.maxStaffSim >= 0.58) {
          console.log(`[FaceRecognition] Candidato descartado para nuevo cliente: sospecha de Barbero (similitud: ${staffMatch.maxStaffSim.toFixed(3)} >= 0.58).`);
          continue;
        }

        let matchedCandidateKey = null;
        let candidate = null;
        let candidateSim = 0;

        for (const [key, cand] of pendingNewClients.entries()) {
          // Expirar candidatos inactivos > 120 seg
          if (Date.now() - cand.lastSeen > 120000) {
            pendingNewClients.delete(key);
            continue;
          }
          const candVectors = Array.isArray(cand.embeddings) && cand.embeddings.length > 0
            ? cand.embeddings
            : (Array.isArray(cand.embedding) ? [cand.embedding] : []);
          const sim = candVectors.length > 0
            ? Math.max(...candVectors.map(v => computeCosineSimilarity(embedding, v)))
            : 0;

          // Exigir similitud biométrica real >= 0.52 para considerar el mismo candidato
          if (sim >= 0.52) {
            matchedCandidateKey = key;
            candidate = cand;
            candidateSim = sim;
            break;
          }
        }

        if (candidate) {
          candidate.count += 1;
          candidate.lastSeen = Date.now();
          if (!candidate.name) candidate.name = "Candidato";
          if (!candidate.embeddings) candidate.embeddings = [candidate.embedding];
          if (!Array.isArray(candidate.photos) || candidate.photos.length === 0) {
            candidate.photos = [{
              thumbnailBase64: candidate.faceThumbnailBase64 || faceThumbnailBase64,
              sharpnessScore: candidate.bestFaceScore || quality?.sharpnessScore || 0,
              capturedAt: new Date(candidate.firstSeen || Date.now()).toISOString(),
              pose: candidate.pose || quality?.pose || 'frontal',
              poseLabel: candidate.poseLabel || quality?.poseLabel || 'Frontal'
            }];
          }

          const candPoses = new Set((candidate.photos || []).map(ph => ph.pose || 'frontal'));
          const isCandUnrepresentedPose = quality.pose && !candPoses.has(quality.pose);

          if (candidate.embeddings.length < 20 && (quality.sharpnessScore > (candidate.bestFaceScore || 0) || (candidateSim >= 0.50 && candidateSim <= 0.88) || isCandUnrepresentedPose)) {
            const enriched = enrichPersonAngles(candidate, {
              embedding,
              faceThumbnailBase64,
              sharpnessScore: quality.sharpnessScore,
              pose: quality.pose,
              poseLabel: quality.poseLabel
            }, { minCanonicalSimilarity: 0.48 });
            candidate.embeddings = enriched.embeddings;
            candidate.photos = enriched.photos;
          }
          if (quality.sharpnessScore > (candidate.bestFaceScore || 0)) {
            candidate.embedding = embedding;
            candidate.faceThumbnailBase64 = faceThumbnailBase64;
            candidate.bestFaceScore = quality.sharpnessScore;
            candidate.pose = quality.pose;
            candidate.poseLabel = quality.poseLabel;
          }

          // Re-verificar que no se parezca al barbero con umbral sensible 0.46
          const candStaffCheck = matchStaffFace(candidate.embedding, allKnown, 0.46);
          if (candStaffCheck.isStaffMatch || candStaffCheck.maxStaffSim >= 0.46) {
            console.log(`[FaceRecognition] Candidato descartado: sospecha de Barbero (similitud: ${candStaffCheck.maxStaffSim.toFixed(3)} >= 0.46). No se crea cliente.`);
            pendingNewClients.delete(matchedCandidateKey);
            continue;
          }

          console.log(`[FaceRecognition] Candidato acumulado en memoria (${candidate.count} ciclos) en ${crop.zoneId || 'silla'}. Sin creación prematura en Firestore.`);

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            box: crop.box,
            personId: candidate.tempId,
            name: null,
            isStaff: false,
            isFrequent: false,
            isPendingConfirmation: true,
            isCandidate: true,
            candidateCount: candidate.count,
            visitCount: 1,
            similarity: result.similarity,
            confidence: crop.confidence,
            faceBuffer: quality.faceBuffer,
            faceBoxNorm: quality.faceBoxNorm,
            thumbnailBase64: faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore,
            photos: candidate.photos || []
          });
        } else {
          // Ciclo 1: Registrar como candidato pendiente en memoria
          const tempId = `person_${Date.now()}_${i + 1}`;
          const candidateKey = `cand_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          const initialPhoto = {
            thumbnailBase64: faceThumbnailBase64,
            sharpnessScore: quality?.sharpnessScore || 0,
            capturedAt: new Date().toISOString(),
            pose: quality?.pose || 'frontal',
            poseLabel: quality?.poseLabel || 'Frontal'
          };
          pendingNewClients.set(candidateKey, {
            tempId,
            zoneId: crop.zoneId || null,
            count: 1,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            embedding,
            embeddings: [embedding],
            photos: [initialPhoto],
            faceThumbnailBase64,
            bestFaceScore: quality.sharpnessScore,
            pose: quality?.pose || 'frontal',
            poseLabel: quality?.poseLabel || 'Frontal',
            storagePath: record ? record.storagePath : ""
          });

          console.log(`[FaceRecognition] Nuevo rostro detectado en ${crop.zoneId || 'silla'}: candidato registrado en memoria.`);

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            box: crop.box,
            personId: tempId,
            name: null,
            isStaff: false,
            isFrequent: false,
            isPendingConfirmation: true,
            isCandidate: true,
            candidateCount: 1,
            visitCount: 1,
            similarity: result.similarity,
            confidence: crop.confidence,
            faceBuffer: quality.faceBuffer,
            faceBoxNorm: quality.faceBoxNorm,
            thumbnailBase64: faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore,
            photos: [initialPhoto]
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[FaceRecognition] Error en proceso de reconocimiento facial:`, err.message);
  }

  return identifiedPeople;
}
