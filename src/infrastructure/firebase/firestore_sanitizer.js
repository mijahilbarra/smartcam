/**
 * Sanitizador de Documentos para Firestore
 * Evita el error 'Nested arrays are not supported' transformando tuplas de coordenadas
 * en objetos { x, y } y removiendo campos undefined.
 */

/**
 * Sanitiza recursivamente objetos y arrays para compatibilidad estricta con Firestore:
 * 1. Convierte matrices anidadas [ [x, y], ... ] en arrays de mapas [ {x, y}, ... ].
 * 2. Remueve propiedades undefined (Firestore lanza excepción con undefined).
 * 3. Preserva instancias de Date, FieldValue y tipos primitivos.
 * @param {any} val
 * @returns {any}
 */
export function sanitizeForFirestore(val) {
  if (val === null || val === undefined) return null;
  if (typeof val !== "object") return val;
  if (val instanceof Date) return val;
  if (val._methodName || (val.constructor && val.constructor.name === "FieldValue")) return val;

  if (Array.isArray(val)) {
    return val.map(item => {
      if (Array.isArray(item)) {
        if (item.length === 2 && typeof item[0] === "number" && typeof item[1] === "number") {
          return { x: item[0], y: item[1] };
        }
        return sanitizeForFirestore({ items: item });
      }
      return sanitizeForFirestore(item);
    });
  }

  const cleanObj = {};
  for (const [k, v] of Object.entries(val)) {
    if (v === undefined || k.startsWith("_")) continue;
    cleanObj[k] = sanitizeForFirestore(v);
  }
  return cleanObj;
}

/**
 * Prepara y aligera un documento de cita para Firestore asegurando que nunca exceda
 * el límite estricto de 1,048,576 bytes (1 MB) de Firestore.
 * @param {object} doc
 * @returns {object}
 */
export function prepareAppointmentForFirestore(doc) {
  if (!doc) return doc;
  const clone = { ...doc };

  // 1. Conservar thumbnailBase64 principal
  const mainThumb = clone.thumbnailBase64 || clone.photos?.[0]?.thumbnailBase64 || null;
  clone.thumbnailBase64 = mainThumb;

  // 2. Limitar el array photos de la cita a máx 3 fotos y aligerar base64
  if (Array.isArray(clone.photos)) {
    clone.photos = clone.photos.slice(0, 3).map((p, idx) => ({
      sharpnessScore: p.sharpnessScore || 0,
      pose: p.pose || "frontal",
      poseLabel: p.poseLabel || "Frontal",
      capturedAt: p.capturedAt || clone.startedAt,
      thumbnailBase64: idx === 0 ? (p.thumbnailBase64 || mainThumb) : undefined
    }));
  }

  // 3. Aligerar las attentionUnits embebidas
  if (Array.isArray(clone.attentionUnits)) {
    clone.attentionUnits = clone.attentionUnits.map((u) => {
      const uThumb = u.thumbnailBase64 || u.photos?.[0]?.thumbnailBase64 || mainThumb;
      return {
        ...u,
        thumbnailBase64: uThumb,
        photos: Array.isArray(u.photos) ? u.photos.slice(0, 2).map((up, upIdx) => ({
          sharpnessScore: up.sharpnessScore || 0,
          pose: up.pose || "frontal",
          capturedAt: up.capturedAt || u.startedAt,
          thumbnailBase64: upIdx === 0 ? uThumb : undefined
        })) : []
      };
    });
  }

  // 4. Remover embeddings pesados del documento
  delete clone.embeddings;
  delete clone.representatives;

  return sanitizeForFirestore(clone);
}

/**
 * Prepara y aligera un documento de unidad de atención individual para Firestore.
 * @param {object} uDoc
 * @returns {object}
 */
export function prepareAttentionUnitForFirestore(uDoc) {
  if (!uDoc) return uDoc;
  const clone = { ...uDoc };
  const uThumb = clone.thumbnailBase64 || clone.photos?.[0]?.thumbnailBase64 || null;
  clone.thumbnailBase64 = uThumb;
  if (Array.isArray(clone.photos)) {
    clone.photos = clone.photos.slice(0, 3).map((p, idx) => ({
      sharpnessScore: p.sharpnessScore || 0,
      pose: p.pose || "frontal",
      capturedAt: p.capturedAt || clone.startedAt,
      thumbnailBase64: idx === 0 ? uThumb : undefined
    }));
  }
  delete clone.embeddings;
  return sanitizeForFirestore(clone);
}
