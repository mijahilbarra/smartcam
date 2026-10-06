# 10. Vista en Vivo del Daemon y Telemetría en Tiempo Real

* **Estado:** Aceptado y en producción
* **Fecha:** Octubre 2026
* **Componentes afectados:** `src/daemon_reporter.js`, `src/index.js`, `web/index.html`, `web/app.js`, `web/style.css`

---

## Contexto y Necesidad
El sistema contaba con un backend que corría 24/7 en una VM `e2-micro` de Google Cloud y un panel web que mostraba los registros históricos de fotos una vez completadas. Sin embargo, no existía una forma de observar visualmente **qué estaba haciendo el daemon en tiempo real durante cada ciclo**:
1. ¿Cuánto tiempo falta para la siguiente consulta programada?
2. ¿Cuándo se activa la conexión P2P con la cámara Reolink?
3. ¿Llegó la imagen base y cómo se proyectan los cuadrantes físicos (ROI)?
4. ¿Detectó el modelo YOLOv8 humanos en la escena?
5. ¿Quiénes son las personas detectadas (Barbero/Staff vs. Clientes frecuentes vs. Nuevos)?

El usuario requería una vista completamente descriptiva que notificara cada proceso real a Firebase (`camera_catcher/daemon_state`) e imprimiera progresivamente el flujo sobre un **Canvas HTML5**.

---

## Decisión de Arquitectura
1. **Módulo Centralizado de Telemetría (`src/daemon_reporter.js`)**:
   - Implementa una máquina de estados para el pipeline de visión:
     - `idle`: Estado base con evaluación de horario laboral activo (`workingHours`).
     - `querying_camera`: Activación de consulta P2P Reolink o frame en memoria.
     - `image_received`: Entrega inmediata de metadatos de fotograma base al Canvas.
     - `quadrants_active`: Activación y dibujo de zonas ROI (sillas, puestos, entrada).
     - `detecting_humans`: Inferencia YOLOv8: resultado explícito de si hay humanos o no con cajas delimitadoras.
     - `identifying_people`: Inferencia biométrica ArcFace: clasificación de Barbero, Clientes frecuentes y Nuevos.
     - `completed`: Persistencia del documento de foto (modo manual) o reporte en tiempo real.
   - Transmite efímeramente hacia el frontend vía SSE directo (`/api/yolo/stream`, evento `daemon_state`).
   - Mantiene un buffer circular con los últimos 30 eventos para la terminal descriptiva.

2. **Renderizado en Canvas HTML5 Dinámico (`DaemonCanvasRenderer`)**:
   - La vista web dibuja el fotograma a alta resolución y superpone capas configurables:
     - Capa de Cuadrantes: polígonos/rectángulos translúcidos con etiquetas de ocupación.
     - Capa de Humanos: cajas fluorescentes con indicador explícito cuando no hay presencia humana.
     - Capa de Biometría: insignias doradas para Barberos, cian para Clientes Frecuentes (con conteo de visitas) y verde para Nuevos.

3. **Pestañas de Navegación en la Interfaz**:
   - Pestaña 1: **📡 Monitor en Vivo del Daemon** (por defecto).
   - Pestaña 2: **🖼️ Historial y Métricas**.

---

## Consecuencias y Beneficios
* **Transparencia total**: Visibilidad total e inmediata del ciclo de captura y ML sin necesidad de conectarse por SSH a la VM ni consultar logs en `/tmp/camera-catcher.log`.
* **Cero costo de base de datos ($0.00)**: La telemetría se transmite efímeramente en memoria vía SSE directo hacia los clientes conectados, sin generar escrituras continuas ni consumir cuota en Firestore.
* **Experiencia de usuario enriquecida**: Interfaz intuitiva con transmisión directa por SSE, pipeline visual animado sobre Canvas y bitácora en tiempo real.
