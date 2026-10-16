# Guía: Grabación y Simulación Offline del Stream (100% Fiel)

Esta guía documenta cómo capturar video real desde el flujo en vivo de la cámara y cómo inyectarlo en el daemon local para realizar pruebas offline sin necesidad de conexión física a la cámara, sin internet y sin dependencias de servidores RTSP externos.

---

## 1. Concepto y Funcionamiento

El pipeline de producción consume video a **3.5 FPS** y ejecuta un bucle de visión por computador cada **400 ms** (YOLOv8, PersonTracker, detección y reconocimiento facial con ArcFace, y lógica de atenciones en sillas).

Para simular este comportamiento al 100% de manera offline:
1. **Grabación**: Se capturan fotogramas del stream con sus marcas de tiempo reales de reloj (`-use_wallclock_as_timestamps 1`), empaquetándolos en un archivo MP4 (H.264 / 640x360).
2. **Inyección**: `StreamServer` lee el archivo con los flags de FFmpeg:
   * `-re`: Decodificación a velocidad nativa 1x (tiempo real).
   * `-stream_loop -1`: Bucle infinito continuo (al finalizar el video, reinicia sin cortes).
3. **Paridad total**: El buffer en RAM, los endpoints HTTP (`/api/stream` y `/api/snapshot`), las inferencias de IA y los eventos SSE operan de forma idéntica a producción.

---

## 2. Cómo Grabar el Stream

El proyecto incluye el script automatizado [`scripts/record-stream.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/scripts/record-stream.js) que autodetecta si el stream de producción o un RTSP local está activo.

### A. Grabación Rápida (60 segundos por defecto)
```bash
npm run record
```
*Guarda el video automáticamente en `data/recordings/mock_stream.mp4`.*

### B. Grabación con Duración Personalizada
Usa el argumento `--duration` (en segundos):
```bash
# Grabar 2 minutos (120 segundos)
npm run record -- --duration 120

# Grabar 30 minutos (1800 segundos)
npm run record -- --duration 1800

# Grabar 1 hora completa (3600 segundos)
npm run record -- --duration 3600
```

### C. Guardar con Nombre Específico
Usa el argumento `--output`:
```bash
npm run record -- --duration 300 --output data/recordings/barberia_concurrida.mp4
```

### D. Especificar Fuente Manual (Opcional)
Por defecto, el script prueba primero `https://stream.perrosuelto.com/api/snapshot` y luego `rtsp://127.0.0.1:8554/barberia/sub`. Puedes forzar una fuente con `--source`:
```bash
node scripts/record-stream.js --duration 60 --source "rtsp://127.0.0.1:8554/barberia/sub"
```

### E. Detener Grabación Prematuramente
Puedes presionar `Ctrl + C` en cualquier momento. El script captura la señal (`SIGINT`), cierra el flujo de FFmpeg ordenadamente y escribe los encabezados `moov` (+faststart) para que el video grabado hasta ese segundo sea 100% reproducible y válido.

---

## 3. Cómo Setear y Ejecutar el Video en Local

Una vez que tengas tu grabación en `data/recordings/`, puedes levantar el entorno offline con cualquiera de las siguientes modalidades:

### Opción 1: Simulación Completa con Docker E2 (Recomendado - Fidelidad GCP)
Ejecuta el frontend Vite y el simulador de hardware de la VM GCP e2-micro (1 GB RAM, cgroups):
```bash
npm run dev:mock
```
*Si tienes un video con nombre personalizado:*
```bash
MOCK_VIDEO_PATH="data/recordings/barberia_stream_20261012.mp4" npm run dev:mock
```

### Opción 1B: Simulación Docker de Alto Rendimiento (Fast Replay / 60 FPS) 🚀
Mismas librerías pero sin límites de CPU ni RAM, y procesando el video a máxima velocidad (60 FPS, sin esperar los 15-20 minutos reales):
```bash
# Con frontend Web:
npm run dev:mock:fast

# O solo el contenedor en background:
docker compose -f docker-compose.fast-sim.yml up -d --force-recreate
```

### Opción 2: Desarrollo Local Directo (Ligero, sin Docker Desktop)
Arranca el daemon directamente en Node.js y el frontend Vite en paralelo:
```bash
npm run dev:mock:local
```
*O con video personalizado:*
```bash
MOCK_VIDEO_PATH="data/recordings/barberia_stream_20261012.mp4" npm run dev:mock:local
```

### Opción 3: Solo el Daemon en Consola
Para depuración de inferencias o logs directos:
```bash
npm run start:mock
```
*O con video personalizado:*
```bash
MOCK_VIDEO_PATH="data/recordings/barberia_stream_20261012.mp4" npm run start
```

### Opción 4: Probar solo los últimos minutos (Final de atención y salida)
Para probar de forma rápida el final de un corte, la retirada de la capa y el cierre automático de la sesión sin esperar 15 a 27 minutos:
```bash
# Reproducir únicamente los últimos 5 minutos del video:
MOCK_VIDEO_PATH="data/recordings/barberia_stream_20261012.mp4" MOCK_VIDEO_LAST_MINUTES=5 npm run start

# O especificando un segundo de inicio exacto (ej. segundo 600 = minuto 10):
MOCK_VIDEO_PATH="data/recordings/barberia_stream_20261012.mp4" MOCK_VIDEO_START_SS=600 npm run start

# Con Docker e2-simulator:
MOCK_VIDEO_PATH="data/recordings/barberia_stream_20261012.mp4" MOCK_VIDEO_LAST_MINUTES=5 docker compose -f docker-compose.e2-sim.yml up -d --force-recreate
```

---

## 4. Verificación del Funcionamiento Offline

Al iniciar el daemon con `MOCK_VIDEO_PATH`, observarás en los logs:

```text
[Startup] 🎬 Modo Simulación Offline activado con video local: .../data/recordings/...
[Startup] 🔒 Omitiendo conexión a producción y daemon Neolink. Sistema listo.
[Stream] 🎬 Iniciando ingesta FFmpeg en modo MOCK VIDEO desde: ... a 3.5 FPS (bucle continuo 1x)...
[RealtimeLoop] Bucle de visión continua activo cadencia dinámica ~400ms.
[Tracker] Personas rastreadas activas (1): #1 [Silla de barbero (Frente)]
```

Puedes abrir en tu navegador:
* **Stream en vivo**: `http://localhost:8085/api/stream`
* **Último fotograma**: `http://localhost:8085/api/snapshot`
* **Telemetría y Cuadrantes**: `http://localhost:8085/api/telemetry/latest`
* **Dashboard Web**: `http://localhost:5173/`

---

## 5. Ubicación de Archivos de Video

Todos los videos para pruebas offline deben guardarse en:
```text
data/recordings/
├── barberia_stream_9h.mp4                  # Sesión de 6 horas y 1 min (15.6 MB)
├── barberia_stream_1h.mp4                  # Grabación completa de 1 hora (90 MB, 10,764 frames)
├── barberia_stream_20261012.mp4            # Grabación recortada de 15 minutos (34 MB)
├── barberia_stream_20261012_full27m.mp4    # Respaldo de la sesión de 27m 40s (57 MB)
└── mock_stream.mp4                         # Enlace simbólico hacia el video activo por defecto
```

> [!NOTE]
> La carpeta `data/` se encuentra montada como volumen dentro de `docker-compose.e2-sim.yml`, por lo que cualquier video colocado en `data/recordings/` estará inmediatamente disponible tanto en el host como dentro del contenedor Docker.
