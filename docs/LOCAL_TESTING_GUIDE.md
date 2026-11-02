# 🧪 Guía Rápida de Pruebas en Local (Para Agentes y Desarrolladores)

Esta guía documenta paso a paso cómo ejecutar pruebas en el entorno local, configurar videos simulados (completos o fragmentados), visualizar logs de ejecución e inspeccionar datos en SQLite y Firestore sin tocar el entorno de producción.

---

## 1. Arquitectura del Entorno de Pruebas

El sistema cuenta con un simulador local que reproduce de forma 100% fiel las condiciones de producción:
* **Entorno Docker E2 Simulator**: Simula una instancia GCP `e2-micro` con límites estrictos de hardware (0.5 CPU, 1024 MB RAM, asignador `MALLOC_ARENA_MAX=2`).
* **Aislamiento de Base de Datos**: En local y en el contenedor `e2-micro-sim`, la base de datos de Firestore está configurada como `test` (`FIRESTORE_DATABASE_ID=test`) y el bucket como `skip-bigotes-test`. En SQLite se usa `data/barberia_test.db`. **Nunca se escribe en la base de datos `(default)` en pruebas locales**.
* **Protección del Barbero**: El perfil `staff_barbero` cuenta con 20 fotos y 20 vectores auténticos. El algoritmo anti-truncación impide que scripts o atenciones reduzcan esta galería.

---

## 2. Ejecución de la Suite de Pruebas Automatizadas

Antes de probar con video, siempre verifica que las 14 suites pasen al 100%:

### A. Ejecutar todas las pruebas (Nativo en Node.js)
```bash
npm test
```
*Verifica: desinfección de Firestore, reporter daemon, detector ONNX, horario comercial, modular core, nitidez facial, person tracker, visit sessions, debounce de procesos, unificación de clientes, cliente SQLite, servicio de clientes, pipeline de atenciones, resiliencia de stream, detector de capa, anclaje espacial de silla, descargador de grabaciones Google Drive, track block manager, pipeline causal canónico componible y consulta de incidentes.*

### B. Pruebas de Streaming y Monitoreo en Vivo (`npm run stream:test`)
Lanza una prueba de streaming con video mock (una sola pasada) tras purgar la base `test` de Firebase y `barberia_test.db`:
```bash
# Avance rápido (FAST_FORWARD, 0ms intervalo):
npm run stream:test

# En tiempo real sincronizado con producción (10 FPS video, ~180ms inferencia):
npm run stream:test -- --realtime

# Tramo específico o fecha concreta:
npm run stream:test -- --video data/recordings/barberia_stream_7h.mp4 --start 2420 --fps 10
```

### B. Ejecutar pruebas dentro del contenedor Docker E2
```bash
npm run test:e2
```

### C. Ejecutar solo la suite de Atenciones y Biometría
```bash
node test/test-appointments.js
```

### D. Ejecutar solo la suite de Resiliencia y Mock Video
```bash
node test/test-stream-resilience.js
```

---

## 3. Configuración del Video de Simulación (Mock Video)

Los videos de prueba se almacenan en el directorio `data/recordings/`:

| Archivo | Duración | Descripción |
|---|---|---|
| `data/recordings/barberia_stream_20261012.mp4` | ~15 min | Grabación real de atención de corte en la silla de barbero |
| `data/recordings/barberia_stream_20261012_full27m.mp4` | ~27 min | Grabación extendida de atención completa |
| `data/recordings/barberia_stream_1h.mp4` | ~60 min | Grabación continua de 1 hora |
| `data/recordings/mock_stream.mp4` | — | Enlace simbólico al video por defecto (15 min) |

### Variables de Entorno de Control de Video:

| Variable | Tipo / Valor | Efecto |
|---|---|---|
| `MOCK_VIDEO_PATH` | Ruta (ej. `data/recordings/mock_stream.mp4`) | Activa el modo simulación offline usando ese archivo. |
| `MOCK_VIDEO_LAST_MINUTES` | Entero (ej. `5`) | Salta automáticamente al video para reproducir **solo los últimos N minutos**. Ideal para probar fin de corte y cierre de atención. |
| `MOCK_VIDEO_START_SS` | Segundos (ej. `600`) | Inicia la reproducción en el segundo especificado (ej. segundo 600 = min 10). |
| `MOCK_VIDEO_LOOP` | `true` \| `false` (default: `false`) | `false`: reproduce el video 1 sola vez hasta el final (la silla se vacía naturalmente y la atención se cierra tras 30s de gracia). `true`: reinicio infinito continuo. |

