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
    if (v === undefined) continue;
    cleanObj[k] = sanitizeForFirestore(v);
  }
  return cleanObj;
}
