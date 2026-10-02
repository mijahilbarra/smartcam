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

1. **Modo de extracción de imagen (`neolink image`)**:
   En lugar de mantener un servidor RTSP perpetuo encendido consumiendo ancho de banda, se utiliza el modo de captura puntual:
   ```bash
   neolink image -c /etc/neolink.toml --use-stream -f /out/snap.jpeg barberia
   ```
2. **P2P Handshake & UDP Punching**:
   Neolink negocia con los servidores P2P de Reolink, resuelve la IP y puerto efímero de la cámara en Movistar, e intercambia tokens de sesión criptográficos.
3. **Bandwidth Efficiency con `--use-stream`**:
   Como la cámara no soporta captura estática pura vía P2P, `--use-stream` instruye a Neolink a solicitar temporalmente el flujo de video H.264, esperar el primer Keyframe (I-frame) completo, decodificarlo a RGB y guardarlo como JPEG, cerrando la conexión de red inmediatamente.
4. **Empaquetado en Docker**:
   Se ejecuta como contenedor efímero (`docker run --rm`) con volumen montado para `neolink.toml` y el directorio temporal `/tmp`. Esto garantiza portabilidad absoluta en cualquier entorno Linux sin problemas de dependencias nativas de GStreamer o Rust.

---

## Consecuencias

### Positivas:
* Conexión confiable a través del CGNAT de Movistar sin requerir VPN ni IP pública en la barbería.
* Captura de alta resolución (3MP / 2304×1296 píxeles) en solo 8 a 12 segundos.
* Cero consumo continuo de datos: el túnel de video se abre únicamente por los segundos que tarda en recibir un fotograma clave.

### Negativas / Restricciones:
* Requiere un sistema operativo con soporte de red UDP nativo (por lo cual no puede correr en entornos serverless con NAT estricto como Cloud Functions).