---

## 4. Cómo Levantar la Simulación

### Modalidad 1: Simulador Docker E2 (Recomendado - Paridad 100% con GCP)

```bash
# A. Simulación completa (15 minutos de corte, 1 sola pasada):
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" docker compose -f docker-compose.e2-sim.yml up -d --force-recreate

# B. Simulación rápida: Solo los últimos 5 minutos (prueba cierre de sesión y salida):
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LAST_MINUTES=5 docker compose -f docker-compose.e2-sim.yml up -d --force-recreate

# C. Simulación iniciando en un segundo específico (ej. minuto 10 = seg 600):
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_START_SS=600 docker compose -f docker-compose.e2-sim.yml up -d --force-recreate

# D. Simulación con bucle infinito (para desarrollo visual con el frontend):
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LOOP=true docker compose -f docker-compose.e2-sim.yml up -d --force-recreate
```

Para detener el contenedor:
```bash
docker compose -f docker-compose.e2-sim.yml down
```

### Modalidad 1B: Simulador Docker de Alto Rendimiento (Fast Replay / 60 FPS) 🚀

Para iterar rápidamente en fixes sin esperar 15–20 minutos a velocidad real:
* **Mismas librerías y dependencias**: Node 20 bookworm, ONNX Runtime, OpenCV/FFmpeg, SQLite, Firebase Admin.
* **Sin estrangulamiento de hardware**: Sin límites de CPU (usa todos los núcleos) y 2 GB de memoria Node.js.
* **FFmpeg Fast-Forward**: Omite la bandera `-re` para leer a velocidad nativa de decodificación y salta de 3.5 a **60 FPS** (`REALTIME_INTERVAL_MS=16`).

```bash
# A. Simulación rápida a máxima velocidad (Fast Replay de 60 FPS):
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" docker compose -f docker-compose.fast-sim.yml up -d --force-recreate

# B. Simulación rápida con Frontend Web Vite:
npm run dev:mock:fast

# C. Suite de pruebas completa dentro del contenedor de alto rendimiento:
npm run test:fast

# D. Para detener el contenedor rápido:
docker compose -f docker-compose.fast-sim.yml down
```

### Modalidad 1C: Tester Oficial y Monitor Unificado (`scripts/run-and-monitor.js`) ⭐

> [!IMPORTANT]
> **ESTE ES EL ÚNICO RUNNER OFICIAL DE SIMULACIÓN Y PRUEBAS DEL PROYECTO**.
> Queda **terminantemente prohibido** crear scripts adicionales, descartables o temporales de monitoreo/reporte (ej. `auto-report-on-finish.js`, `generate-vX-...js`). Todo agente o desarrollador DEBE utilizar exclusivamente este runner.

Ejecuta el ciclo de simulación integral de extremo a extremo:
1. **Limpieza profunda**: Limpia SQLite (`data/barberia_test.db`), borra archivos WAL temporales y purga Firestore `test`.
2. **Reinicio limpio**: Levanta el contenedor `fast-sim` a 60 FPS con el video indicado.
3. **Monitoreo calibrado**: Sigue en vivo el porcentaje y tiempo real transcurrido sobre los fotogramas del video.
4. **Detección automática de cierre**: Espera a que FFmpeg finalice de reproducir el archivo.
5. **Reporte fotográfico completo**: Exporta automáticamente los assets, genera la hoja de contacto consolidada (`sharp`) y crea el reporte Markdown bajo `docs/REPORTE_FOTOGRAFICO_<timestamp>.md`.

```bash
# Simulación con video de 7 horas (por defecto o pasando ruta):
node scripts/run-and-monitor.js data/recordings/barberia_stream_7h.mp4

# Simulación con video de 10 horas:
node scripts/run-and-monitor.js data/recordings/barberia_stream_10h.mp4

# Simulación con cualquier video arbitrario:
node scripts/run-and-monitor.js ruta/a/tu_video.mp4
```

Logs del contenedor de alto rendimiento:
```bash
docker logs -f fast-sim
```

### Modalidad 1D: Pipeline Rápido en 2 Pasos (Cosecha Offline + Clasificación Ultrarrápida en 5s) ⚡⚡

