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

---

## 5. TensorFlow.js (`@tensorflow/tfjs` + COCO-SSD) para Detección Local en la VM

### ¿Qué se intentó?
Utilizar TensorFlow para JavaScript (`@tensorflow/tfjs` y el modelo `@tensorflow-models/coco-ssd` con MobileNet v2) para ejecutar inferencia de detección de personas y objetos directamente en el daemon de Node.js.

### ¿Por qué se descartó?
1. **Consumo Crítico de Memoria en la VM `e2-micro`**:
   * En pruebas empíricas reales sobre la captura de la barbería, `@tensorflow/tfjs` consumió **431.6 MB de memoria RAM (RSS)** para una sola inferencia.
   * La VM cuenta con solo 1.0 GB de RAM total (con ~400 MB ocupados por Ubuntu, systemd y Docker). Sumar 431 MB eleva el consumo a más del 83%, provocando que el kernel de Linux active el **OOM-killer (Out-of-Memory)** y cierre inesperadamente el proceso de Node.js.
2. **Latencia Inaceptable en CPU**:
   * La inferencia en JS puro tardó **5,328 ms (~5.3 segundos)** al 100% de uso de CPU, agotando rápidamente los créditos burstables de la máquina virtual (0.25 vCPU baseline).
   * La alternativa `@tensorflow/tfjs-node` requería binarios nativos de C++ con `libtensorflow` pesados (>150 MB de descarga) con alto riesgo de fallo de compilación o incompatibilidad de libc.
3. **Baja Precisión en Entorno de Vigilancia Real**:
   * COCO-SSD falló en detectar a la persona en tránsito y al cliente sentado en la silla de barbero (clasificó erróneamente solo el auto exterior y la banca de espera).

### Reemplazo adoptado:
Se adoptó **ONNX Runtime para Node.js (`onnxruntime-node`) con YOLOv8** (ADR 08).
* Inferencia en **96 a 110 ms** (50 veces más veloz).
* Consumo de memoria controlado de **~180-230 MB** (seguro para 1 GB de RAM).
* Mapeo de cuadrantes geométricos (CCTV ROI) con alta sensibilidad para personas, sillas y clientes.

---

## 6. Programador Periódico por Intervalos y Contador Regresivo (SchedulerService / 15-Minute Cron & Countdown)

### ¿Qué se intentó?
Ejecutar capturas fotográficas periódicas mediante un temporizador cron dinámico (`SchedulerService` en `src/services/scheduler_service.js`) configurado cada 15 minutos (o según el campo `intervalMinutes` de Firestore `camera_catcher/prompt`), reportando una cuenta regresiva (`countdown`, `nextCaptureAtIso`) hacia el frontend para sincronizar el próximo ciclo de captura.

### ¿Por qué se retiró?
1. **Evolución Arquitectónica hacia Streaming y Tiempo Real (Agent.md Regla 7)**:
   * El sistema migró de un modelo batch de capturas discretas cada 15 minutos a un **bucle continuo de visión en tiempo real (cada 2.5 segundos)** alimentado directamente desde el fotograma en memoria RAM (`StreamServer` a 0 ms) y transmitido vía SSE directo (`/api/yolo/stream`).
   * Mantener el programador periódico junto al bucle continuo violaba la Regla 7 de Agent.md (*"Cero Coexistencia de Paradigmas: Reemplazo Radical, Nunca Modos Paralelos Duplicados"*).
2. **Obsolescencia del Contador y Estados de Espera**:
   * Al ejecutarse la analítica y el tracking de clientes de forma continua cada 2.5s, las barras de espera de captura, los contadores regresivos de 15 minutos y los campos `nextCaptureAtIso`/`countdown` carecen por completo de propósito en la experiencia de usuario y en el backend.
3. **Desacoplamiento Limpio de Horarios Laborales**:
   * La evaluación de horario laboral (`isWithinWorkingHours`, `workStartTime`, `workEndTime`, `timezone`) se desacopló del cron y se encapsuló limpiamente en `WorkingHoursManager` (`src/core/working_hours.js`), permitiendo al bucle continuo suspenderse automáticamente fuera de jornada laboral sin requerir temporizadores de captura periódica.

### Reemplazo adoptado:
* **Bucle Continuo en Tiempo Real**: Ejecución cada 2.5s (`startRealtimeLoop` en `src/index.js`), con gating de jornada laboral mediante `WorkingHoursManager` en `src/core/working_hours.js`.
* **Depuración Total**: Eliminación radical del archivo `src/services/scheduler_service.js`, pruebas de ticker regresivo obsoletas (`test/test-countdown-ticker.js`), campos `countdown`/`intervalMinutes` de `daemonReporter` y controles del intervalo periódico en el frontend web.

---

## 7. Google Cloud Compute Engine `e2-micro` (Free Tier) como Host de Producción

### ¿Qué se utilizó?
Una máquina virtual `e2-micro` (2 vCPUs compartidas, 1 GB RAM, 20 GB disco `pd-standard`) en la región `us-central1-a` (Iowa) bajo la capa Always Free de Google Cloud para ejecutar el daemon y Neolink 24/7.

### ¿Por qué se retiró / reemplazó?
1. **Cobros Obligatorios de IPv4 Pública ($0.005/hora)**:
   * Google Cloud modificó su política tarifaria comenzando a cobrar por toda dirección IPv4 pública en uso (~$3.60 a $7.20 USD mensuales).
   * La instancia dejó de ser $0.00 real, resultando más costosa que un VPS comercial dedicado con especificaciones superiores.
2. **Cuello de Botella Severo de Memoria RAM (1 GB)**:
   * 1 GB de RAM resultaba insuficiente para ejecutar conjuntamente Ubuntu 22.04, Docker, Neolink, Node.js y los modelos ONNX (YOLOv8 + ArcFace).
   * La memoria se mantenía permanentemente al 85–90% de saturación, forzando el uso de 2 GB de swap en disco, degradando los tiempos de inferencia y aumentando el riesgo de congelamiento del sistema.

### Reemplazo adoptado:
Se migró formalmente hacia **OVHcloud VPS-1 Starter** ($5.35 USD/mes) en el datacenter de Virginia (US-East) ([ADR 02](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/agent/decisions/02-ovhcloud-vps-production-host.md)):
* **4 GB de RAM física** (4× más capacidad), operando con holgura al 6% de memoria sin swap.
* 1 IPv4 pública dedicada incluida sin costo adicional.
* Tráfico no medido (unmetered) y protección Anti-DDoS.
* La máquina virtual de GCP fue apagada y decomisionada para cortar los cargos por IP pública.

