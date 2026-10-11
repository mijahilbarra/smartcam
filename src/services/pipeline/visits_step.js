/**
 * 7. Gestión del ciclo de vida de sesiones de visita (apertura, actualización y cierre).
 * La permanencia en la silla de corte y la gracia de 30 segundos gobiernan el ciclo de vida.
 */
export async function updateVisits({ visitService, tracker, activeTracks = [] }) {
  if (!visitService) return;

  for (const track of activeTracks) {
    await visitService.processTrack(track);
  }

  if (typeof visitService.checkChairTimeouts === "function") {
    await visitService.checkChairTimeouts(Date.now(), activeTracks);
  } else if (tracker?.historyTracks) {
    for (const lostTrack of tracker.historyTracks) {
      await visitService.closeSession(lostTrack.trackId);
    }
  }

  if (tracker?.historyTracks) {
    tracker.historyTracks = [];
  }
}
