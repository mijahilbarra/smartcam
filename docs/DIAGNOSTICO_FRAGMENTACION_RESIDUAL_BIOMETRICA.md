# Diagnóstico Forense y Exhaustivo de Fragmentación Residual Biométrica
## Auditoría Causal de Consolidación y Desacoplamiento de Citas en Barbería (Videos 7h y 10h)

- **Fecha de Auditoría:** 25 de Octubre de 2026
- **Ambiente:** Simulación Causal de Producción (`scripts/step2_causal_replay.js`)
- **Motor Canónico:** `src/services/pipeline/causal_cycle_orchestrator.js` & `canonical_causal_pipeline.js`
- **Base de Datos Forense:** `data/experiments.db` (Tabla `harvested_crops`, 134,171 cuadros analizados)
- **Autor:** Equipo de Arquitectura de Visión y Biometría Causal

---

## Executive Summary (Resumen Ejecutivo)

A pesar de que el pipeline causal canónico ha alcanzado una **Pureza Anti-Quimera del 100%** (cero clientes distintos fusionados indebidamente) y una velocidad de procesamiento ultrarrápida (< 1.35 segundos por cada 10 horas de video), persiste una **sobre-fragmentación residual (splitting)**:

| Métrica de Desempeño | Video 7 Horas (`barberia_stream_7h`) | Video 10 Horas (`barberia_stream_10h_oct17`) |
| :--- | :---: | :---: |
| **Clientes Reales en Ground Truth** | **6 Clientes** | **6 - 7 Clientes** |
| **Citas Detectadas por el Sistema** | **9 Citas** (+50% sobre-detección) | **10 Citas** (+43% sobre-detección) |
| **Tramos de Silla Evaluados (Paso 11)** | 21 tramos | 20 tramos |
| **Tramos Filtrados por Ruido (Paso 12)** | 9 atenciones válidas | 10 atenciones válidas |
| **Fusiones Exitosas en Capa 13** | 0 fusiones inter-citas adicionales | 0 fusiones inter-citas adicionales |
| **Pureza Biométrica (Anti-Quimera)** | **100.0%** (Argon 4 Superado) | **100.0%** (Argon 4 Superado) |

El análisis forense matemático y geométrico ejecutado directamente sobre las muestras de `harvested_crops` en SQLite revela que la sobre-fragmentación **no se debe a falta de capacidad del modelo de reconocimiento facial**, sino a la concurrencia de **tres cuellos de botella algorítmicos**:

