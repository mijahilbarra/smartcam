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
> 3. **Prompt autónomo y detallado**: Cada subagente debe recibir un prompt claro y auto-contenido con los antecedentes exactos, archivos a intervenir, restricciones de arquitectura y pasos de verificación que debe cumplir antes de reportar el resultado.

---

### 7. Cero Coexistencia de Paradigmas: Reemplazo Radical, Nunca Modos Paralelos Duplicados
> [!IMPORTANT]
> **PROHIBIDO CONSTRUIR DOS FORMAS DE HACER LAS COSAS A MENOS QUE EL USUARIO LO PIDA EXPLÍCITAMENTE**.
> Cuando la arquitectura del sistema evoluciona o migra hacia un nuevo estándar (por ejemplo: de capturas periódicas por intervalos de 15 min hacia streaming y seguimiento en tiempo real):
> 1. **Reemplazo Radical y Definitivo**: El nuevo paradigma reemplaza por completo al anterior. Queda terminantemente prohibido mantener "dos formas paralelas", switchers de alternancia innecesarios ("Modo A vs Modo B") o vistas intermedias redundantes por miedo a romper lo anterior.
> 2. **Depuración de Elementos Obsoletos**: Todo componente que pierda sentido con la nueva arquitectura debe eliminarse de raíz (por ejemplo: el contador/cron regresivo de 15 minutos, las barras de espera de captura y las fases antiguas del ciclo).
> 3. **Fuente Única de Verdad (Single Source of Truth)**: La interfaz y el backend deben ofrecer una experiencia limpia, unificada y coherente con el nuevo paradigma, presentando directamente la sesión en vivo y la analítica en tiempo real.

---

## 🛠️ Resumen de Componentes Técnicos

1. **Captura P2P (Neolink)**:
   - Comunicación UDP con protocolo Baichuan propietario de Reolink para atravesar CGNAT sin IP pública.
2. **Daemon Host (GCP VM `e2-micro`)**:
   - Servicio systemd 24/7 (`camera-catcher.service`) que coordina Neolink, captura de fotogramas e integración con APIs de Google.
3. **Firestore**:
   - `camera_catcher/commands`: Bus de comandos en tiempo real para disparos manuales (`action: "capture"`).
   - `camera_catcher/prompt`: Configuración viva de intervalo de captura y prompt para Gemini.
   - `camera_catcher/photos/photos/<id>`: Metadatos y descripciones analíticas de cada foto.
4. **Firebase Storage**:
   - Bucket que almacena los fotogramas JPEG (`camera_catcher/photos/<id>.jpg`).
5. **Gemini Vision AI (`gemini-flash-latest`)**:
   - Inferencia multimodal sobre el fotograma capturado según el prompt dinámico configurado.
6. **Frontend Web Dashboard (`web/`)**:
   - Vanilla JavaScript y Firebase SDK para monitoreo y control en tiempo real desde navegadores.
