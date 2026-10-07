/**
 * Utilidades puras para normalización, cálculo y fusión de perfiles biométricos
 * Cumple con ADR 12 y directrices de arquitectura modular.
 */

/**
 * Parsea cualquier formato de fecha soportado a milisegundos de época
 * @param {string|number|Date|Object} val
 * @returns {number} Milisegundos o 0
 */
export function parseDateMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  if (typeof val.seconds === 'number') return val.seconds * 1000;
  const d = new Date(val).getTime();
  return isNaN(d) ? 0 : d;
}

/**
 * Normaliza un score de nitidez a entero de 0 a 100
 * @param {number|string} val
 * @returns {number}
 */
export function normalizeSharpness(val) {
  if (val == null) return 0;
  const num = Number(val);
  if (isNaN(num)) return 0;
  if (num <= 1 && num > 0) return Math.round(num * 100);
  return Math.round(num);
}

/**
 * Extrae y normaliza todas las fotos de un perfil
 * @param {Object} person
 * @returns {Array} Array de fotos { thumbnailBase64, sharpnessScore, capturedAt }
 */
export function extractPersonPhotos(person) {
  if (!person) return [];
  if (Array.isArray(person.photos) && person.photos.length > 0) {
    return person.photos.map(p => ({
      thumbnailBase64: p.thumbnailBase64,
      sharpnessScore: normalizeSharpness(p.sharpnessScore),
      capturedAt: p.capturedAt || person.firstSeen || person.lastSeen || new Date().toISOString()
    }));
  }
  if (person.thumbnailBase64) {
    return [{
      thumbnailBase64: person.thumbnailBase64,
      sharpnessScore: normalizeSharpness(person.bestFaceScore),
      capturedAt: person.firstSeen || person.lastSeen || new Date().toISOString()
    }];
  }
  return [];
}

/**
 * Sanitiza y encapsula una lista de embeddings para almacenamiento seguro en Firestore.
 * Firestore rechaza matrices anidadas directas (Array<Array<number>>).
 * Encapsula cada vector en un objeto { vector: [...] } compatible con Firestore Web SDK y Node Admin SDK.
 * @param {Array} embeddings
 * @returns {Array<{ vector: Array<number> }>}
 */
export function toFirestoreEmbeddings(embeddings) {
  if (!Array.isArray(embeddings)) return [];
  return embeddings.map(e => {
    if (Array.isArray(e)) return { vector: e };
    if (e && typeof e === 'object' && Array.isArray(e.vector)) return e;
    return null;
  }).filter(Boolean);
}

/**
 * Computa la combinación de datos para fusionar varios perfiles en uno solo.
 * 
 * - Combina fotos en un único array (hasta 6 máx), priorizando mayor nitidez y eliminando duplicados.
 * - Combina embeddings (hasta 6 máx) en correlación con las fotos conservadas.
 * - firstSeen: timestamp más antiguo entre todos los seleccionados.
 * - lastSeen: timestamp más reciente entre todos los seleccionados.
 * - visitCount: suma acumulada de visitas de los perfiles fusionados.
 * - bestFaceScore: score de nitidez máximo entre las fotos resultantes.
 * - Name: conserva el nombre del perfil principal (por defecto el más antiguo).
 * 
 * @param {Array<Object>} profiles - Lista de perfiles a fusionar (mínimo 2)
 * @param {Object} [options]
 * @param {string} [options.targetId] - ID del perfil de destino (por defecto el más antiguo)
 * @param {string} [options.name] - Nombre a conservar
 * @returns {Object} { targetId, deleteIds, mergedData }
 */
