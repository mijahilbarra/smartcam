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
    // Conserva la foto frontal original de referencia (índice 0) y rota las intermedias
    existingPhotos = [existingPhotos[0], ...existingPhotos.slice(2), newPhoto];
  }

  return existingPhotos;
}

/**
 * Enriquece la galería biométrica y de fotos de un cliente existente con un nuevo ángulo
 * garantizando correspondencia estricta 1:1 entre embeddings y fotos hasta 20 ángulos.
 * @param {Object} person - Perfil del cliente
 * @param {Object} data - Datos del nuevo ángulo ({ embedding, faceThumbnailBase64, sharpnessScore, pose, poseLabel })
 * @returns {{ embeddings: Array, photos: Array }}
 */
export function enrichPersonAngles(person, { embedding, faceThumbnailBase64, sharpnessScore = 0, pose, poseLabel }) {
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

  const updatedPhotos = enrichPersonPhotos(person, faceThumbnailBase64, sharpnessScore, { pose, poseLabel });

  if (embedding) {
    if (currentGallery.length < 20) {
      currentGallery.push(embedding);
    } else if (existingPhotos.length < currentGallery.length) {
      // Perfil legado con más embeddings que fotos (ej: 20 embeddings y 1 foto):
      // Asignamos el nuevo embedding en la posición correspondiente al nuevo ángulo de foto (updatedPhotos.length - 1)
      const photoIdx = updatedPhotos.length - 1;
      if (photoIdx >= 0 && photoIdx < currentGallery.length) {
        currentGallery[photoIdx] = embedding;
      } else {
        currentGallery = [currentGallery[0], ...currentGallery.slice(2), embedding];
      }
    } else {
      // Galería completa (20 ángulos y 20 fotos): rotación en paralelo estricto con photos
      currentGallery = [currentGallery[0], ...currentGallery.slice(2), embedding];
    }
  }

  return {
    embeddings: currentGallery,
    photos: updatedPhotos
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

  try {
    // 1. Obtener perfiles para comparación biométrica rápida desde customerService (RAM cache / SQLite)
    if (!custService.isLoaded) {
      await custService.loadProfilesIntoMemory({ db });
    }

    const allKnown = custService.getComparisonProfiles();

    for (let i = 0; i < clientCrops.length; i++) {
      const crop = clientCrops[i];
      const record = clientRecords ? clientRecords[i] : null;

      // Descartar si proviene de una zona de tránsito peatonal (a menos que el usuario haya habilitado captura explícita)
      if (isTransitZone(crop) && crop.capturePerson !== true) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: zona de tránsito peatonal.`);
        continue;
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
        continue;
      }

      // Filtro de Cara Frontal y Nitidez (Rechaza nucas, espaldas, orejas y codos con umbral 0.70)
      const quality = await evaluateFaceQuality(crop.buffer, { minConfidence: 0.70, minSharpness: 40 });
      if (!quality.isValid) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: ${quality.reason} (No es rostro frontal nítido).`);
        continue;
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

      // GOBERNANZA TEMPORAL DE SESIÓN:
      // Si el rostro detectado se ubica en la zona/silla de una sesión activa que ya tiene un cliente identificado:
      // - NUNCA crear un nuevo cliente ni candidato en debounce.
      // - Asociar directamente la detección a ese cliente existente.
      // - Si el nuevo embedding ofrece un ángulo complementario (similitud 0.50 a 0.88), mayor nitidez o pose no representada, incorporarlo a su galería (hasta 20).
      const activeSession = activeSessions.find(s =>
        (s.chairId && crop.zoneId && s.chairId === crop.zoneId) ||
        (s.chairName && crop.zoneId && s.chairName === crop.zoneId)
      );

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

        // Extraer vectores del perfil para calcular similitud contra su galería actual
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

        const sim = pVectors.length > 0
          ? Math.max(...pVectors.map(v => computeCosineSimilarity(embedding, v)))
          : 1.0;

        let currentGallery = Array.isArray(p.embeddings) && p.embeddings.length > 0
          ? [...p.embeddings]
          : (Array.isArray(p.embedding) ? [p.embedding] : []);
        let galleryUpdated = false;

        const isNovelAngle = sim >= 0.50 && sim <= 0.88;
        const hasHigherSharpness = quality.sharpnessScore > (p.bestFaceScore || 0);
        const pPhotosCount = Array.isArray(p.photos) ? p.photos.length : 0;
        const pEmbeddingsCount = currentGallery.length;
        const hasMissingPhotos = pPhotosCount < pEmbeddingsCount && pPhotosCount < 20;

        const currentPoses = new Set((p.photos || []).map(ph => ph.pose || 'frontal'));
        const isUnrepresentedPose = quality.pose && !currentPoses.has(quality.pose);

        if (isNovelAngle || hasHigherSharpness || hasMissingPhotos || isUnrepresentedPose) {
          const enriched = enrichPersonAngles(p, {
            embedding,
            faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore,
            pose: quality.pose,
            poseLabel: quality.poseLabel
          });
          currentGallery = enriched.embeddings;
          p.photos = enriched.photos;
          galleryUpdated = true;
          console.log(`[FaceRecognition] Rostro añadido a galería de "${p.name}" (NovelAngle: ${isNovelAngle}, MayorNitidez: ${hasHigherSharpness}, FaltanFotos: ${hasMissingPhotos}, UnrepresentedPose: ${Boolean(isUnrepresentedPose)}, Total embeddings: ${currentGallery.length}/20, Total fotos: ${p.photos.length}/20).`);
        }

        if (hasHigherSharpness || !p.photos?.length) {
          p.bestFaceScore = quality.sharpnessScore;
          p.thumbnailBase64 = faceThumbnailBase64;
          p.embedding = embedding;
        }

        if (galleryUpdated) {
          p.embeddings = currentGallery;
        }

        p.lastSeen = new Date().toISOString();

        await custService.saveOrUpdateCustomer(p, {
          db,
          newAngle: isNovelAngle,
          higherSharpness: hasHigherSharpness,
          galleryUpdated,
          faceBuffer: quality.faceBuffer,
          sharpnessScore: quality.sharpnessScore
        });

        console.log(`[FaceRecognition] Rostro gobernado por sesión activa en ${crop.zoneId || 'silla'} -> Cliente: "${p.name}" (${p.id}).`);

        identifiedPeople.push({
          cropId: crop.id || `crop_${i + 1}`,
          box: crop.box,
          personId: p.id,
          name: p.name,
          isStaff: false,
          isFrequent: (p.visitCount || 1) > 1,
          visitCount: p.visitCount || 1,
          similarity: sim,
          confidence: crop.confidence,
          faceBuffer: quality.faceBuffer,
          faceBoxNorm: quality.faceBoxNorm,
          thumbnailBase64: faceThumbnailBase64 || p.photos?.[0]?.thumbnailBase64 || p.thumbnailBase64,
          sharpnessScore: quality.sharpnessScore,
          sessionGoverned: true,
          photos: p.photos || []
        });

        // Omitir debounce y búsqueda: la identidad está fijada por la sesión activa
        continue;
      }

      // Umbral biométrico calibrado con soporte de galería multi-ángulo (0.50)
      const result = identifyFace(embedding, allKnown, 0.50);

      if (result.matched && result.profile) {
        const p = result.profile;
        console.log(`[FaceRecognition] Match biométrico: "${p.name}" (Similitud: ${result.similarity}, Staff: ${p.isStaff ? "SÍ" : "NO"})`);

        if (p.isStaff) {
          p.lastSeen = new Date().toISOString();
          let higherSharpness = false;
          if (quality.sharpnessScore > (p.bestFaceScore || 0) || !p.photos?.length) {
            p.bestFaceScore = quality.sharpnessScore;
            p.thumbnailBase64 = faceThumbnailBase64;
            higherSharpness = true;
          }
          await custService.saveOrUpdateCustomer(p, {
            db,
            higherSharpness,
            faceBuffer: quality.faceBuffer,
            sharpnessScore: quality.sharpnessScore
          });

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            box: crop.box,
            personId: p.id,
            name: p.name,
            isStaff: true,
            role: "Barbero / Staff",
            similarity: result.similarity,
            confidence: crop.confidence,
            faceBuffer: quality.faceBuffer,
            faceBoxNorm: quality.faceBoxNorm,
            thumbnailBase64: faceThumbnailBase64 || p.photos?.[0]?.thumbnailBase64 || p.thumbnailBase64,
            sharpnessScore: quality.sharpnessScore
          });
        } else {
          // Cliente existente: incrementar visitas y actualizar fecha
          const newCount = (p.visitCount || 1) + 1;
          p.visitCount = newCount;
          p.lastSeen = new Date().toISOString();
          if (record?.storagePath) {
            p.thumbnailPath = record.storagePath;
          }

          let currentGallery = Array.isArray(p.embeddings) && p.embeddings.length > 0
            ? [...p.embeddings]
            : (Array.isArray(p.embedding) ? [p.embedding] : []);
          let galleryUpdated = false;

          const isNovelAngle = result.similarity >= 0.50 && result.similarity <= 0.88;
          const hasHigherSharpness = quality.sharpnessScore > (p.bestFaceScore || 0);
          const pPhotosCount = Array.isArray(p.photos) ? p.photos.length : 0;
          const pEmbeddingsCount = currentGallery.length;
          const hasMissingPhotos = pPhotosCount < pEmbeddingsCount && pPhotosCount < 20;

          const currentPoses = new Set((p.photos || []).map(ph => ph.pose || 'frontal'));
          const isUnrepresentedPose = quality.pose && !currentPoses.has(quality.pose);

          if (isNovelAngle || hasHigherSharpness || hasMissingPhotos || isUnrepresentedPose) {
            const enriched = enrichPersonAngles(p, {
              embedding,
              faceThumbnailBase64,
              sharpnessScore: quality.sharpnessScore,
              pose: quality.pose,
              poseLabel: quality.poseLabel
            });
            currentGallery = enriched.embeddings;
            p.photos = enriched.photos;
            galleryUpdated = true;
            console.log(`[FaceRecognition] Rostro complementario añadido a cliente "${p.name}" (NovelAngle: ${isNovelAngle}, MayorNitidez: ${hasHigherSharpness}, FaltanFotos: ${hasMissingPhotos}, UnrepresentedPose: ${Boolean(isUnrepresentedPose)}, Total embeddings: ${currentGallery.length}/20, Total fotos: ${p.photos.length}/20).`);
          }

          if (hasHigherSharpness || !p.photos?.length) {
            p.bestFaceScore = quality.sharpnessScore;
            p.thumbnailBase64 = faceThumbnailBase64;
            p.embedding = embedding;
          }

          if (galleryUpdated) {
            p.embeddings = currentGallery;
          }

          await custService.saveOrUpdateCustomer(p, {
            db,
            newAngle: isNovelAngle,
            higherSharpness: hasHigherSharpness,
            galleryUpdated,
            faceBuffer: quality.faceBuffer,
            sharpnessScore: quality.sharpnessScore
          });

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            box: crop.box,
            personId: p.id,
            name: p.name,
            isStaff: false,
            isFrequent: newCount > 1,
            visitCount: newCount,
            similarity: result.similarity,
            confidence: crop.confidence,
            faceBuffer: quality.faceBuffer,
            faceBoxNorm: quality.faceBoxNorm,
            thumbnailBase64: faceThumbnailBase64 || p.photos?.[0]?.thumbnailBase64 || p.thumbnailBase64,
            sharpnessScore: quality.sharpnessScore,
            photos: p.photos || []
          });
        }
      } else {
        // Persona no reconocida previamente.
        // Aplicar Confirmación Temporal (Debounce): Exigir al menos 3 ciclos consecutivos
        // sentado en la silla de barbero antes de crear un nuevo perfil en Firestore.
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
          if (sim >= 0.50 || (crop.zoneId && cand.zoneId === crop.zoneId)) {
            matchedCandidateKey = key;
            candidate = cand;
            candidateSim = sim;
            break;
          }
        }

        if (candidate) {
          candidate.count += 1;
          candidate.lastSeen = Date.now();
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
            });
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

          if (candidate.count >= 3) {
            // Confirmado por 3 ciclos: Crear perfil definitivo en SQLite / Firestore
            const totalProfiles = (custService.profilesCache?.size || allKnown.length) + 1;
            const newPersonId = candidate.tempId || `person_${Date.now()}_${i + 1}`;
            const newName = `Cliente #${totalProfiles}`;
            const clientEmbeddings = candidate.embeddings && candidate.embeddings.length > 0
              ? candidate.embeddings
              : [candidate.embedding];

            const initialPhotos = Array.isArray(candidate.photos) && candidate.photos.length > 0
              ? candidate.photos
              : [{
                  thumbnailBase64: candidate.faceThumbnailBase64 || faceThumbnailBase64,
                  sharpnessScore: candidate.bestFaceScore || quality?.sharpnessScore || 0,
                  capturedAt: new Date().toISOString(),
                  pose: quality?.pose || 'frontal',
                  poseLabel: quality?.poseLabel || 'Frontal'
                }];

            const newProfile = {
              id: newPersonId,
              name: newName,
              firstSeen: new Date(candidate.firstSeen).toISOString(),
              lastSeen: new Date().toISOString(),
              visitCount: 1,
              isStaff: false,
              role: "client",
              embedding: candidate.embedding,
              embeddings: clientEmbeddings,
              photos: initialPhotos,
              thumbnailBase64: candidate.faceThumbnailBase64 || faceThumbnailBase64,
              thumbnailPath: record ? record.storagePath : "",
              bestFaceScore: candidate.bestFaceScore || quality?.sharpnessScore || 0
            };

            await custService.saveOrUpdateCustomer(newProfile, {
              db,
              isNew: true,
              faceBuffer: quality.faceBuffer,
              sharpnessScore: quality.sharpnessScore
            });
            console.log(`[FaceRecognition] ✅ Cliente confirmado tras 3 ciclos y registrado en SQLite/Firestore con ${initialPhotos.length} fotos: "${newName}" (${newPersonId})`);

            pendingNewClients.delete(matchedCandidateKey);
            allKnown.push(newProfile);

            identifiedPeople.push({
              cropId: crop.id || `crop_${i + 1}`,
              box: crop.box,
              personId: newPersonId,
              name: newName,
              isStaff: false,
              isFrequent: false,
              isPendingConfirmation: false,
              visitCount: 1,
              similarity: result.similarity,
              confidence: crop.confidence,
              faceBuffer: quality.faceBuffer,
              faceBoxNorm: quality.faceBoxNorm,
              thumbnailBase64: faceThumbnailBase64,
              sharpnessScore: quality.sharpnessScore,
              photos: initialPhotos
            });
          } else {
            console.log(`[FaceRecognition] Candidato en confirmación (${candidate.count}/3 ciclos) en ${crop.zoneId || 'silla'}.`);
            identifiedPeople.push({
              cropId: crop.id || `crop_${i + 1}`,
              box: crop.box,
              personId: candidate.tempId,
              name: `Cliente en confirmación (${candidate.count}/3)`,
              isStaff: false,
              isPendingConfirmation: true,
              visitCount: 1,
              similarity: result.similarity,
              confidence: crop.confidence,
              faceBuffer: quality.faceBuffer,
              faceBoxNorm: quality.faceBoxNorm,
              thumbnailBase64: faceThumbnailBase64,
              sharpnessScore: quality.sharpnessScore
            });
          }
        } else {
          // Ciclo 1: Registrar como candidato pendiente de confirmación
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

          console.log(`[FaceRecognition] Nuevo rostro detectado en ${crop.zoneId || 'silla'}: ciclo 1/3 para confirmación.`);

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            box: crop.box,
            personId: tempId,
            name: `Cliente en confirmación (1/3)`,
            isStaff: false,
            isPendingConfirmation: true,
            visitCount: 1,
            similarity: result.similarity,
            confidence: crop.confidence,
            faceBuffer: quality.faceBuffer,
            faceBoxNorm: quality.faceBoxNorm,
            thumbnailBase64: faceThumbnailBase64,
            sharpnessScore: quality.sharpnessScore
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[FaceRecognition] Error en proceso de reconocimiento facial:`, err.message);
  }

  return identifiedPeople;
}
