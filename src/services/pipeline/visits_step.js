/**
 * 7. Gestión del ciclo de vida de sesiones de visita (apertura, actualización y cierre).
 * La permanencia en la silla de corte y la gracia de 30 segundos gobiernan el ciclo de vida.
 */
export async function updateVisits({ visitService, tracker, activeTracks = [], now }) {
  if (!visitService) return;

  const currentNow = now || (typeof visitService.getNow === "function" ? visitService.getNow() : Date.now());

  for (const track of activeTracks) {
    await visitService.processTrack(track, { now: currentNow });
  }

  if (typeof visitService.checkChairTimeouts === "function") {
    await visitService.checkChairTimeouts(currentNow, activeTracks);
  } else if (tracker?.historyTracks) {
    for (const lostTrack of tracker.historyTracks) {
      await visitService.closeSession(lostTrack.trackId);
    }
  }

  if (tracker?.historyTracks) {
    tracker.historyTracks = [];
  }
}

export const STEP_NAME = "Gestión del Ciclo de Vida de Visitas y Citas";
export const STEP_DESCRIPTION = (timeoutSec = 45) =>
  `Gestión temporal del ciclo de vida de visitas, con tolerancia de ${timeoutSec}s de silla vacía y consolidación cronológica.`;
export const formatStepSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `7. **${STEP_NAME}:** ${imagesCount.toLocaleString()} imágenes, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`;
