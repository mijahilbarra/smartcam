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
*Verifica: desinfección de Firestore, reporter daemon, detector ONNX, horario comercial, modular core, nitidez facial, person tracker, visit sessions, debounce de procesos, unificación de clientes, cliente SQLite, servicio de clientes, pipeline de atenciones (24 pruebas) y resiliencia de stream (8 pruebas).*

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

Logs del contenedor de alto rendimiento:
```bash
docker logs -f fast-sim
```

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

## 8. Flujo Típico de Prueba Rápida (4 Pasos)

Si como agente realizas un cambio en el código y deseas validarlo de principio a fin:

```bash
# 1. Correr la suite de pruebas unitarias
npm test

# 2. Levantar el simulador con los últimos 5 minutos del video de corte
MOCK_VIDEO_PATH="data/recordings/mock_stream.mp4" MOCK_VIDEO_LAST_MINUTES=5 docker compose -f docker-compose.e2-sim.yml up -d --force-recreate

# 3. Seguir los logs de la sesión y el cierre automático
docker logs -f e2-micro-sim

# 4. Al terminar el video, verificar la atención generada en SQLite
sqlite3 data/barberia_test.db "SELECT id, clientName, durationMinutes, photoCount FROM appointments ORDER BY createdAt DESC LIMIT 1;"
```
