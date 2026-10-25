# Guía para el Agente (Agent.md) - IOT Camera Catcher

Este documento contiene las reglas de operación, directrices de flujo de trabajo y contexto técnico esencial para cualquier Agente de IA o desarrollador que interactúe y realice modificaciones en este repositorio.

---

## 🚨 Reglas de Oro Obligatorias

### 1. Política Estricta de Ramas (Git Workflow)
> [!IMPORTANT]
> **NUNCA trabajar directamente en la rama `main`**.
> Cada vez que el usuario solicite un cambio, nueva característica, corrección o refactorización:
> 1. **Crear una nueva rama antes de tocar cualquier archivo**:
>    ```bash
>    git checkout -b <tipo>/<nombre-descriptivo>
>    ```
> 2. **Convención de prefijos para ramas**:
>    - `feat/`: Nueva funcionalidad o capacidad.
>    - `fix/`: Corrección de errores o bugs.
>    - `chore/`: Mantenimiento, dependencias o configuración interna.
>    - `docs/`: Cambios exclusivamente en documentación.
>    - `refactor/`: Reestructuración de código sin alterar comportamiento.
> 3. **Commits con formato Conventional Commits**:
>    Ejemplos: `feat(daemon): add retry on network failure`, `fix(web): correct timestamp parsing in dashboard`.

---

### 2. Contexto y Mantenimiento de la Carpeta `agent/`
La carpeta [`agent/`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent) es el núcleo de documentación arquitectónica viva del proyecto:

* **Estructura**:
  * [`agent/decisions/index.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/index.md): Índice principal de **Registros de Decisiones de Arquitectura (ADRs)**, diagrama de arquitectura global y diagramas de flujo de datos.
  * [`agent/decisions/01-...md` a `13-...md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions): Fichas individuales de cada tecnología activa en producción.
  * [`agent/decisions/removed.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/removed.md): Registro histórico de tecnologías descartadas o reemplazadas.

* **Reglas para modificar la arquitectura**:
  1. **Toda tecnología en uso DEBE estar documentada en `agent/decisions/`** y listada en `index.md`.
  2. **Si se añade un nuevo componente o tecnología**: Debe redactarse su respectivo ADR (`agent/decisions/XX-tecnologia.md`) y agregarse a la tabla de `index.md`.
  3. **Si una tecnología se descarta o reemplaza**: Debe removerse su archivo de las decisiones activas y documentarse en detalle en [`agent/decisions/removed.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/removed.md) con el motivo del descarte, problemas encontrados y la alternativa adoptada.

---

### 3. CI/CD Selectivo y Estructura de Despliegue (ADR 07)
El repositorio utiliza GitHub Actions con filtros por ruta (`paths:`):

| Directorio / Archivos | Destino del Despliegue | Pipeline |
| :--- | :--- | :--- |
| `src/**`, `neolink.toml`, `package.json`, `package-lock.json` | GCP Compute Engine `e2-micro` (VM Daemon) | `.github/workflows/deploy-vm.yml` |
| `web/**`, `firebase.json`, `storage.rules` | Firebase Hosting CDN + Storage Rules | `.github/workflows/deploy-hosting.yml` |
| `agent/**`, `Agent.md`, `*.md` | Solo repositorio (sin despliegues automáticos) | N/A |

---

### 4. Estándar de Tipografía e Iconografía Frontend (Google Fonts)
> [!IMPORTANT]
> **GOOGLE FONTS COMO ESTÁNDAR ÚNICO DE DISEÑO**:
> El frontend del proyecto (`web/`) utiliza exclusivamente la infraestructura de **Google Fonts**:
> 1. **Tipografía**:
>    - `Inter` (sans-serif): Interfaz de usuario general, títulos, botones y textos descriptivos.
>    - `JetBrains Mono` (monospace): Timestamps, IDs de documentos de Firestore, métricas técnicas y bitácoras.
> 2. **Iconografía**:
>    - **Google Fonts Material Symbols Outlined**: Es la biblioteca estándar y obligatoria de iconos vectoriales para toda la aplicación web.
>    - **Regla Estricta**: Queda prohibido el uso de emojis sueltos de sistema operativo (`📸`, `⚙️`, `⚡`, `👤`, `📐`, etc.) como iconos representativos en la interfaz de usuario. Todo icono debe declararse mediante:
>      ```html
>      <span class="material-symbols-outlined">nombre_icono</span>
>      ```
>    - **Ventajas**: Garantiza consistencia visual idéntica sin distorsión entre sistemas operativos (macOS, Windows, Linux, iOS, Android), escalabilidad vectorial precisa y estilización reactiva con variables CSS del tema (`var(--primary)`, `var(--text-muted)`, etc.).

