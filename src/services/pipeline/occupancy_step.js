import { isServiceChair, isTransitZone } from "../../core/barbershop_rules.js";

/**
 * 8. Cálculo de métricas de ocupación en tiempo real.
 */
export function computeOccupancy({ quadrants = [], identifiedPeople = [], rawDetections = [] } = {}) {
  const clientsInCut = quadrants.filter(q =>
    isServiceChair(q) && (q.status === 'en_corte' || q.status === 'ocupada')
  ).length;

  const clientsWaiting = quadrants.filter(q =>
    (q.type === 'waiting_chair' || q.status === 'en_espera') && !isTransitZone(q)
  ).length;

  const activeBarbers = identifiedPeople.filter(p => p.isStaff).length ||
    quadrants.filter(q => q.status === 'en_servicio' || q.type === 'barber_workstation').length;

  const totalHumans = rawDetections.filter(d => d.class === 'person').length;

  return {
    clientsInCut,
    clientsWaiting,
    activeBarbers,
    totalHumans
  };
}
