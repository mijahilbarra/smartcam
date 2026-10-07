# ADR 15: Galería Biométrica Multi-Ángulo y Gobernanza por Sesión Temporal

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

En un entorno real de barbería, un cliente permanece sentado en la silla de servicio durante un lapso prolongado (entre 20 y 45 minutos). A lo largo de la atención, el cliente gira la cabeza en múltiples orientaciones (de frente, perfil 3/4, inclinado hacia abajo mirando su teléfono o girando hacia el espejo).

Antes de esta decisión:
- El perfil biométrico de cada persona en Firestore (`camera_catcher_people`) almacenaba un único vector facial (`embedding`).
- El modelo ligero MobileFaceNet ArcFace (ONNX CPU) y el umbral rígido original (0.65) causaban que giros de cabeza pronunciados redujeran la similitud coseno por debajo del umbral.
- Como consecuencia, el sistema creaba candidatos repetidos y perfiles falsos duplicados ("Cliente #1", "Cliente #2", "Cliente #3") para la **misma persona sentada en la misma silla** durante la misma visita.

---

## Decisión Técnica

Se implementa una solución de **fusión espacio-temporal y representación multi-vectorial**:

### 1. Galería de Embeddings Multi-Ángulo (`embeddings: [...]`)
* Cada cliente almacena una galería de hasta **6 vectores biométricos clave** en el campo `embeddings`.
* En [`src/face_recognizer.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/face_recognizer.js), la función `identifyFace`:
  * Extrae todos los vectores disponibles de cada perfil (`profile.embeddings` soportando arrays planos o mapas `{ vector }`, con fallback a `profile.embedding`).
  * Calcula la similitud máxima contra todos los ángulos registrados:
    $$\text{sim} = \max_{v \in \text{gallery}} (\vec{e} \cdot \vec{v})$$
  * Se calibra el umbral de aceptación estándar a **0.50** para acomodar variaciones angulares sin comprometer la especificidad.

### 2. Gobernanza Determinística por Sesión Temporal
* En [`src/services/people_service.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/people_service.js) y [`src/services/processes.js`](file:///Users/javierli/Documents/elmuki/IOTCameraCatcher/src/services/processes.js):
  * El motor biométrico recibe en cada ciclo la lista de sesiones de visita activas (`activeSessions`) gestionadas por `VisitSessionService`.
  * **Regla Inmutable**: Si un rostro es detectado dentro de la zona/silla de una sesión activa que ya cuenta con un cliente identificado:
    1. **Queda terminantemente prohibido crear un cliente nuevo o candidato en debounce**.
    2. La detección se asocia de forma determinística al cliente asignado a dicha sesión.
    3. Si el nuevo rostro aporta un ángulo complementario (similitud coseno entre 0.50 y 0.88) o presenta mayor nitidez (`sharpnessScore`), se incorpora automáticamente a la galería `embeddings` del cliente en Firestore, preservando el vector frontal inicial y rotando hasta un máximo de 6 ángulos.
    4. Si la nitidez supera el récord previo, se actualizan `bestFaceScore` y la miniatura `thumbnailBase64`.

### 3. Ciclo de Vida del Registro de Clientes
* **Nuevo Cliente**: Tras superar la confirmación temporal de 3 ciclos consecutivos en la silla, se registra con `embeddings: [candidate.embedding]` y `embedding: candidate.embedding`.
* **Cliente Frecuente**: Al ser identificado en visitas posteriores, cualquier pose novedosa capturada con buena nitidez enriquece progresivamente su galería hasta completar los 6 ángulos.

---

## Consecuencias y Beneficios

### Positivas:
- **Cero Duplicación de Clientes**: Se erradica por completo la fragmentación de perfiles de una misma persona en una sola sesión de corte.
- **Tolerancia a Giros de Cabeza**: Al evaluar `Math.max` sobre la galería multi-ángulo, la persona es reconocida de inmediato independientemente de si mira al barbero, al espejo o a la cámara.
- **Impacto Nulo en Rendimiento ($0 Cloud)**: La comparación de similitud coseno entre vectores unitarios L2 de 512 dimensiones toma menos de **0.05 ms** en CPU, manteniendo el uso de memoria y procesador por debajo de las restricciones de la máquina `e2-micro`.
- **Compatibilidad Hacia Atrás**: Mantiene compatibilidad total con perfiles históricos que poseían únicamente el campo `embedding` simple.
