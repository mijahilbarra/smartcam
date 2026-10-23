<script setup>
import { ref, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import DeleteAppointmentModal from './DeleteAppointmentModal.vue';
import ClientAppointmentConflictModal from './ClientAppointmentConflictModal.vue';
import ClientPhotosModal from '@/widgets/people-directory/ui/ClientPhotosModal.vue';
import { useAppointments } from '@/entities/appointment/model/useAppointments';
import { usePeople } from '@/entities/person/model/usePeople';

const emit = defineEmits(['open-person', 'open-photo']);

const { appointments, loading, error, refresh, deleteAppointment } = useAppointments();
const { people, deletePerson } = usePeople();

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

  return appointments.value.filter(apt => {
    if (!apt.startTime) return false;
    const aptDateStr = apt.startTime.split('T')[0];
    
    // Filtro por rango semanal
    if (aptDateStr < startIso || aptDateStr > endIso) return false;

    // Descartar citas huérfanas de perfiles que ya no existen en el Directorio
    if (!loading.value && people.value.length > 0) {
      const pId = apt.clientId || apt.personId;
      const foundInPeople = people.value.some(p => p.id === pId || (apt.clientName && p.name === apt.clientName));
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

// Agrupar atenciones por día (isoDate -> array de atenciones)
const appointmentsByDay = computed(() => {
  const map = {};
  weekDays.value.forEach(d => {
    map[d.isoDate] = [];
  });

  filteredAppointments.value.forEach(apt => {
    const dStr = apt.startTime.split('T')[0];
    if (map[dStr]) {
      map[dStr].push(apt);
    }
  });

  // Ordenar cada día por hora de inicio
  Object.keys(map).forEach(dateKey => {
    map[dateKey].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
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

const isConflictModalOpen = ref(false);
const conflictingAppointments = ref([]);
const pendingAppointmentForDelete = ref(null);
const isDeletingConflictAppt = ref(false);

const matchedPersonToDelete = computed(() => {
  if (!appointmentToDelete.value) return null;
  const pId = appointmentToDelete.value.personId || appointmentToDelete.value.clientId;
  if (!pId) return null;
  return people.value.find(p => p.id === pId) || null;
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

const handleConfirmDelete = async ({ appointmentId, deleteUser, personId }) => {
  if (!appointmentId) return;

  if (deleteUser) {
    const pId = personId || appointmentToDelete.value?.personId || appointmentToDelete.value?.clientId;
    const clientName = matchedPersonToDelete.value?.name || appointmentToDelete.value?.clientName;

    const otherAppointments = appointments.value.filter(a => {
      if (a.id === appointmentId) return false;
      if (pId && (a.personId === pId || a.clientId === pId)) return true;
      if (clientName && clientName !== 'Cliente' && clientName !== 'Cliente sin nombre' && a.clientName === clientName) return true;
      return false;
    });

    if (otherAppointments.length > 0) {
      conflictingAppointments.value = otherAppointments;
      pendingAppointmentForDelete.value = appointmentToDelete.value;
      isDeleteModalOpen.value = false;
      isConflictModalOpen.value = true;
      return;
    }
  }

  isDeleting.value = true;
  try {
    // 1. Eliminar cita de Firestore y SQLite
    await deleteAppointment(appointmentId, { deletePersonId: deleteUser ? personId : null });

    // 2. Si se solicitó borrar también el usuario y tiene personId
    if (deleteUser && personId) {
      await deletePerson(personId);
    }

    // Cerrar modal de confirmación
    isDeleteModalOpen.value = false;
    appointmentToDelete.value = null;

    // Si el modal de detalle estaba abierto para esta misma cita, cerrarlo
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

const handleDeleteAppointmentOnlyFromConflict = async () => {
  if (!pendingAppointmentForDelete.value) return;
  isDeletingConflictAppt.value = true;
  try {
    const apptId = pendingAppointmentForDelete.value.id;
    await deleteAppointment(apptId);
    isConflictModalOpen.value = false;
    conflictingAppointments.value = [];
    pendingAppointmentForDelete.value = null;
    appointmentToDelete.value = null;
    if (selectedAppointment.value?.id === apptId) {
      closeDetailModal();
    }
  } catch (err) {
    console.error('Error eliminando cita desde conflicto:', err);
    alert(`Error al eliminar cita: ${err.message}`);
  } finally {
    isDeletingConflictAppt.value = false;
  }
};

const closeConflictModal = () => {
  if (isDeletingConflictAppt.value) return;
  isConflictModalOpen.value = false;
  conflictingAppointments.value = [];
  pendingAppointmentForDelete.value = null;
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

const isValidImageUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:');
};

const getAppointmentAvatar = (apt) => {
  if (!apt) return '';
  if (isValidImageUrl(apt.avatarUrl)) return apt.avatarUrl;
  if (Array.isArray(apt.photos)) {
    for (const p of apt.photos) {
      if (!p) continue;
      const candidate = p.thumbnailBase64 || p.base64 || (typeof p === 'string' ? p : '') || p.url;
      if (isValidImageUrl(candidate)) return candidate;
    }
  }
  return '';
};

const getPhotoSrc = (photo) => {
  if (!photo) return '';
  if (photo.hasError) return '';
  if (typeof photo === 'string' && isValidImageUrl(photo)) return photo;
  const candidate = photo.thumbnailBase64 || photo.base64 || photo.url;
  if (isValidImageUrl(candidate)) return candidate;
  return '';
};

// Resuelve reactivamente el cliente desde el directorio 'people'
const getAppointmentClient = (apt) => {
  if (!apt) return null;
  const pId = apt.clientId || apt.personId;
  if (pId) {
    const found = people.value.find(p => p.id === pId);
    if (found) return found;
  }
  if (apt.clientName && apt.clientName !== 'Cliente') {
    return people.value.find(p => p.name === apt.clientName) || null;
  }
  return null;
};

const getClientDisplayName = (apt) => {
  const client = getAppointmentClient(apt);
  return client?.name || apt?.clientName || 'Cliente';
};

const getClientDisplayAvatar = (apt) => {
  const client = getAppointmentClient(apt);
  return client?.thumbnailBase64 || getAppointmentAvatar(apt);
};

const getClientDisplayBadge = (apt) => {
  const client = getAppointmentClient(apt);
  if (client) {
    if (client.isStaff) return 'Barbero';
    return (client.visitCount || 1) > 1 ? 'Cliente Frecuente' : 'Nuevo Cliente';
  }
  return apt?.clientBadge || 'Cliente';
};
</script>

<template>
  <div class="space-y-6">
    <!-- Header de Controles del Calendario -->
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-slate-900/80 border border-slate-800 p-4 rounded-2xl shadow-lg">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
          <AppIcon name="calendar_month" :size="22" />
        </div>
        <div>
          <h2 class="text-base font-bold text-white flex items-center gap-2">
            Calendario Semanal de Atenciones
            <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
              {{ weekRangeLabel }}
            </span>
          </h2>
          <p class="text-xs text-slate-400">
            Monitoreo en tiempo real de citas, sillas activas y sesiones capturadas por IA.
          </p>
        </div>
      </div>

      <!-- Controles de Navegación y Filtros -->
      <div class="flex flex-wrap items-center gap-2">
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
            class="bg-blue-600 hover:bg-blue-500 text-white shadow-md"
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

    <!-- Grilla Semanal (7 Columnas de Lunes a Domingo) -->
    <div class="grid grid-cols-1 md:grid-cols-7 gap-3">
      <div
        v-for="day in weekDays"
        :key="day.isoDate"
        class="bg-slate-900/60 border border-slate-800/80 rounded-2xl flex flex-col overflow-hidden min-h-[500px]"
      >
        <!-- Cabecera del Día -->
        <div class="bg-slate-800/80 border-b border-slate-700/60 p-3 text-center">
          <span class="text-xs uppercase tracking-wider font-bold text-slate-400 block">{{ day.name }}</span>
          <span class="text-sm font-extrabold text-white mt-0.5 inline-block px-2 py-0.5 bg-slate-900/60 rounded-lg border border-slate-700/40">
            {{ day.dateFormatted }}
          </span>
        </div>

        <!-- Contenido / Tarjetas de Atenciones del Día -->
        <div class="p-2.5 flex-1 space-y-2.5 overflow-y-auto">
          <div v-if="(appointmentsByDay[day.isoDate] || []).length === 0" class="h-full flex flex-col items-center justify-center text-center py-12 text-slate-500">
            <AppIcon name="event_busy" :size="28" class="opacity-40 mb-1" />
            <span class="text-xs">Sin atenciones</span>
          </div>

          <div
            v-for="apt in (appointmentsByDay[day.isoDate] || [])"
            :key="apt.id"
            @click="openDetailModal(apt)"
            class="group bg-slate-800/90 hover:bg-slate-800 border border-slate-700/80 hover:border-blue-500/50 rounded-xl p-3 transition-all duration-200 cursor-pointer shadow-sm hover:shadow-md hover:-translate-y-0.5 relative overflow-hidden"
          >
            <!-- Indicador lateral de color según silla -->
            <div
              :class="[
                'absolute left-0 top-0 bottom-0 w-1',
                apt.chairId === 'Silla 1' ? 'bg-blue-500' : 'bg-emerald-500'
              ]"
            ></div>

            <!-- Horario y Duración -->
            <div class="flex items-center justify-between text-[11px] font-semibold text-slate-300 mb-2 pl-1">
              <span class="flex items-center gap-1 text-blue-400">
                <AppIcon name="schedule" :size="13" />
                {{ formatTimeOnly(apt.startTime) }} - {{ formatTimeOnly(apt.endTime) }}
              </span>
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] bg-slate-900/80 px-1.5 py-0.5 rounded text-slate-400 border border-slate-700/50">
                  {{ apt.durationMinutes || 45 }} min
                </span>
                <button
                  type="button"
                  @click.stop="promptDeleteAppointment(apt)"
                  class="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                  title="Eliminar atención"
                >
                  <AppIcon name="delete" :size="14" />
                </button>
              </div>
            </div>

            <!-- Info del Cliente y Silla -->
            <div class="flex items-center gap-2.5 pl-1">
              <!-- Avatar / Miniatura Real -->
              <div class="relative w-10 h-10 rounded-xl bg-slate-700 overflow-hidden flex-shrink-0 border border-slate-600 shadow-inner">
                <img
                  v-if="getClientDisplayAvatar(apt)"
                  :src="getClientDisplayAvatar(apt)"
                  :alt="getClientDisplayName(apt)"
                  class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                  @error="apt.avatarUrl = ''"
                />
                <div v-else class="w-full h-full flex items-center justify-center text-slate-400 bg-slate-800">
                  <AppIcon name="person" :size="20" />
                </div>
              </div>

              <!-- Nombre y Silla -->
              <div class="min-w-0 flex-1">
                <h4 class="text-xs font-bold text-white truncate group-hover:text-blue-300 transition">
                  {{ getClientDisplayName(apt) }}
                </h4>
                <div class="flex items-center gap-1.5 mt-0.5">
                  <span class="text-[10px] text-slate-400 font-medium truncate">
                    {{ apt.chairName || apt.chairId }}
                  </span>
                  <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold bg-slate-900/90 text-blue-300 border border-blue-500/20">
                    {{ getClientDisplayBadge(apt) }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Footer indicador de fotos -->
            <div v-if="apt.photos && apt.photos.length > 0" class="mt-2 pt-2 border-t border-slate-700/50 flex items-center justify-between text-[10px] text-slate-400 pl-1">
              <span class="flex items-center gap-1">
                <AppIcon name="photo_camera" :size="12" class="text-emerald-400" />
                {{ apt.photos.length }} fotos capturadas
              </span>
              <span class="text-blue-400 group-hover:translate-x-0.5 transition font-semibold flex items-center gap-0.5">
                Ver <AppIcon name="arrow_forward" :size="12" />
              </span>
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
      <!-- Header del Modal -->
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
            <span class="text-[10px] text-slate-400">
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
                <span class="text-emerald-400 font-semibold">
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

    <!-- Modal de Conflicto de Atención con Cliente Vinculado -->
    <ClientAppointmentConflictModal
      :show="isConflictModalOpen"
      :client-name="pendingAppointmentForDelete?.clientName || 'Cliente'"
      :conflicting-appointments="conflictingAppointments"
      :loading="isDeletingConflictAppt"
      @close="closeConflictModal"
      @confirm-delete-appointment-only="handleDeleteAppointmentOnlyFromConflict"
    />
  </div>
</template>
