# ADR 17: Túnel HTTPS Seguro para Live Streaming y Telemetría SSE

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El sistema de streaming en vivo y telemetría de ultra-baja latencia (<20ms) opera directamente mediante un servidor HTTP local embebido en el daemon de Node.js (`src/daemon_reporter.js`), escuchando en el puerto TCP `8085`:
- `/api/stream`: Servidor de flujo continuo MJPEG (multipart/x-mixed-replace).
- `/api/yolo/stream`: Flujo unidireccional de Server-Sent Events (SSE) con telemetría geométrica de cajas YOLO, tracks y cuadrantes.

Cuando la aplicación web se ejecuta en **desarrollo local** (`localhost`), el navegador puede comunicarse directamente con `http://localhost:8085`. Sin embargo, al desplegar la aplicación web a **producción** en Firebase Hosting (`https://camera-catcher-bigotes.web.app`):
1. **Bloqueo por Contenido Mixto (Mixed Content)**: Los navegadores modernos bloquean cualquier intento de cargar recursos HTTP no cifrados (`http://<ip-vm>:8085/...`) desde un origen HTTPS seguro.
2. **Ausencia de IP Pública Fija y Puertos Abiertos**: Exponer directamente el puerto 8085 en Google Cloud Compute Engine (`e2-micro`) requeriría abrir reglas de firewall en VPC, reservar IP estática (con costo adicional) y aprovisionar/renovar certificados TLS (Let's Encrypt / Certbot) manualmente en la máquina virtual.
3. **Pérdida de Reactividad**: Si la URL de conexión se quemara en el empaquetado de producción (`Vite build`), cualquier rotación de infraestructura requeriría recompilar y desplegar nuevamente el frontend.

---

## Decisión Técnica

Se implementa la **Opción B: Túnel HTTPS Seguro Gestionado (Cloudflare Tunnel)** combinado con **resolución reactiva en tiempo real en Frontend**:

```mermaid
flowchart LR
    subgraph Browser ["🌐 Navegador (Web Dashboard HTTPS)"]
        UI["Vue 3 SPA<br/>https://camera-catcher-bigotes.web.app"]
        Settings["⚙️ Modal de Ajustes<br/>streamUrl"]
    end

    subgraph CloudflareEdge ["☁️ Red Anycast Cloudflare Edge"]
        EdgeSSL["SSL/TLS Edge Termination<br/>https://stream.tudominio.com"]
    end

    subgraph GCP ["🖥️ GCP VM e2-micro"]
        subgraph TunnelDaemon ["🛡️ Servicio de Túnel"]
            CFD["cloudflared tunnel<br/>camera-tunnel.service (24/7)"]
        end
        subgraph NodeDaemon ["⚙️ Daemon Catcher"]
            STREAM["Servidor HTTP (Puerto 8085)<br/>/api/stream + /api/yolo/stream"]
        end
        CFD <-->|Túnel Saliente Encriptado Quick2 / HTTP2| EdgeSSL
        CFD -->|Proxy Inverso Local 127.0.0.1:8085| STREAM
    end

    subgraph Firebase ["🔥 Firebase Firestore"]
        PROMPT_DOC["camera_catcher/prompt<br/>{ streamUrl: 'https://...' }"]
    end

    Settings -->|Guarda streamUrl| PROMPT_DOC
    PROMPT_DOC -->|onSnapshot en tiempo real| UI
    UI -->|GET /api/stream (MJPEG)| EdgeSSL
    UI -->|EventSource /api/yolo/stream (SSE)| EdgeSSL
```

### 1. Desacoplamiento y Resolución Dinámica de URLs (`environment.js`)
En [`web/src/shared/lib/environment.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/web/src/shared/lib/environment.js), la función `getEnvironmentInfo()` resuelve la URL activa del backend bajo una jerarquía determinista y estricta:
1. `localStorage.getItem('CAMERA_CATCHER_API_URL')`: Configuración explícita del operador en el navegador local.
2. `import.meta.env.VITE_CAMERA_CATCHER_API_URL`: Variable de entorno inyectada durante compilación (CI/CD).
3. Entorno local (`isLocal`): `'http://localhost:8085'`.
4. Servidor cloud sin configuración: `null` (**Prohibido** generar rutas relativas fallidas como `'/api/stream'`).

Se añade la función `setCustomBackendUrl(url)` para persistir y normalizar URLs seguras (eliminando barras finales sobrantes).

### 2. Configuración Viva en Firestore y Sincronización Local (`useSettings.js`)
En [`web/src/features/configure-settings/model/useSettings.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/web/src/features/configure-settings/model/useSettings.js):
- Se añade el campo reactivo `streamUrl = ref('')`.
- Al cargar la configuración desde `camera_catcher/prompt`, se lee `data.streamUrl || ''`.
- Al guardar, se sincroniza en Firestore y se replica en `localStorage` mediante `setCustomBackendUrl`.

### 3. Interfaz de Configuración en `SettingsModal.vue`
En [`web/src/widgets/settings-modal/ui/SettingsModal.vue`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/web/src/widgets/settings-modal/ui/SettingsModal.vue), se incluye un campo intuitivo para la "URL del Túnel del Stream (HTTPS)" con icono de Google Fonts Material Symbols (`link`), badge de estado y explicaciones claras.

### 4. Ciclo de Vida y Reconexión SSE Reactiva en `useDaemonState.js`
En [`web/src/entities/daemon/model/useDaemonState.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/web/src/entities/daemon/model/useDaemonState.js):
- Se suscribe a `camera_catcher/prompt` vía `onSnapshot` para detectar cambios en `streamUrl` instantáneamente.
- Si no existe una URL configurada en la nube, `streamUrl` y `yoloStreamUrl` devuelven estrictamente `null`.
- `connectYoloStream()` verifica la presencia de URL válida antes de instanciar `EventSource`, evitando intentos infinitos y ruidosos de reconexión contra endpoints inexistentes.
- `watch(yoloStreamUrl)` reconecta el flujo SSE inmediatamente cuando el usuario o Firestore actualiza la URL.

### 5. Estado Vacío Informativo en `DaemonLiveMonitor.vue`
En [`web/src/widgets/daemon-monitor/ui/DaemonLiveMonitor.vue`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/web/src/widgets/daemon-monitor/ui/DaemonLiveMonitor.vue):
- Cuando la aplicación se encuentra en producción y no se ha definido un túnel HTTPS, el visor de video reemplaza la pantalla en negro por una tarjeta informativa con el icono `videocam_off`.
- Ofrece el botón interactivo **"Abrir Ajustes"**, permitiendo al usuario configurar el túnel directamente sin fricción.

### 6. Automatización de Instalación en la VM (`setup-cloudflare-tunnel.sh`)
En [`scripts/setup-cloudflare-tunnel.sh`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/scripts/setup-cloudflare-tunnel.sh):
- Script Bash automatizado para Debian/Ubuntu amd64 en la VM `e2-micro`.
- Descarga e instala el binario oficial de `cloudflared`.
- Configura el servicio systemd persistente `/etc/systemd/system/camera-tunnel.service` con reinicio automático (`Restart=always`) y políticas de aislamiento seguro.
- Soporta tanto túneles permanentes de Cloudflare Zero Trust (con token) como túneles efímeros de prueba rápida (`cloudflared tunnel --url http://localhost:8085`).

---

## Consecuencias y Beneficios

### Positivas:
- **Cumplimiento Estricto de Seguridad HTTPS**: Elimina por completo las alertas y bloqueos por *Mixed Content* en Firebase Hosting.
- **Cero Costo Adicional ($0.00)**: Cloudflare Tunnels (Zero Trust) y Cloudflare Quick Tunnels son gratuitos y no requieren IPs estáticas reservadas en GCP.
- **Seguridad Perimetral Sin Puertos Abiertos**: El tráfico hacia la VM GCP es exclusivamente saliente mediante túneles seguros; no se abren puertos TCP en la VPC ni en el firewall.
- **Sincronización Multi-Dispositivo**: Al almacenarse la URL en `camera_catcher/prompt`, todos los navegadores y dispositivos que abran el dashboard reciben la URL del túnel en vivo sin configuración manual repetida.
- **Experiencia de Usuario Transparente**: Indicadores visuales claros en la interfaz cuando el túnel no está configurado, guiando al administrador directamente a la solución.
