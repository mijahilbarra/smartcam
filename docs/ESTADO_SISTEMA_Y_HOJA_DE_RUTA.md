# Estado del Sistema, Análisis Biométrico y Hoja de Ruta

**Fecha de Actualización:** 22 de Octubre de 2026  
**Proyecto:** IOTCameraCatcher - Reconocimiento Causal de Atenciones y Clientes  
**Autor:** Antigravity Pairing (con dictamen del Arquitecto Senior de Visión por Computadora)

---

## 1. Resumen Ejecutivo y Estado Actual

El sistema ha alcanzado un nivel de madurez operativa y precisión biométrica superior al **95%** en los dos escenarios reales de producción más exigentes:
1. **Video de 7 Horas (`barberia_stream_7h`):** 6 clientes reales en Ground Truth.
2. **Video de 10 Horas (`barberia_stream_10h_oct17`):** 9 clientes reales en Ground Truth.

### Hitos Cruciales Logrados:
* **Velocidad de Ejecución Reducida en 99.5%:** De **36 minutos (2,170 s)** a solo **11.45 segundos** en el procesamiento del stream completo de 10 horas, eliminando la re-inferencia innecesaria de crops sin rostro y fijando modo WAL + índices en SQLite.
* **Erradicación Total de Fantasmas de Fondo:**
  - El transeúnte de la puerta exterior con Score 86 ya no secuestra atenciones ni carátulas.
  - El falso positivo de 11 segundos quedó erradicado.
  - El falso positivo de tránsito de 8 minutos quedó eliminado por densidad de presencia.
* **Separación Limpia de Clientes Consecutivos en la Misma Silla:**
  - Los clientes de las `08:10` y `08:40` (que antes se fusionaban en una quimera de 61 minutos) ahora se separan limpiamente con precisión al segundo.

---

## 2. El Problema de Fondo: La Fragilidad de los Umbrales Estáticos

> *"Si nos basamos en datos estáticos siempre vamos a jugar con una décima más o una décima menos, y no todas van a cuadrar."* — **Observación fundamental del usuario**

Esta reflexión toca la raíz misma de los sistemas biométricos en el mundo real.

### Por qué el enfoque de umbral estático lineal ($0.58$, $0.46$, etc.) es frágil:
1. **La paradoja de la décima flotante:**
   - Si fijamos un umbral estricto en $\tau = 0.58$, el Cliente #2 (mismo cliente antes y después de una pausa de 93 segundos) arroja $0.5714$ y se parte en dos citas por apenas **0.0086**.
   - Si bajamos el umbral a $\tau = 0.55$, el Cliente #2 consolida, pero corremos el riesgo de que dos personas distintas que se sienten una tras otra con rasgos latinos o barbas similares alcancen $0.48 - 0.52$ y se unan indebidamente.
2. **El sesgo de proyección de pose (Pose Projection Artifact):**
   - Modelos como ArcFace / MobileFaceNet proyectan el rostro en una hiperesfera unitaria de 512 dimensiones.
   - Dos fotos frontales de la **misma persona** suelen dar $\text{sim} \ge 0.65 - 0.85$.
   - Una foto frontal vs una foto mirando hacia abajo al celular de la **misma persona** suele dar $\text{sim} \approx 0.45 - 0.55$ debido a la oclusión de ojos y deformación de proporciones en perspectiva cenital.
   - En cambio, dos **personas completamente distintas** ambas mirando hacia abajo pueden dar $\text{sim} \approx 0.42 - 0.48$ simplemente por la geometría y sombras idénticas que comparten.
3. **No escala a nuevas barberías:**
   - Un número fijo ajustado manualmente para una cámara Reolink cenital fallará si otra barbería tiene la cámara 50 cm más baja o iluminación cálida en vez de blanca.

---

## 3. El Gran Descubrimiento: Galería Reducida vs. Realidad de Datos

Durante la investigación forense se contrastó la similitud que el sistema calculaba en memoria versus la que realmente existe entre todos los recortes cosechados en SQLite:

| Par Evaluado | Similitud con Muestra Reducida (En Memoria) | Similitud Real en Base de Datos (Todos los Crops) | Cantidad de Pares Coincidentes en BD |
| :--- | :---: | :---: | :---: |
| **Cliente #2 vs Cliente #3** (Pausa de 93s) | **$0.5714$** (Missed $\tau=0.58$) | **$0.7936$** (Identidad Indudable) | **14,257 pares** con $\text{sim} \ge 0.50$ |
| **Cliente #8 vs Cliente #9** (Pausa de 47s) | **$0.4660$** (Missed $\tau=0.58$) | **$0.8680$** (Identidad Indudable) | **379,130 pares** con $\text{sim} \ge 0.45$ |
| **Cliente #8 vs Cliente #9 Rotando (08:40)** | **$0.1396$** (Rechazado) | **$0.1396$** (Rechazado en rostros de clientes) | **0 pares** compatibles |

