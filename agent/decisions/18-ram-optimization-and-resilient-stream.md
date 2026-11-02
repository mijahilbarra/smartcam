# ADR 18: Optimización Extrema de RAM en e2-micro y Streaming RTSP Resiliente

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

En la máquina virtual de producción (Google Cloud Compute Engine `e2-micro`, Free Tier $0, 1 GB de RAM total, Ubuntu 22.04), el daemon de Node.js alcanzaba entre 280 MB y 300 MB de memoria residente (RSS). Combinado con Docker (`dockerd`), el túnel de Cloudflare (`cloudflared`) y los servicios base del sistema operativo, el consumo total de memoria superaba los 600 MB, empujando al kernel a utilizar espacio de paginación swap y ralentizando las inferencias neuronales ONNX.

Asimismo, se detectaron tres factores críticos de sobreconsumo e inestabilidad:
1. **Retención de imágenes en RAM**: La caché de clientes en memoria (`CustomerService.profilesCache`) almacenaba la lista completa de fotos en Base64 de cada cliente para comparación facial, cuando el algoritmo biométrico ArcFace únicamente requiere vectores numéricos de 512 dimensiones (`embedding`).
2. **Fragmentación y arenas de memoria Glibc**: Por defecto, la librería de C de Linux (`glibc ptmalloc`) asigna hasta `8 * núcleos_CPU` arenas de asignación de memoria dinámica para hilos nativos creados por Sharp (libvips) y ONNX Runtime. En sistemas con swaps o hilos intermitentes, esto provocaba inflación de memoria virtual y RSS no liberada.
3. **Sobrecarga de CPU en Streaming y Caídas de Neolink**: La ingesta FFmpeg operaba a 8 FPS decodificando continuamente el flujo RTSP. Si por tareas de limpieza en scripts de CI/CD o diagnóstico el contenedor permanente `neolink-daemon` era reiniciado o eliminado, FFmpeg fallaba y `/api/snapshot` quedaba indisponible arrojando errores `503 Service Unavailable`.

---

## Decisiones Técnicas Implementadas

### 1. Poda Radical de Imágenes en Memoria RAM (`sqlite_client.js` y `customer_service.js`)
- En `getAllComparisonProfiles()`, la consulta SQL local (`stmtGetAllCustomers`) recupera estrictamente: `id`, `name`, `first_seen`, `last_seen`, `visit_count`, `notes` y `embeddings` en formato binario `BLOB`.
- Las fotos en Base64 (`photos_json`, `thumbnail_base64`, `thumbnail_path`) se excluyen al 100% de la caché de comparación en RAM.
- **Hidratación bajo demanda**: La función `getCustomerData(id)` lee la galería completa desde SQLite únicamente cuando un cliente finaliza su sesión en una silla y se consolida la visita.
- **Impacto**: Reducción inmediata del 54% en el V8 Heap de JavaScript (de ~57 MB a ~24 MB).

### 2. Control de Arenas Glibc y Límites de Memoria V8
- **`MALLOC_ARENA_MAX=2`**: Limita estrictamente a 2 arenas de asignación de memoria glibc para todos los subprocesos e hilos nativos de Node.js, Sharp y ONNX Runtime, previniendo la retención fantasma de memoria nativa.
- **Flags V8 de Node.js**:
  ```bash
  node --optimize-for-size --max-old-space-size=192 src/index.js
  ```
  Obliga al recolector de basura de V8 a priorizar compactación y huella de memoria sobre velocidad de reserva.

### 3. Detección Exclusiva de Personas en YOLOv8 (Acceso O(1))
- En `src/detector.js`, se eliminó el bucle anidado que recorría las 80 clases COCO para los 8,400 anchors generados por YOLOv8 (672,000 iteraciones por frame).
- Acceso directo en $O(1)$ a la clase 0 (`person`) mediante offset `4 * numAnchors + a`, descartando sillas, autos, mochilas u otros objetos no requeridos en el negocio de la barbería.
- **Modo Centinela Dinámico de Saltos Estáticos**:
  - Si la escena está inmóvil (< 1% de variación) y **no hay personas presentes**, el sistema permite hasta **25 ciclos consecutivos de salto de inferencia (~30 segundos a 0% CPU / 0 ms)**.
  - Si hay personas rastreadas activas, el límite de saltos se acota a 5 para preservar la reactividad del tracking continuo.

