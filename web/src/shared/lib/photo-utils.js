/**
 * Utilidades para manejo de imágenes y selección de miniaturas biométricas
 */

export const isValidImageUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return (
    url.startsWith('data:image/') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('blob:')
  );
};

/**
 * Extrae la URL o base64 válida de un objeto foto o string
 * @param {Object|string} photo
 * @returns {string}
 */
export const getPhotoUrl = (photo) => {
  if (!photo) return '';
  if (photo.hasError) return '';
  if (typeof photo === 'string' && isValidImageUrl(photo)) return photo;
  const candidate = photo.thumbnailBase64 || photo.base64 || photo.url;
  if (isValidImageUrl(candidate)) return candidate;
  return '';
};

/**
 * Selecciona la miniatura correspondiente a la mejor nitidez (bestFaceScore)
 * entre la galería de fotos. Si no hay puntuaciones, usa la primera válida o el fallback.
 *
 * @param {Array<Object|string>} photos - Lista de fotos ({ thumbnailBase64, sharpnessScore, ... } o strings)
 * @param {string|null} fallbackThumbnail - Miniatura o avatar de respaldo
 * @param {number|null} targetScore - Score específico de referencia (bestFaceScore)
 * @returns {string} - Data URL o URL de la mejor foto
 */
export function getBestFaceThumbnail(photos, fallbackThumbnail = null, targetScore = null) {
  if (Array.isArray(photos) && photos.length > 0) {
    // 1. Si targetScore viene provisto y es > 0, intentar encontrar la foto con ese score exacto
    if (targetScore != null && Number(targetScore) > 0) {
      const target = Number(targetScore);
      const exactMatch = photos.find((p) => {
        if (!p || typeof p !== 'object') return false;
        const s = Number(p.sharpnessScore ?? 0);
        return Math.abs(s - target) < 0.05 || Math.abs(s * 100 - target) < 0.5 || Math.abs(s - target * 100) < 0.5;
      });
      if (exactMatch) {
        const url = getPhotoUrl(exactMatch);
        if (url) return url;
      }
    }

    // 2. Buscar la foto con el mayor sharpnessScore de la lista
    let bestCandidate = null;
    let maxScore = -1;

    for (const p of photos) {
      if (!p) continue;
      const url = getPhotoUrl(p);
      if (!url) continue;

      const rawScore = typeof p === 'object' ? Number(p.sharpnessScore ?? 0) : 0;
      const score = rawScore > 0 && rawScore <= 1 ? rawScore * 100 : rawScore;

      if (score > maxScore) {
        maxScore = score;
        bestCandidate = url;
      }
    }

    if (bestCandidate && maxScore > 0) {
      return bestCandidate;
    }

    // 3. Si ninguna tiene score > 0, usar la primera foto válida
    for (const p of photos) {
      const url = getPhotoUrl(p);
      if (url) return url;
    }
  }

  // 4. Si no hubo fotos o ninguna fue válida, recurrir al fallbackThumbnail
  if (isValidImageUrl(fallbackThumbnail)) {
    return fallbackThumbnail;
  }

  return '';
}
