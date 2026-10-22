import { isServiceChair, isTransitZone } from "../../core/barbershop_rules.js";

/**
 * 8. Cálculo de métricas de ocupación en tiempo real.
 */
export function computeOccupancy({ quadrants = [], identifiedPeople = [], rawDetections = [] } = {}) {
  const clientsInCut = quadrants.filter(q =>
    q.isConfiguredZone !== false &&
    isServiceChair(q) && (q.status === 'en_corte' || q.status === 'ocupada')
  ).length;

  const clientsWaiting = quadrants.filter(q =>
    q.isConfiguredZone !== false &&
    (q.type === 'waiting_chair' || q.status === 'en_espera') && !isTransitZone(q)
  ).length;

  const activeBarbers = identifiedPeople.filter(p => p.isStaff).length ||
    quadrants.filter(q => q.isConfiguredZone !== false && (q.status === 'en_servicio' || q.type === 'barber_workstation')).length;

  const totalHumans = rawDetections.filter(d => d.class === 'person').length;

  return {
    clientsInCut,
    clientsWaiting,
    activeBarbers,
    totalHumans
  };
}

export const STEP_NAME = "Métricas de Ocupación";
export const STEP_DESCRIPTION = (occ = {}) =>
  `Ocupación actual en barbería: ${occ.clientsInCut || 0} en corte, ${occ.clientsWaiting || 0} en espera, ${occ.activeBarbers || 0} barberos activos.`;
export const formatStepSummary = (imagesCount = 0, appointmentsCount = 0, details = "") =>
  `**${STEP_NAME}:** ${imagesCount.toLocaleString()} imágenes evaluadas, ${appointmentsCount} atenciones.${details ? `\n   - *${details}*` : ""}`;

