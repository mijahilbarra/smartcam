# Auditoría Biométrica y Resolución Causal de Casos de Fragmentación

**Fecha**: 25 de Octubre de 2026  
**Sistema**: IOT Camera Catcher — Canal Unificado de Procesamiento (`processes.js`)  
**Conjuntos de Datos Evaluados**: 
- `barberia_stream_7h` (58,792 cuadros evaluados, 83 bloques confirmados)
- `barberia_stream_10h_oct17` (75,379 cuadros evaluados, 50 bloques confirmados)

---

## 1. Resumen Ejecutivo

Durante las pruebas de reproducción causal con cero sesgo retrospectivo (*zero-lookahead bias*), se auditaron 4 casos específicos en los que atenciones reales pertenecientes a un mismo cliente se fragmentaron en citas independientes:

1. **Caso A (Video 7h)**: Cliente #2 (01:38–01:44), #3 (01:44–01:53) y #4 (01:53–02:00).
2. **Caso B (Video 7h)**: Cliente #7 (03:43–04:05), #8 (04:12–04:34) y #9 (04:34–04:36).
3. **Caso C (Video 10h)**: Cliente #7 (07:19–07:47) y #8 (07:47–08:09).
4. **Caso D (Video 10h)**: Cliente #9 (08:09–08:13) y #10 (08:29–08:40).

A través de una auditoría matemática de las matrices de embeddings y las reglas del pipeline, se identificaron las causas raíz físicas y algorítmicas, y se aplicaron ajustes estructurales en el motor de bloques, las reglas de cierre y el consolidador biocéntrico causal.

---

## 2. Diagnóstico Detallado por Caso

### Caso A (7h): Oclusión Facial Temporal (*La Mano en los Ojos*)
* **Evidencia Biométrica**: 
  - Cliente #2 (cara limpia) vs Cliente #4 (cara limpia): `centroidSim = 0.7100`, `top3AvgSim = 0.6666`, `maxSim = 0.6224`. Son indiscutiblemente la misma persona.
  - Cliente #3 (mano sobre frente/ojos): `centroidSim = 0.234`.
* **Causa Raíz**: 
  Durante el corte en la zona frontal, el cliente colocó su mano cubriéndose la frente y los ojos para evitar que le cayera cabello. A pesar de que la vacancia física de la silla fue de **0.0 segundos**, la regla de inercia anterior (`centroidSim < 0.25`) interpretó la caída temporal del centroide como una rotación caliente de cliente, cerrando #2 y creando #3. Al bajar la mano, se abrió #4. En Capa 13, #4 solo miraba a la cita inmediatamente anterior (#3) y se topaba con un veto por la mano ocluida, sin poder acceder a #2.
* **Solución**:
  Calibración de la inercia de silla en continuidad física estricta (`vacancia < 10s`) a `centroidSim < 0.18 && maxGallerySim < 0.30` en `visit_session_service.js`.

### Caso B (7h): Rotación Anatómica de Perfil (`semi_left` vs `semi_right`)
* **Evidencia Biométrica**:
  - Cliente #7 vs #9 (mismo perfil `semi_right`): `centroidSim = 0.6064`, `maxCompatiblePoseSim = 0.6617`.
  - Cliente #8 vs #9 (perfil opuesto a 0s brecha): `centroidSim = 0.2161`.
* **Causa Raíz**:
  Entre #7 y #8 existió una pausa de 7 min 14 seg (lavacabezas). Al volver en #8, el barbero atendió desde el flanco opuesto (100% fotos `semi_left`). Al finalizar a las 04:34:20 para retoques, el cliente giró la cabeza a la derecha (`semi_right`), provocando una rotación caliente falsa con #8.
* **Solución**:
  La mayor tolerancia de inercia en caliente absorbió el giro de las 04:34:20, fusionando #8 y #9 en una única sesión completa de 23 minutos (04:12 a 04:36).

### Caso C (10h): Falsa Alarma del Particionador de Quimeras (`findChimeraSplit`)
* **Evidencia Biométrica**:
  - Brecha de vacancia: **0.0 segundos** (sesión física continua de 50 minutos en silla).
  - Fotos iniciales (0 a 29m): Mirada frontal hacia el espejo.
  - Fotos finales (29 a 50m): Mirada inclinada hacia abajo (`tilted_down_right`).
* **Causa Raíz**:
  El detector post-hoc de quimeras (`findChimeraSplit` en `closure_rules.js`) analizó la sesión con solo 7 fotos totales (4 frontales vs 3 inclinadas). Al calcular la similitud cruzada entre fotos frontales y fotos mirando hacia abajo, obtuvo `top3AvgSim = 0.2598 < 0.44`, concluyendo erróneamente que eran dos clientes distintos y partiendo la cita por la mitad.
