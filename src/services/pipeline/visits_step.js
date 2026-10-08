/**
 * 7. Gestión del ciclo de vida de sesiones de visita (apertura, actualización y cierre).
 */
export async function updateVisits({ visitService, tracker, activeTracks = [] }) {
  if (!visitService) return;

  for (const track of activeTracks) {
    await visitService.processTrack(track);
  }

  if (tracker?.historyTracks) {
    for (const lostTrack of tracker.historyTracks) {
      await visitService.closeSession(lostTrack.trackId);
    }
    tracker.historyTracks = [];
  }
}