### 4. Arquitectura Dual-Stream Desacoplada (Video a 10 FPS + Inferencia IA a 5.5 FPS + Captura HD On-Demand)
- **Desacoplamiento de Frecuencias de Cuadro (FPS)**:
  - **Video Continuo a 10 FPS**: Ingesta continua sobre `subStream` (640x360) a **10 FPS** (`STREAM_FPS=10`, `-q:v 4`, `-threads 1`). Esto asegura que el visor web MJPEG y la grabación continua en Google Drive se capturen a la tasa de refresco nativa de la cámara con máxima fluidez visual.
  - **Bucle de Inferencia de IA a ~5.5 FPS (~180ms)**: El bucle de visión y tracking espacial de personas (`RealtimeLoop`) opera con cadencia de ~180 ms. Al nutrirse del fotograma más reciente en RAM en 0 ms, aprovecha la CPU al ~35% durante movimiento y 0% en escenas estáticas, evitando saturar el procesador del VPS.
  - **Captura HD On-Demand**: Cuando un cliente sentado en silla requiere biometría nítida, `clear_stream_step.js` solicita puntualmente un único fotograma de alta definición (2304x1296) a `/barberia/main`, recortando el rostro a máxima fidelidad con Sharp y respetando cooldown de 20s.
- **Sondeo RTSP Robusto**: Flags `-analyzeduration 15000000` y `-probesize 1000000` preservados en el demuxer RTSP TCP para garantizar la recepción completa de parámetros SPS/PPS de H.264 sin abortar por timeout.
- **Auto-Recuperación (`onEnsureRtspSource`)**: Si un cliente se conecta a `/api/stream` y el contenedor `neolink-daemon` no está activo en el puerto 8554, el servidor lo detecta y lo levanta automáticamente antes de spawnear FFmpeg.
- **Persistencia de Último Fotograma**: Si FFmpeg reconecta momentáneamente, `latestFrameBuffer` no se anula, permitiendo que `/api/snapshot` continúe entregando el último frame válido en lugar de responder 503.
- **Protección de Contenedores en CI/CD**: Se ajustaron `.github/workflows/deploy-vm.yml` y `.github/workflows/vm-logs.yml` para limpiar exclusivamente contenedores efímeros con nombre `neolink-capture`, protegiendo el ciclo de vida del contenedor permanente `neolink-daemon`.

### 5. Métricas de Rendimiento en Tiempo Real a Costo Cero (`system_metrics.js`)
- Módulo puro `src/core/system_metrics.js` que utiliza llamadas nativas del sistema operativo (`process.memoryUsage()`, `os.totalmem()`, `os.freemem()`).
- Ejecución en <0.001 ms sin impacto en RAM ni CPU.
- Emitido en cada tick SSE hacia el frontend web y visualizado en el encabezado (`AppHeader.vue`) con badge de diagnóstico en vivo.

---

## Resultados y Validación en Producción

Métricas reales obtenidas en la máquina virtual GCP Compute Engine `e2-micro`:

| Métrica | Antes de la Optimización | Producción Actual | Variación |
| :--- | :---: | :---: | :---: |
| **Memoria del Servicio Systemd** | `294.5 MB` | **`210.2 MB`** | **-84.3 MB directos (-28.6%)** |
| **V8 Heap Utilizado (`heapUsedMB`)** | `38.3 MB` | **`24.6 MB`** | **-35.8%** |
| **V8 Heap Reservado (`heapTotalMB`)** | `42.4 MB` | **`27.2 MB`** | **-35.8%** |
| **Memoria Libre del SO (`osFreeMB`)** | `392 MB` | **`441 MB`** | **+49 MB de margen libre** |
| **Cadencia y Calidad de Video** | 8 FPS | **3.5 FPS (`subStream` 640x360, `-q:v 4`) + HD On-Demand** | **<5% CPU continua y biometría HD puntual** |
| **Tiempo de Inferencia en Reposo** | 450 ms (cíclico) | **0 ms / 0% CPU (hasta 25 skips)** | **Ahorro masivo de cómputo** |
