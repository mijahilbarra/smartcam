<script setup>
import { ref, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
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
    const dEnd = new Date(apt.endTime);
    let startMin = dStart.getHours() * 60 + dStart.getMinutes();
    let endMin = dEnd.getHours() * 60 + dEnd.getMinutes();
    if (isNaN(startMin)) startMin = gridStartMinutes;
    if (isNaN(endMin) || endMin <= startMin) endMin = startMin + (apt.durationMinutes || 45);
    const duration = Math.max(15, apt.durationMinutes || (endMin - startMin) || 45);

    const top = Math.max(0, ((startMin - gridStartMinutes) / 60) * hourHeight);
    const height = Math.max(36, (duration / 60) * hourHeight);

    return {
      apt,
      startMin,
      endMin: startMin + duration,
      top,
      height,
      col: 0,
      totalCols: 1
    };
  });

  // Agrupar eventos que se traslapan en tiempo
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const item of parsed) {
    if (currentCluster.length === 0) {
      currentCluster.push(item);
      clusterEnd = item.endMin;
    } else {
      if (item.startMin < clusterEnd) {
        currentCluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.endMin);
      } else {
        clusters.push(currentCluster);
        currentCluster = [item];
        clusterEnd = item.endMin;
      }
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  // Asignar columnas paralelas (ej: Silla 1 vs Silla 2 al mismo tiempo)
  for (const cluster of clusters) {
    const columnEnds = [];
    for (const item of cluster) {
      let placed = false;
      for (let c = 0; c < columnEnds.length; c++) {
        if (columnEnds[c] <= item.startMin) {
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
    for (const item of cluster) {
      item.totalCols = totalCols;
    }
  }

  return parsed.map((item) => {
    const colWidthPct = 100 / item.totalCols;
    const leftPct = item.col * colWidthPct;
    return {
      ...item.apt,
      _layout: {
        top: `${item.top}px`,
        height: `${item.height}px`,
        left: `calc(${leftPct}% + 1px)`,
        width: `calc(${colWidthPct}% - 2px)`,
        isCompact: item.height < 52
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

// Estado de Modal de Detalle de Atención
const selectedAppointment = ref(null);
const isDetailModalOpen = ref(false);

const openDetailModal = (apt) => {
  selectedAppointment.value = apt;
  isDetailModalOpen.value = true;
};

const closeDetailModal = () => {
  isDetailModalOpen.value = false;
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
  isDetailModalOpen.value = false;
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
      closeDetailModal();
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

    <!-- Google Calendar View Container -->
    <div class="rounded-2xl border border-slate-800 bg-slate-950/70 shadow-xl overflow-hidden flex flex-col">
      <!-- Scroll horizontal contenedor para pantallas pequeñas y tablets -->
      <div class="overflow-x-auto">
        <div class="min-w-[860px] flex flex-col">
          <!-- 1. Cabecera Fija de Días de la Semana (Lunes a Domingo) -->
          <div class="flex border-b border-slate-800 bg-slate-900/90 backdrop-blur sticky top-0 z-30">
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

          <!-- 2. Cuerpo de la Agenda (Regla Horaria + 7 Columnas Temporales) -->
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
                  class="absolute inset-x-0 border-t-2 border-red-500 z-20 pointer-events-none flex items-center"
                  :style="{ top: `${currentTimeTopPx}px` }"
                >
                  <span class="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1 shadow-sm shadow-red-500"></span>
                </div>

                <!-- Tarjetas de Atenciones (Posicionadas y Escaladas Proporcionalmente a su Duración) -->
                <div
                  v-for="apt in (positionedAppointmentsByDay[day.isoDate] || [])"
                  :key="apt.id"
                  @click="openDetailModal(apt)"
                  :style="{
                    top: apt._layout.top,
                    height: apt._layout.height,
                    left: apt._layout.left,
                    width: apt._layout.width
                  }"
                  class="group absolute rounded-lg border transition-all duration-150 cursor-pointer shadow-md hover:shadow-xl hover:z-20 overflow-hidden flex flex-col p-1.5 box-border"
                  :class="[
                    apt.chairId === 'Silla 1' || (apt.chairId || '').includes('1')
                      ? 'bg-slate-900/95 border-l-4 border-l-blue-500 border-slate-700/80 hover:border-blue-400 hover:bg-slate-850'
                      : 'bg-slate-900/95 border-l-4 border-l-emerald-500 border-slate-700/80 hover:border-emerald-400 hover:bg-slate-850'
                  ]"
                >
                  <!-- Barra Superior: Horario, Duración y Botón Eliminar -->
                  <div class="flex items-center justify-between gap-1 text-[10px] font-semibold text-slate-300 leading-none">
                    <span class="flex items-center gap-1 font-mono text-blue-300 truncate">
                      <AppIcon name="schedule" :size="11" class="text-blue-400 shrink-0" />
                      {{ formatTimeOnly(apt.startTime) }} - {{ formatTimeOnly(apt.endTime) }}
                    </span>
                    <div class="flex items-center gap-1 shrink-0">
                      <span class="text-[9px] bg-slate-800 px-1 py-0.2 rounded text-slate-300 font-mono border border-slate-700/60">
                        {{ apt.durationMinutes || 45 }}m
                      </span>
                      <button
                        type="button"
                        @click.stop="promptDeleteAppointment(apt)"
                        class="p-0.5 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-500/20 transition cursor-pointer"
                        title="Eliminar atención"
                      >
                        <AppIcon name="delete" :size="12" />
                      </button>
                    </div>
                  </div>

                  <!-- Contenido Central: Avatar (bestFaceScore) + Silla + Insignia -->
                  <!-- (Simplificado: SIN Nombre de Cliente, SIN N fotos, SIN Ver) -->
                  <div class="flex items-center gap-2 mt-1 min-w-0 flex-1">
                    <!-- Avatar con la foto de mejor nitidez facial -->
                    <div class="relative w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-800 overflow-hidden shrink-0 border border-slate-700 shadow-inner">
                      <img
                        v-if="getClientDisplayAvatar(apt)"
                        :src="getClientDisplayAvatar(apt)"
                        alt="Foto sesión"
                        class="w-full h-full object-cover group-hover:scale-105 transition duration-200"
                        @error="apt.avatarUrl = ''"
                      />
                      <div v-else class="w-full h-full flex items-center justify-center text-slate-400 bg-slate-800">
                        <AppIcon name="person" :size="16" />
                      </div>
                    </div>

                    <!-- Insignia de Silla y Estado -->
                    <div class="min-w-0 flex-1 flex flex-col justify-center">
                      <div class="flex items-center gap-1 flex-wrap">
                        <span
                          class="text-[10px] font-bold truncate px-1.5 py-0.2 rounded border"
                          :class="apt.chairId === 'Silla 1' || (apt.chairId || '').includes('1')
                            ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                            : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'"
                        >
                          {{ apt.chairName || apt.chairId }}
                        </span>
                        <span
                          v-if="!apt._layout.isCompact"
                          class="text-[9px] px-1.5 py-0.2 rounded font-medium bg-slate-800/90 text-slate-300 border border-slate-700/50 truncate"
                        >
                          {{ getClientDisplayBadge(apt) }}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal de Detalle de Atención -->
    <ModalTemplate
      :show="isDetailModalOpen"
      @close="closeDetailModal"
    >
      <ModalHeader
        title="Detalle de Atención y Sesión"
        icon="event_note"
        tag="Atención IA"
        @close="closeDetailModal"
      />

      <div v-if="selectedAppointment" class="p-4 sm:p-6 space-y-6 overflow-y-auto">
        <!-- Tarjeta de Resumen de Cita -->
        <div class="bg-slate-800/90 border border-slate-700 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="w-14 h-14 rounded-2xl bg-slate-700 overflow-hidden border border-slate-600 flex-shrink-0 shadow-md">
              <img
                v-if="getClientDisplayAvatar(selectedAppointment)"
                :src="getClientDisplayAvatar(selectedAppointment)"
                :alt="getClientDisplayName(selectedAppointment)"
                class="w-full h-full object-cover"
                @error="selectedAppointment.avatarUrl = ''"
              />
              <div v-else class="w-full h-full flex items-center justify-center text-slate-400">
                <AppIcon name="person" :size="28" />
              </div>
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-base font-bold text-white">{{ getClientDisplayName(selectedAppointment) }}</h3>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-950 text-blue-300 border border-blue-500/30">
                  {{ getClientDisplayBadge(selectedAppointment) }}
                </span>
              </div>
              <p class="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                <span class="text-emerald-400 font-semibold">{{ selectedAppointment.chairId }}</span>
                <span>•</span>
                <span>ID: {{ selectedAppointment.clientId || selectedAppointment.personId || 'N/D' }}</span>
              </p>
            </div>
          </div>

          <div class="flex flex-col items-end gap-1 bg-slate-900/80 px-4 py-2.5 rounded-xl border border-slate-700/80 w-full sm:w-auto">
            <span class="text-xs text-slate-400 font-medium">Duración de la Sesión</span>
            <span class="text-sm font-bold text-blue-400 flex items-center gap-1">
              <AppIcon name="timer" :size="16" />
              {{ selectedAppointment.durationMinutes || 45 }} minutos exactos
            </span>
            <span class="text-[10px] text-slate-400 font-mono">
              {{ formatTimeOnly(selectedAppointment.startTime) }} - {{ formatTimeOnly(selectedAppointment.endTime) }}
            </span>
          </div>
        </div>

        <!-- Notas de la sesión -->
        <div v-if="selectedAppointment.notes" class="bg-slate-900/60 border border-slate-800 rounded-xl p-3.5">
          <h4 class="text-xs font-bold text-slate-300 uppercase tracking-wider mb-1 flex items-center gap-1.5">
            <AppIcon name="note" :size="14" class="text-blue-400" />
            Notas del Barbero / IA
          </h4>
          <p class="text-xs text-slate-300 leading-relaxed">
            {{ selectedAppointment.notes }}
          </p>
        </div>

        <!-- Galería de Fotos Capturadas en esta Sesión -->
        <div>
          <h4 class="text-xs font-bold text-slate-300 uppercase tracking-wider mb-3 flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <AppIcon name="photo_library" :size="16" class="text-blue-400" />
              Fotos Capturadas en esta Sesión ({{ (selectedAppointment.photos || []).length }})
            </span>
            <span class="text-[10px] text-slate-400 font-normal">Alta resolución biométrica</span>
          </h4>

          <div v-if="!selectedAppointment.photos || selectedAppointment.photos.length === 0" class="text-center py-8 bg-slate-900/40 border border-slate-800 rounded-xl text-slate-500">
            <AppIcon name="no_photography" :size="24" class="opacity-40 mb-1" />
            <p class="text-xs">No hay fotos registradas para esta sesión específica.</p>
          </div>

          <div v-else class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div
              v-for="(photo, idx) in selectedAppointment.photos"
              :key="idx"
              class="group relative bg-slate-900 border border-slate-700/80 rounded-xl overflow-hidden shadow-sm hover:border-blue-500/60 transition"
            >
              <div class="aspect-[4/3] w-full bg-slate-800 overflow-hidden">
                <img
                  v-if="getPhotoSrc(photo)"
                  :src="getPhotoSrc(photo)"
                  :alt="photo.poseLabel || photo.pose || 'Recorte de sesión'"
                  class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                  @error="photo.hasError = true"
                />
                <div v-else class="w-full h-full flex items-center justify-center text-slate-500">
                  <AppIcon name="face" :size="24" />
                </div>
              </div>
              <div class="p-2 bg-slate-900/90 border-t border-slate-800 flex items-center justify-between text-[11px]">
                <span class="font-medium text-slate-300 truncate">{{ photo.poseLabel || photo.pose || 'Frontal' }}</span>
                <span class="text-emerald-400 font-semibold font-mono">
                  {{ photo.sharpnessScore ? `${photo.sharpnessScore}%` : (photo.sharpness || '') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Acciones del Modal -->
        <div class="flex items-center justify-between gap-3 pt-4 border-t border-slate-800">
          <AppButton
            variant="danger-outline"
            size="sm"
            icon="delete"
            @click="promptDeleteAppointment(selectedAppointment)"
          >
            Eliminar Atención
          </AppButton>
          <div class="flex items-center gap-3">
            <AppButton
              variant="secondary"
              size="sm"
              @click="closeDetailModal"
              class="bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
            >
              Cerrar
            </AppButton>
            <AppButton
              variant="primary"
              size="sm"
              @click="openClientHistoryModal"
              class="bg-blue-600 hover:bg-blue-500 text-white shadow cursor-pointer"
            >
              Ver Historial Completo del Cliente
            </AppButton>
          </div>
        </div>
      </div>
    </ModalTemplate>

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
