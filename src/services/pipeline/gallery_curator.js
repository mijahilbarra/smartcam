import { computeCosineSimilarity } from "../../face_recognizer.js";
import { hasTwoEyesVisible } from "../face_quality_service.js";
export { getRepresentativeFace, isVector } from "./appointment_finalizer.js";
import { isVector } from "./appointment_finalizer.js";

/**
 * Filtra muestras outliers en el cluster de fotos y embeddings de la sesión.
 * Si session.photos.length >= 3 y session.embeddings.length >= 3:
 * Calcula la similitud promedio de cada muestra contra el resto del grupo.
 * Cualquier muestra cuya similitud promedio sea < 0.45 se descarta.
 * @param {Array<Object>} photos
 * @param {Array<Array<number>>} embeddings
 * @returns {{ photos: Array<Object>, embeddings: Array<Array<number>> }}
 */
export function filterOutlierSamples(photos = [], embeddings = []) {
  if (!photos || !embeddings || photos.length < 3 || embeddings.length < 3) {
    return { photos: [...photos], embeddings: [...embeddings] };
  }

  const N = Math.min(photos.length, embeddings.length);
  const vectors = embeddings.slice(0, N).map(e => isVector(e) ? e : (e?.vector || null));

  const validIndices = [];
  for (let i = 0; i < N; i++) {
    const vecI = vectors[i];
    if (!vecI) {
      validIndices.push(i);
      continue;
    }

    let totalSim = 0;
    let count = 0;
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const vecJ = vectors[j];
      if (!vecJ) continue;
      const sim = computeCosineSimilarity(vecI, vecJ);
      totalSim += sim;
      count++;
    }

    const avgSim = count > 0 ? (totalSim / count) : 1.0;
    if (avgSim >= 0.45) {
      validIndices.push(i);
    } else {
      console.warn(`[Appointment] Muestra #${i + 1} descartada por outlier biométrico (similitud promedio con cluster: ${avgSim.toFixed(3)} < 0.45). Excluye foto contaminante.`);
    }
  }

  const filteredPhotos = validIndices.map(idx => photos[idx]);
  const filteredEmbeddings = validIndices.map(idx => embeddings[idx]);

  // Preservar fotos adicionales si existieran sin embedding
  if (photos.length > N) {
    filteredPhotos.push(...photos.slice(N));
  }

  return { photos: filteredPhotos, embeddings: filteredEmbeddings };
}

/**
 * Deduplica fotos de sesión eliminando miniaturas idénticas y similitud coseno >= 0.88 (misma pose)
 * Limita a un máximo de fotos diversas y nítidas para la atención, privilegiando
 * consistentemente fotos con dos ojos visibles (hasTwoEyes = true).
 * @param {Array<Object>} photos
 * @param {Array<Array<number>>} embeddings
 * @param {number} [maxPhotos=20]
 * @returns {{ photos: Array<Object>, embeddings: Array<Array<number>> }}
 */
