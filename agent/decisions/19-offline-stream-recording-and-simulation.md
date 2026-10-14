# ADR 19: Grabación de Flujo en Vivo y Simulación de Stream Offline

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

Para desarrollar, depurar y evaluar los modelos de IA (YOLOv8, ByteTrack, ArcFace y reglas de negocio de atenciones en sillas) en entornos locales, los desarrolladores dependían de:
1. Una conexión activa con la cámara física vía Neolink P2P, lo que provocaba colisiones P2P con la VM de producción (bloqueos de sesión Baichuan UDP).
2. O bien el modo Remote Relay consumiendo ancho de banda continuo desde el túnel de producción (`stream.perrosuelto.com`).

Esto impedía realizar pruebas offline (sin internet), pruebas reproducibles sobre un mismo conjunto de clientes y cortes de pelo, o pruebas en entornos aislados.

Asimismo, utilizar videos genéricos exportados desde la app o tarjeta SD de Reolink presentaba inconvenientes:
* Resolución 2K/4K (*mainStream*) que sobrecargaba la CPU local con decodificación innecesaria.
* Desajuste en escala respecto a los cuadrantes normalizados definidos en producción sobre el *subStream*.

---

## Decisión Técnica

Se implementa una solución de **Grabación Nativa de Stream e Inyección Offline 100% Simulada**:

### 1. Grabador Resiliente (`scripts/record-stream.js`)
* Detecta automáticamente el origen: flujo HTTP MJPEG de producción (`/api/stream`) o RTSP local (`rtsp://127.0.0.1:8554/barberia/sub`).
* Aplica el flag `-use_wallclock_as_timestamps 1` para preservar la cadencia exacta de llegada de los fotogramas (3.5 FPS).
* Cuenta con reconexión automática ante microcortes y captura limpia de `SIGINT`/`SIGTERM` para escribir los metadatos `moov` (+faststart) en el MP4 ante detención manual.

### 2. Inyección Directa en `StreamServer` (`MOCK_VIDEO_PATH`)
* En lugar de requerir servidores RTSP intermedios o contenedores adicionales, `StreamServer` evalúa si `mockVideoPath` está configurado.
* Si está activo, lanza FFmpeg con:
  ```bash
  ffmpeg -re -stream_loop -1 -i <mockVideoPath> -an -r 3.5 -threads 1 -f image2pipe -q:v 5 -vcodec mjpeg pipe:1
  ```
  * `-re`: Decodificación estricta a velocidad nativa 1x (tiempo real).
  * `-stream_loop -1`: Bucle infinito continuo.
* La entrega de buffers a RAM, `/api/stream`, `/api/snapshot` y el bucle de visión de 400 ms es **100% idéntica a la cámara física en producción**.

### 3. Modos de Arranque en `package.json`
* `npm run record`: Graba el stream en vivo a `data/recordings/mock_stream.mp4`.
* `npm run dev:mock`: Arranca el simulador Docker E2 y el frontend Vite inyectando el video.
* `npm run dev:mock:local`: Arranca el daemon Node.js y el frontend Vite directamente en host sin requerir Docker.
* `npm run start:mock`: Arranca solo el daemon en consola.

---

## Consecuencias y Beneficios

* **Fidelidad**: Mismas tasas de fotogramas (3.5 FPS), resolución (640x360), compresión H.264 y comportamiento temporal.
* **Cero Colisiones P2P**: No se establecen conexiones UDP hacia la cámara física.
* **Cero Dependencias Externas**: No requiere instalar MediaMTX ni abrir puertos RTSP auxiliares.
* **Reproducibilidad**: Permite correr benchmarks comparativos con la misma sesión de barbería grabada.

Para la guía paso a paso de uso y pruebas locales, consultar:
👉 **[LOCAL_TESTING_GUIDE.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/docs/LOCAL_TESTING_GUIDE.md)**
👉 **[OFFLINE_STREAM_GUIDE.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/docs/OFFLINE_STREAM_GUIDE.md)**
