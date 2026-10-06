/**
 * Servicio de Reconocimiento y Re-identificación de Personas
 * Gestiona la comparación biométrica de rostros, coincidencia con staff y clientes frecuentes,
 * confirmación temporal (debounce) de nuevos clientes y persistencia de perfiles biométricos en Firestore.
 */

import sharp from "sharp";
import { extractFaceEmbedding, identifyFace, computeCosineSimilarity } from "../face_recognizer.js";
import { evaluateFaceQuality } from "./face_quality_service.js";
import { isChairZone, isTransitZone } from "../core/barbershop_rules.js";

// Buffer de candidatos a nuevos clientes para Confirmación Temporal (Debounce)
// Evita crear perfiles falsos en Firestore en el milisegundo 0 (exige al menos 3 ciclos consecutivos)
const pendingNewClients = new Map();

/**
 * Limpia el buffer de candidatos (útil para tests)
 */
export function resetPendingCandidates() {
  pendingNewClients.clear();
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
 * @returns {Promise<Array>}
 */
export async function processPeopleRecognition(db, clientRecords, clientCrops) {
  if (!clientCrops || clientCrops.length === 0) return [];
  const identifiedPeople = [];

  try {
    // 1. Obtener perfiles conocidos y staff desde Firestore
    const profilesSnap = await db.collection("camera_catcher_people").get();
    const knownProfiles = [];
    profilesSnap.forEach(docSnap => {
      knownProfiles.push({ id: docSnap.id, ...docSnap.data() });
    });

    const staffDoc = await db.doc("camera_catcher/staff").get();
    const staffMembers = staffDoc.exists ? (staffDoc.data().members || []) : [];

    // Combinar staff con perfiles generales
    const allKnown = [
      ...staffMembers.map(s => ({ ...s, isStaff: true })),
      ...knownProfiles
    ];

    for (let i = 0; i < clientCrops.length; i++) {
      const crop = clientCrops[i];
      const record = clientRecords ? clientRecords[i] : null;

      // Descartar si proviene de una zona de tránsito peatonal (pasillo, puerta, entrada)
      if (isTransitZone(crop)) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: zona de tránsito peatonal.`);
        continue;
      }

      // Regla estricta: Solo registrar clientes sentados en silla o staff en servicio
      const isSeatedOrStaff = crop.isStaffHint || 
        crop.role === "staff" ||
        crop.zoneType === "barber_workstation" ||
        crop.status === "en_servicio" ||
        crop.zoneType === "barber_chair" ||
        crop.zoneType === "waiting_chair" ||
        isChairZone(crop) ||
        crop.status === "en_corte" || 
        crop.status === "en_espera";

      if (!isSeatedOrStaff) {
        console.log(`[FaceRecognition] Recorte ${crop.id || i + 1} omitido: persona no está sentada en silla de servicio.`);
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

      // Umbral biométrico estándar para ArcFace / MobileFaceNet (0.65)
      const result = identifyFace(embedding, allKnown, 0.65);

      if (result.matched && result.profile) {
        const p = result.profile;
        console.log(`[FaceRecognition] Match biométrico: "${p.name}" (Similitud: ${result.similarity}, Staff: ${p.isStaff ? "SÍ" : "NO"})`);

        if (p.isStaff) {
          const updateData = {
            lastSeen: new Date().toISOString()
          };
          if (quality.sharpnessScore > (p.bestFaceScore || 0) || !p.thumbnailBase64) {
            updateData.bestFaceScore = quality.sharpnessScore;
            updateData.thumbnailBase64 = faceThumbnailBase64;
          }
          await db.doc(`camera_catcher_people/${p.id}`).update(updateData).catch(() => {});

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
            thumbnailBase64: faceThumbnailBase64 || p.thumbnailBase64,
            sharpnessScore: quality.sharpnessScore
          });
        } else {
          // Cliente existente: incrementar visitas y actualizar fecha
          const newCount = (p.visitCount || 1) + 1;
          const updateData = {
            lastSeen: new Date().toISOString(),
            lastThumbnailPath: record ? record.storagePath : "",
            visitCount: newCount
          };
          if (quality.sharpnessScore > (p.bestFaceScore || 0) || !p.thumbnailBase64) {
            updateData.bestFaceScore = quality.sharpnessScore;
            updateData.thumbnailBase64 = faceThumbnailBase64;
          }
          await db.doc(`camera_catcher_people/${p.id}`).update(updateData);

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
            thumbnailBase64: faceThumbnailBase64 || p.thumbnailBase64,
            sharpnessScore: quality.sharpnessScore
          });
        }
      } else {
        // Persona no reconocida previamente.
        // Aplicar Confirmación Temporal (Debounce): Exigir al menos 3 ciclos consecutivos
        // sentado en la silla de barbero antes de crear un nuevo perfil en Firestore.
        let matchedCandidateKey = null;
        let candidate = null;

        for (const [key, cand] of pendingNewClients.entries()) {
          // Expirar candidatos inactivos > 120 seg
          if (Date.now() - cand.lastSeen > 120000) {
            pendingNewClients.delete(key);
            continue;
          }
          const sim = computeCosineSimilarity(embedding, cand.embedding);
          if (sim >= 0.60 || (crop.zoneId && cand.zoneId === crop.zoneId)) {
            matchedCandidateKey = key;
            candidate = cand;
            break;
          }
        }

        if (candidate) {
          candidate.count += 1;
          candidate.lastSeen = Date.now();
          if (quality.sharpnessScore > (candidate.bestFaceScore || 0)) {
            candidate.embedding = embedding;
            candidate.faceThumbnailBase64 = faceThumbnailBase64;
            candidate.bestFaceScore = quality.sharpnessScore;
          }

          if (candidate.count >= 3) {
            // Confirmado por 3 ciclos: Crear perfil definitivo en Firestore
            const totalProfiles = knownProfiles.length + 1;
            const newPersonId = candidate.tempId || `person_${Date.now()}_${i + 1}`;
            const newName = `Cliente #${totalProfiles}`;

            const newProfile = {
              id: newPersonId,
              name: newName,
              firstSeen: new Date(candidate.firstSeen).toISOString(),
              lastSeen: new Date().toISOString(),
              visitCount: 1,
              isStaff: false,
              role: "client",
              embedding: candidate.embedding,
              thumbnailBase64: candidate.faceThumbnailBase64 || faceThumbnailBase64,
              thumbnailPath: record ? record.storagePath : "",
              bestFaceScore: candidate.bestFaceScore
            };

            await db.doc(`camera_catcher_people/${newPersonId}`).set(newProfile);
            console.log(`[FaceRecognition] ✅ Cliente confirmado tras 3 ciclos y registrado en Firestore: "${newName}" (${newPersonId})`);

            pendingNewClients.delete(matchedCandidateKey);
            knownProfiles.push(newProfile);
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
              sharpnessScore: quality.sharpnessScore
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
          pendingNewClients.set(candidateKey, {
            tempId,
            zoneId: crop.zoneId || null,
            count: 1,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            embedding,
            faceThumbnailBase64,
            bestFaceScore: quality.sharpnessScore,
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