---

### 5. Prohibición Estricta de Parches Superficiales (Arquitectura Primero)
> [!CAUTION]
> **PROHIBIDO APLICAR WORKAROUNDS O PARCHES SUPERFICIALES (MONKEY-PATCHING)**.
> Cuando se descubra un error, bug, limitación o fallo sistémico cuya causa raíz pertenezca a la arquitectura, infraestructura o modelo de datos (por ejemplo: configuración de CORS en buckets, políticas de red, ciclo de vida de procesos, desacoplamientos de capas, esquemas de bases de datos o dependencias nativas):
> 1. **No aplicar apaños temporales** en capas superiores (como proxies cosméticos, timeouts ciegos, supresión de errores en consola o hacks en frontend para enmascarar fallos de backend/cloud).
> 2. **Reportar la causa raíz al usuario**: Explicar técnicamente el origen estructural del problema, el impacto y la solución arquitectónica correcta.
> 3. **Detenerse y esperar confirmación explícita del usuario** antes de aplicar la modificación arquitectónica o de infraestructura.

---

### 6. Delegación Obligatoria en Subagentes (Contexto Limpio y Especializado)
> [!IMPORTANT]
> **TODA TAREA DE EJECUCIÓN, INVESTIGACIÓN O IMPLEMENTACIÓN DEBE DELEGARSE SIEMPRE A SUBAGENTES**.
> Para asegurar que el agente encargado de resolver la tarea trabaje con un contexto limpio, sin ruido ni sobrecarga del historial previo de la conversación:
> 1. **El Agente Principal actúa como Orquestador**: Analiza la solicitud, dialoga con el usuario, diseña la estrategia y valida los resultados finales.
> 2. **Delegación sistemática mediante `invoke_subagent`**: Toda modificación de código, refactorización, resolución de bugs o investigación técnica debe ser delegada a un subagente especializado.
> 3. **Ahorro de Tokens y Jerarquía de Modelos**:
>    - Los subagentes deben ser invocados con modelos más ligeros y rápidos (ej. `Model: 'flash'` / Gemini Flash / Low) para optimizar costos de cómputo y consumo de tokens, mientras el agente principal orquestador opera en un modelo superior (High).
>    - **Obligación de Instrucción Quirúrgica**: Como contrapartida indispensable de emplear un modelo más ligero en los subagentes, el agente orquestador (High) tiene la **obligación estricta** de suministrar un prompt y conjunto de instrucciones totalmente detallado, quirúrgico y exhaustivo, con todo el contexto necesario, rutas absolutas exactas de archivos, contratos de interfaz, restricciones y pasos de verificación que debe cumplir antes de reportar el resultado, evitando bajo cualquier circunstancia instrucciones vagas o ambiguas.

---

### 7. Cero Coexistencia de Paradigmas: Reemplazo Radical, Nunca Modos Paralelos Duplicados
> [!IMPORTANT]
> **PROHIBIDO CONSTRUIR DOS FORMAS DE HACER LAS COSAS A MENOS QUE EL USUARIO LO PIDA EXPLÍCITAMENTE**.
> Cuando la arquitectura del sistema evoluciona o migra hacia un nuevo estándar (por ejemplo: de capturas periódicas por intervalos de 15 min hacia streaming y seguimiento en tiempo real):
> 1. **Reemplazo Radical y Definitivo**: El nuevo paradigma reemplaza por completo al anterior. Queda terminantemente prohibido mantener "dos formas paralelas", switchers de alternancia innecesarios ("Modo A vs Modo B") o vistas intermedias redundantes por miedo a romper lo anterior.
> 2. **Depuración de Elementos Obsoletos**: Todo componente que pierda sentido con la nueva arquitectura debe eliminarse de raíz (por ejemplo: el contador/cron regresivo de 15 minutos, las barras de espera de captura y las fases antiguas del ciclo).
> 3. **Fuente Única de Verdad (Single Source of Truth)**: La interfaz y el backend deben ofrecer una experiencia limpia, unificada y coherente con el nuevo paradigma, presentando directamente la sesión en vivo y la analítica en tiempo real.

