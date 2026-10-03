# Registro de Decisiones de Arquitectura (ADRs) - IOT Camera Catcher

Este directorio documenta de manera viva, estricta y transparente todas las decisiones técnicas, herramientas, servicios y componentes que conforman el sistema **IOT Camera Catcher**.

---

## Regla de Oro y Mantenimiento del Stack

> [!IMPORTANT]
> **POLÍTICA DE ACTUALIZACIÓN PERMANENTE**:
> 1. Toda tecnología actualmente en uso en el sistema **DEBE** tener su archivo de decisión técnica en este directorio (`agent/decisions/`).
> 2. Si alguna tecnología es reemplazada, descartada o descontinuada, **su archivo debe ser eliminado de las decisiones activas** y su análisis debe incorporarse de inmediato en [removed.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/removed.md), explicando detalladamente por qué se descartó, qué problemas presentó y cuál fue la solución adoptada.
> 3. Ningún componente nuevo debe incorporarse al código sin su respectiva documentación en este índice.

---

## Diagrama de Arquitectura Global

```mermaid
flowchart TB
    subgraph Edge ["📍 Ubicación Remota (Barbería)"]
        CAM["📷 Cámara Reolink E321<br/>UID: 9527000K49FGY65H"]
        CGNAT["🌐 ISP Movistar Perú<br/>(CGNAT 100.85.35.177)"]
        CAM -->|Flujo H.264 comprimido| CGNAT
    end

    subgraph GCP ["☁️ Google Cloud Platform (Proyecto: skip-bigotes)"]
        subgraph VM ["🖥️ Compute Engine e2-micro (us-central1-a) - Free Tier ($0)"]
            DAEMON["⚙️ Node.js Daemon (camera-catcher.service)<br/>Systemd 24/7"]
            DOCKER["🐳 Neolink Docker Engine<br/>quantumentangledandy/neolink:latest"]
            SCHEDULER["⏱️ Dynamic Cron Scheduler<br/>(Intervalo Firestore)"]
            LISTENER["📡 Real-time Firestore Listener<br/>(camera_catcher/commands)"]

            SCHEDULER -->|Tick de captura| DOCKER
            LISTENER -->|Disparo manual| DOCKER
            DOCKER <-->|P2P Baichuan UDP Relay| CGNAT
        end

        subgraph FirebaseServices ["🔥 Servicios Firebase & Google APIs"]
            FS_CMD["📄 Firestore: camera_catcher/commands"]
            FS_CFG["⚙️ Firestore: camera_catcher/prompt<br/>(prompt + intervalMinutes)"]
            FS_PHOTOS["🗄️ Firestore: camera_catcher/photos/photos/<doc>"]
            STORAGE["📦 Firebase Storage<br/>(skip-bigotes.firebasestorage.app)"]
            GEMINI["🧠 Gemini Vision API<br/>(gemini-flash-latest)"]
            HOSTING["🌐 Firebase Hosting CDN<br/>(camera-catcher-bigotes.web.app)"]
        end

        DAEMON -->|Sube imagen JPEG| STORAGE
        DAEMON -->|Lee prompt dinámico| FS_CFG
        FS_CFG -->|Sincroniza intervalo en vivo| SCHEDULER
        DAEMON -->|Envía Base64| GEMINI
        GEMINI -->|Retorna descripción| DAEMON
        DAEMON -->|Guarda metadata y análisis| FS_PHOTOS
        FS_CMD -->|WebSocket push| LISTENER
    end

    subgraph Clients ["👥 Clientes / Usuarios"]
        BROWSER["💻 Panel Web Dashboard<br/>(Cualquier dispositivo)"]
        BROWSER <-->|Lee y actualiza prompt/intervalo| FS_CFG
        BROWSER -->|Dispara 'Capturar Ahora'| FS_CMD
        FS_PHOTOS -->|onSnapshot en tiempo real| BROWSER
        STORAGE -->|getDownloadURL / CDN| BROWSER
        HOSTING -->|Sirve assets HTML/JS/CSS| BROWSER
    end
```

---

## Diagrama de Flujo de Datos

