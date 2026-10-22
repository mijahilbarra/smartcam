# 20. Regla Fundamental de Arquitectura: Cero Tiempos Estáticos y Gobernanza Biométrica de Sesiones

**Estado:** Aprobado  
**Fecha:** 2026-10-17  
**Contexto:** Gestión de Atenciones y Detección de Citas en Sillas de Barbería (`VisitSessionService`)

---

## 1. Contexto y Problema

Durante las iteraciones previas del sistema de captura, se introdujeron heurísticas basadas en temporizadores fijos y límites artificiales de tiempo:
1. **Límite máximo estático (Hard Cap de 50/60 minutos):** Diseñado como salvaguarda para forzar el cierre de sesiones abiertas, provocaba que atenciones legítimas largas se truncaran a los 60 minutos exactos, o que citas que ya habían finalizado se mantuvieran abiertas artificialmente absorbiendo al cliente siguiente.
2. **Temporizadores frágiles de liberación rápida (30 segundos):** En una barbería real, un cliente no finaliza su cita cuando el barbero se aparta durante 35-45 segundos a buscar una toalla caliente, lavar tijeras o preparar espuma. Un timer estático de 30s fragmentaba cortes complejos (cabello + afeitado) en dos citas artificiales.
3. **Temporizadores excesivos de liberación (5 minutos):** Al subir el timer ciegamente a 300 segundos, este superaba la brecha física real de cambio entre clientes (1.5 a 3 minutos), impidiendo que la cita previa cerrara antes de que el siguiente cliente tomara asiento.

---

## 2. Decisión Arquitectónica: Regla de CERO Tiempos Estáticos

Se establece como regla arquitectónica inviolable que **ninguna atención o cita de cliente puede ser iniciada, cerrada o fragmentada por límites estáticos de reloj (hard caps o timers ciegos)**.

El ciclo de vida de una atención en la silla de servicio se gobierna exclusivamente mediante dos factores:
1. **Transición Biométrica de Identidad (Biometric Identity Transition):**
   - La sesión está anclada a la silla física (`chairId`).
   - Dos personas distintas en la escena presentan una similitud coseno máxima `< 0.58` (matriz empírica calculada entre 0.31 y 0.567).
   - Un mismo cliente en poses compatibles presenta similitudes `>= 0.58` (entre 0.65 y 0.85).
   - Cuando una persona en la silla presenta un rostro con similitud `< 0.58` respecto a la galería de la atención, y se confirma con consenso de 2 muestras consistentes, se declara una **Rotación de Cliente**: la cita previa finaliza de forma inmediata y comienza la nueva cita.
2. **Eventos Físicos de Escena y Presencia Real:**
   - La atención dura lo que físicamente dura la permanencia del cliente en el servicio.
   - Si la silla se desocupa (el cliente se va), la sesión entra en `esperando_liberacion` conservando la marca de tiempo de salida (`emptySinceEpoch`).
   - Al entrar el nuevo cliente, la cita previa se cierra formalmente con fecha y hora exacta de `emptySinceEpoch`.
   - Se erradican por completo los cortes arbitrarios a los 50 o 60 minutos.

---

## 3. Consecuencias y Beneficios

- **Respeto a la Realidad Operativa:** Atenciones cortas (ej. perfilado de 15 min) o largas (ej. corte completo, lavado y barba de 70 min) se registran con su duración real exacta.
- **Cero Fragmentación por Pausas:** Procesos de afeitado con toalla caliente o espera de tijeras no provocan escisiones en la cita.
- **Pureza de Galerías:** Ningún cliente absorbe fotos del cliente posterior ni se fusionan rostros de distintas personas.
