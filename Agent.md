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
  * [`agent/decisions/01-...md` a `07-...md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions): Fichas individuales de cada tecnología activa en producción.
  * [`agent/decisions/removed.md`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/removed.md): Registro histórico de tecnologías descartadas o reemplazadas.
  * `agent/decision`: Enlace simbólico (symlink) que apunta a `decisions/`.

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

> [!NOTE]
> Modificar archivos de documentación no dispara pipelines de despliegue, protegiendo los recursos de cómputo y minutos de CI/CD.

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