```mermaid
sequenceDiagram
    autonumber
    actor Usuario as 👤 Usuario (Web Dashboard)
    participant Hosting as 🌐 Firebase Hosting
    participant Firestore as 🗄️ Firestore
    participant VM as 🖥️ Daemon VM (e2-micro)
    participant Cam as 📷 Cámara Reolink (CGNAT)
    participant Storage as 📦 Firebase Storage
    participant Gemini as 🧠 Gemini Vision AI

    rect rgb(240, 248, 255)
        note over Usuario,Firestore: Flujo A: Configuración en Vivo
        Usuario->>Firestore: Guarda nuevo prompt e intervalo (ej: 0.5 min) en camera_catcher/prompt
        Firestore-->>VM: Evento onSnapshot (cambio de intervalo)
        VM->>VM: Reinicia temporizador local a 30 segundos inmediatamente
    end

    rect rgb(255, 250, 240)
        note over Usuario,Firestore: Flujo B: Disparo Manual ("Capturar Ahora")
        Usuario->>Firestore: Escribe comando { action: "capture" } en camera_catcher/commands
        Firestore-->>VM: Push en tiempo real por WebSocket (< 100ms)
    end

    rect rgb(245, 255, 245)
        note over VM,Gemini: Flujo C: Ciclo de Captura y Análisis
        VM->>Cam: Negociación P2P UDP Baichuan
        Cam-->>VM: Transmisión de stream H.264
        VM->>VM: Decodifica keyframe a JPEG (snap.jpeg)
        VM->>Storage: Sube fotograma a camera_catcher/photos/<id>.jpg
        VM->>Firestore: Lee prompt dinámico actual
        VM->>Gemini: POST generateContent (Prompt + Base64)
        Gemini-->>VM: Respuesta visual detallada del entorno
        VM->>Firestore: Registra documento en camera_catcher/photos/photos/<id>
        Firestore-->>Usuario: onSnapshot dispara actualización en la tabla del navegador
        Usuario->>Storage: Descarga miniatura HD vía CDN
    end
```

---

## Índice de Tecnologías Activas

| Módulo | Tecnología / Herramienta | Rol en la Arquitectura | Archivo de Decisión |
| :--- | :--- | :--- | :---: |
| **P2P Protocol** | Neolink (Rust) | Conexión UDP P2P con protocolo Baichuan y extracción H.264 | [01-reolink-p2p-neolink.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/01-reolink-p2p-neolink.md) |
| **Cómputo 24/7** | GCP Compute Engine `e2-micro` | VM Linux gratuita (Free Tier $0) con stack de red UDP nativo | [02-gcp-compute-engine-e2-micro.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/02-gcp-compute-engine-e2-micro.md) |
| **Base de Datos & Bus** | Cloud Firestore | Base NoSQL, bus de comandos en tiempo real y configuración dinámica | [03-firebase-firestore.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/03-firebase-firestore.md) |
| **Media Storage** | Firebase Storage (GCS) | Almacenamiento seguro de imágenes y distribución CDN de miniaturas | [04-firebase-storage.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/04-firebase-storage.md) |
| **Inteligencia Visual** | Google Gemini Vision API | Análisis contextual y descripción visual de fotogramas de la barbería | [05-gemini-vision-ai.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/05-gemini-vision-ai.md) |
| **Detección Local & Cuadrantes** | ONNX Runtime Node + YOLOv8 | Detección de objetos, clientes, sillas y personas en cuadrantes locales ($0) | [08-local-ml-onnx-quadrants.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/08-local-ml-onnx-quadrants.md) |
| **Frontend Web** | Firebase Hosting + Vanilla JS | Dashboard reactivo en tiempo real sin backend server-rendered | [06-firebase-hosting-web-dashboard.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/06-firebase-hosting-web-dashboard.md) |
| **CI/CD Automatizado** | GitHub Actions | Despliegue continuo selectivo por carpetas hacia GCP VM y Hosting | [07-github-actions-cicd.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/07-github-actions-cicd.md) |
| **Monitoreo de Costos & Cuotas** | Calculador Reactivo Vanilla JS | Supervisión preventiva de cuotas GCP Free Tier y simulador de intervalos | [09-google-cloud-cost-monitoring.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/09-google-cloud-cost-monitoring.md) |

---

## Tecnologías Descartadas y Registro de Eliminaciones

Para conocer las tecnologías que fueron evaluadas, probadas y posteriormente descartadas (como Cloud Functions serverless, decodificadores en JavaScript puro, sockets UDP en navegadores y puertos HTTP públicos), consulta el archivo histórico:
👉 **[removed.md](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/removed.md)**