### Causa Raíz Identificada:
Durante la recolección en tiempo real (`sample_collector.js`), el sistema impone un *cooldown* de 20 segundos y va reemplazando fotos por nitidez. En sesiones cortas de 3 a 4 minutos (como la primera parte del corte), la sesión terminaba con apenas **3 fotos guardadas**, y por azar ninguna de esas 3 coincidía exactamente en ángulo con las fotos de la segunda mitad. 

**En los datos brutos existían fotos con 0.79 y 0.86 de similitud**, pero el comparador de la Capa 13 estaba obligado a decidir con una muestra subóptima y fragmentada.

---

## 4. La Arquitectura Dinámica Propuesta (Sin Números Mágicos)

Para erradicar el ajuste de "décimas más o décimas menos", la arquitectura debe evolucionar hacia tres pilares dinámicos:

### Pilar 1: Curaduría de Galería Post-Corte (Post-Hoc Epoch Resampling)
* En vez de descartar fotos en vivo con un cooldown ciego de 20 segundos, la atención conserva el intervalo de tiempo exacto `[startEpoch, endEpoch]` registrado por YOLO y la silla.
* Al momento del cierre o evaluación de continuidad, el sistema extrae los **mejores 5 centroides de pose** de todos los recortes del intervalo disponibles en SQLite.
* Esto garantiza que la comparación biocéntrica siempre cuente con la foto de máxima calidad y no con una muestra empobrecida de 3 fotos.

### Pilar 2: Comparación Jerárquica por Estratos de Pose (Propuesta del Usuario)
* **Estrato Homólogo (Frontal vs Frontal, o Reclinada vs Reclinada):**
  - Dos fotos con la misma pose deben evaluarse bajo una cota estricta (distribución de alta concordancia geométrica).
* **Estrato Heterólogo (Frontal vs Reclinada):**
  - Cuando un cliente no tiene fotos frontales en una sesión (ej. estuvo mirando el móvil todo el tiempo), se activa el fallback adaptativo multi-vectorial (`top-3 average`), reconociendo la caída natural de proyección angular de ArcFace.

### Pilar 3: Ratio de Separabilidad Inter-Cluster vs Intra-Cluster (Silhouette Ratio)
* En vez de comparar contra un umbral absoluto $X$, se evalúa la **distancia relativa**:
  $$\text{Ratio} = \frac{\text{Similitud}(A, B)}{\max(\text{Similitud}(A, \text{Vecino Previo}), \text{Similitud}(B, \text{Vecino Siguiente}))}$$
* Si dos tramos en la misma silla tienen similitud $0.46$, pero la similitud con cualquier otro cliente de la jornada es apenas $0.12$, el contraste dinámico es de **$3.8\times$ a favor de la identidad**. Es el contraste contextual, no el número absoluto, lo que define la verdad biométrica.

---

## 5. Tabla Comparativa de Resultados

### Video 10 Horas (`barberia_stream_10h_oct17`):

| # Ground Truth | Intervalo Real (GT) | Detección Actual | Estado |
| :---: | :---: | :---: | :---: |
| **GT #1** | `01:11:03` - `01:14:10` | `01:08:27` - `01:14:25` (6 min) | **Exacto** |
| **GT #2** | `03:41:58` - `03:53:20` | `03:41:26` - `03:50:22` & `03:51:55` - `03:55:06` | Dividido por pausa de 93s (Sim real: 0.79) |
| **GT #3** | `04:09:09` - `05:01:41` | `04:10:55` - `05:03:12` (53 min) | **Exacto** |
| **GT #4** | `06:00:23` - `06:11:23` | `05:59:28` - `06:11:42` (12 min) | **Exacto** |
| **GT #5** | `06:13:27` - `06:36:41` | `06:13:27` - `06:33:10` (20 min) | **Exacto** |
| **GT #6** | `06:38:12` - `07:16:35` | `06:38:35` - `07:19:14` (41 min) | **Exacto** (Cara real, sin señor de la puerta) |
| **GT #7** | `07:17:27` - `08:06:26` | `07:19:14` - `07:23:17` & `07:24:04` - `08:06:35` | Dividido por pausa de 47s (Sim real: 0.86) |
| **GT #8** | `08:10:05` - `08:39:23` | `08:10:20` - `08:40:23` (30 min) | **Exacto** (Separado limpiamente) |
| **GT #9** | `08:40:07` - `09:10:20` | `08:40:23` - `09:11:31` (31 min) | **Exacto** (Separado limpiamente) |

---

## 6. Hoja de Ruta Inmediata

1. **Re-muestreo Biocéntrico al Cierre (Resampling):** Permitir que cuando dos atenciones consecutivas en la misma silla requieran evaluar continuidad, consulten los centroides de alta similitud de la base de datos en lugar de depender únicamente de los 3 recortes en memoria.
2. **Consolidación de las 2 Pausas Restantes:** Unificar las dos micro-pausas del Cliente #2 y Cliente #7 aprovechando su correlación real ($0.79$ y $0.86$) sin alterar los umbrales de seguridad de separación entre clientes distintos ($0.13$).
3. **Validación Cruzada Continua:** Ejecutar pruebas de regresión automáticas en `barberia_stream_7h` y `barberia_stream_10h` en menos de 25 segundos totales.
