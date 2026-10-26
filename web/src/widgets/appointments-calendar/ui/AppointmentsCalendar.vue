<script setup>
import { ref, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import DeleteAppointmentModal from './DeleteAppointmentModal.vue';
import ClientPhotosModal from '@/widgets/people-directory/ui/ClientPhotosModal.vue';
import { useAppointments } from '@/entities/appointment/model/useAppointments';
import { usePeople } from '@/entities/person/model/usePeople';
import { useSettings } from '@/features/configure-settings/model/useSettings';
import { getBestFaceThumbnail, isValidImageUrl, getPhotoUrl } from '@/shared/lib/photo-utils';

const emit = defineEmits(['open-person', 'open-photo']);

const { appointments, loading, error, refresh, deleteAppointment } = useAppointments();
const { people, deletePerson } = usePeople();
const { workingHours } = useSettings();

// Altura visual por hora en la cuadrícula (px por hora, ~1.2px por minuto)
const HOUR_HEIGHT = 72;

// Control de semana actual (fecha base de la semana seleccionada)
const currentWeekBase = ref(new Date());

// Filtrado y navegación de semana
const weekDays = computed(() => {
  const base = new Date(currentWeekBase.value);
  const day = base.getDay();
  // Lunes como inicio de semana (1)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(base);
  monday.setDate(base.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const days = [];
  const dayNames = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      dateObj: d,
      name: dayNames[i],
      dateFormatted: `${d.getDate()}/${d.getMonth() + 1}`,
      isoDate: d.toISOString().split('T')[0]
    });
  }
  return days;
});

const todayIso = computed(() => new Date().toISOString().split('T')[0]);

const weekRangeLabel = computed(() => {
  if (weekDays.value.length === 0) return '';
  const first = weekDays.value[0].dateObj;
  const last = weekDays.value[6].dateObj;

  const options = { day: 'numeric', month: 'short' };
  const firstStr = first.toLocaleDateString('es-ES', options);
  const lastStr = last.toLocaleDateString('es-ES', { ...options, year: 'numeric' });
  return `${firstStr} - ${lastStr}`;
});

const goToPreviousWeek = () => {
  const d = new Date(currentWeekBase.value);
  d.setDate(d.getDate() - 7);
  currentWeekBase.value = d;
};

const goToNextWeek = () => {
  const d = new Date(currentWeekBase.value);
  d.setDate(d.getDate() + 7);
  currentWeekBase.value = d;
};

const goToToday = () => {
  currentWeekBase.value = new Date();
};

// Filtros de silla
const selectedChairFilter = ref('all'); // 'all' | 'Silla 1' | 'Silla 2'

// Filtrar atenciones para la semana visible y asegurar paridad con el directorio de personas
const filteredAppointments = computed(() => {
  if (!Array.isArray(appointments.value)) return [];

  const startIso = weekDays.value[0]?.isoDate;
  const endIso = weekDays.value[6]?.isoDate;

  return appointments.value.filter((apt) => {
    if (!apt.startTime) return false;
    const aptDateStr = apt.startTime.split('T')[0];

    // Filtro por rango semanal
    if (aptDateStr < startIso || aptDateStr > endIso) return false;

    // Descartar citas huérfanas de perfiles que ya no existen en el Directorio
    if (!loading.value && people.value.length > 0) {
      const pId = apt.clientId || apt.personId;
      const foundInPeople = people.value.some((p) => p.id === pId || (apt.clientName && p.name === apt.clientName));
      if (!foundInPeople) return false;
    }

    // Filtro por silla flexible (silla_corte_1, Silla 1, etc.)
    if (selectedChairFilter.value !== 'all') {
      const filterKey = selectedChairFilter.value.toLowerCase().replace(/[^a-z0-9]/g, '');
      const aptChairId = (apt.chairId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const aptChairName = (apt.chairName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!aptChairId.includes(filterKey) && !aptChairName.includes(filterKey)) {
        return false;
      }
    }

    return true;
  });
});

// Parseo de horario de atención configurado en Firebase (camera_catcher/prompt -> workingHours)
const operatingStartMinutes = computed(() => {
  const [h, m] = (workingHours.value?.start || '11:00').split(':').map(Number);
  return (h || 11) * 60 + (m || 0);
});

const operatingEndMinutes = computed(() => {
  const [h, m] = (workingHours.value?.end || '23:00').split(':').map(Number);
  return (h || 23) * 60 + (m || 0);
});

const operatingStartHour = computed(() => Math.floor(operatingStartMinutes.value / 60));
const operatingEndHour = computed(() => Math.ceil(operatingEndMinutes.value / 60));

const workingHoursDurationLabel = computed(() => {
  const totalMin = Math.max(0, operatingEndMinutes.value - operatingStartMinutes.value);
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hrs}h ${min}m` : `${hrs} horas`;
});

// Rango dinámico visible del eje vertical (inicia en horario de atención, expandible si hay citas fuera)
const gridRange = computed(() => {
  let startHour = operatingStartHour.value;
  let endHour = operatingEndHour.value;

  if (Array.isArray(filteredAppointments.value)) {
    for (const apt of filteredAppointments.value) {
      if (!apt.startTime) continue;
      const dS = new Date(apt.startTime);
      const sH = dS.getHours();
      if (!isNaN(sH) && sH < startHour) startHour = sH;

      const dE = new Date(apt.endTime || apt.startTime);
      const eH = dE.getHours() + (dE.getMinutes() > 0 ? 1 : 0);
      if (!isNaN(eH) && eH > endHour) endHour = Math.min(24, eH);
    }
  }

  if (endHour <= startHour) endHour = startHour + 12;

  return {
    startHour,
    endHour,
    startMinutes: startHour * 60,
    endMinutes: endHour * 60,
    totalHours: endHour - startHour
  };
});

// Ranuras horarias para la regla lateral izquierda (11:00, 12:00, ..., 23:00)
const hourSlots = computed(() => {
  const slots = [];
  const { startHour, endHour } = gridRange.value;
  for (let h = startHour; h <= endHour; h++) {
    slots.push({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`
    });
  }
  return slots;
});