export function deduplicateSessionPhotos(photos = [], embeddings = [], maxPhotos = 20) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return { photos: [], embeddings: [] };
  }

  const cleanPhotos = [];
  const cleanEmbeddings = [];

  for (let i = 0; i < photos.length; i++) {
    const ph = photos[i];
    const emb = embeddings?.[i] || null;
    if (!ph) continue;

    let duplicateIdx = -1;
    for (let j = 0; j < cleanPhotos.length; j++) {
      const exPh = cleanPhotos[j];
      const exEmb = cleanEmbeddings[j] || null;

      // 1. Miniatura idéntica en base64
      if (ph.thumbnailBase64 && exPh.thumbnailBase64 && ph.thumbnailBase64 === exPh.thumbnailBase64) {
        duplicateIdx = j;
        break;
      }

      // 2. Similitud coseno alta con misma pose
      if (emb && exEmb) {
        const v1 = isVector(emb) ? emb : (emb.vector || null);
        const v2 = isVector(exEmb) ? exEmb : (exEmb.vector || null);
        if (v1 && v2) {
          const sim = computeCosineSimilarity(v1, v2);
          const samePose = (ph.pose || 'frontal') === (exPh.pose || 'frontal');
          if (sim >= 0.92 || (sim >= 0.88 && samePose)) {
            duplicateIdx = j;
            break;
          }
        }
      }
    }

    if (duplicateIdx !== -1) {
      const exPh = cleanPhotos[duplicateIdx];
      const exHasTwoEyes = exPh.hasTwoEyes !== undefined
        ? Boolean(exPh.hasTwoEyes)
        : hasTwoEyesVisible(exPh.landmarks, exPh.boxNorm, exPh.pose);
      const phHasTwoEyes = ph.hasTwoEyes !== undefined
        ? Boolean(ph.hasTwoEyes)
        : hasTwoEyesVisible(ph.landmarks, ph.boxNorm, ph.pose);

      let shouldReplace = false;
      if (phHasTwoEyes && !exHasTwoEyes) {
        shouldReplace = true;
      } else if (!phHasTwoEyes && exHasTwoEyes) {
        shouldReplace = false;
      } else {
        shouldReplace = (ph.sharpnessScore || 0) > (exPh.sharpnessScore || 0);
      }

      if (shouldReplace) {
        cleanPhotos[duplicateIdx] = ph;
        if (emb) cleanEmbeddings[duplicateIdx] = emb;
      }
    } else {
      cleanPhotos.push(ph);
      if (emb) cleanEmbeddings.push(emb);
    }
  }

  // Limitar al máximo de fotos (seleccionadas priorizando fotos con 2 ojos, diversidad de pose y nitidez, preservando orden cronológico estricto)
  if (cleanPhotos.length > maxPhotos) {
    const items = cleanPhotos.map((p, idx) => ({
      photo: p,
      emb: cleanEmbeddings[idx],
      origIdx: idx,
      hasTwoEyes: p.hasTwoEyes !== undefined
        ? Boolean(p.hasTwoEyes)
        : hasTwoEyesVisible(p.landmarks, p.boxNorm, p.pose)
    }));

    const posesSeen = new Set();
    const prioritized = [];
    const others = [];

    // Priorizar poses únicas prefiriendo fotos con 2 ojos
    const twoEyesItems = items.filter(it => it.hasTwoEyes);
    const oneEyeItems = items.filter(it => !it.hasTwoEyes);

    for (const it of twoEyesItems) {
      const pose = it.photo.pose || 'frontal';
      if (!posesSeen.has(pose)) {
        posesSeen.add(pose);
        prioritized.push(it);
      } else {
        others.push(it);
      }
    }

    for (const it of oneEyeItems) {
      const pose = it.photo.pose || 'frontal';
      if (!posesSeen.has(pose)) {
        posesSeen.add(pose);
        prioritized.push(it);
      } else {
        others.push(it);
      }
    }

    // En 'others', las fotos con 2 ojos siempre van antes que las de 1 ojo, luego por nitidez
    others.sort((a, b) => {
      if (a.hasTwoEyes !== b.hasTwoEyes) return b.hasTwoEyes ? 1 : -1;
      return (b.photo.sharpnessScore || 0) - (a.photo.sharpnessScore || 0);
    });

    const combined = [...prioritized, ...others].slice(0, maxPhotos);
    combined.sort((a, b) => a.origIdx - b.origIdx);

    return {
      photos: combined.map(c => c.photo),
      embeddings: combined.map(c => c.emb).filter(Boolean)
    };
  }

  return { photos: cleanPhotos, embeddings: cleanEmbeddings };
}

/**
 * Unifica fotos y embeddings asegurando correspondencia estricta 1:1,
 * deduplicación con similitud >= 0.88 y protección inmutable de la foto canónica inicial (index 0).
 */