> [!TIP]
> **METODOLOGÍA RECOMENDADA PARA ITERACIÓN RÁPIDA DE ALGORITMOS Y BIOMETRÍA**.
> En lugar de esperar entre 20 y 40 minutos reproduciendo el video fotograma a fotograma en cada prueba de filtros o umbrales, el flujo se desacopla en dos etapas independientes:
> 1. **Paso 1 (Cosecha)**: Extrae una sola vez todos los recortes de personas en la silla con YOLO y los almacena en SQLite (`data/experiments.db`).
> 2. **Paso 2 (Clasificación)**: Ejecuta el pipeline completo de biometría, filtros y formación de citas en **~5 segundos** reutilizando exactamente los mismos procesos modulares de producción ([`src/services/processes.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/processes.js)).

#### Paso 1: Cosecha de Recortes de Silla (`scripts/step1_harvest_crops.js`)
Ejecuta la decodificación del video y la detección espacial con YOLOv8, almacenando cada recorte de persona en la silla con sus metadatos (timestamp virtual, caja delimitadora, silla) en la tabla `harvested_crops` de `data/experiments.db`:

```bash
# Cosechar recortes del video de 7 horas (se ejecuta una sola vez):
node scripts/step1_harvest_crops.js --video data/recordings/barberia_stream_7h.mp4

# O cosechar del video de 10 horas:
node scripts/step1_harvest_crops.js --video data/recordings/barberia_stream_10h.mp4
```
*Los datos cosechados permanecen intactos y persistidos en `data/experiments.db` para ser reutilizados indefinidamente en todas las pruebas de clasificación.*

#### Paso 2: Fast Causal Replay (`scripts/step2_causal_replay.js`)
Reproduce causalmente los recortes cosechados en el Paso 1 con paridad arquitectónica 100% con streaming en producción:
1. **Reloj virtual de alta fidelidad:** Avance milisegundo a milisegundo con heartbeat de vacancia de silla.
2. **PeopleService Causal:** Reconocimiento biométrico facial y anti-anclaje en tiempo real.
3. **ChairTracker & VisitSessionService:** Rotación causal y gestión de timeouts.
4. **Validación contra Ground Truth:** Aserciones anti-quimera en < 10 segundos.

##### Argumentos CLI Disponibles en el Paso 2:

| Argumento | Alias | Descripción | Valor por Defecto |
|---|---|---|---|
| `--video <nombre>` | | Nombre del video cosechado a evaluar | Detecta el más reciente |
| `--from <segundos>` | | Filtra eventos a partir del segundo especificado | Inicio del video |
| `--last <minutos>` | | Filtra únicamente los últimos N minutos | Ninguno |
| `--verbose-blocks` | | Muestra log en consola de cada decisión de bloque (confirmado, descartado, presencia) | Desactivado |

##### Ejemplos de Ejecución:

```bash
# A. Ejecutar replay causal completo (< 10 segundos):
npm run step2
# o directamente:
node scripts/step2_causal_replay.js

# B. Evaluar un video cosechado específico:
node scripts/step2_causal_replay.js --video barberia_stream_7h.mp4

# C. Evaluar los últimos 30 minutos:
node scripts/step2_causal_replay.js --last 30
```

**Salidas generadas automáticamente:**
- **Reporte Markdown del Funnel:** `docs/REPORTE_FUNNEL_<timestamp>.md` detallando el embudo paso a paso (recortes brutos $\to$ caras $\to$ piel $\to$ nitidez $\to$ barbero $\to$ sesiones $\to$ citas finales), tiempo de ejecución, árbol de linaje genealógico, historial completo de segmentación de bloques (TrackBlocks Timeline con veredictos, razones y descartes explicados) y el **motor de procesos exacto** utilizado.
- **Hoja de Contacto:** `docs/assets/simulacion_7h/contact_sheet_funnel_<timestamp>.jpg` con la galería de fotos reales de cada cliente clasificado.
- **Tablas de Experimento:** `experiment_appointments` y `experiment_customers` en `data/experiments.db` (sin tocar las bases de datos de producción).

#### 🎯 Ground Truth Oficial de Referencia (`barberia_stream_7h.mp4`)

Para evaluar la precisión de cualquier variante del pipeline, contrasta el reporte generado contra el documento canónico [`docs/GROUND_TRUTH_BARBERIA_7H.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/docs/GROUND_TRUTH_BARBERIA_7H.md):

* **Video:** `barberia_stream_7h.mp4` (Duración: 07:07:44 / 25,664 segundos).
* **Clientes Reales:** **Exactamente 6 clientes**.
* **Tiempos Exactos Verificados:**
  1. **Cliente #1:** `00:40:06 - 01:09:47` (29 min 41s)
  2. **Cliente #2:** `01:12:03 - 01:59:48` (47 min 45s)
  3. **Cliente #3:** `02:00:45 - 02:51:35` (50 min 50s)
  4. **Cliente #4:** `02:52:10 - 03:40:16` (48 min 06s)
  5. **Cliente #5:** `03:43:33 - 04:39:09` (55 min 36s)
  6. **Cliente #6:** `04:40:11 - 05:17:45` (37 min 34s)

> [!CAUTION]
> **RESTRICCIÓN CRÍTICA DE TIEMPO:** En esta barbería, los clientes consecutivos se sientan inmediatamente (gaps de 35 a 60 segundos entre que uno se levanta y el siguiente se sienta). **Está prohibido usar gaps ciegos de tiempo $\le 3\text{ min}$ para consolidar o separar clientes**. Toda consolidación de tramos debe basarse en compatibilidad biométrica (`similarity` y poses anatómicas), nunca en supuestos temporales.

### Modalidad 2: Desarrollo Completo con Frontend Web (Puerto 8085 + Vite 5173)

```bash
# Levanta Docker E2 y el servidor web Vite simultáneamente:
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LAST_MINUTES=5 npm run dev:mock
```

### Modalidad 3: Nativo en Node.js (Sin Docker Desktop)

```bash
# Solo el daemon backend:
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LAST_MINUTES=5 node src/index.js

# Daemon backend + Vite en paralelo:
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LAST_MINUTES=5 npm run dev:mock:local
```

---

## 5. Dónde y Cómo Ver los Logs de Ejecución

### A. Ver logs en vivo en Docker (Streaming en tiempo real)
```bash
docker logs -f e2-micro-sim
```

### B. Ver las últimas N líneas
```bash
docker logs --tail 100 e2-micro-sim
```

### C. Filtros rápidos con `grep` para depurar problemas específicos

#### 1. Ver capturas de rostro y biometría:
```bash
docker logs e2-micro-sim | grep "FaceRecognition"
```
*Patrones clave:*
* `📸 Rostro añadido a galería`: Foto del cliente agregada.
* `Rostro sospechoso de Barbero/Staff (Sim: ... >= 0.30)`: Filtro de exclusión del barbero actuando.
* `Recorte client_1 omitido: no_face_detected_or_back_of_head`: Filtro de nuca/espalda.

#### 2. Ver eventos de la Silla y Atenciones:
```bash
docker logs e2-micro-sim | grep "Appointment"
```
*Patrones clave:*
* `💺 Persona se sienta en Silla`: Inicio de atención y creación de perfil `to_verify`.
* `📸 Muestra facial recolectada para la atención`: Acumulación continua de fotos en la sesión.
* `⏳ Persona se levantó de Silla. Esperando 30s`: Cuenta regresiva de gracia de salida.
* `🚪 La persona se fue. Finalizando atención`: Fin de corte y análisis de cluster.
* `Muestra #N descartada por outlier biométrico`: Filtro anti-outliers eliminando fotos contaminantes.
* `✅ Atención registrada exitosamente`: Guardado formal de la cita en SQLite y Firestore.

#### 3. Ver sincronización de Clientes con Firestore:
```bash
docker logs e2-micro-sim | grep "CustomerService"
```
*Patrones clave:*
* `✅ Nuevo cliente sincronizado con Firestore`: Formalización del cliente.
* `🗑️ Borrado físico completo`: Eliminación de perfiles temporales `to_verify` huérfanos.
* `🛡️ [Anti-Truncación] Protegiendo galería`: Protección contra pérdida de fotos en actualizaciones parciales.

#### 4. Ver estado del Stream y FFmpeg:
```bash
docker logs e2-micro-sim | grep "Stream"
```
*Muestra inicio del video, cálculo de offset de minutos y código de salida del proceso FFmpeg.*

---

## 6. Endpoints HTTP para Verificación en Vivo

Con el simulador corriendo en el puerto 8085:

| Endpoint | Método | Descripción | Ejemplo de Comando |
|---|---|---|---|
| `http://localhost:8085/` | GET | Estado de salud, uso de memoria RAM, horario | `curl -s http://localhost:8085/ \| jq .` |
| `http://localhost:8085/api/snapshot` | GET | Fotograma decodificado actual (JPEG) | `curl -I http://localhost:8085/api/snapshot` |
| `http://localhost:8085/api/stream` | GET | Stream de video MJPEG en vivo | Abrir en navegador o VLC |
| `http://localhost:8085/api/telemetry/latest` | GET | Telemetría YOLO actual (cajas, cuadrantes, inferencia) | `curl -s http://localhost:8085/api/telemetry/latest \| jq .` |
| `http://localhost:8085/api/telemetry/stream` | GET | Flujo SSE en tiempo real para el frontend | Abrir en frontend Vite |
| `http://localhost:5173/` | Web | Dashboard visual con monitoreo y calendario | Abrir en navegador Chrome/Safari |

---

## 7. Cómo Inspeccionar la Base de Datos Local

Toda la actividad del simulador se guarda en SQLite en `data/barberia_test.db`. Puedes consultar directamente:

### A. Consultar las últimas atenciones registradas
```bash
sqlite3 data/barberia_test.db "
SELECT id, clientName, durationMinutes, photoCount, status, createdAt 
FROM appointments 
ORDER BY createdAt DESC LIMIT 5;
"
```

### B. Consultar los clientes registrados y su cantidad de fotos
```bash
sqlite3 data/barberia_test.db "
SELECT id, name, appointmentCount, photoCount, updatedAt 
FROM people 
WHERE isStaff = 0 
ORDER BY updatedAt DESC LIMIT 5;
"
```

### C. Verificar las 20 fotos del Barbero (Blindaje)
```bash
node scripts/restore-barber-photos.js
```
*Este comando realiza un dry-run verificando que el barbero mantiene sus 20 fotos auténticas en SQLite (`barberia.db` y `barberia_test.db`) y Firestore (`test` y `(default)`).*

---

## 8. Flujos Típicos de Desarrollo y Pruebas

Dependiendo del tipo de cambio que estés realizando, elige el flujo más adecuado:

### Flujo A: Iteración Instantánea de Filtros, Biometría y Motores en Paralelo (~5 segundos) ⚡ (Recomendado)
Usa este flujo cuando experimentes con mejoras en la lógica de detección facial, umbrales de pose/nitidez, filtros de barbero o reglas de consolidación/cierre en `src/services/pipeline/` o variantes de `processes.js`:

```bash
# 1. Crear una variante experimental para no alterar el código base ni producción:
cp src/services/processes.js src/services/processes_experimento.js

# 2. Modificar tu variante experimental según la hipótesis a probar:
# (ej. ajustar consolidación adaptativa, filtrado de teléfono, umbrales de nitidez, etc.)

# 3. Ejecutar el replay causal de alta fidelidad:
node scripts/step2_causal_replay.js

# 4. Inspeccionar y comparar los reportes del embudo y hojas de contacto generados:
# (Comprueba si el número de clientes se acerca al Ground Truth oficial de exactamente 6)
cat docs/REPORTE_FUNNEL_<timestamp>.md
open docs/assets/simulacion_7h/contact_sheet_funnel_<timestamp>.jpg

# 5. Contrastar los rangos de tiempo contra la Verdad de Terreno:
cat docs/GROUND_TRUTH_BARBERIA_7H.md

# 6. Si el experimento es exitoso y supera al baseline, promueve los cambios a producción y verifica la regresión:
# cp src/services/processes_experimento.js src/services/processes.js
npm test
```

---

### Flujo B: Validación Completa E2E de Streaming en Vivo (Docker) 🎬
Usa este flujo cuando modifiques la ingesta FFmpeg, decodificación RTSP/Neolink, tracking espacial en tiempo real o persistencia formal en SQLite/Firestore:

```bash
# Opción 1: Simulación completa con monitoreo automático y reporte fotográfico oficial
node scripts/run-and-monitor.js data/recordings/barberia_stream_7h.mp4

# Opción 2: Simulación rápida de los últimos 5 minutos (prueba cierre y salida)
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LAST_MINUTES=5 docker compose -f docker-compose.e2-sim.yml up -d --force-recreate
docker logs -f e2-micro-sim
```