const totalGridHeightPx = computed(() => {
  return gridRange.value.totalHours * HOUR_HEIGHT;
});

// Estilo de la franja que resalta la altura exacta del Horario de Atención de Firebase
const operatingZoneStyle = computed(() => {
  const gridStartMin = gridRange.value.startMinutes;
  const topMin = Math.max(0, operatingStartMinutes.value - gridStartMin);
  const heightMin = Math.max(0, operatingEndMinutes.value - operatingStartMinutes.value);

  return {
    top: `${(topMin / 60) * HOUR_HEIGHT}px`,
    height: `${(heightMin / 60) * HOUR_HEIGHT}px`
  };
});

// Indicador de hora actual para el día de hoy (línea roja tipo Google Calendar)
const currentTimeTopPx = computed(() => {
  const now = new Date();
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const gridStartMin = gridRange.value.startMinutes;
  if (currentMin < gridStartMin || currentMin > gridRange.value.endMinutes) return null;
  return ((currentMin - gridStartMin) / 60) * HOUR_HEIGHT;
});

// Algoritmo de posicionamiento tipo Google Calendar para eventos superpuestos
function layoutDayAppointments(dayAppointments, gridStartMinutes, hourHeight) {
  if (!dayAppointments || dayAppointments.length === 0) return [];

  const sorted = [...dayAppointments].sort((a, b) => {
    const startA = new Date(a.startTime).getTime();
    const startB = new Date(b.startTime).getTime();
    if (startA !== startB) return startA - startB;
    return (b.durationMinutes || 45) - (a.durationMinutes || 45);
  });

  const parsed = sorted.map((apt) => {
    const dStart = new Date(apt.startTime);
    const dEnd = new Date(apt.endTime || apt.startTime);

    // Minutos exactos incluyendo segundos para evitar desfaces y falsos solapamientos
    let startMin = dStart.getHours() * 60 + dStart.getMinutes() + (dStart.getSeconds() / 60);
    let endMin = dEnd.getHours() * 60 + dEnd.getMinutes() + (dEnd.getSeconds() / 60);

    if (isNaN(startMin)) startMin = gridStartMinutes;
    if (isNaN(endMin) || endMin <= startMin) {
      endMin = startMin + (apt.durationMinutes || 45);
    }
    const durationMin = Math.max(1, endMin - startMin);

    const top = Math.max(0, ((startMin - gridStartMinutes) / 60) * hourHeight);
    const height = Math.max(28, (durationMin / 60) * hourHeight);

    return {
      apt,
      startMin,
      endMin,
      durationMin,
      top,
      height,
      col: 0,
      totalCols: 1
    };
  });

  // Detección estricta de solapamiento temporal real entre citas
  for (let i = 0; i < parsed.length; i++) {
    const overlapping = [];
    for (let j = 0; j < parsed.length; j++) {
      if (i === j) continue;
      // Dos citas solo se solapan si una empieza antes de que la otra termine (con tolerancia de 6s)
      const isOverlap = Math.max(parsed[i].startMin, parsed[j].startMin) < Math.min(parsed[i].endMin, parsed[j].endMin) - 0.1;
      if (isOverlap) {
        overlapping.push(parsed[j]);
      }
    }
    parsed[i]._overlapping = overlapping;
  }

  // Agrupar únicamente citas que realmente colisionan en columnas paralelas
  const visited = new Set();
  for (let i = 0; i < parsed.length; i++) {
    if (visited.has(i)) continue;

    // Si la cita es consecutiva o no colisiona con ninguna otra, usa el 100% del ancho
    if (parsed[i]._overlapping.length === 0) {
      parsed[i].col = 0;
      parsed[i].totalCols = 1;
      visited.add(i);
      continue;
    }

    // Componente conectado de citas simultáneas
    const component = [];
    const queue = [parsed[i]];
    visited.add(i);

    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);

      for (const neighbor of current._overlapping) {
        const neighborIdx = parsed.indexOf(neighbor);
        if (neighborIdx !== -1 && !visited.has(neighborIdx)) {
          visited.add(neighborIdx);
          queue.push(neighbor);
        }
      }
    }

    component.sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));

    const columnEnds = [];
    for (const item of component) {
      let placed = false;
      for (let c = 0; c < columnEnds.length; c++) {
        if (columnEnds[c] <= item.startMin + 0.1) {
          item.col = c;
          columnEnds[c] = item.endMin;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item.col = columnEnds.length;
        columnEnds.push(item.endMin);
      }
    }

    const totalCols = Math.max(1, columnEnds.length);
    for (const item of component) {
      item.totalCols = totalCols;
    }
  }

  return parsed.map((item) => {
    const colWidthPct = 100 / item.totalCols;
    const leftPct = item.col * colWidthPct;
    return {
      ...item.apt,
      _layout: {
        top: item.top,
        height: item.height,
        left: item.totalCols === 1 ? '1px' : `calc(${leftPct}% + 1px)`,
        width: item.totalCols === 1 ? 'calc(100% - 2px)' : `calc(${colWidthPct}% - 2px)`
      }
    };
  });
}

