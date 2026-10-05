/**
 * Servicio de Reconocimiento y Re-identificación de Personas
 * Gestiona la comparación biométrica de rostros, coincidencia con staff y clientes frecuentes,
 * y persistencia de perfiles biométricos en Firestore.
 */

import { extractFaceEmbedding, identifyFace } from "../face_recognizer.js";

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
      const record = clientRecords[i];
      const t0 = Date.now();

      const embedding = await extractFaceEmbedding(crop.buffer);
      console.log(`[FaceRecognition] Embedding extraído en ${Date.now() - t0} ms.`);

      const result = identifyFace(embedding, allKnown, 0.45);

      if (result.matched && result.profile) {
        const p = result.profile;
        console.log(`[FaceRecognition] Match biométrico: "${p.name}" (Similitud: ${result.similarity}, Staff: ${p.isStaff ? "SÍ" : "NO"})`);

        if (p.isStaff) {
          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            personId: p.id,
            name: p.name,
            isStaff: true,
            role: "Barbero / Staff",
            similarity: result.similarity,
            confidence: crop.confidence
          });
        } else {
          // Cliente existente: incrementar visitas y actualizar fecha
          const newCount = (p.visitCount || 1) + 1;
          await db.doc(`camera_catcher_people/${p.id}`).update({
            lastSeen: new Date().toISOString(),
            lastThumbnailPath: record ? record.storagePath : "",
            visitCount: newCount
          });

          identifiedPeople.push({
            cropId: crop.id || `crop_${i + 1}`,
            personId: p.id,
            name: p.name,
            isStaff: false,
            isFrequent: newCount > 1,
            visitCount: newCount,
            similarity: result.similarity,
            confidence: crop.confidence
          });
        }
      } else {
        // Nuevo cliente
        const totalProfiles = knownProfiles.length + 1;
        const newPersonId = `person_${Date.now()}_${i + 1}`;
        const newName = `Cliente #${totalProfiles}`;

        const newProfile = {
          id: newPersonId,
          name: newName,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          visitCount: 1,
          isStaff: false,
          embedding: embedding,
          thumbnailPath: record ? record.storagePath : ""
        };

        await db.doc(`camera_catcher_people/${newPersonId}`).set(newProfile);
        console.log(`[FaceRecognition] Nuevo cliente registrado en Firestore: "${newName}" (${newPersonId})`);

        identifiedPeople.push({
          cropId: crop.id || `crop_${i + 1}`,
          personId: newPersonId,
          name: newName,
          isStaff: false,
          isFrequent: false,
          visitCount: 1,
          similarity: result.similarity,
          confidence: crop.confidence
        });

        knownProfiles.push(newProfile);
        allKnown.push(newProfile);
      }
    }
  } catch (err) {
    console.warn(`[FaceRecognition] Error en proceso de reconocimiento facial:`, err.message);
  }

  return identifiedPeople;
}
