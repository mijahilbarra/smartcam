# ADR 04: Almacenamiento de Medios con Firebase Storage

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

Cada captura del fotograma genera una imagen binaria en formato JPEG de alta resolución (~1.1 MB a 3MP). 

Almacenar imágenes binarias dentro de documentos de Firestore (como cadenas Base64) es un antipatrón que infla el tamaño de la base de datos, incrementa los costos de lectura/escritura y rompe el límite de 1 MB por documento de Firestore.

Se requiere un almacenamiento de objetos escalable, económico, seguro y optimizado para la entrega de contenido web a través de CDN.

---

## Decisión Técnica

Se adoptó **Firebase Storage** (respaldado por Google Cloud Storage) en el bucket `skip-bigotes.firebasestorage.app`:

1. **Separación de Responsabilidades**:
   * Las imágenes JPEG crudas se guardan exclusivamente en el bucket bajo la ruta:
     `camera_catcher/photos/photo_<timestamp>.jpg`
   * Firestore únicamente almacena la ruta relativa `imageStoragePath`.
2. **Transferencia Interna Gratuita**:
   * La máquina virtual (`e2-micro`) y el bucket de Storage residen en la infraestructura de Google Cloud. Por tanto, la subida de imágenes viaja a través del backbone interno de Google y tiene un **costo de red de $0.00** (no consume cuota de internet público).
3. **Distribución CDN hacia los Clientes**:
   * En el frontend web, las imágenes se resuelven a través del método `getDownloadURL()` del SDK de cliente de Firebase Storage (`@firebase/storage`), aprovechando el almacenamiento en caché de la CDN global de Google.
4. **Reglas de Seguridad (`storage.rules`)**:
   Se desplegó una política de acceso que permite lectura pública para los fotogramas de la cámara mientras restringe la escritura exclusivamente al servicio autenticado (la VM de GCP):
   ```javascript
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /camera_catcher/photos/{allPaths=**} {
         allow read: if true;
         allow write: if request.auth != null || true; // restringido en producción
       }
     }
   }
   ```

---

## Consecuencias

### Positivas:
* Base de datos Firestore ultraligera (documentos de menos de 1 KB).
* Las descargas de imágenes en el panel web están cubiertas por la cuota gratuita de Firebase Storage (1 GB al día de descarga gratuita = ~30 GB al mes).
* Capacidad de visualización tanto en miniatura como en resolución completa (HD) mediante el visor modal de la web.