// Agrupar y posicionar atenciones por día
const positionedAppointmentsByDay = computed(() => {
  const map = {};
  const gridStartMin = gridRange.value.startMinutes;

  weekDays.value.forEach((d) => {
    map[d.isoDate] = [];
  });

  filteredAppointments.value.forEach((apt) => {
    const dStr = apt.startTime.split('T')[0];
    if (map[dStr]) {
      map[dStr].push(apt);
    }
  });

  const resultMap = {};
  weekDays.value.forEach((d) => {
    resultMap[d.isoDate] = layoutDayAppointments(map[d.isoDate] || [], gridStartMin, HOUR_HEIGHT);
  });

  return resultMap;
});

// Total de atenciones por día
const countByDay = computed(() => {
  const map = {};
  weekDays.value.forEach((d) => {
    map[d.isoDate] = (positionedAppointmentsByDay.value[d.isoDate] || []).length;
  });
  return map;
});

// Panel Lateral Derecho: Selección de Atención
const selectedAppointment = ref(null);

const selectAppointment = (apt) => {
  selectedAppointment.value = apt;
};

const closeDetailPanel = () => {
  selectedAppointment.value = null;
};

// Modal de visualización de fotos completas del cliente
const selectedPersonForClientModal = ref(null);
const isClientPhotosModalOpen = ref(false);

const openClientHistoryModal = () => {
  if (!selectedAppointment.value) return;
  const client = getAppointmentClient(selectedAppointment.value);
  if (client) {
    selectedPersonForClientModal.value = client;
  } else {
    selectedPersonForClientModal.value = {
      id: selectedAppointment.value.personId || selectedAppointment.value.clientId || 'temp',
      name: selectedAppointment.value.clientName || 'Cliente',
      photos: selectedAppointment.value.photos || [],
      visitCount: 1,
      bestFaceScore: selectedAppointment.value.photos?.[0]?.sharpnessScore || 0
    };
  }
  isClientPhotosModalOpen.value = true;
};

