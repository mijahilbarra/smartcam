# ADR 01: Protocolo P2P de Reolink y Motor Neolink

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

La cámara instalada en la barbería es una **Reolink E321 (3MP)** con UID `9527000K49FGY65H`. La conexión de internet en el local la provee Movistar Perú, la cual asigna direcciones IP bajo **CGNAT residencial (Carrier-Grade NAT, rango `100.64.0.0/10`)**:
* No es posible abrir puertos (Port Forwarding / NAT) en el router del local.
* No existe IP pública fija ni accesible directamente desde internet.
* La cámara utiliza un protocolo propietario de señalización y transmisión sobre UDP denominado **Baichuan P2P**, comunicándose con servidores de relevo (relay) para establecer el emparejamiento con aplicaciones externas.
* A diferencia de cámaras industriales con API ONVIF/HTTP expuesta, la Reolink E321 no responde a comandos HTTP de captura estática (`/cgi-bin/api.cgi?cmd=Snap`) a través de la red WAN; únicamente emite paquetes de video continuo comprimido en formato H.264.

---

## Decisión Técnica

Se adoptó **Neolink** (`quantumentangledandy/neolink:latest`), una implementación de código abierto escrita en **Rust** especializada en el protocolo Baichuan de Reolink:

1. **Modo Servidor RTSP Dual-Stream Permanente (`neolink rtsp`)**:
   En el contenedor daemon de producción (`neolink-daemon`), se configura `neolink.toml` con exposición dual:
   ```toml
   stream = "both"
   ```
   Neolink publica localmente en el puerto `8554` ambos flujos de video:
   - `rtsp://127.0.0.1:8554/barberia/sub`: Flujo ligero continuo en 640×360 @ 10 fps para YOLO, telemetría SSE y grabación en Drive.
   - `rtsp://127.0.0.1:8554/barberia/main`: Flujo nativo en 2304×1296 @ 15 fps negociado reactivamente bajo demanda para biometría facial en sillas de corte.
2. **P2P Handshake & UDP Punching**:
   Neolink negocia con los servidores P2P de Reolink, resuelve la IP y puerto efímero de la cámara en Movistar, e intercambia tokens de sesión criptográficos.
3. **Eficiencia de Ancho de Banda On-Demand**:
   Aunque Neolink expone ambos streams, el servidor interno de GStreamer solo solicita el flujo pesado `main` a la cámara física cuando un cliente local conecta a su socket RTSP (`acquireClearFrame`), manteniendo el consumo en reposo al nivel de `subStream` (<0.5 Mbps).
4. **Empaquetado y Auto-Recuperación en Docker**:
   Se ejecuta como contenedor persistente (`docker run -d --name neolink-daemon --restart always -v /opt/camera-catcher/neolink.toml:/etc/neolink.toml -p 8554:8554 quantumentangledandy/neolink:latest neolink rtsp -c /etc/neolink.toml`). Cuenta con auto-recuperación gestionada por el daemon (`onEnsureRtspSource`) si se detecta apagado.

---

## Consecuencias

### Positivas:
* Conexión confiable a través del CGNAT de Movistar sin requerir VPN ni IP pública en la barbería.
* Disponibilidad dual instantánea: streaming ligero constante a 10 FPS e instantáneas HD de 3MP (2304×1296) bajo demanda en ~1.4 segundos.
* Cero dependencias nativas complejas en el host gracias a la encapsulación en Docker.

### Negativas / Restricciones:
* Requiere un sistema operativo con soporte de red UDP nativo (por lo cual no puede correr en entornos serverless con NAT estricto como Cloud Functions).
