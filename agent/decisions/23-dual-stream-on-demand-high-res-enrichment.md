# ADR 23: Arquitectura Dual-Stream Híbrida y Enriquecimiento Facial en Alta Resolución Bajo Demanda

## Estado
**Aceptado** — Implementado y verificado en producción (02 de Noviembre, 2026).

---

## Contexto y Problema
En el flujo continuo de monitoreo y reidentificación biométrica en la barbería:
1. **Limitación de Resolución en SubStream (640×360)**:
   - Mantener el flujo ligero a 640×360 es óptimo para la detección YOLO (que de todas formas reescala internamente a 640×640) y para la emisión de video MJPEG / SSE al panel web con baja latencia y consumo de red mínimo (<500 Kbps).
   - Sin embargo, para personas sentadas en las sillas de corte al fondo del local, el recorte corporal completo mide aproximadamente $80 \times 120$ px en 640×360.
   - El detector facial (SCRFD) y extractor de embeddings (ArcFace) requieren un mínimo de $48 \times 48$ px (`face_quality_service.js`) y preferiblemente $>75 \times 75$ px para extraer vectores biométricos nítidos. En el stream de baja definición, estos recortes arrojaban caras de apenas $\approx 22 \times 22$ px, siendo sistemáticamente rechazados por la regla `face_too_small`.
2. **Inviabilidad de Ingesta Continua en MainStream (2304×1296)**:
   - Decodificar continuamente 2304×1296 @ 15 fps mediante FFmpeg saturaría la CPU (múltiples núcleos al 80-90%) y aumentaría la latencia de procesamiento por cuadro de ~180ms a >1.2s.
   - Además, la cámara Reolink E321 sobre P2P Baichuan sufriría pérdidas de paquetes UDP si se le exige transmitir 2304×1296 de forma continua e ininterrumpida.

---

## Decisión de Arquitectura: Modelo Híbrido Reactivo

Adoptamos una arquitectura **dual-stream asimétrica**:

```mermaid
flowchart TD
    CAM["📷 Reolink E321"] -->|P2P Baichuan| NEO["🐳 Neolink Daemon (stream = 'both')"]
    
    subgraph StreamContinuo ["Flujo Continuo (Bajo Costo / 0.5 Mbps)"]
        NEO -->|RTSP /barberia/sub (640x360 @ 10fps)| INGEST["⚡ Ingesta MJPEG & YOLO Detection"]
        INGEST --> TRACK["🧭 Multi-Person Tracking (ByteTrack)"]
        INGEST --> WEB["💻 Web Dashboard & SSE Telemetry"]
    end

    subgraph EnriquecimientoReactivo ["Enriquecimiento Bajo Demanda (MainStream)"]
        TRACK -->|Persona se sienta en Silla| EVAL{"¿Silla de corte y carece de rostro nítido?"}
        EVAL -->|Sí & Fuera de Cooldown (20s)| ACQUIRE["📸 acquireClearFrame()<br/>RTSP /barberia/main (2304x1296)"]
        ACQUIRE --> RESCALE["📐 Reescalado de Coordenadas (scaleX: 3.6x, scaleY: 3.6x)"]
        RESCALE --> SHARP["✂️ Sharp High-Res Crop (95% JPEG Quality)"]
        SHARP --> FACE["🧠 SCRFD Landmarks + ArcFace Re-identificación"]
        EVAL -->|No o Cooldown Activo| SKIP["⏭️ Continuar con recorte estándar"]
    end
```

### 1. Configuración de Neolink (`neolink.toml`)
Se activa la exposición simultánea:
```toml
stream = "both"
```
Neolink expone:
- `rtsp://127.0.0.1:8554/barberia/sub` (640×360 @ 10 fps)
- `rtsp://127.0.0.1:8554/barberia/main` (2304×1296 @ 15 fps)

Neolink solo negocia el flujo `main` con la cámara física cuando un cliente solicita conexión RTSP, manteniendo el ancho de banda P2P en reposo al nivel de `subStream`.

### 2. Adquisición Segura Bajo Demanda (`src/services/pipeline/clear_stream_step.js`)
- **Timeout Calibrado (`3500ms`)**: El handshake RTSP sobre TCP en P2P requiere ~1.48s para entregar el primer I-frame. Un timeout de 3.5s previene falsos cortes garantizando extracción confiable.
- **Cooldown por Track (`20s`)**: Una vez adquirido un fotograma HD para un track, se congela la solicitud de Clear por 20 segundos para evitar sobrecargar la cámara o el hilo de Node.js.
- **Terminación de Procesos Zombie (`neolink_client.js`)**: Si la captura excede el tiempo límite, se invoca `pkill -9` garantizando que no queden procesos huérfanos de FFmpeg.
- **Reactivación de Escena Estática**: Si el detector rápido omitió el cuadro por variación estática (`skippedDueToNoChange = true`), la llegada de un recorte Clear fuerza `skippedDueToNoChange = false` para procesar de inmediato la biometría.

---

## Consecuencias y Beneficios

### Positivas:
1. **Densidad Facial Multiplicada por 13x**: El rostro de un cliente sentado pasa de $22 \times 22$ px a más de $80 \times 80$ px en el recorte de alta resolución, superando holgadamente los umbrales de nitidez de SCRFD y ArcFace.
2. **Consumo de CPU y RAM Impecable**: La memoria RSS del daemon se mantiene en ~235 MB (6.2% de la RAM del VPS) y la CPU se mantiene casi en 0% durante periodos estáticos.
3. **Latencia Inalterada en Telemetría**: El dashboard web continúa recibiendo telemetría en tiempo real a <150ms desde el stream ligero sin verse afectado por las capturas esporádicas en HD.