---

### 8. Arquitectura Limpia del Pipeline Core (Prohibición Estricta de Ensuciar processes.js)
> [!CAUTION]
> **PROHIBICIÓN ESTRICTA DE ENSUCIAR `processes.js` CON LÓGICA DE DETALLE**.
> El archivo [`src/services/processes.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/processes.js) es el **orquestador declarativo principal del backend** y debe mantenerse estrictamente limpio, lineal y conciso (< 120-150 líneas en total, con `runProcessCycle` < 90 líneas).
> 1. **Prohibición de Lógica Procedural Interna**: Queda terminantemente prohibido que los agentes coloquen lógica de detalle de un step (manipulación de buffers con Sharp, transformaciones de coordenadas, bucles anidados de persistencia, sockets, reescalados, etc.) directamente dentro de `processes.js` o en el cuerpo de `runProcessCycle`.
> 2. **Modularización Obligatoria en `src/services/pipeline/`**: Cada paso del pipeline debe vivir en su propio módulo independiente bajo [`src/services/pipeline/`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/pipeline) con interfaces puras y testeables (`acquisition_step.js`, `clear_stream_step.js`, `detection_step.js`, `tracking_step.js`, `biometrics_step.js`, `visits_step.js`, `occupancy_step.js`, `telemetry_step.js`, `persistence_step.js`).
> 3. **Regla de Extensión de Nuevas Funcionalidades**: Si se necesita agregar una nueva funcionalidad, paso o etapa al pipeline, NUNCA se debe agregar código procedural dentro de `processes.js`. Se DEBE crear una nueva etapa modularizada en su propio archivo dentro de `src/services/pipeline/` (ej: `nuevo_step.js`) y luego solo importarse e invocarse limpiamente en la secuencia lineal de `processes.js`.
> 4. **Re-exportación y Compatibilidad**: `processes.js` actúa como fachada re-exportando las funciones públicas de cada step para preservar 100% de compatibilidad hacia atrás con el resto del sistema y las suites de test.

---

### 9. El Servidor es Exclusivamente Motor de Visión (Cero Endpoints de API / CRUD)
> [!IMPORTANT]
> **EL SERVIDOR SOLO RECIBE IMAGEN Y PROCESA IMAGEN**.
> El servidor / daemon (`src/index.js`) tiene una única responsabilidad: conectarse a la cámara/stream, adquirir fotogramas y procesar el pipeline de visión por computadora (detección YOLO, ArcFace y seguimiento).
> 1. **Prohibición Total de Servir como API Web o Backend CRUD**: Queda terminantemente prohibido utilizar el servidor para servir endpoints de consulta, creación, modificación o eliminación de datos de negocio (como atenciones/appointments, perfiles de clientes, fotos o configuraciones).
> 2. **Todo el Proceso de Datos Vive en el Frontend**: Toda la gestión de lectura, escritura y borrado de citas, clientes y configuraciones debe realizarse directamente desde el frontend (`web/`) comunicándose de forma serverless con Firebase (Cloud Firestore y Storage).
> 3. **Cero Sobrecarga Extra en la Máquina Virtual**: La VM de cómputo (`e2-micro` o hardware de borde) debe dedicar el 100% de su capacidad a la inferencia neuronal y flujo de imágenes sin sobrecargas de peticiones HTTP de datos.
> 4. **Flujo Continuo en Tiempo Real**: El sistema opera de forma continua y autónoma con bucle en tiempo real (`startRealtimeLoop`). La telemetría y métricas se transmiten vía Server-Sent Events (SSE) hacia la interfaz web.

---

### 10. Segregación Estricta y Obligatoria de Entornos (Local vs Producción)
> [!CAUTION]
> **PROHIBIDO COMPARTIR O COMBINAR BASES DE DATOS O BUCKETS ENTRE LOCAL Y PRODUCCIÓN**.
> El sistema cuenta con aislamiento estricto por diseño para que las pruebas, desarrollo y simulaciones locales jamás contaminen ni lean los datos reales de producción de la barbería:
> 
> | Entorno | Firestore Database | Firebase Cloud Storage | SQLite Local |
> | :--- | :--- | :--- | :--- |
> | **Local / Dev / Simulador E2** (`localhost`, `127.0.0.1`, Docker `e2-micro-sim`) | `"test"` | `"skip-bigotes-test"` (`gs://skip-bigotes-test`) | `data/barberia_test.db` |
> | **Producción Real** (`camera-catcher-bigotes.web.app`, VM GCP `/opt/camera-catcher`) | `"(default)"` | `"skip-bigotes.firebasestorage.app"` (`gs://...`) | `data/barberia.db` |
> 
> 1. **Prohibición de Fallback a Producción en Local**: En [`web/src/shared/lib/environment.js`](web/src/shared/lib/environment.js), el cálculo automático DEBE resolver siempre:
>    ```javascript
>    const databaseId = customDb || (isLocal ? 'test' : '(default)');
>    const storageBucket = customStorage || (isLocal ? 'gs://skip-bigotes-test' : 'gs://skip-bigotes.firebasestorage.app');
>    ```
>    Queda **terminantemente prohibido** que un agente reemplace `(isLocal ? 'test' : '(default)')` por `'(default)'` o el bucket de producción como fallback por conveniencia temporal.
> 2. **Modal de Configuración y Reset Auto**: El botón "Auto" en el frontend debe restablecer siempre la resolución basada en el hostname (`isLocal`), llevando a `test` en local y a `(default)` en producción.
> 3. **Scripts y Migraciones Seguros**: Todo script de mantenimiento o migración en `scripts/` debe operar por defecto en `"test"`. Para tocar producción, el usuario o desarrollador DEBE pasar explícitamente el flag `--database="(default)"`.

---

### 11. Herramientas Oficiales de Testing y Simulación (Cero Scripts Huérfanos)
> [!CAUTION]
> **PROHIBIDO CREAR NUEVOS SCRIPTS TEMPORALES O HUÉRFANOS PARA TESTEAR O SIMULAR**.
> El proyecto cuenta con dos modalidades oficiales, estandarizadas y documentadas en [`docs/LOCAL_TESTING_GUIDE.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/docs/LOCAL_TESTING_GUIDE.md):
> 
> 1. **Tester de Simulación Streaming E2E (`scripts/run-and-monitor.js`)**:
>    - Para pruebas de extremo a extremo que validan la reproducción continua de video (7h, 10h), ingesta FFmpeg, Docker `fast-sim` y persistencia general:
>      ```bash
>      node scripts/run-and-monitor.js [ruta-al-video.mp4]
>      ```
> 
> 2. **Pipeline Rápido en 2 Pasos (Cosecha + Clasificación en 5s)**:
>    - Para iteración ultra-rápida de algoritmos, detección facial, nitidez, exclusión de personal y consolidación de citas sin esperar horas:
>      - **Paso 1 (Cosecha de Recortes con YOLO, 1 sola vez)**:
>        ```bash
>        node scripts/step1_harvest_crops.js --video data/recordings/barberia_stream_7h.mp4
>        ```
>      - **Paso 2 (Fast Causal Replay en ~5-10 segundos con reloj virtual de alta fidelidad)**:
>        ```bash
>        # Simulación causal de alta fidelidad:
>        node scripts/step2_causal_replay.js --video barberia_stream_7h
>        # O filtrar ventana de tiempo:
>        node scripts/step2_causal_replay.js --last 30
>        ```
> 
> 3. **Prohibición Estricta de Scripts Ad-Hoc / Huérfanos**: Queda terminantemente prohibido crear scripts paralelos de monitoreo, generadores de reportes específicos de versión o scripts descartables (como `auto-report-on-finish.js`, `generate-vX-...js`, `test-runner-...js`, etc.).
> 4. **Evolución Centralizada**: Cualquier mejora a los flujos de prueba debe realizarse dentro de estas herramientas oficiales y reutilizar los módulos de producción en [`src/services/processes.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/processes.js).
> 5. **Estandarización de Reportes**: Los reportes generados siguen estrictamente la convención cronológica genérica `docs/REPORTE_FOTOGRAFICO_${YYYY}${MM}${DD}_${HH}${mm}.md` o `docs/REPORTE_FUNNEL_${YYYY}${MM}${DD}_${HH}${mm}.md`.

---

### 12. Regla de Oro: Transparencia Total en el Embudo (Prohibido Ocultar Movimientos)
> [!IMPORTANT]
> **PROHIBIDO OCULTAR, AGRUPAR SILENCIOSAMENTE O CONDENSAR MOVIMIENTOS EN EL EMBUDO (FUNNEL)**.
> Cada acción de filtrado, clasificación anatómica, descarte de artefactos/objetos, continuidad de silla o consolidación DEBE reportarse de manera explícita y transparente como un escalón numerado e independiente en el reporte del Embudo (`REPORTE_FUNNEL_*.md`).
> 1. **Clasificación Anatómica y Geometría Facial**: La separación entre caras erguidas (anclas de identidad biométrica, proporción ~1x2, `h/w >= 1.5`) y caras chatas/reclinadas (destinadas exclusivamente a extender y computar duración de servicio) debe ser un paso explícito del embudo con su conteo exacto de fotos.
> 2. **Filtro Anti-Objetos / Celulares**: Los descartes de pantallas, objetos o reflejos deben reflejarse como un filtro explícito con cantidad de sesiones/fotos eliminadas.
> 3. **Continuidad Temporal en Silla**: La unión de micro-segmentos contiguos del mismo cliente sentado (gaps de silla menores a 45s o lavado) debe mostrarse como paso visible de agrupamiento continuo.
> 4. **Delimitación de Vacancia Real**: La detección de vacancia de silla entre clientes diferentes (cambio de cliente) debe mostrarse con el número de cortes formalizados.
> 5. **Consolidación Biocéntrica Final**: La unión final guiada por anclas erguidas debe reflejar las citas definitivas resultantes sin suposiciones ocultas.

---

### 13. Causalidad Temporal Estricta y Cero Lookahead Bias (Prohibido "Mirar al Futuro" en Simulaciones)
> [!CAUTION]
> **PROHIBIDO EL SESGO DE ANTICIPACIÓN (LOOKAHEAD BIAS) Y LA FUGA TEMPORAL EN SIMULACIONES O PROCESAMIENTO OFFLINE**.
> Toda lógica algorítmica de detección, agrupamiento, tracking, sillas y cierre de citas DEBE respetar la causalidad temporal estricta:
> 1. **Causalidad Estricta ($t_0 \rightarrow t_n$)**: En el instante $t_k$, el sistema SOLO puede conocer y operar sobre lo que ha ocurrido hasta $t_k$. Queda terminantemente prohibido hacer barridos globales hacia adelante y atrás sobre grabaciones históricas que tomen decisiones usando información que un sistema en vivo no tendría en ese instante.
> 2. **Unificación Absoluta de Algoritmos (Mismo Código, Mismo Comportamiento)**:
>    - La simulación NO puede tener su propia lógica paralela de agrupamiento o inferencia. Debe ser un simple "Replay Causal Acelerado" (Fast-Forward Replay) alimentando la misma máquina de estados y las mismas funciones que corren en producción ([`src/services/pipeline/`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/pipeline) y [`VisitSessionService`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/visit_session_service.js)).
>    - Lo que se pruebe en simulación DEBE funcionar de forma idéntica en el streaming en vivo segundo a segundo.
> 3. **Prohibición de "Hacer Trampa" en Benchmarks**: Diseñar algoritmos que solo funcionan cuando tienen el dataset completo en memoria mirando hacia el futuro es considerado una violación grave de arquitectura, pues genera reportes cosméticamente atractivos pero inoperables en la cámara en vivo.

---

### 14. Colaboración y Alineación con el Usuario (No Resolver Todo por Cuenta Propia)
> [!IMPORTANT]
> **PROHIBIDO INTENTAR SOLUCIONAR TODO DE FORMA AUTÓNOMA Y AISLADA**.
> El agente es un copiloto de desarrollo y debe mantener una alineación constante con el usuario:
> 1. **Pausas Obligatorias de Alineación**: Cuando surjan discrepancias, fallos de calibración o bifurcaciones en los resultados, el agente NO debe encadenar múltiples cambios especulativos o ejecutar bucles de corrección continuos por su cuenta.
> 2. **Consultar y Proponer en Lugar de Asumir**: El agente debe detenerse, exponer con claridad sus hallazgos, diagnósticos objetivos y las opciones posibles, solicitando el criterio y la validación del usuario antes de proceder con modificaciones de fondo.
> 3. **Respeto a las Directivas Inmediatas del Usuario**: Si el usuario pide detenerse, revisar una parte específica o plantear una hipótesis particular, el agente debe priorizar esa instrucción de forma inmediata por encima de cualquier plan autónomo previo.

---

## 🛠️ Resumen de Componentes Técnicos

1. **Captura P2P (Neolink)**:
   - Comunicación UDP con protocolo Baichuan propietario de Reolink para atravesar CGNAT sin IP pública.
2. **Daemon Host (GCP VM `e2-micro`)**:
   - Servicio systemd 24/7 (`camera-catcher.service`) que coordina Neolink, captura de fotogramas, inferencia local ONNX y túnel Cloudflare.
   - Configurado con `MALLOC_ARENA_MAX=2` y flags de Node.js `--optimize-for-size --max-old-space-size=192` para operar de forma ultra-ligera en 1 GB de RAM (~210 MB RSS en prod).
3. **Firestore**:
   - `camera_catcher/prompt`: Configuración viva de horario laboral (workStartTime, workEndTime, timezone) y prompt para Gemini.
   - `camera_catcher/photos/photos/<id>`: Metadatos y descripciones analíticas de cada foto.
4. **Firebase Storage**:
   - Bucket que almacena los fotogramas JPEG (`camera_catcher/photos/<id>.jpg`).
5. **Gemini Vision AI (`gemini-flash-latest`)**:
   - Inferencia multimodal sobre el fotograma capturado según el prompt dinámico configurado.
6. **Frontend Web Dashboard (`web/`)**:
   - Vue 3 + Tailwind CSS + Vite y Firebase SDK para monitoreo y control en tiempo real desde navegadores con badge de memoria RAM en vivo.
7. **Pipeline Funcional Core (`src/services/processes.js`, `src/services/pipeline/` & `agent/PROCESSES.md`)**:
   - **Pipeline Core del Sistema**: Orquestador lineal de alto nivel (`src/services/processes.js`, < 110 líneas) descompuesto en etapas puras y declarativas bajo `src/services/pipeline/` para adquisición de fotogramas (0ms RAM en tiempo real o Stream Clear 2560x1440 reactivo en `clear_stream_step.js`), inferencia local YOLOv8 con acceso $O(1)$ a personas y modo centinela de 25 skips estáticos (`detection_step.js`), seguimiento continuo de personas (`tracking_step.js`), biometría gobernada por sesión con galería multi-ángulo y caché podada de fotos en RAM (`biometrics_step.js` + `VisitSessionService` + ArcFace MobileFaceNet), gestión de visitas (`visits_step.js`), cálculo funcional de ocupación (`occupancy_step.js`), emisión SSE de telemetría y métricas de RAM (`telemetry_step.js`) y persistencia atómica (`persistence_step.js`). Especificación canónica y guía de extensión detalladas en [`agent/PROCESSES.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/PROCESSES.md).
8. **Live Streaming MJPEG Resiliente & Túnel Seguro (ADR 17 & ADR 18)**:
   - Arquitectura Dual-Stream desacoplada: Streaming continuo liviano (`subStream` 640x360 a 3.5 FPS, `-q:v 4`, `-threads 1`) para el visor web y YOLO (<5% CPU), y captura puntual en alta resolución (2304x1296) bajo demanda gobernada por `clear_stream_step.js` para biometría de clientes sentados, retención de último fotograma para `/api/snapshot` y auto-recuperación (`onEnsureRtspSource`) que levanta el contenedor `neolink-daemon` si se encuentra apagado. Conectado a producción vía Cloudflare Tunnel en `https://stream.perrosuelto.com`.
