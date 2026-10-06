# ADR 13: Arquitectura Modular por Capas del Daemon (Hexagonal Ligera)

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El daemon de captura y procesamiento (`src/`) experimentó un crecimiento orgánico rápido. El archivo principal [`src/index.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/index.js) superó las 730 líneas y concentraba múltiples responsabilidades desconectadas:
1. Inicialización de Firebase Admin y configuración de credenciales.
2. Control de procesos del sistema operativo (`docker run`, `pkill`, `rm -f`).
3. Lógica matemática de horarios de trabajo y zonas horarias.
4. Programador cron de intervalos dinámicos con temporizadores `setInterval`.
5. Listeners de sockets WebSocket en tiempo real de Firestore (`commands`, `prompt`, `quadrants`).
6. Subida de archivos binarios a Firebase Storage.
7. Lógica de negocio de reconciliación biométrica facial de clientes y personal.
8. Telemetría de estados del daemon para el panel web (`daemonReporter`).

Simultáneamente, [`src/detector.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/detector.js) contenía tanto tensores ONNX como heurísticas espaciales de la barbería y utilidades de serialización de Firestore.

Esta concentración generaba:
- **Acoplamiento elevado**: Importar una función auxiliar de horario laboral en pruebas disparaba efectos colaterales de Docker y conexiones a Firebase.
- **Riesgo en la VM e2-micro**: Dificultad para aislar el consumo de memoria y CPU ante fallos de procesos hijos.
- **Complejidad de Mantenimiento**: Archivos monolíticos difíciles de auditar y extender.

---

## Decisión Técnica

Se rediseña la arquitectura del directorio `src/` aplicando una **Arquitectura Modular por Capas (Hexagonal ligera / Clean Architecture adaptada a IoT)**:

```text
src/
├── core/                                # 🧠 Lógica pura de dominio (cero dependencias de I/O)
│   ├── working_hours.js                 # parseTimeToMinutes, isWithinWorkingHours, WorkingHoursManager
│   ├── geometry.js                      # pointInPolygon, boxIntersectionArea, toPointObject, boxNormToPolygonNorm, calculateIoU, applyNMS
│   └── barbershop_rules.js              # Heurísticas de barbería: clasificación de cuadrantes y solapamiento
│
├── infrastructure/                      # 🔌 Adaptadores a servicios externos, SO y Red
│   ├── camera/
│   │   └── neolink_client.js            # Docker Neolink execution, killCaptureContainer, cleanupZombies
│   ├── firebase/
│   │   ├── firebase_admin.js            # Inicialización singleton de Firebase Admin (db, bucket)
│   │   ├── firestore_sanitizer.js       # sanitizeForFirestore
│   │   ├── firestore_listeners.js       # Snapshot listeners de commands, prompt y quadrants
│   │   └── storage_client.js            # Subida de fotos originales y recortes de clientes
│   └── logging/
│       └── logger.js                    # Redirección de console.log/error a daemon.log y /tmp
│
├── services/                            # ⚙️ Casos de uso y orquestación
│   ├── capture_orchestrator.js          # Orquesta: Neolink -> ONNX -> Crops -> Face -> Storage -> Firestore -> Telemetría
│   ├── people_service.js                # Biometría: reconciliación con staff y perfiles en Firestore
│   └── visit_session_service.js         # Ciclo de vida de visitas, auditoría de sillas y persistencia
│
├── models/                              # 📦 Pesos binarios ONNX (yolov8n, w600k_mbf, etc.)
├── detector.js                          # Fachada / Facade hacia core/ + ONNX (retrocompatible al 100%)
└── index.js                             # 🚀 Entrypoint limpio (< 110 líneas): arranque, Express, DI, loop continuo y listeners
```

### Principios Clave Implementados:
1. **Separación de Responsabilidades**:
   - `core/`: Funciones matemáticas y lógicas 100% puras, sin dependencias de red, SO ni librerías pesadas.
   - `infrastructure/`: Encapsula clientes de I/O (Docker, Firebase Admin, Storage, Logging).
   - `services/`: Orquesta los flujos de negocio sin lidiar con los detalles de bajo nivel de transporte.
2. **Retrocompatibilidad Total**:
   - `src/detector.js` y `src/index.js` actúan como fachadas re-exportando las funciones públicas requeridas por tests o integraciones previas.
3. **Cero Impacto en CI/CD**:
   - `.github/workflows/deploy-vm.yml` sincroniza `src/**` de forma recursiva; la nueva jerarquía de carpetas se despliega de forma nativa e idéntica.

---

## Consecuencias y Beneficios

### Positivas:
- **Reducción de tamaño del Entrypoint**: `src/index.js` pasa de 737 líneas a ~105 líneas limpias y legibles.
- **Testeabilidad Aislada**: Las pruebas unitarias de horarios laborales y geometría corren en menos de 5 ms sin inicializar bases de datos ni sockets.
- **Resiliencia en GCP `e2-micro`**: Las fallas en Neolink o Docker quedan acotadas a `neolink_client.js` sin corromper el estado del daemon ni los listeners.
- **Compatibilidad 100% Verificada**: Todas las suites de pruebas (`npm test`) se ejecutan con éxito inmediato.