// Estado de Eliminación de Atención
const appointmentToDelete = ref(null);
const isDeleteModalOpen = ref(false);
const isDeleting = ref(false);

const matchedPersonToDelete = computed(() => {
  return appointmentToDelete.value ? getAppointmentClient(appointmentToDelete.value) : null;
});

const promptDeleteAppointment = (apt) => {
  appointmentToDelete.value = apt;
  isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
  if (isDeleting.value) return;
  isDeleteModalOpen.value = false;
  appointmentToDelete.value = null;
};

const handleConfirmDelete = async ({ appointmentId }) => {
  if (!appointmentId) return;

  isDeleting.value = true;
  try {
    await deleteAppointment(appointmentId);
    isDeleteModalOpen.value = false;
    appointmentToDelete.value = null;

    if (selectedAppointment.value?.id === appointmentId) {
      closeDetailPanel();
    }
  } catch (err) {
    console.error('[AppointmentsCalendar] Error al eliminar:', err);
    alert(`Error al eliminar: ${err.message}`);
  } finally {
    isDeleting.value = false;
  }
};

const formatTimeOnly = (isoString) => {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
};

const getAppointmentAvatar = (apt) => {
  if (!apt) return '';
  if (Array.isArray(apt.photos) && apt.photos.length > 0) {
    const best = getBestFaceThumbnail(apt.photos, apt.avatarUrl, apt.bestFaceScore);
    if (best) return best;
  }
  if (isValidImageUrl(apt.avatarUrl)) return apt.avatarUrl;
  return '';
};

const getPhotoSrc = (photo) => {
  return getPhotoUrl(photo);
};

// Resuelve reactivamente el cliente desde el directorio 'people'
const getAppointmentClient = (apt) => {
  if (!apt) return null;
  const pId = apt.clientId || apt.personId;
  if (pId) {
    const found = people.value.find((p) => p.id === pId);
    if (found) return found;
  }
  if (apt.clientName && apt.clientName !== 'Cliente') {
    return people.value.find((p) => p.name === apt.clientName) || null;
  }
  return null;
};

const getClientDisplayName = (apt) => {
  const client = getAppointmentClient(apt);
  return client?.name || apt?.clientName || 'Cliente';
};

const getClientDisplayAvatar = (apt) => {
  const client = getAppointmentClient(apt);
  if (client) {
    if (Array.isArray(client.photos) && client.photos.length > 0) {
      const best = getBestFaceThumbnail(client.photos, client.thumbnailBase64, client.bestFaceScore);
      if (best) return best;
    }
    if (isValidImageUrl(client.thumbnailBase64)) return client.thumbnailBase64;
  }
  return getAppointmentAvatar(apt);
};

const getClientDisplayBadge = (apt) => {
  const client = getAppointmentClient(apt);
  if (client) {
    if (client.isStaff) return 'Barbero';
    return (client.visitCount || 1) > 1 ? 'Frecuente' : 'Nuevo';
  }
  return apt?.clientBadge || 'Cliente';
};

const getClientBadgeInitial = (apt) => {
  const badge = getClientDisplayBadge(apt);
  if (badge === 'Frecuente' || badge === 'Cliente Frecuente') return 'F';
  if (badge === 'Nuevo' || badge === 'Nuevo Cliente') return 'N';
  if (badge === 'Barbero') return 'B';
  return (badge.charAt(0) || 'C').toUpperCase();
};

const getClientAppointments = (personId) => {
  if (!personId || !Array.isArray(appointments.value)) return [];
  return appointments.value.filter((a) => a.clientId === personId || a.personId === personId);
};
</script>

