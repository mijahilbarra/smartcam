# Registro de Tecnologías Descartadas y Retiradas (Removed Decisions)

Este documento registra formalmente todas las alternativas técnicas, bibliotecas y modelos de infraestructura que fueron evaluados, probados o inicialmente considerados, detallando el motivo técnico exacto por el cual fueron descartados o retirados del sistema **IOT Camera Catcher**.

---

## 1. Firebase Functions & Google Cloud Run (Serverless)

### ¿Qué se intentó?
Ejecutar la captura del fotograma dentro de una función serverless efímera (Node.js o contenedor Docker en Cloud Run/Cloud Functions) para evitar tener un servidor encendido.

### ¿Por qué se descartó?
1. **Incompatibilidad de Red con P2P UDP (*Cloud NAT Packet Drop*)**:
   * La cámara Reolink se encuentra detrás de una conexión residencial Movistar Perú bajo CGNAT (`100.85.35.177`).
   * Para atravesar el CGNAT, el protocolo Baichuan requiere abrir sockets UDP bidireccionales y realizar *hole-punching* recibiendo paquetes en puertos efímeros no solicitados.
   * La infraestructura de red de Google Cloud Serverless (VPC NAT / Cloud NAT) **no mantiene tablas de traducción NAT persistentes para puertos UDP asimétricos y descarta paquetes fragmentados**.
   * Resultado: El handshake P2P fallaba sistemáticamente por *timeout* de red en Cloud Functions y Cloud Run.
2. **Ciclo de vida efímero y *Cold Starts***:
   * Inicializar el contenedor de Neolink en cada invocación fría añadía entre 15 y 25 segundos adicionales de latencia por cada foto.

### Reemplazo adoptado:
Se migró a una máquina virtual **Compute Engine `e2-micro`** (100% gratuita bajo el Free Tier perpetuo de Google Cloud). Al contar con una interfaz de red Linux estándar, soporta sockets UDP bidireccionales completos y resuelve el P2P en 8 segundos.

---

## 2. Decodificación de Video en JavaScript Puro / WebAssembly (Node.js)

### ¿Qué se intentó?
Reescribir el proceso de captura en código puro de Node.js (usando `dgram` para UDP, decodificadores H.264 en WebAssembly como Broadway.js o ffmpeg.wasm, y codificadores JPEG en JS como `jpeg-js`) para eliminar la dependencia de binarios nativos compilados de C/Rust (FFmpeg/GStreamer).

### ¿Por qué se descartó?
1. **Lentitud extrema y consumo de CPU**:
   * La cámara Reolink E321 no soporta comando directo de foto vía P2P; solo emite flujos de video continuo comprimido en H.264.
   * Un fotograma de 3 Megapíxeles (2304×1296) tiene casi 3 millones de píxeles.
   * Decodificar NAL units H.264 en JavaScript/Wasm y calcular la transformada de coseno discreta (DCT) para comprimir a JPEG tomaba entre **35 y 60+ segundos de CPU al 100%**, frente a los **0.3 segundos** que toma en C/Rust con aceleración vectorial.
2. **Consumo de Memoria Excesivo**:
   * Manejar los buffers de fotogramas crudos YUV420p en el garbage collector de V8 requería entre 400 MB y 800 MB de RAM.
3. **El obstáculo de red persistía**:
   * Aunque se usara Node.js puro (`dgram`), la limitación del NAT UDP de Cloud Functions seguía bloqueando el tráfico.

### Reemplazo adoptado:
Uso del motor nativo en Rust de **Neolink** empaquetado en Docker sobre la VM `e2-micro`, logrando la captura en 8-10 segundos con mínimo uso de CPU.

---

## 3. Conexión P2P Directa desde el Navegador Web (Client-Side Wasm)

### ¿Qué se intentó?
Ejecutar la captura directamente desde el navegador del usuario al abrir el panel de control web, utilizando WebAssembly en el cliente para conectarse a la cámara y descargar el fotograma.

### ¿Por qué se descartó?
1. **Restricción de Seguridad del Sandbox Web (No Raw UDP)**:
   * Por razones de seguridad (prevención de amplificación DDoS y escaneo de puertos locales), los navegadores web **tienen terminantemente prohibido abrir sockets UDP arbitrarios**.
   * La API del navegador únicamente permite HTTP, WebSockets (TCP) y WebRTC (que usa UDP, pero solo con señalización ICE/STUN/TURN estándar, no con protocolos binarios propietarios de cámaras como Baichuan).
2. **Dependencia de usuario**:
   * Si la captura ocurriera en el navegador, no habría capturas periódicas automáticas cada 15 minutos cuando nadie tuviese el dashboard abierto.

### Reemplazo adoptado:
El navegador web actúa únicamente como panel de visualización y control. La captura la realiza el daemon en la VM de Google Cloud y se sincroniza al navegador a través de Firestore y Firebase Storage.

---

## 4. Endpoints HTTP Públicos en la VM (Ingress HTTP con Puertos Abiertos)

### ¿Qué se intentó?
Para el botón "Capturar Ahora" de la web, exponer el servidor Express de la VM en el puerto 8085 (o puerto 80/443) hacia el internet público para recibir peticiones POST desde el frontend.

### ¿Por qué se descartó?
1. **Riesgos de Seguridad**:
   * Abrir puertos HTTP públicos en la IP externa de la VM la expone a escaneos automatizados de bots, ataques de fuerza bruta y DDoS.
2. **Complejidad de Certificados SSL y CORS**:
   * Como el dashboard se sirve sobre HTTPS (`https://camera-catcher-bigotes.web.app`), hacer peticiones a una IP HTTP sin certificado SSL provocaría bloqueos de contenido mixto (*Mixed Content Block*) en el navegador.
   * Obligaría a configurar un dominio público, Let's Encrypt y renovaciones automáticas de certificados.

### Reemplazo adoptado:
**Bus de comandos reactivo en Cloud Firestore (`camera_catcher/commands`)**:
* El navegador web escribe `{ action: "capture", requestedAt: Date.now() }` en Firestore.
* La VM escucha ese documento mediante `onSnapshot` por una conexión WebSocket saliente segura.
* Se logra comunicación bidireccional en menos de 100 ms **sin abrir un solo puerto de entrada en el firewall de la VM**.
