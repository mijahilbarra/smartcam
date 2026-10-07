# ADR 16: Almacenamiento Biométrico Dual (SQLite Local WAL + RAM Cache + Reflejo Asíncrono Firebase)

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

Anteriormente, el daemon de la cámara realizaba consultas a Cloud Firestore (`camera_catcher_people`) en cada fotograma del ciclo de detección para obtener la lista de clientes conocidos y comparar sus vectores faciales contra las caras detectadas.

Este enfoque presentaba tres problemas críticos:
1. **Latencia de Red en Ciclo Crítico**: Consultar Firestore añadía entre 150 ms y 400 ms de latencia por frame en el pipeline de visión.
2. **Consumo de Cuotas y Costos**: En operación continua de alta frecuencia (ej. cada 2 a 5 segundos), realizar lecturas constantes de la colección de personas agotaba rápidamente la cuota gratuita de 50,000 lecturas diarias de Firestore.
3. **Bloqueo de Telemetría**: El envío de telemetría por SSE (`broadcastTelemetry`) esperaba a la resolución de la etapa biométrica y al fotograma Clear (`acquireClearFrame`), demorando la visualización de los cuadros delimitadores YOLO en el frontend.

---

## Decisión Técnica

Se implementa una **arquitectura de almacenamiento biométrico dual** con jerarquía de 3 niveles:

```mermaid
flowchart TD
    Frame["Fotograma Detectado (YOLO)"] --> Track["Tracking Espacial"]
    Track --> Telemetry["SSE broadcastTelemetry (<50ms)"]
    Track --> FaceBio["Extracción Facial ArcFace"]
    FaceBio --> RAM["Nivel 1: Caché en RAM (<0.001 ms)"]
    RAM --> SQLite["Nivel 2: SQLite Local WAL (data/barberia.db) (<1 ms)"]
    SQLite --> AsyncDecision{"¿Cambio Significativo?<br/>(Nuevo / Mayor Nitidez / Nuevo Ángulo)"}
    AsyncDecision -- "Sí" --> Firebase["Nivel 3: Firestore + Storage (Asíncrono)"]
    AsyncDecision -- "No (Tick de rutina)" --> LocalOnly["Permanecer en Local ($0 Cuota)"]
```

### 1. Nivel 1: Caché en RAM Ultrarrápida (`CustomerService`)
* [`src/services/customer_service.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/customer_service.js) mantiene en memoria un `Map` indexado por ID de cliente con todos los perfiles biométricos activos.
* La función `getComparisonProfiles()` entrega la galería completa para `identifyFace` en menos de **0.001 ms** (sub-microsegundo), eliminando la latencia de red y disco por completo.

### 2. Nivel 2: SQLite Local con Modo WAL y Blobs Binarios (`SQLiteClient`)
* [`src/infrastructure/storage/sqlite_client.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/infrastructure/storage/sqlite_client.js) administra la base de datos local `data/barberia.db` utilizando `better-sqlite3`.
* Modo WAL (`journal_mode = WAL`) y claves foráneas activadas (`foreign_keys = ON`).
* Tablas relacionales con integridad referencial:
  * `customers`: Metadatos del cliente (nombre, visitas, nitidez récord, fechas, miniatura).
  * `customer_embeddings`: Galería de hasta 6 vectores por cliente con clave foránea `ON DELETE CASCADE`.
* Serialización binaria: Los vectores de características (512 floats) se almacenan directamente como **BLOB binarios de 2048 bytes** (`Float32Array` <-> `Buffer`), evitando el sobrecosto de parseo JSON.

### 3. Nivel 3: Reflejo Asíncrono Selectivo a Firebase
* Las actualizaciones de presencia rutinarias (`lastSeen`) se persisten exclusivamente en SQLite local y RAM.
* La sincronización hacia Firebase (`camera_catcher_people` y Storage) sólo se dispara ante **eventos significativos**:
  * Registro de nuevo cliente (`isNew: true`).
  * Mejora de nitidez respecto al récord anterior (`higherSharpness: true`).
  * Incorporación de un ángulo novedoso a la galería (`newAngle: true`).
  * Sincronización forzada explícita (`forceSync: true`).

### 4. Desacoplamiento de Telemetría SSE y Reducción de Timeout Clear
* En [`src/services/processes.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/processes.js):
  * `broadcastTelemetry` se ejecuta inmediatamente tras el Paso 4 (`trackEntities`), enviando los cuadros YOLO y tracks al frontend en **<50 ms**.
  * El timeout de adquisición reactiva `acquireClearFrame` se reduce de 8000 ms a **1500 ms**, evitando congelamientos del hilo ante latencias RTSP.

---

## Consecuencias y Beneficios

### Positivas:
- **Latencia Sub-milisegundo**: Comparación biométrica instantánea en RAM (<0.001 ms) y persistencia transaccional local (<1 ms).
- **Ahorro Radical de Cuotas Firebase ($0 Cloud)**: Reduce las operaciones de escritura/lectura en Firestore en más de un 95% durante la operación continua.
- **Frontend Ultra-Fluido**: La telemetría en tiempo real se transmite al navegador sin esperar las etapas de mayor peso computacional o de red.
- **Resiliencia Offline**: El daemon puede continuar reconociendo clientes y registrando visitas localmente incluso si la conexión a Internet se interrumpe temporalmente.
