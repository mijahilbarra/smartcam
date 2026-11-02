/**
 * Feed de decisiones del análisis (explicabilidad en vivo).
 *
 * Convierte las decisiones del pipeline (bloques confirmados/descartados, fusiones,
 * clientes nuevos, rotaciones, vetos biométricos, descartes) en eventos SSE
 * `analysis_decision` para que la UI las muestre como cards temporales con el
 * motivo de cada decisión.
 */
import { telemetryStream } from "../../infrastructure/streaming/telemetry_stream.js";

const DEDUP_WINDOW_MS = 3000;
const recentKeys = new Map();
let seq = 0;

/** Etiquetas legibles para los veredictos atómicos de TrackBlockManager. */
const BLOCK_VERDICTS = {
  CONFIRMED_CLIENT_BLOCK: { kind: "block_confirmed", tone: "success", title: "Bloque confirmado: cliente real" },
  DISCARDED_OUTSIDE_CHAIR: { kind: "block_discarded", tone: "warning", title: "Desaparece: estaba fuera de la silla" },
  DISCARDED_BARBER: { kind: "block_discarded", tone: "warning", title: "Descartado: es el barbero" },
  DISCARDED_BARBER_STANDING: { kind: "block_discarded", tone: "warning", title: "Descartado: persona de pie (staff)" },
  DISCARDED_NO_ANATOMICAL_FACE: { kind: "block_discarded", tone: "warning", title: "Descartado: sin rostro válido (nuca/pelo)" },
  DISCARDED_EPHEMERAL_PASSING: { kind: "block_discarded", tone: "warning", title: "Descartado: paso muy breve" }
};

/**
 * Clasifica un log verbal del pipeline en una decisión explicable.
 * @param {string} text
 * @returns {{kind: string, tone: string, title: string}|null}
 */
export function classifyVerbalLog(text) {
  if (!text || typeof text !== "string") return null;
  if (text.includes("[DEBUG")) return null;

  if (/consolidado en la atención en curso|🔗/.test(text)) {
    return { kind: "merge", tone: "info", title: "Se fusionó con la atención anterior" };
  }
  if (/🆕 Nuevo cliente/.test(text)) {
    return { kind: "new_client", tone: "success", title: "Nuevo cliente registrado" };
  }
  if (/identificado como recurrente/.test(text)) {
    return { kind: "returning", tone: "success", title: "Cliente recurrente reconocido" };
  }
  if (/Rotación de cliente detectada|Veto Homólogo directo/.test(text)) {
    return { kind: "rotation", tone: "warning", title: "Cambió la persona en la silla (nuevo cliente)" };
  }
  if (/🛑/.test(text)) {
    return { kind: "no_merge", tone: "warning", title: "No se fusionó: biometría incompatible" };
  }
  if (/🛡️/.test(text)) {
    return { kind: "continuity", tone: "info", title: "Misma persona: se mantiene la sesión" };
  }
  if (/de pie detectada/.test(text)) {
    return { kind: "standing", tone: "neutral", title: "Persona de pie: no se abre sesión" };
  }
  if (/descartad[ao]/.test(text)) {
    return { kind: "discarded", tone: "warning", title: "Estancia descartada" };
  }
  if (/Auto-eliminando perfil|purgada tras puente/.test(text)) {
    return { kind: "purge", tone: "neutral", title: "Perfil temporal eliminado" };
  }
  return null;
}

/** Quita emojis iniciales y prefijos técnicos de un log para mostrarlo como motivo. */
function cleanReason(text) {
  return String(text)
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^[^\p{L}\p{N}"'(]+/u, "")
    .trim();
}

/**
 * Emite una decisión a los clientes SSE (con deduplicación por ventana corta).
 */
export function emitDecision({ kind, tone = "info", title, reason, trackId = null, chairName = null }) {
  if (!title) return;
  const key = `${kind}|${title}|${reason}`;
  const now = Date.now();
  const last = recentKeys.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return;
  recentKeys.set(key, now);
  if (recentKeys.size > 200) {
    for (const [k, t] of recentKeys) if (now - t > DEDUP_WINDOW_MS) recentKeys.delete(k);
  }

  try {
    telemetryStream.broadcastEvent("analysis_decision", {
      id: `dec_${now}_${++seq}`,
      kind,
      tone,
      title,
      reason: reason || "",
      trackId,
      chairName,
      emittedAt: now,
      ttlMs: 15000
    });
  } catch (_) {}
}

/** Hook para VisitSessionService.logVerbal. */
export function emitDecisionFromLog(text) {
  const cls = classifyVerbalLog(text);
  if (!cls) return;
  emitDecision({ ...cls, reason: cleanReason(text) });
}

/** Hook para TrackBlockManager.onBlockDecided. */
export function emitBlockDecision(decision) {
  const meta = BLOCK_VERDICTS[decision?.verdict];
  if (!meta) return;
  emitDecision({
    ...meta,
    reason: decision.reason,
    trackId: decision.block?.trackId ?? null,
    chairName: decision.block?.chairId ?? null
  });
}