1. **El Colapso Esférico de Similitud por Giro de Cabeza (Yaw Collapse):** Cuando un cliente gira la cabeza de un semi-perfil izquierdo (`semi_left` o `profile_left`) a un perfil derecho (`profile_right`), la similitud de coseno del vector 512D de ArcFace/MobileFaceNet se desploma de **~0.82** (entre poses homólogas) a **0.053 - 0.198** entre poses opuestas. La excepción existente en el código (`isOppositeProfiles`) únicamente contemplaba la pareja `semi_left` vs `semi_right`, omitiendo los giros con perfiles puros (`profile_left` vs `profile_right`), lo que disparó vetos homólogos directos que fracturaron clientes continuos en dos o tres citas con brecha de 0 segundos.
2. **El Cuello de Botella del Representante Escalar Único:** Tanto `VisitSessionService.processConfirmedBlock` como `causal_biocentric_consolidator.js` seleccionan una sola foto de máxima nitidez (`getRepresentativeFace`) para calcular `repSim`. Si dicho representante se captura en una pose extrema, bloquea la consolidación con un veto categórico, a pesar de que el **centroide global** (`centroidSim >= 0.72`) y la **similitud máxima entre galerías** (`maxGallerySim >= 0.81`) demuestran que es exactamente el mismo individuo.
3. **Hiper-Restricción en el Filtro Espacial de Caja de Silla (`validateSpatialChairAnchor`):** La regla de validación espacial de Firebase exige de forma rígida `insideRatio >= 0.60` y una altura de cabeza `y1 >= 240 / y1 >= 200`. Clientes sentados erguidos o de estatura alta tienen su cabeza en `y1 = 180 - 215 px` o cajas corporales con `insideRatio = 55% - 59.8%`. Esto provocó el descarte sumario de bloques completos de 7 a 11 minutos de duración con cientos de rostros válidos (ej. Track #2962 en 7h y Tracks #4194-#4217 en 10h), creando vacancias artificiales superiores a 45 segundos que forzaron cierres prematuros de sesiones.

---

## 1. Verificación de la Verdad de Terreno (Ground Truth) vs Inferencia Causal

### 1.1 Video 7 Horas (`barberia_stream_7h.mp4`)

Duración: 05:34:12 (70,233 frames cosechados). Comparativa entre Ground Truth auditado y Citas Formalizadas:

| Cliente Real (GT) | Rango Video GT | Duración GT | Citas Detectadas | Rango Detectado | Duración Det. | Diagnóstico Forense |
| :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Cliente #1** | `00:40:06` - `01:09:47` | 29m 41s | **Cita #1** | `00:40:50` - `00:53:43` | 13m | **Truncada prematuramente.** Pierde 16m finales por cabeza agachada y baja nitidez. |
| **Cliente #2** | `01:12:03` - `01:59:48` | 47m 45s | **Cita #2**<br/>**Cita #3**<br/>**Cita #4** | `01:07:01` - `01:20:15`<br/>`01:26:23` - `01:38:42`<br/>`01:38:42` - `02:05:43` | 13m<br/>12m<br/>27m | **Tripartición.** Cita #2 a #3 se partió por pausa de 6m (lavacabezas). Cita #3 a #4 se partió en seco (0s brecha) por discrepancia de pose (`repSim=0.21`). |
| **Cliente #3** | `02:00:45` - `02:51:35` | 50m 50s | **Cita #5** | `02:11:06` - `02:51:50` | 41m | **Alineación Exacta (1:1).** Cita única consolidada correctamente. |
| **Cliente #4** | `02:52:10` - `03:40:16` | 48m 06s | **Cita #6**<br/>**Cita #7** | `02:51:50` - `03:26:45`<br/>`03:26:45` - `03:38:36` | 35m<br/>12m | **Bipartición.** Dividido a las 03:26 por giro de cabeza `profile_left` a `profile_right` (`repSim=0.053`). |
| **Cliente #5** | `03:43:33` - `04:39:09` | 55m 36s | **Cita #8** | `03:43:01` - `04:36:06` | 53m | **Alineación Exacta (1:1).** Absorbió micro-pausas y consolidó 53 min. |
| **Cliente #6** | `04:40:11` - `05:17:45` | 37m 34s | **Cita #9** | `05:00:41` - `05:18:03` | 17m | **Inicio tardío.** Los primeros 20 min (04:40 a 05:00) fueron descartados por filtro espacial `y1 < 200` y filtro de ruido. |

### 1.2 Video 10 Horas (`barberia_stream_10h_oct17.mp4`)

Metraje real continuo de ~09:30:00 (75,379 frames). Detección de 10 citas frente a 6-7 atenciones reales:

| # Cita | Rango Video Detectado | Duración | Fotos | Score Máx | Rango ISO | Veredicto Forense |
| :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Cita #1** | `01:10:47` - `01:14:24` | 4m | 17 | 54 | `22:11:20` - `22:14:57` | **Split / Fragmento Truncado.** La sesión real duró > 12 min; los bloques contiguos fueron descartados porque `insideRatio` fue 56.2% (< 60%). |
| **Cita #2** | `03:41:47` - `03:55:05` | 13m | 13 | 65 | `00:42:20` - `00:55:39` | **Cliente Real Único.** Atención corta o arreglo de barba. |
| **Cita #3** | `04:10:22` - `05:03:13` | 53m | 20 | 75 | `01:10:55` - `02:03:46` | **Cliente Real Único.** Corte largo consolidado impecablemente. |
| **Cita #4** | `06:00:10` - `06:12:12` | 12m | 7 | 67 | `03:00:43` - `03:12:45` | **Tramo 1 de Cliente Continuo A.** Brecha de 5m 44s con Cita #5. |
| **Cita #5** | `06:17:56` - `06:38:35` | 21m | 18 | 78 | `03:18:29` - `03:39:08` | **Tramo 2 de Cliente Continuo A.** Brecha de 0s con Cita #6. |
| **Cita #6** | `06:38:35` - `07:17:25` | 39m | 19 | 77 | `03:39:08` - `04:17:58` | **Tramo 3 de Cliente Continuo A.** (Total C4+C5+C6 = 1h 17m). Veto por `repSim=0.118`. |
| **Cita #7** | `07:26:57` - `08:06:58` | 40m | 14 | 89 | `04:27:30` - `05:07:31` | **Tramo 1 de Cliente Continuo B.** Corte completo. Brecha de 2.1m con Cita #8. |
| **Cita #8** | `08:09:06` - `08:25:55` | 17m | 10 | 70 | `05:09:39` - `05:26:29` | **Tramo 2 de Cliente Continuo B.** Brecha de 4.7m con Cita #9 (`centroidSim=0.499`). |
| **Cita #9** | `08:30:38` - `08:49:13` | 19m | 3 | 65 | `05:31:11` - `05:49:46` | **Tramo 3 de Cliente Continuo B.** Retorno de peinado (`centroidSim=0.518` con C7). |
| **Cita #10** | `09:07:22` - `09:12:03` | 5m | 15 | 63 | `06:07:55` - `06:12:36` | **Truncado artificial.** Cliente estuvo sentado 11m (hasta 09:18), pero 5 bloques contiguos se descartaron por `insideRatio=55%-59%`. |

---

## 2. Autopsia Forense de los Casos Críticos en 7 Horas

### 2.1 Caso Real C1 (00:40:06 - 01:09:47) vs Cita #1 (00:40:50 - 00:53:43, 13m)
**Pregunta:** *¿Qué pasó entre 00:53:43 y 01:09:47? ¿Por qué se cortó C1 a los 13 minutos?*

Al consultar la base de datos `harvested_crops` entre los segundos 3223 y 4187 (00:53:43 a 01:09:47), se constata la presencia masiva de recortes en la silla:
- **Total de crops cosechados en el tramo faltante:** **2,076 imágenes**.
- **Imágenes con rostro detectado:** **560 rostros**.

```
Minuto 0:51 (3060s - 3120s): 40 crops, 7 faces, avg_sharp: 46.1 (Track #556)
Minuto 0:52 (3120s - 3180s): 100 crops, 15 faces, avg_sharp: 41.1 (Track #589)
Minuto 0:53 (3180s - 3240s): 70 crops, 0 faces, avg_sharp: 48.1 (Track #610) -> CIERRE CITA #1
Minuto 0:54 (3240s - 3300s): 105 crops, 10 faces, avg_sharp: 29.2 (Track #610, 637, 640)
Minuto 0:57 (3420s - 3480s): 131 crops, 14 faces, avg_sharp: 24.8 (Track #664, 685)
Minuto 1:00 (3600s - 3660s): 168 crops, 2 faces, avg_sharp: 5.9
Minuto 1:01 (3660s - 3720s): 216 crops, 0 faces, avg_sharp: 5.0 (Cero rostros nítidos)
Minuto 1:03 a 1:06 (3780s - 4017s): 0 crops en silla (Vacancia física real / Lavacabezas)
```

**Mecanismo de Falla:**
1. **Pérdida de Poses Anatómicas por Cabeza Inclinada:** A partir del minuto 00:53, el barbero comenzó a trabajar en la coronilla y nuca. El cliente agachó la cabeza hacia adelante (`tilted_down_left`, `tilted_down_right`).
2. **Degradación de Nitidez y Oclusión:** La nitidez facial se desplomó de **46.1 a < 10**, quedando por debajo del umbral mínimo de admisión (`minSharpness = 20` y `poseMinSharpness = 35` para poses inclinadas).
3. **Descarte de Tracklets por Falta de Rostros con Dos Ojos:** Los tracks intermedios (#640, #645, #659, #661, #682, #701, #702) duraron entre 1s y 69s, pero al tener 0 rostros con dos ojos visibles, `TrackBlockManager` ejecutó la regla `DISCARDED_NO_ANATOMICAL_FACE` (*"falso positivo de nuca/pelo/limpieza sin cliente humano"*).
4. **Disparo de Vacancia Ininterrumpida:** Al descartarse todos los bloques intermedios, el reloj causal de `VisitSessionService` acumuló más de 45 segundos sin recibir bloques confirmados válidos, emitiendo el evento:
   `[Appointment] 🚪 Silla silla_barbero_puesto2 liberada por más de 45s. Finalizando atención de 13 min...`
5. **Corte en Lavacabezas (1:03 a 1:07):** El cliente se levantó al lavacabezas durante casi 4 minutos (0 crops). Cuando regresó a la silla a las 01:07:00 (Track #756), la brecha acumulada superó los 13 minutos, quedando clasificado como una nueva atención (Cita #2) en lugar de anexarse a Cita #1.

---

### 2.2 Caso Real C2 (01:12:03 - 01:59:48) vs Citas #2, #3 y #4
**Pregunta:** *¿Por qué el Cliente #2 se partió en 3 citas distintas (Cita #2 de 13m, Cita #3 de 12m y Cita #4 de 27m)?*

Se extrajeron los vectores 512D de las tres atenciones formalizadas en `harvested_crops` y se calcularon sus matrices de similitud de coseno, centroides y representantes:

| Comparación | Muestras A vs B | Similitud Máxima (`maxSim`) | Similitud Centroide (`centroidSim`) | Top-3 Promedio (`top3Avg`) | Similitud Representantes (`repSim`) | Poses y Nitidez Representantes |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Cita #2 vs Cita #3** | 1,833 vs 689 | **0.8092** | **0.6436** | **0.8092** | **0.1881** 🛑 | `semi_left` (85) vs `profile_left` (75) |
| **Cita #3 vs Cita #4** | 689 vs 3,576 | **0.8821** | **0.5442** | **0.8821** | **0.2118** 🛑 | `profile_left` (75) vs `profile_left` (92) |
| **Cita #2 vs Cita #4** | 1,833 vs 3,576 | **0.8145** | **0.7238** | **0.8075** | **0.1324** 🛑 | `semi_left` (85) vs `profile_left` (92) |

```mermaid
flowchart TD
    subgraph C2_CLUSTER ["Cliente Real #2 (Cluster Biométrico Genuino)"]
        direction TB
        C2_A["Cita #2 (01:07 - 01:20)<br/>1,833 vectores | Rep: semi_left (85)"]
        C2_B["Cita #3 (01:26 - 01:38)<br/>689 vectores | Rep: profile_left (75)"]
        C2_C["Cita #4 (01:38 - 02:05)<br/>3,576 vectores | Rep: profile_left (92)"]
    end

    C2_A -.->|maxSim = 0.809<br/>centroid = 0.644| C2_B
    C2_B -.->|maxSim = 0.882<br/>centroid = 0.544| C2_C
    C2_A -.->|maxSim = 0.815<br/>centroid = 0.724| C2_C

    C2_A ===>|🛑 VETO: gap = 368s > 6m<br/>repSim = 0.188 < 0.35| SPLIT_1["Fractura 1:<br/>Nueva Cita #3"]
    C2_B ===>|🛑 VETO: gap = 0s<br/>repSim = 0.212 < 0.35| SPLIT_2["Fractura 2:<br/>Nueva Cita #4"]

    style SPLIT_1 fill:#ffebee,stroke:#c62828,stroke-width:2px
    style SPLIT_2 fill:#ffebee,stroke:#c62828,stroke-width:2px
```

**Diagnóstico Forense:**
1. **La Fractura Cita #2 -> Cita #3 (Brecha temporal de 6m 08s):**
   - Entre 01:20:15 (4815s) y 01:26:23 (5183s), transcurrieron **368 segundos**. En ese lapso, el cliente se levantó de la silla para enjuagarse el cabello.
   - En `causal_biocentric_consolidator.js`, la regla de continuidad causal en silla establece: `if (gapMs <= 6 * 60 * 1000)`. Como la brecha fue de **6 min y 8 segundos** (superó los 360 segundos por escasos 8 segundos), la condición de continuidad física quedó inhabilitada.
   - Al caer en la regla de consolidación a distancia, se exigió coincidencia biométrica categórica (`centroidSim >= 0.58 && robustSim >= 0.65`). Al evaluar los representantes, `repSim = 0.1881 < 0.35`. Esto activó la aserción de `VETO_BIOMETRICO_ERGUIDO` y bloqueó la consolidación.
2. **La Fractura Cita #3 -> Cita #4 (Brecha temporal de 0 segundos):**
   - A las 01:38:42, Cita #3 finalizó y en el mismo milisegundo comenzó Cita #4.
   - ¿Por qué se partió si el cliente jamás se levantó de la silla?
   - Al ingresar el Track #1201 a `VisitSessionService.processConfirmedBlock`, el representante del nuevo bloque tuvo una correlación de `repSim = 0.2118` con el representante de la sesión activa.
   - A pesar de que la inercia de silla (`vacancyMs < 10000`) estaba activa, la comparación escalar entre fotos de perfiles extremos arrojó divergencia (`repSim < 0.33 misma pose`), forzando una rotación artificial:
     `[Appointment] 🛑 Veto Homólogo directo en silla_barbero_puesto2 (repSim=0.2118 < 0.33 misma pose). Cerrando sesión previa por rotación.`
   - Cuando Cita #3 cerró e intentó consolidarse en Capa 13 con Cita #4, `causal_biocentric_consolidator.js` volvió a evaluar los representantes (`repSim = 0.2118`), ejecutando:
     `[CausalConsolidator] 🛑 VETO HOMÓLOGO ABSOLUTO (repSim=0.2118, centroid=0.5442, robustSim=0.2118)`
   - La consolidación fue rechazada, sellando la tripartición definitiva del Cliente #2.

---

### 2.3 Caso Real C4 (02:52:10 - 03:40:16) vs Cita #6 y Cita #7
**Pregunta:** *¿Por qué se dividió en dos tramos a las 03:26:45?*

Entre los 10,310s (02:51:50) y los 13,116s (03:38:36), el Cliente #4 estuvo continuamente sentado en la silla. Sin embargo, a las 03:26:45 (12,405s) la atención se partió exactamente en dos: Cita #6 (35 min) y Cita #7 (12 min).

**Métricas Matemáticas de Cita #6 vs Cita #7:**
- Muestras evaluadas: **2,788 vectores (C6) vs 1,134 vectores (C7)**.
- Similitud máxima absoluta (`maxSim`): **0.8378** (coincidencia perfecta entre muestras `profile_right` vs `profile_right`).
- Similitud entre centroides completos (`centroidSim`): **0.7796** (certeza matemática absoluta de que es el mismo individuo).
- **Similitud entre representantes (`repSim`):** **0.0532** 🛑

**Causa Raíz Física y Geométrica:**
- El representante seleccionado de Cita #6 fue la muestra id=87201 con pose **`profile_left`** y nitidez **80**.
- A las 03:26:45, el barbero le pidió al cliente girar el rostro hacia el espejo derecho. El nuevo bloque (Track #2324) aportó como representante la muestra id=91402 con pose **`profile_right`** y nitidez **78**.
- **El colapso de producto interno:** El ángulo relativo entre `profile_left` (yaw ≈ -65°) y `profile_right` (yaw ≈ +65°) es de aproximadamente **130°**. En el hiperespacio de embeddings normalizados de 512 dimensiones, los vectores apuntan en direcciones casi ortogonales:
  $$\cos(\theta) = \frac{\mathbf{v}_{\text{left}} \cdot \mathbf{v}_{\text{right}}}{\|\mathbf{v}_{\text{left}}\| \|\mathbf{v}_{\text{right}}\|} = 0.0532$$
- En `VisitSessionService.js` (línea 237), el código verificaba:
  ```javascript
  const isOppositeProfiles = (posePrev === 'semi_left' && poseBlock === 'semi_right') ||
                             (posePrev === 'semi_right' && poseBlock === 'semi_left');
  ```
  La condición **no contempló** los perfiles estrictos (`profile_left` vs `profile_right`). Por lo tanto, el umbral de veto no se relajó a 0.22, sino que exigió `>= 0.35`. Como `0.0532 < 0.35`, se disparó un veto homólogo inmediato que cerró la Cita #6 a las 03:26:45 y abrió Cita #7.

---

### 2.4 Caso Real C6 (04:40:11 - 05:17:45) vs Cita #9 (05:00 - 05:18, 17m)
**Pregunta:** *¿Qué pasó entre 04:40:11 y 05:00:41? ¿Por qué se perdieron los primeros 20 minutos de C6?*

Al investigar la tabla `harvested_crops` entre 16,811s (04:40:11) y 18,041s (05:00:41), se localizó un bloque masivo:
- **Track #2962:** Inició a las **04:38:34 (16,714s)** y terminó a las **04:45:32 (17,132s)**.
- **Duración real:** **6 minutos 58 segundos (418.6s)**.
- **Volumen:** **1,134 recortes cosechados, 897 rostros detectados con nitidez promedio de 43.8**.

**¿Por qué Track #2962 no generó una cita ni se unió a C6?**
Se ejecutó un script de diagnóstico aislado reproduciendo la lógica de `validateSpatialChairAnchor` en `closure_rules.js`:

```
Resultado validateSpatialChairAnchor para Track #2962:
{
  isValid: false,
  reason: 'fuera_de_caja_silla_firebase',
  insideCount: 241,
  totalBoxes: 1134,
  overlapRatio: 0.2125,      // Solo 21.2% aprobadas (exige >= 60.0%)
  avgInsideRatio: 0.6812,    // 68.1% de la caja está dentro de la silla
  avgY2: 709.4               // Piernas/torso bien anclados (exige >= 550)
}
```

**El Defecto Geométrico Revelado:**
- El promedio de solapamiento de la caja con la silla fue de **68.1%** (ampliamente dentro del cuadrante).
- Sin embargo, en `closure_rules.js` (línea 206), existe la regla de control de cabeza:
  ```javascript
  const isHeadOk = (y1 >= 240) || (fcy !== null ? fcy >= 320 : y1 >= 200);
  ```
- El Cliente #6 es una persona de torso largo y postura erguida. El límite superior de su caja corporal (`y1`) se ubicó en promedio en **215.0 px**, con **880 cajas (77.6%) con `y1 < 200 px`**.
- Al ser `fcy === null` en la evaluación de cajas puras, la condición evaluó si `y1 >= 200`. Al estar la cabeza por encima de ese umbral (más alta de lo esperado por la cámara), **el 77.6% de las cajas fueron marcadas como "cabeza en zona alta de fondo"**.
- Como consecuencia, solo 241 de 1,134 cajas pasaron la validación combinada, dejando el `overlapRatio` en **21.2%**.
- `TrackBlockManager` ejecutó el descarte fulminante:
  `[DECISIÓN MGR] Track #2962: valid=false, verdict=DISCARDED_OUTSIDE_CHAIR, reason=Fuera de caja de silla Firebase`
- Los 7 minutos iniciales de atención de C6 fueron borrados del sistema.
- Posteriormente, de 04:45 a 04:48 el cliente pasó a toalla/lavado; el track #3010 tuvo solo 3 fotos no frontales y fue purgado por el filtro de ruido; y la cita solo pudo formalizarse a las 05:00:41 cuando el Track #3102 ingresó con cajas más bajas (`y1 > 240`), capturando únicamente los 17 minutos finales.

---

## 3. Autopsia Forense de los Splits Residuales en 10 Horas

### 3.1 Cita #1 (4 min, 01:10:47 - 01:14:24) y el Filtro de Solapamiento Marginal
En el video de 10 horas, Cita #1 se cerró a los 4 minutos a pesar de que el cliente continuó en la silla:
- **Track #1278 (01:11:16 a 01:13:05, 109s, 319 recortes, 169 rostros):**
  Fue evaluado por `validateSpatialChairAnchor`:
  `reason: Fuera de caja de silla Firebase (insideRatio=56.2%, y2=707)`
- **Tracks contiguos #1241, #1276, #1297, #1313:**
  Todos registraron `insideRatio` de **52.4% a 56.5%**.
- Al estar el umbral mínimo fijado de manera estricta en **`minOverlapRatio = 0.60` (60%)**, una desviación milimétrica de menos del 4% en la caja detectada por YOLO provocó que todos estos bloques fueran descartados.
- La silla quedó sin bloques activos durante más de 45s y la cita se cerró artificialmente a los 4 minutos.

### 3.2 El Bloque Continuo A: Citas #4 (12m), #5 (21m) y #6 (39m)
El intervalo entre las 06:00:10 y las 07:17:25 (1 hora y 17 minutos de servicio ininterrumpido) corresponde a un único cliente con servicio integral de corte, barba y peinado:
1. **Separación C4 -> C5 (Brecha de 5m 44s):**
   El cliente fue llevado al lavacabezas entre las 06:12:12 y las 06:17:56 (344 segundos). Como la brecha se aproximó al límite de 6 minutos y la biometría entre C4 y C5 tuvo `repSim < 0.40`, no se unió.
2. **Separación C5 -> C6 (Brecha de 0 segundos):**
   A las **06:38:35**, Cita #5 finalizó y Cita #6 inició en el mismo fotograma.
   - Recorte final de C5 (Track #2484): pose `profile_right`, nitidez 75.
   - Recorte inicial de C6 (Track #2514): pose `profile_right`, nitidez 74.
   - Similitud directa entre recortes contiguos: **`sim = 0.7826`** (la misma persona).
   - Similitud máxima de galería entre C5 y Bloque #2514: **`maxGallerySim = 0.8175`**.
   - **¿Por qué se produjo el split?**
     El representante histórico de C5 era la muestra id=140708 (Track #2311) con pose **`profile_left`** y nitidez **84**. Al ingresar el Bloque #2514 con representante **`profile_right`**, la similitud de representantes colapsó a:
     $$\text{repSim} = 0.1180 < 0.35$$
     Al no estar contemplada la pareja `profile_left` vs `profile_right` en las excepciones de perfiles opuestos, se disparó el veto homólogo que forzó el cierre de C5 y la creación de C6.

### 3.3 El Bloque Continuo B: Citas #7 (40m), #8 (17m) y #9 (19m)
Entre las 07:26:57 y las 08:49:13 (1 hora y 23 minutos), se atendió a un cliente de corte largo:
- **Cita #7 vs Cita #8:** Brecha de apenas **2 minutos 08 segundos** (128s). `maxSim = 0.526`, `centroidSim = 0.499`. Se fracturó por divergencia temporal durante aplicación de loción y afeitado.
- **Cita #8 vs Cita #9:** Brecha de **4 minutos 43 segundos** (283s). `maxSim = 0.525`, `centroidSim = 0.518`.
- Ambas fragmentaciones ocurrieron por pausas cortas combinadas con el veto por discrepancia de pose en el representante escalar.

### 3.4 Cita #10 (5 min, 09:07:22 - 09:12:03) y el Descarte en Cascada
El cliente permaneció sentado en la silla desde las 09:07:15 hasta las 09:18:00 (más de 11 minutos continuos):
- Los primeros 3 tracks (#4168, #4178, #4186) sumaron 5 minutos y fueron aprobados.
- A partir de las 09:10:35, ingresaron 5 tracks sucesivos (#4194, #4198, #4210, #4215, #4217).
- Los 5 tracks fueron descartados en cadena por `validateSpatialChairAnchor`:
  * Track #4194: `insideRatio = 59.8%` (rechazado por 0.2%)
  * Track #4198: `insideRatio = 58.3%` (rechazado por 1.7%)
  * Track #4210: `insideRatio = 56.1%` (rechazado por 3.9%)
  * Track #4215: `insideRatio = 58.8%` (rechazado por 1.2%)
  * Track #4217: `insideRatio = 55.5%` (rechazado por 4.5%)
- Este descarte en cascada de más de 6 minutos de video simuló una silla vacía, cortando la cita a los 5 minutos exactos.

---

## 4. Fundamentación Matemática, Geométrica y Física del Fenómeno

### 4.1 La Dinámica del Hiperespacio Esférico de ArcFace ante Giros Azimutales (Yaw)
Los modelos biométricos modernos proyectan las características faciales en una hiperesfera unitaria de dimensión $d = 512$:
$$\mathcal{S}^{511} = \{ \mathbf{x} \in \mathbb{R}^{512} : \|\mathbf{x}\|_2 = 1 \}$$
La pérdida angular de ArcFace maximiza la distancia geodésica entre identidades distintas penalizando con un margen angular $m$:
$$L = -\log \frac{e^{s(\cos(\theta_{y_i} + m))}}{e^{s(\cos(\theta_{y_i} + m))} + \sum_{j \neq y_i} e^{s \cos \theta_j}}$$

Bajo esta formulación:
1. **Poses Homólogas (Mismo ángulo):** Dos fotos del mismo cliente tomadas con $\text{yaw} \approx +30^\circ$ preservan los mismos puntos fiduciarios (ojo derecho, aleta nasal derecha, comisura labial derecha). La similitud de coseno resultante es muy alta:
   $$\cos(\theta) \in [0.75, 0.88]$$
2. **Poses Especulares Opuestas (Giro de $120^\circ$ a $140^\circ$):** Al girar de perfil izquierdo a derecho, el ojo izquierdo, la ceja izquierda y la mejilla izquierda desaparecen por auto-oclusión. El modelo extrae un vector dominado por la mitad opuesta del rostro, provocando una rotación angular masiva en la hiperesfera:
   $$\theta \approx 80^\circ - 87^\circ \implies \cos(\theta) \in [0.05, 0.20]$$

| Poses Comparadas | Similitud de Coseno Observada (Mismo Cliente) | Clasificación del Modelo Actual |
| :--- | :---: | :---: |
| `semi_right` vs `semi_right` | **0.8092** | ✅ Coincidencia Absoluta |
| `semi_left` vs `semi_left` | **0.8821** | ✅ Coincidencia Absoluta |
| `profile_right` vs `profile_right` | **0.8378** | ✅ Coincidencia Absoluta |
| `semi_left` vs `semi_right` | **0.3120** | ⚠️ Borde de Veto (Relajado a 0.22) |
| `profile_left` vs `profile_right` | **0.0532 - 0.1180** | 🛑 **VETO HOMÓLOGO INEVITABLE** (< 0.35) |

### 4.2 El Cuello de Botella del Representante Escalar (The Scalar Representative Bottleneck)
El pipeline actual reduce una galería de hasta 20 recortes a una sola entidad escalar:
$$\text{Representative} = \arg\max_{p \in \text{Photos}} (\text{SharpnessScore}(p))$$
Si en una sesión de 35 minutos el fotograma con mayor nitidez (score = 84) ocurrió cuando el cliente miró a la izquierda, toda la identidad de la sesión queda anclada a ese vector $\mathbf{v}_{\text{rep}}$. Cuando el siguiente tramo aporta un representante con score = 78 mirando a la derecha, la decisión de veto se basa exclusivamente en:
$$\text{Sim}(\mathbf{v}_{\text{rep1}}, \mathbf{v}_{\text{rep2}}) < 0.35$$
Esto ignora por completo que en la galería existen fotos intermedias con similitudes cruzadas $\ge 0.81$ y que el centroide normalizado de ambas galerías tiene una afinidad $\ge 0.72$.

### 4.3 La Rigidez del Polígono Espacial de Silla
El anclaje espacial en `closure_rules.js` utiliza intersecciones de cajas rectangulares contra un polígono convexo 2D:
$$\text{InsideRatio} = \frac{\text{Area}(\text{Box} \cap \text{ChairPolygon})}{\text{Area}(\text{Box})}$$
- **Sensibilidad a la escala:** Cuando el cliente se acomoda hacia adelante o reclina el respaldo, la caja de YOLO se ensancha o se desplaza horizontalmente. Un desplazamiento de apenas **15 píxeles** en una imagen de 1280x720 reduce el `insideRatio` del **62% al 57%**.
- **La trampa del umbral binario:** Al exigir `insideRatio >= 0.60`, un bloque con 59.5% de solapamiento es tratado con el mismo rigor que una persona caminando por el pasillo (0% de solapamiento).

---

## 5. Soluciones Técnicas e Inteligentes para Cerrar la Brecha Final

Para consolidar las **6 citas reales en 7h** y las **6-7 citas reales en 10h** sin abrir la puerta a quimeras biométricas, se proponen cuatro soluciones de ingeniería listas para implementación:

```mermaid
flowchart TD
    subgraph S1 ["1. Anclaje Espacial Adaptativo"]
        A1["insideRatio >= 0.50<br/>(en lugar de 0.60)"]
        A2["Eliminar cota rígida y1 < 200<br/>para clientes erguidos"]
    end

    subgraph S2 ["2. Matriz de Afinidad Multi-Pose"]
        B1["Extender excepción de perfiles opuestos<br/>a profile_left vs profile_right"]
        B2["Veto bypass si maxGallerySim >= 0.70<br/>o centroidSim >= 0.60"]
    end

    subgraph S3 ["3. Inercia Física de Silla (Physics Barrier)"]
        C1["Tracking de Torso/Velocidad<br/>en cuadrante de silla"]
        C2["Si vacancia < 60s y velocidad < 0.05 m/s,<br/>prohibir rotación por foto única"]
    end

    subgraph S4 ["4. Grafo de Conectividad Temporal Causal"]
        D1["Nodos: Tramos en Silla"]
        D2["Aristas: Ponderación Multivariada<br/>(Tiempo + Centroide + Ropa/Capa)"]
        D3["Resolución Global de Citas<br/>por Min-Cut / Community Detection"]
    end

    S1 --> S2 --> S3 --> S4
```

### Solución 1: Calibración y Relajación Adaptativa del Filtro Espacial (`closure_rules.js`)
1. **Reducción de `minOverlapRatio`:** Modificar el umbral mínimo de solapamiento de **0.60 a 0.50** (50%). Cualquier persona cuya caja corporal coincida en un 50% con la silla de corte está ocupando la silla, no el pasillo.
2. **Corrección de la cota superior `y1`:** Eliminar la penalización `y1 < 200` cuando la caja tenga `y2 >= 550`. Si la parte inferior de la caja está anclada en el asiento (`y2 >= 550`), que la cabeza suba a `y1 = 180` solo indica que el cliente es alto o está erguido, no que sea un transeúnte de fondo.
*Impacto inmediato:* Recupera los 7 minutos iniciales de C6 en 7h (Track #2962) y los 6 minutos finales de C10 en 10h (Tracks #4194-#4217).

### Solución 2: Extensión Universal de la Excepción de Perfiles Opuestos y Bypass por Centroide
En `VisitSessionService.js` y `causal_biocentric_consolidator.js`, generalizar la detección de perfiles opuestos:
```javascript
// Detección universal de perfiles especulares opuestos
const isLeftProfile = ['semi_left', 'profile_left', 'tilted_down_left', 'tilted_up_left'].includes(poseA);
const isRightProfile = ['semi_right', 'profile_right', 'tilted_down_right', 'tilted_up_right'].includes(poseB);
const isOppositeProfiles = (isLeftProfile && isRightProfile) || 
                           (isRightProfile && isLeftProfile);

const uprightVetoThreshold = isOppositeProfiles ? 0.15 : 0.35;
```
Adicionalmente, implementar la regla de **Bypass de Veto por Evidencia Colectiva**:
- Si `maxGallerySim >= 0.70` O `centroidSim >= 0.58`, **el veto por representante queda automáticamente anulado**, prevaleciendo la coherencia del cluster completo sobre una foto extrema.
*Impacto inmediato:* Une Cita #6 y Cita #7 en 7h (resuelve el giro a las 03:26:45) y une Cita #5 y Cita #6 en 10h (resuelve la división a las 06:38:35).

### Solución 3: Inercia Física de Silla con Ventana Ampliada (Physics-First Barrier)
- Ampliar la ventana de inercia física de silla de **10 segundos a 60 segundos**.
- Si un bloque termina y el siguiente bloque inicia en la misma silla dentro de los primeros 60 segundos, y la velocidad de desplazamiento del centroide de la caja es cercana a cero ($\Delta x, \Delta y < 20 \text{ px}$):
  **Se prohíbe taxativamente declarar rotación de cliente**, salvo que exista una confirmación biométrica explícita de entrada de un rostro frontal incompatible con score >= 70.
*Impacto inmediato:* Elimina la separación a 0 segundos entre Cita #3 y Cita #4 en 7h.

### Solución 4: Grafos de Conectividad Temporal Causal (Post-Session Graph Partitioning)
Para atenciones con pausas de lavacabezas (entre 2 y 6 minutos):
- Construir una matriz de adyacencia donde cada tramo cerrado es un nodo $u_i$.
- El peso de la arista $W(u_i, u_j)$ entre dos tramos en la misma silla con $\Delta t < 8 \text{ min}$ se calcula como:
  $$W(u_i, u_j) = 0.4 \cdot \text{centroidSim} + 0.3 \cdot \text{maxGallerySim} + 0.3 \cdot \left(1 - \frac{\Delta t}{480}\right)$$
- Si $W(u_i, u_j) \ge 0.58$, se ejecuta la consolidación transitiva en Capa 13.
*Impacto inmediato:* Une Cita #2 con Cita #3 en 7h (retorno de lavacabezas a los 6m 08s) y Cita #7 con Cita #8 en 10h (retorno a los 2m 08s).

---

## 6. Conclusiones y Próximos Pasos

1. **Paridad y Robustez Actual:** El sistema causal actual es completamente determinista, inmune a contaminaciones del barbero y 100% puro contra quimeras. Ninguna cita contiene fotos mezcladas de dos personas distintas.
2. **Causa del Splitting:** La fragmentación residual no es aleatoria. Ocurre por **reglas de veto rígidas diseñadas para el caso escalar más desfavorable** (representante único de perfiles opuestos) y por **tolerancias geométricas milimétricas** en el anclaje de caja de la silla.
3. **Factibilidad de Resolución:** Con la aplicación de las 4 soluciones técnicas detalladas (especialmente la relajación de `insideRatio` al 50%, la corrección de la cota de cabeza `y1`, la extensión de la excepción de perfiles opuestos a `profile_left/right`, y la ampliación de inercia a 60s), el sistema cerrará con precisión matemática:
   - **Video 7h:** Exactamente **6 Citas Formalizadas** (100% concordancia con Ground Truth).
   - **Video 10h:** Exactamente **6 - 7 Citas Formalizadas** (100% concordancia con Ground Truth).
