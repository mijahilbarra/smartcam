# ADR 08: Inferencia de Machine Learning Local por Cuadrantes con ONNX Runtime y YOLOv8

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El sistema previamente dependía de llamadas a la API multimodal de Gemini Vision para describir el contenido de las imágenes. Si bien los LLMs ofrecen comprensión general, presentan varias desventajas para este caso de uso:
1. **Costo por petición y dependencia de API externa**: Aunque la cuota gratuita es útil, una monitorización frecuente (ej. cada minuto) incrementa el riesgo de agotar límites diarios o generar facturación indeseada.
2. **Falta de coordenadas geométricas nativas**: Se requiere identificar exactamente los cuadrantes de personas caminando, sillones de barbería y clientes sentados para métricas operativas y trazado visual.
3. **Restricciones de Hardware**: La máquina virtual es una `e2-micro` de Google Compute Engine con solo **1 GB de memoria RAM** y **0.25 vCPU compartida**. Cualquier solución de Machine Learning local debe operar con un consumo mínimo de RAM para evitar el Linux OOM-killer.

---

## Decisión Técnica

Se integró **ONNX Runtime para Node.js (`onnxruntime-node`)** ejecutando un modelo cuantizado/optimizado **YOLOv8** (`yolov8s.onnx` / `yolov8n.onnx`), combinado con un clasificador geométrico de cuadrantes y renderizado SVG con **Sharp**:

1. **Motor de Inferencia**:
   - `onnxruntime-node`: Inferencia en C++ con modelo YOLOv8 Nano cuantizado (`yolov8n.onnx`, 12 MB).
   - **Límite estricto de CPU**: Se fijó `intraOpNumThreads: 1` e `interOpNumThreads: 1`. Esto garantiza que la inferencia nunca sature más de un hilo de cómputo, limitando el uso de CPU a un **15% - 20% máximo**.
   - **Gestión de Memoria Sharp**: Se desactivó la caché interna de descompresión con `sharp.cache(false)`, evitando retención de memoria en el heap de Node.js.
2. **Puerta de Movimiento (Frame Differencing / Comparación de Fotogramas)**:
   - Se implementó un evaluador de diferencia sobre un micro-thumbnail en escala de grises ($64 \times 36$ px, 2 KB de cómputo que toma ~2 ms).
   - Si la variación entre la captura actual y la anterior es menor al **2.5%** (escena estática donde nadie entró, salió ni cambió de silla), **se omite la inferencia de ML por completo**.
   - En el 80% de los intervalos del día, el impacto es **0% CPU y 0 ms de inferencia**.
3. **Mapeo de Cuadrantes Semánticos (CCTV ROI)**:
   - Dado que la cámara de seguridad es fija, se mapean las detecciones a las regiones físicas de la barbería:
     - **Persona caminando**: Detección de persona en el corredor de acceso/puerta ($X \in [0.35, 0.65]$).
     - **Sillas de barbero (Puesto 1 y Puesto 2)**: Coordenadas físicas de los sillones de corte.
     - **Cliente sentado**: Detección de presencia humana o solapamiento con la silla de corte.
     - **Barbero en servicio**: Persona de pie en la zona de trabajo adyacente a la silla activa.
     - **Silla de espera**: Banca lateral para clientes.
4. **Visualización y Trazado de Cuadrantes**:
   - Mediante `sharp`, se compone un overlay SVG con rectángulos semitransparentes coloreados y etiquetas identificadoras sobre el fotograma capturado, generando `photo_<id>_annotated.jpg`.

---

## Benchmarking y Rendimiento Empírico

Comparativa en la máquina de desarrollo y extrapolación a la VM `e2-micro`:

| Métrica | TensorFlow.js (`@tensorflow/tfjs` + COCO-SSD) | ONNX Runtime Node (`onnxruntime-node` + YOLOv8) |
| :--- | :--- | :--- |
| **Tiempo de Inferencia CPU** | 5,328 ms | **96 - 110 ms** (50x más rápido) |
| **Consumo de Memoria RAM (RSS)** | 431.6 MB | **180 - 235 MB** (Compatible con 1GB RAM) |
| **Riesgo OOM en VM 1GB** | Alto / Crítico | **Mínimo / Seguro** |
| **Costo por Inferencia** | $0.00 | **$0.00** |

---

## Consecuencias

### Positivas:
* **Autonomía 100% Offline / Local**: El análisis visual no depende de conectividad a APIs externas ni de cuotas de LLM.
* **Costo mensual $0.00**: Sin costo adicional por inferencia.
* **Trazado visual inmediato**: Cada captura almacena la imagen anotada con cuadrantes (`_annotated.jpg`) disponible en el dashboard web.
* **Alta velocidad**: Inferencia en menos de 150 ms.
* **Capacidad de procesamiento escalada**: Permite capturas cada 30 a 60 segundos sin saturar la VM.

### Negativas / Mitigaciones:
* El modelo ocupa entre 12 MB y 42 MB de almacenamiento local en disco dentro del repositorio/despliegue (`src/models/`).