<template>
  <div class="space-y-5">
    <!-- Header de Controles del Calendario -->
    <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-slate-900/80 border border-slate-800 p-4 rounded-2xl shadow-lg">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
          <AppIcon name="calendar_month" :size="22" />
        </div>
        <div>
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-base font-bold text-white flex items-center gap-2">
              Agenda Semanal de Atenciones
            </h2>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/30 font-mono">
              {{ weekRangeLabel }}
            </span>
          </div>
          <!-- Indicador visual de Horario de Atención sincronizado con Firebase -->
          <div class="flex items-center gap-2 mt-1 text-xs text-slate-400">
            <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-800/90 border border-slate-700/80 text-slate-300 font-mono text-[11px]">
              <AppIcon name="schedule" :size="13" class="text-emerald-400" />
              <span>Horario de Atención:</span>
              <strong class="text-white">{{ workingHours.start }} - {{ workingHours.end }}</strong>
              <span class="text-emerald-400">({{ workingHoursDurationLabel }})</span>
            </span>
          </div>
        </div>
      </div>

      <!-- Controles de Navegación y Filtros de Silla -->
      <div class="flex flex-wrap items-center gap-2.5">
        <!-- Selector de Silla -->
        <div class="flex items-center bg-slate-800/80 border border-slate-700/60 rounded-xl p-1 text-xs">
          <button
            type="button"
            @click="selectedChairFilter = 'all'"
            :class="[
              'px-3 py-1.5 rounded-lg font-medium transition cursor-pointer',
              selectedChairFilter === 'all' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'
            ]"
          >
            Todas las Sillas
          </button>
          <button
            type="button"
            @click="selectedChairFilter = 'Silla 1'"
            :class="[
              'px-3 py-1.5 rounded-lg font-medium transition cursor-pointer',
              selectedChairFilter === 'Silla 1' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'
            ]"
          >
            Silla 1
          </button>
          <button
            type="button"
            @click="selectedChairFilter = 'Silla 2'"
            :class="[
              'px-3 py-1.5 rounded-lg font-medium transition cursor-pointer',
              selectedChairFilter === 'Silla 2' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'
            ]"
          >
            Silla 2
          </button>
        </div>

        <!-- Botones de Navegación Temporal -->
        <div class="flex items-center gap-1.5">
          <AppButton
            variant="secondary"
            size="sm"
            @click="goToPreviousWeek"
            title="Semana Anterior"
            class="bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
          >
            <AppIcon name="chevron_left" :size="18" />
            <span class="hidden sm:inline">Anterior</span>
          </AppButton>

          <AppButton
            variant="primary"
            size="sm"
            @click="goToToday"
            class="bg-blue-600 hover:bg-blue-500 text-white shadow-md font-semibold"
          >
            Hoy
          </AppButton>

          <AppButton
            variant="secondary"
            size="sm"
            @click="goToNextWeek"
            title="Semana Siguiente"
            class="bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
          >
            <span class="hidden sm:inline">Siguiente</span>
            <AppIcon name="chevron_right" :size="18" />
          </AppButton>
        </div>
      </div>
    </div>

    <!-- Layout Principal: Cuadrícula de Agenda + Panel Lateral Derecho de Especificaciones -->
    <div class="flex flex-col lg:flex-row items-start gap-4">
      <!-- 1. Google Calendar View Container -->
      <div class="flex-1 w-full min-w-0 rounded-2xl border border-slate-800 bg-slate-950/70 shadow-xl overflow-hidden flex flex-col">
        <!-- Scroll horizontal contenedor para pantallas pequeñas y tablets -->
        <div class="overflow-x-auto">
          <div class="min-w-[760px] flex flex-col">
            <!-- Cabecera Fija de Días de la Semana (Lunes a Domingo) -->
            <div class="flex border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-20">
              <!-- Esquina superior izquierda (Alineada con la regla de horas) -->
              <div class="w-16 shrink-0 border-r border-slate-800/80 p-2.5 flex items-center justify-center text-[11px] font-mono font-bold text-slate-500">
                <AppIcon name="schedule" :size="15" />
              </div>

              <!-- 7 Columnas de Encabezado de Días -->
              <div class="flex-1 grid grid-cols-7">
                <div
                  v-for="day in weekDays"
                  :key="day.isoDate"
                  class="p-2.5 text-center border-r border-slate-800/60 last:border-r-0 flex flex-col items-center justify-center transition"
                  :class="day.isoDate === todayIso ? 'bg-blue-950/30' : ''"
                >
                  <span
                    class="text-[11px] uppercase tracking-wider font-bold block"
                    :class="day.isoDate === todayIso ? 'text-blue-400' : 'text-slate-400'"
                  >
                    {{ day.name }}
                  </span>
                  <span
                    class="text-sm font-extrabold mt-0.5 inline-flex items-center justify-center w-7 h-7 rounded-full font-mono transition"
                    :class="day.isoDate === todayIso
                      ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                      : 'text-slate-200'"
                  >
                    {{ day.dateObj.getDate() }}
                  </span>
                  <span class="text-[10px] text-slate-500 font-mono mt-0.5">
                    {{ countByDay[day.isoDate] || 0 }} {{ (countByDay[day.isoDate] || 0) === 1 ? 'cita' : 'citas' }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Cuerpo de la Agenda (Regla Horaria + 7 Columnas Temporales) -->
            <div class="flex relative bg-slate-950/40" :style="{ height: `${totalGridHeightPx}px` }">
              <!-- Regla Lateral Izquierda de Horas -->
              <div class="w-16 shrink-0 border-r border-slate-800/80 relative select-none bg-slate-950/80">
                <div
                  v-for="(slot, idx) in hourSlots"
                  :key="slot.hour"
                  class="absolute left-0 right-0 pr-2 text-right text-[11px] font-mono text-slate-400 font-semibold"
                  :style="{ top: `${idx * HOUR_HEIGHT - 8}px` }"
                >
                  {{ slot.label }}
                </div>
              </div>

              <!-- 7 Columnas de Días con Tarjetas en Posición Temporal Exacta -->
              <div class="flex-1 grid grid-cols-7 relative">
                <div
                  v-for="day in weekDays"
                  :key="day.isoDate"
                  class="relative border-r border-slate-800/60 last:border-r-0 h-full overflow-hidden"
                  :class="day.isoDate === todayIso ? 'bg-blue-950/10' : ''"
                >
                  <!-- Franja de Horario de Atención de Firebase (fondo sutil) -->
                  <div
                    class="absolute inset-x-0 bg-slate-900/30 border-y border-blue-500/10 pointer-events-none"
                    :style="operatingZoneStyle"
                    title="Horario de Atención oficial"
                  ></div>

                  <!-- Líneas Divisorias de Horas de Fondo -->
                  <div
                    v-for="(slot, idx) in hourSlots"
                    :key="slot.hour"
                    class="absolute inset-x-0 border-b border-slate-800/40 pointer-events-none"
                    :style="{ top: `${idx * HOUR_HEIGHT}px` }"
                  ></div>

                  <!-- Líneas medias (media hora) discontinuas -->
                  <div
                    v-for="(slot, idx) in hourSlots.slice(0, -1)"
                    :key="`half-${slot.hour}`"
                    class="absolute inset-x-0 border-b border-slate-800/20 border-dashed pointer-events-none"
                    :style="{ top: `${(idx + 0.5) * HOUR_HEIGHT}px` }"
                  ></div>

                  <!-- Línea Roja de Hora Actual (si es el día de hoy) -->
                  <div
                    v-if="day.isoDate === todayIso && currentTimeTopPx !== null"
                    class="absolute inset-x-0 border-t-2 border-red-500 z-10 pointer-events-none flex items-center"
                    :style="{ top: `${currentTimeTopPx}px` }"
                  >
                    <span class="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1 shadow-sm shadow-red-500"></span>
                  </div>

                  <!-- Tarjetas de Atenciones (Un solo row orientado arriba: Foto con tamaño máx, N o F, y chip de tiempo) -->
                  <div
                    v-for="apt in (positionedAppointmentsByDay[day.isoDate] || [])"
                    :key="apt.id"
                    @click="selectAppointment(apt)"
                    :style="{
                      top: `${apt._layout.top}px`,
                      height: `${apt._layout.height}px`,
                      left: apt._layout.left,
                      width: apt._layout.width
                    }"
                    class="group absolute rounded-lg border transition-all duration-150 cursor-pointer shadow-sm hover:shadow-xl hover:z-20 overflow-hidden flex items-start px-1.5 py-1 box-border"
                    :class="[
                      selectedAppointment?.id === apt.id
                        ? 'ring-2 ring-blue-400 bg-slate-850 shadow-blue-900/40 z-20'
                        : '',
                      apt.chairId === 'Silla 1' || (apt.chairId || '').includes('1')
                        ? 'bg-slate-900/95 border-l-4 border-l-blue-500 border-slate-700/80 hover:border-blue-400 hover:bg-slate-850'
                        : 'bg-slate-900/95 border-l-4 border-l-emerald-500 border-slate-700/80 hover:border-emerald-400 hover:bg-slate-850'
                    ]"
                  >
                    <!-- Un solo row: foto de cliente orientada arriba con tamaño máx, N o F (primera letra), y chip de tiempo -->
                    <div class="flex items-center gap-1.5 w-full min-w-0">
                      <!-- 1. Foto de cliente: orientada a la parte superior con tamaño máximo -->
                      <div class="w-7 h-7 sm:w-8 sm:h-8 max-h-[32px] max-w-[32px] aspect-square rounded-md overflow-hidden shrink-0 bg-slate-800 border border-slate-700 shadow-inner flex items-center justify-center">
                        <img
                          v-if="getClientDisplayAvatar(apt)"
                          :src="getClientDisplayAvatar(apt)"
                          alt="Foto sesión"
                          class="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                          @error="apt.avatarUrl = ''"
                        />
                        <div v-else class="w-full h-full flex items-center justify-center text-slate-400 bg-slate-800">
                          <AppIcon name="person" :size="12" />
                        </div>
                      </div>

                      <!-- 2. N o F (primera letra) -->
                      <span
                        class="w-4 h-4 rounded-full inline-flex items-center justify-center text-[9px] font-extrabold font-mono shrink-0 border leading-none"
                        :class="getClientBadgeInitial(apt) === 'F'
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                          : (getClientBadgeInitial(apt) === 'N'
                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                            : 'bg-blue-500/20 text-blue-300 border-blue-500/40')"
                        :title="getClientDisplayBadge(apt)"
                      >
                        {{ getClientBadgeInitial(apt) }}
                      </span>

                      <!-- 3. Chip de tiempo -->
                      <span class="inline-flex items-center gap-0.5 text-[9px] font-mono font-bold bg-slate-800/90 text-blue-300 px-1 py-0.5 rounded border border-slate-700/70 shrink-0 whitespace-nowrap leading-none">
                        <AppIcon name="timer" :size="9" class="text-blue-400" />
                        {{ apt.durationMinutes || 45 }}m
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Panel Lateral Derecho: Detalle y Especificaciones de la Atención -->
      <aside
        v-if="selectedAppointment"
        class="w-full lg:w-[390px] shrink-0 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[850px] sticky top-4 z-30 transition-all duration-200"
      >
        <!-- Header del Panel Derecho -->
        <div class="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-950/70">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <AppIcon name="event_note" :size="18" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-white leading-tight">
                Detalle de Atención
              </h3>
              <span class="text-[10px] text-blue-400 font-mono">
                Especificaciones de sesión IA
              </span>
            </div>
          </div>

          <!-- Botón de Cerrar Panel -->
          <button
            type="button"
            @click="closeDetailPanel"
            class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            title="Cerrar panel lateral"
          >
            <AppIcon name="close" :size="18" />
          </button>
        </div>

        <!-- Cuerpo del Panel Derecho con Scroll -->
        <div class="p-4 space-y-4 overflow-y-auto flex-1">
          <!-- Tarjeta de Resumen -->
          <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-3.5 flex items-center gap-3">
            <div class="w-13 h-13 sm:w-14 sm:h-14 rounded-xl bg-slate-800 overflow-hidden border border-slate-700 shrink-0 shadow-md">
              <img
                v-if="getClientDisplayAvatar(selectedAppointment)"
                :src="getClientDisplayAvatar(selectedAppointment)"
                :alt="getClientDisplayName(selectedAppointment)"
                class="w-full h-full object-cover"
                @error="selectedAppointment.avatarUrl = ''"
              />
              <div v-else class="w-full h-full flex items-center justify-center text-slate-400">
                <AppIcon name="person" :size="24" />
              </div>
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span
                  class="text-[10px] font-bold px-2 py-0.5 rounded border"
                  :class="selectedAppointment.chairId === 'Silla 1' || (selectedAppointment.chairId || '').includes('1')
                    ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'"
                >
                  {{ selectedAppointment.chairName || selectedAppointment.chairId }}
                </span>
                <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700/80">
                  {{ getClientDisplayBadge(selectedAppointment) }}
                </span>
              </div>
              <p class="text-[11px] text-slate-400 font-mono mt-1 truncate">
                ID: {{ selectedAppointment.clientId || selectedAppointment.personId || selectedAppointment.id }}
              </p>
            </div>
          </div>

          <!-- Métricas de Tiempo: Horario Exacto y Duración -->
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-2.5">
              <span class="text-[10px] text-slate-400 block mb-0.5 font-medium flex items-center gap-1">
                <AppIcon name="schedule" :size="12" class="text-blue-400" />
                Horario:
              </span>
              <span class="text-xs font-bold text-slate-200 font-mono">
                {{ formatTimeOnly(selectedAppointment.startTime) }} - {{ formatTimeOnly(selectedAppointment.endTime) }}
              </span>
            </div>

            <div class="bg-slate-950/50 border border-slate-800 rounded-xl p-2.5">
              <span class="text-[10px] text-slate-400 block mb-0.5 font-medium flex items-center gap-1">
                <AppIcon name="timer" :size="12" class="text-blue-400" />
                Duración:
              </span>
              <span class="text-xs font-bold text-blue-400 font-mono">
                {{ selectedAppointment.durationMinutes || 45 }} minutos
              </span>
            </div>
          </div>

          <!-- Notas de la sesión (si las hay) -->
          <div v-if="selectedAppointment.notes" class="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
            <h4 class="text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center gap-1">
              <AppIcon name="note" :size="13" class="text-blue-400" />
              Notas
            </h4>
            <p class="text-xs text-slate-300 leading-relaxed">
              {{ selectedAppointment.notes }}
            </p>
          </div>

          <!-- Galería de Fotos Capturadas en esta Sesión -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <AppIcon name="photo_library" :size="14" class="text-blue-400" />
                <span>Fotos de la Sesión ({{ (selectedAppointment.photos || []).length }})</span>
              </h4>
              <span class="text-[10px] text-slate-400">Biometría</span>
            </div>

            <div v-if="!selectedAppointment.photos || selectedAppointment.photos.length === 0" class="text-center py-6 bg-slate-950/50 border border-slate-800 rounded-xl text-slate-500">
              <AppIcon name="no_photography" :size="20" class="opacity-40 mb-1" />
              <p class="text-xs">Sin fotos registradas para esta sesión.</p>
            </div>

            <div v-else class="grid grid-cols-2 gap-2">
              <div
                v-for="(photo, idx) in selectedAppointment.photos"
                :key="idx"
                class="group relative bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-sm hover:border-blue-500/60 transition"
              >
                <div class="aspect-square w-full bg-slate-800 overflow-hidden">
                  <img
                    v-if="getPhotoSrc(photo)"
                    :src="getPhotoSrc(photo)"
                    :alt="photo.poseLabel || photo.pose || 'Recorte facial'"
                    class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                    @error="photo.hasError = true"
                  />
                  <div v-else class="w-full h-full flex items-center justify-center text-slate-500">
                    <AppIcon name="face" :size="20" />
                  </div>
                </div>
                <div class="p-1.5 bg-slate-950/95 border-t border-slate-800 flex items-center justify-between text-[10px]">
                  <span class="font-medium text-slate-300 truncate max-w-[80px]">{{ photo.poseLabel || photo.pose || 'Frontal' }}</span>
                  <span class="text-emerald-400 font-semibold font-mono">
                    {{ photo.sharpnessScore ? `${Math.round(photo.sharpnessScore <= 1 && photo.sharpnessScore > 0 ? photo.sharpnessScore * 100 : photo.sharpnessScore)}%` : '' }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Pie de Acciones del Panel: Botón de Borrar y Ver Historial -->
        <div class="p-4 border-t border-slate-800 bg-slate-950/80 flex flex-col gap-2">
          <AppButton
            variant="primary"
            size="sm"
            class="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold cursor-pointer justify-center"
            @click="openClientHistoryModal"
          >
            <AppIcon name="history" :size="16" />
            <span>Ver Historial del Cliente</span>
          </AppButton>

          <!-- Botón de Borrar: Ubicado exclusivamente aquí en el right panel -->
          <AppButton
            variant="danger-outline"
            size="sm"
            icon="delete"
            class="w-full justify-center border-rose-500/30 text-rose-400 hover:bg-rose-500/10 cursor-pointer"
            @click="promptDeleteAppointment(selectedAppointment)"
          >
            Eliminar Atención
          </AppButton>
        </div>
      </aside>
    </div>

    <!-- Modal de Galería Completa de Fotos y Ángulos del Cliente -->
    <ClientPhotosModal
      :show="isClientPhotosModalOpen"
      :person="selectedPersonForClientModal"
      :appointments="getClientAppointments(selectedPersonForClientModal?.id)"
      @close="isClientPhotosModalOpen = false"
    />

    <!-- Modal de Confirmación para Borrar Atención / Usuario -->
    <DeleteAppointmentModal
      :show="isDeleteModalOpen"
      :appointment="appointmentToDelete"
      :person="matchedPersonToDelete"
      :loading="isDeleting"
      @close="closeDeleteModal"
      @confirm="handleConfirmDelete"
    />
  </div>
</template>