export function computeMergedPersonData(profiles, options = {}) {
  if (!Array.isArray(profiles) || profiles.length < 2) {
    throw new Error('Se requieren al menos 2 perfiles para fusionar');
  }

  // 1. Identificar el perfil más antiguo según firstSeen
  const sortedByFirstSeen = [...profiles].sort((a, b) => {
    const timeA = parseDateMs(a.firstSeen) || parseDateMs(a.lastSeen) || Infinity;
    const timeB = parseDateMs(b.firstSeen) || parseDateMs(b.lastSeen) || Infinity;
    return timeA - timeB;
  });

  const oldestProfile = sortedByFirstSeen[0] || profiles[0];
  const targetId = options.targetId || oldestProfile.id;
  const targetProfile = profiles.find(p => p.id === targetId) || oldestProfile;
  const targetName = options.name?.trim() || oldestProfile.name || targetProfile.name || 'Cliente';

  const deleteIds = profiles.map(p => p.id).filter(id => id !== targetId);

  // 2. Tiempos: inicial más antiguo y final más reciente
  const firstSeenList = profiles.map(p => parseDateMs(p.firstSeen)).filter(t => t > 0);
  const earliestMs = firstSeenList.length > 0 ? Math.min(...firstSeenList) : null;
  const firstSeen = earliestMs ? new Date(earliestMs).toISOString() : (targetProfile.firstSeen || null);

  const lastSeenList = profiles.map(p => parseDateMs(p.lastSeen)).filter(t => t > 0);
  const latestMs = lastSeenList.length > 0 ? Math.max(...lastSeenList) : null;
  const lastSeen = latestMs ? new Date(latestMs).toISOString() : (targetProfile.lastSeen || null);

  // 3. Visitas: suma acumulada de visitas
  const totalVisits = profiles.reduce((sum, p) => sum + (Number(p.visitCount) || 1), 0);

  // 4. Staff / Barbero: si alguno es staff, se preserva rol barbero
  const isStaff = profiles.some(p => Boolean(p.isStaff) || p.role === 'barber');
  const role = isStaff ? 'barber' : 'client';

  // 5. Combinar fotos y embeddings respetando correlación y orden de nitidez
  const candidateItems = [];
  const extraEmbeddings = [];

  for (const p of profiles) {
    const photos = extractPersonPhotos(p);
    const embeddings = Array.isArray(p.embeddings) ? p.embeddings : (p.embedding ? [p.embedding] : []);

    for (let i = 0; i < photos.length; i++) {
      candidateItems.push({
        photo: photos[i],
        embedding: embeddings[i] || null,
        profileId: p.id
      });
    }

    if (embeddings.length > photos.length) {
      for (let j = photos.length; j < embeddings.length; j++) {
        extraEmbeddings.push(embeddings[j]);
      }
    }
  }

  // Deduplicación de fotos (por thumbnailBase64 idéntico)
  const uniqueItems = [];
  const seenThumbnails = new Set();

  for (const item of candidateItems) {
    const thumb = item.photo.thumbnailBase64;
    if (thumb && seenThumbnails.has(thumb)) {
      continue;
    }
    if (thumb) {
      seenThumbnails.add(thumb);
    }
    uniqueItems.push(item);
  }

  // Ordenar fotos por nitidez descendente (mayor nitidez primero)
  uniqueItems.sort((a, b) => {
    return (b.photo.sharpnessScore || 0) - (a.photo.sharpnessScore || 0);
  });

  // Conservar hasta 6 fotos de mayor nitidez
  const selectedItems = uniqueItems.slice(0, 6);
  const mergedPhotos = selectedItems.map(item => item.photo);

  // Combinar embeddings (hasta 6)
  let mergedEmbeddings = selectedItems.map(item => item.embedding).filter(Boolean);
  if (mergedEmbeddings.length < 6 && extraEmbeddings.length > 0) {
    for (const extraEmb of extraEmbeddings) {
      if (mergedEmbeddings.length >= 6) break;
      mergedEmbeddings.push(extraEmb);
    }
  }

  // Sanitizar embeddings para compatibilidad estricta con Firestore (evitar 'Nested arrays are not supported')
  const firestoreEmbeddings = toFirestoreEmbeddings(mergedEmbeddings);
  const primaryEmbedding = firestoreEmbeddings[0]?.vector || null;

  // 6. Mejor nitidez facial y miniatura principal
  const bestFaceScore = mergedPhotos.length > 0
    ? Math.max(...mergedPhotos.map(p => p.sharpnessScore || 0))
    : (normalizeSharpness(targetProfile.bestFaceScore) || 0);

  const thumbnailBase64 = mergedPhotos.length > 0
    ? mergedPhotos[0].thumbnailBase64
    : (targetProfile.thumbnailBase64 || null);

  return {
    targetId,
    deleteIds,
    mergedData: {
      name: targetName,
      firstSeen,
      lastSeen,
      visitCount: totalVisits,
      bestFaceScore,
      thumbnailBase64,
      photos: mergedPhotos,
      embeddings: firestoreEmbeddings,
      ...(primaryEmbedding ? { embedding: primaryEmbedding } : {}),
      isStaff,
      role,
      updatedAt: new Date().toISOString()
    }
  };
}