export function mergePhotosAndEmbeddings(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
  const list = Array.isArray(existingPhotos) ? [...existingPhotos] : [];
  const embList = Array.isArray(existingEmbeddings) ? [...existingEmbeddings] : [];

  while (embList.length < list.length) embList.push(null);
  if (embList.length > list.length) embList.length = list.length;

  const hasCanonicalPhoto = existingPhotos && existingPhotos.length > 0;

  for (let k = 0; k < newSessionPhotos.length; k++) {
    const ph = newSessionPhotos[k];
    const emb = newSessionEmbeddings?.[k] || null;

    // 1. Verificación por miniatura idéntica
    const exactIdx = list.findIndex(e => e.thumbnailBase64 && ph.thumbnailBase64 && e.thumbnailBase64 === ph.thumbnailBase64);
    if (exactIdx !== -1) {
      if (!(hasCanonicalPhoto && exactIdx === 0)) {
        const exHasTwo = list[exactIdx]?.hasTwoEyes !== undefined
          ? Boolean(list[exactIdx].hasTwoEyes)
          : hasTwoEyesVisible(list[exactIdx]?.landmarks, null, list[exactIdx]?.pose);
        const phHasTwo = ph?.hasTwoEyes !== undefined
          ? Boolean(ph.hasTwoEyes)
          : hasTwoEyesVisible(ph?.landmarks, null, ph?.pose);

        let shouldReplace = false;
        if (phHasTwo && !exHasTwo) {
          shouldReplace = true;
        } else if (!phHasTwo && exHasTwo) {
          shouldReplace = false;
        } else {
          shouldReplace = (ph.sharpnessScore || 0) > (list[exactIdx].sharpnessScore || 0);
        }

        if (shouldReplace) {
          list[exactIdx] = ph;
          if (emb) embList[exactIdx] = emb;
        }
      }
      continue;
    }

    // 2. Verificación por similitud coseno si hay embeddings disponibles
    let dupIdx = -1;
    if (emb && embList.length > 0) {
      const phPose = ph.pose || 'frontal';
      for (let j = 0; j < embList.length; j++) {
        const exEmb = isVector(embList[j]) ? embList[j] : (embList[j]?.vector || null);
        const curEmb = isVector(emb) ? emb : (emb?.vector || null);
        if (!exEmb || !curEmb) continue;
        const sim = computeCosineSimilarity(curEmb, exEmb);
        const samePose = (list[j]?.pose || 'frontal') === phPose;
        if (sim >= 0.92 || (sim >= 0.88 && samePose)) {
          dupIdx = j;
          break;
        }
      }
    }

    if (dupIdx !== -1) {
      if (!(hasCanonicalPhoto && dupIdx === 0)) {
        const exHasTwo = list[dupIdx]?.hasTwoEyes !== undefined
          ? Boolean(list[dupIdx].hasTwoEyes)
          : hasTwoEyesVisible(list[dupIdx]?.landmarks, null, list[dupIdx]?.pose);
        const phHasTwo = ph?.hasTwoEyes !== undefined
          ? Boolean(ph.hasTwoEyes)
          : hasTwoEyesVisible(ph?.landmarks, null, ph?.pose);

        let shouldReplace = false;
        if (phHasTwo && !exHasTwo) {
          shouldReplace = true;
        } else if (!phHasTwo && exHasTwo) {
          shouldReplace = false;
        } else {
          shouldReplace = (ph.sharpnessScore || 0) > (list[dupIdx].sharpnessScore || 0);
        }

        if (shouldReplace) {
          list[dupIdx] = ph;
          if (emb) embList[dupIdx] = emb;
        }
      }
      continue;
    }

    list.push(ph);
    embList.push(emb);
  }

  return { photos: list, embeddings: embList };
}

/**
 * Unifica fotos de la nueva sesión a la galería del cliente sin duplicados
 */
export function mergeCustomerPhotos(existingPhotos = [], newSessionPhotos = [], existingEmbeddings = [], newSessionEmbeddings = []) {
  return mergePhotosAndEmbeddings(existingPhotos, newSessionPhotos, existingEmbeddings, newSessionEmbeddings).photos;
}

/**
 * Unifica embeddings de la nueva sesión a la galería del cliente en paralelo con las fotos conservadas
 */
export function mergeCustomerEmbeddings(existingEmbeddings = [], newSessionEmbeddings = [], existingPhotos = [], newSessionPhotos = []) {
  return mergePhotosAndEmbeddings(existingPhotos, newSessionPhotos, existingEmbeddings, newSessionEmbeddings).embeddings;
}