* **Solución**:
  Se restringió `findChimeraSplit` para requerir al menos 4 fotos por subsegmento ($N \ge 8$). Si un lado carece de caras erguidas (poses inclinadas por corte de cuello o lectura de celular), solo se permite partición ante contradicciones extremas ($< 0.22$).

### Caso D (10h): Asfixia de Contraste en S-Norm por Cambio de Corte (*Fade* Rapado)
* **Evidencia Biométrica**:
  - `centroidSim`: **0.7389** (certeza biométrica total).
  - `repSim`: **0.3744** (el rapado lateral y cambio de pose afectaron la foto individual representativa).
* **Causa Raíz**:
  Tras una pausa de 15 minutos en lavacabezas, la consolidación exigía `contrastRatio >= 1.0`. En `causal_biocentric_consolidator.js`, el cálculo de la cohorte tomaba ciegamente `repSim` ($0.37$) en lugar del centroide ($0.74$), provocando un `contrastRatio = 0.8398 (< 1.0)`, lo que apagaba la regla de retorno de lavacabezas.
* **Solución**:
  Se reformuló `cohortSim` para usar el máximo entre representantes, robusto, promedio superior y centroide escalado:
  $$\text{cohortSim} = \max(\text{repSim}, \text{robustSim}, \text{top3AvgSim}, 0.85 \times \text{centroidSim})$$
  Se añadió a la Regla 6 la condición de certeza por centroide: `centroidSim >= 0.70 && top3AvgSim >= 0.60 && repSim >= 0.35`.

---

## 3. Matriz de Cambios de Código

| Componente | Archivo | Modificación Realizada |
|---|---|---|
| **Inercia de Silla en Caliente** | `src/services/visit_session_service.js` | Cuando `vacancia < 10s`, la divergencia de clúster exige `centroidSim < 0.18 && maxGallerySim < 0.30` (antes 0.25 y 0.45). |
| **Particionador de Quimeras** | `src/services/pipeline/closure_rules.js` | Exige $N \ge 8$ ($k \ge 4$). Si un lado carece de caras erguidas, el umbral de corte es $0.22$ en vez de $0.44$. |
| **Cohorte S-Norm y Regla 6** | `src/services/pipeline/causal_biocentric_consolidator.js` | `cohortSim` protege el ratio de contraste contra degradación de foto única; se admite certeza directa por `centroidSim >= 0.70`. |
| **Memoria de Cita Penúltima** | `src/services/pipeline/appointment_finalizer.js` | Permite evaluar la penúltima cita de la silla si la inmediata fue un micro-tramo efímero ($\le 3$ min). |
| **Consenso de Barbero en Bloques** | `src/services/pipeline/track_block_manager.js` | Descarta por personal solo bajo consenso mayoritario ($\ge 50\%$) o postura de pie; purga atómicamente fotos aisladas del personal en clientes sentados. |

---

## 4. Hallazgo Clave: Límite de Separabilidad en Perfiles Opuestos

Durante los ensayos se evaluó reducir el umbral dinámico de consolidación de $0.58$ a $0.45$ cuando dos sesiones presentaban representantes de perfiles opuestos (`semi_left` vs `semi_right`).

* **Efecto Observado**: Bajar el umbral a $0.45$ provocó que clientes distintos consecutivos se fusionaran falsamente (por ejemplo, Cliente #1 y #2 en 7h formaron una quimera de 85 minutos).
* **Conclusión Teórica**: En espacios métricos de ArcFace/MobileFaceNet, la franja de similitud $[0.44, 0.50]$ representa la zona de solapamiento entre:
  1. La atenuación natural por ángulo de *yaw* ($\approx 60^\circ - 90^\circ$) de la **misma persona**.
  2. La similitud basal entre **dos personas distintas** del mismo biotipo (hombres jóvenes de tez y corte similar).
* **Criterio de Producción (Cero Falsos Positivos)**: Para garantizar que personas distintas jamás se unan, el umbral dinámico debe mantenerse firme en **$0.58$** para poses erguidas. La unión de sesiones con brechas prolongadas debe apoyarse en fotos intermedias o centroides consolidados, nunca en una rebaja ciega del umbral.

---

## 5. Verificación y Pruebas Automatizadas

* **Suite de Pruebas**: `npm test` ejecutado exitosamente con **21 de 21 suites pasando al 100%**:
  - Sanitización de Firestore y polígonos
  - Máquina de estados del `DaemonReporter`
  - Inferencia y mapeo de cuadrantes ONNX
  - Filtro de calidad facial y seguimiento de personas
  - Ciclos unificados de `processes.js`
  - Detector de capa y ancla espacial de silla Firebase
  - Descarga y fusión diaria Google Drive
  - Manejo de bloques y consensos en `TrackBlockManager`
