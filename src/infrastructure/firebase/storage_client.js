/**
 * Adaptador de Firebase Storage
 * Maneja la subida de fotogramas originales y recortes de clientes.
 */

/**
 * Sube una imagen original capturada a Firebase Storage
 * @param {Object} bucket - Bucket de Google Cloud Storage
 * @param {string} storagePath - Ruta de destino en el bucket
 * @param {Buffer} buffer - Buffer binario de la imagen
 * @param {Object} metadata - Metadatos opcionales
 */
export async function uploadRawSnapshot(bucket, storagePath, buffer, metadata = {}) {
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    metadata: {
      contentType: "image/jpeg",
      metadata: {
        capturedAt: new Date().toISOString(),
        camera: "barberia",
        source: "gcp-e2-micro",
        type: "raw",
        ...metadata
      }
    }
  });
  return storagePath;
}

/**
 * Sube un recorte de cliente sentado a Firebase Storage
 * @param {Object} bucket
 * @param {string} storagePath
 * @param {Buffer} cropBuffer
 * @param {Object} metadata
 */
export async function uploadClientCrop(bucket, storagePath, cropBuffer, metadata = {}) {
  const file = bucket.file(storagePath);
  await file.save(cropBuffer, {
    metadata: {
      contentType: "image/jpeg",
      metadata: {
        capturedAt: new Date().toISOString(),
        camera: "barberia",
        source: "gcp-e2-micro",
        type: "client_seated_crop",
        ...metadata
      }
    }
  });
  return storagePath;
}
