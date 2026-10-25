/**
 * Orquestador Causal Canónico del Ciclo de Vida de Visitas y Bloques
 * 
 * Mantiene compatibilidad hacia atrás delegando directamente en canonical_causal_pipeline.js
 */

export {
  evaluateCropStep,
  ingestSampleStep,
  evaluateInactiveBlocksStep,
  dispatchConfirmedBlocksStep,
  heartbeatStep,
  executeCausalCycle,
  flushCausalPipeline
} from "./canonical_causal_pipeline.js";

import {
  ingestSampleStep,
  evaluateInactiveBlocksStep,
  dispatchConfirmedBlocksStep,
  heartbeatStep,
  flushCausalPipeline as canonicalFlush
} from "./canonical_causal_pipeline.js";

/**
 * Ingesta una muestra atómica de track o recorte y evalúa bloques inactivos.
 */
export async function processCausalSample({
  sample,
  trackBlockManager,
  visitService,
  options = {}
}) {
  if (!trackBlockManager || !visitService || !sample) return [];

  ingestSampleStep({ sample, trackBlockManager });

  const confirmedBlocks = evaluateInactiveBlocksStep({
    trackBlockManager,
    timestampEpoch: sample.timestampEpoch,
    options
  });

  return await dispatchConfirmedBlocksStep({
    confirmedBlocks,
    visitService,
    timestampEpoch: sample.timestampEpoch,
    options
  });
}

/**
 * Avanza el reloj virtual causal evaluando timeouts de vacancia de silla paso a paso.
 */
export async function advanceCausalHeartbeat(params) {
  return await heartbeatStep(params);
}
