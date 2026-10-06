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
│   ├── processes.js                     # Pipeline funcional: acquireFrame -> detectScene -> trackEntities -> matchIdentities -> updateVisits -> computeOccupancy -> broadcastTelemetry -> persistCycleData
│   ├── capture_orchestrator.js          # Controlador con estado (tracker, visitService, mutex) que delega en runProcessCycle
│   ├── people_service.js                # Biometría: reconciliación con staff y perfiles en Firestore
│   └── visit_session_service.js         # Ciclo de vida de visitas, auditoría de sillas y persistencia
│
├── models/                              # 📦 Pesos binarios ONNX (yolov8n, w600k_mbf, etc.)
├── detector.js                          # Fachada / Facade hacia core/ + ONNX (retrocompatible al 100%)
└── index.js                             # 🚀 Entrypoint limpio (< 110 líneas): arranque, Express, DI, loop continuo y listeners
```

### Principios Clave Implementados:
1. **Separación de Responsabilidades**:
   - `core/`: Funciones matemáticas y lógicas 100% puras, sin dependencias de red, SO ni librerías pesadas (`barbershop_rules.js`, `geometry.js`, `working_hours.js`).
   - `infrastructure/`: Encapsula clientes de I/O (Docker, Neolink RTSP, Firebase Admin, Storage, Logging).
   - `services/`: Orquesta los flujos de negocio (`processes.js`, `capture_orchestrator.js`, `people_service.js`, `visit_session_service.js`).
2. **Zonas de Captura de Personas Configurables Dinámicamente**:
   - Se erradica por completo la etiqueta rígida hardcodeada `"cliente_sentado"` y las suposiciones fijas.
   - Cada cuadrante en Firestore y la interfaz web ahora expone `capturePerson: boolean`, `role: 'client' | 'staff' | 'visitor'` y `labelOnOccupied: string`.
   - Si una persona detectada ocupa una zona con `capturePerson === true`, el sistema le asigna dinámicamente el rol, la etiqueta configurada y activa la bandera `requiresClearCapture: true`.
3. **Captura Reactiva en Alta Resolución (Stream Clear On-Demand)**:
   - Para no sobrecargar la CPU de la VM `e2-micro`, el daemon realiza la inferencia continua YOLO sobre el substream ligero (640x360 @ 8fps).
   - Cuando un nuevo track de persona es detectado en una zona con captura habilitada y carece de rostro nítido (`sharpnessScore < 60`), el daemon dispara de manera reactiva y controlada (rate-limited / cooldown de 12s) la extracción de un fotograma de alta definición (Clear Stream 2560x1440 vía RTSP).
   - Se calcula el factor de escala hacia el frame Clear, se extrae el recorte con máxima resolución de píxeles y se ejecuta la re-identificación biométrica facial (`reidentifyPeople`) para extraer embeddings de máxima precisión.
   - Si el stream Clear falla o sufre timeout, el daemon degrada suavemente al recorte ligero sin interrumpir el ciclo (Regla 5).
4. **Retrocompatibilidad Total**:
   - `src/detector.js` y `src/index.js` actúan como fachadas re-exportando las funciones públicas requeridas por tests o integraciones previas.
5. **Cero Impacto en CI/CD**:
   - `.github/workflows/deploy-vm.yml` sincroniza `src/**` de forma recursiva; la nueva jerarquía de carpetas se despliega de forma nativa e idéntica.

---

## Consecuencias y Beneficios

### Positivas:
- **Reducción de tamaño del Entrypoint**: `src/index.js` pasa de 737 líneas a ~105 líneas limpias y legibles.
- **Biometría de Alta Fidelidad sin Sobrecarga**: Embeddings faciales extraídos sobre fotogramas de 2560x1440 bajo demanda, manteniendo la CPU en reposo la mayor parte del tiempo.
- **Zonas 100% Flexibles**: El usuario configura qué zonas capturan rostros, qué roles desempeñan y cómo se nombran directamente desde el Calibrador Visual.
- **Testeabilidad Aislada**: Las pruebas unitarias de horarios laborales, geometría y pipeline corren en milisegundos sin inicializar bases de datos ni sockets.
- **Resiliencia en GCP `e2-micro`**: Las fallas en Neolink o Docker quedan acotadas a `neolink_client.js` sin corromper el estado del daemon ni los listeners.
- **Compatibilidad 100% Verificada**: Todas las suites de pruebas (`npm test`) y la compilación web (`npm run build:web`) se ejecutan con éxito inmediato.
