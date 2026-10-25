<script setup>
import { ref, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import DeleteAppointmentModal from '@/widgets/appointments-calendar/ui/DeleteAppointmentModal.vue';
import ClientPhotosModal from '@/widgets/people-directory/ui/ClientPhotosModal.vue';
import { useAppointments } from '@/entities/appointment/model/useAppointments';
import { usePeople } from '@/entities/person/model/usePeople';

const props = defineProps({
  clientsInCut: {
    type: Number,
    default: 0
  },
  activeBarbers: {
    type: Number,
    default: 0
  }
});

const emit = defineEmits(['switch-tab']);

const { appointments, loading, deleteAppointment } = useAppointments();
const { people } = usePeople();

// Filtro de silla: 'all' | 'Silla 1' | 'Silla 2'
const selectedChairFilter = ref('all');

// Orden de lista: 'asc' (cronológico, 09:00 -> 21:00) | 'desc' (más recientes arriba)
const sortOrder = ref('asc');

// Comparar si una fecha corresponde al día actual
const isToday = (isoString) => {
  if (!isoString) return false;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
};

// Formato de texto para el encabezado del día
const todayLabel = computed(() => {
  const now = new Date();
  const options = { weekday: 'long', day: 'numeric', month: 'long' };
  const str = now.toLocaleDateString('es-ES', options);
  return str.charAt(0).toUpperCase() + str.slice(1);
});

// Filtrado de citas correspondientes exclusivamente al día actual
const todayAppointments = computed(() => {
  if (!Array.isArray(appointments.value)) return [];

  const list = appointments.value.filter((apt) => {
    if (!apt.startTime) return false;
    if (!isToday(apt.startTime)) return false;

    // Descartar citas huérfanas si la lista de personas ya cargó
    if (!loading.value && people.value.length > 0) {
      const pId = apt.clientId || apt.personId;
      const foundInPeople = people.value.some(
        (p) => p.id === pId || (apt.clientName && p.name === apt.clientName)
      );
      if (!foundInPeople) return false;
    }

    // Filtro por silla
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

  return list.sort((a, b) => {
    const timeA = new Date(a.startTime).getTime();
    const timeB = new Date(b.startTime).getTime();
    return sortOrder.value === 'asc' ? timeA - timeB : timeB - timeA;
  });
});

// Métricas del día actual
const totalToday = computed(() => todayAppointments.value.length);
const totalMinutesToday = computed(() =>
  todayAppointments.value.reduce((acc, a) => acc + (a.durationMinutes || 0), 0)
);

// Formatear horas
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
  return (
    url.startsWith('data:image/') ||
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('blob:')
  );
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

const getClientAppointments = (personId) => {
  if (!personId || !Array.isArray(appointments.value)) return [];
  return appointments.value.filter((a) => a.clientId === personId || a.personId === personId);
};

// Modales
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

const appointmentToDelete = ref(null);
const isDeleteModalOpen = ref(false);
const isDeleting = ref(false);

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
    console.error('[TodayScheduleWidget] Error eliminando atención:', err);
    alert(`Error al eliminar: ${err.message}`);
  } finally {
    isDeleting.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col bg-slate-950/70 border border-slate-800 rounded-xl overflow-hidden h-[820px] shadow-sm">
    <!-- Header del Calendario de Hoy -->
    <div class="p-3.5 border-b border-slate-800 bg-slate-900/90 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="p-2 rounded-lg bg-blue-950/70 text-blue-400 border border-blue-500/30">
            <AppIcon name="calendar_today" :size="18" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-white flex items-center gap-2">
              Calendario del Día
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-950/80 text-blue-400 border border-blue-500/30">
                <span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                HOY
              </span>
            </h3>
            <p class="text-[11px] text-slate-400 font-medium capitalize">
              {{ todayLabel }}
            </p>
          </div>
        </div>

        <AppBadge variant="default" class="text-[11px] font-mono">
          {{ totalToday }} {{ totalToday === 1 ? 'atención' : 'atenciones' }}
        </AppBadge>
      </div>

      <!-- Barra de Resumen / Métricas Rápidas de Hoy -->
      <div class="grid grid-cols-2 gap-2 pt-1 text-[11px]">
        <div class="bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
          <span class="text-slate-400">Tiempo en Corte:</span>
          <span class="font-bold text-emerald-400 font-mono">{{ totalMinutesToday }} min</span>
        </div>
        <div class="bg-slate-950/70 border border-slate-800 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
          <span class="text-slate-400">En Curso Ahora:</span>
          <span :class="['font-bold font-mono', props.clientsInCut > 0 ? 'text-amber-400' : 'text-slate-400']">
            {{ props.clientsInCut }} {{ props.clientsInCut === 1 ? 'cliente' : 'clientes' }}
          </span>
        </div>
      </div>

      <!-- Filtros de Silla y Orden -->
      <div class="flex items-center justify-between gap-1.5 pt-1">
        <div class="flex items-center gap-1 bg-slate-950/80 border border-slate-800/80 rounded-lg p-0.5 text-[11px]">
          <button
            type="button"
            @click="selectedChairFilter = 'all'"
            :class="[
              'px-2 py-0.5 rounded-md font-medium transition cursor-pointer',
              selectedChairFilter === 'all'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            ]"
          >
            Todas
          </button>
          <button
            type="button"
            @click="selectedChairFilter = 'Silla 1'"
            :class="[
              'px-2 py-0.5 rounded-md font-medium transition cursor-pointer',
              selectedChairFilter === 'Silla 1'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            ]"
          >
            Silla 1
          </button>
          <button
            type="button"
            @click="selectedChairFilter = 'Silla 2'"
            :class="[
              'px-2 py-0.5 rounded-md font-medium transition cursor-pointer',
              selectedChairFilter === 'Silla 2'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            ]"
          >
            Silla 2
          </button>
        </div>

        <button
          type="button"
          @click="sortOrder = sortOrder === 'asc' ? 'desc' : 'asc'"
          class="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          :title="sortOrder === 'asc' ? 'Orden: de mañana a noche (click para invertir)' : 'Orden: más recientes primero (click para invertir)'"
        >
          <AppIcon :name="sortOrder === 'asc' ? 'arrow_downward' : 'arrow_upward'" :size="13" />
          <span>{{ sortOrder === 'asc' ? '09:00 → 21:00' : 'Recientes' }}</span>
        </button>
      </div>
    </div>

    <!-- Indicador de Atención en Curso (Si hay corte activo) -->
    <div
      v-if="props.clientsInCut > 0"
      class="p-2.5 mx-3 mt-3 rounded-xl bg-gradient-to-r from-emerald-950/70 to-slate-900 border border-emerald-500/40 flex items-center justify-between shadow-xs animate-pulse"
    >
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
        <div class="flex flex-col min-w-0">
          <span class="text-xs font-bold text-emerald-300 truncate">Atención en Curso Ahora</span>
          <span class="text-[10px] text-emerald-400/80">Silla activa con cliente en corte</span>
        </div>
      </div>
      <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-900/80 text-emerald-200 border border-emerald-500/30">
        EN PROGRESO
      </span>
    </div>

    <!-- Lista de Atenciones del Día -->
    <div class="flex-1 p-3 overflow-y-auto space-y-2.5">
      <!-- Estado vacío si aún no hay atenciones hoy -->
      <div
        v-if="todayAppointments.length === 0"
        class="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 gap-3"
      >
        <div class="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500">
          <AppIcon name="event_available" :size="26" class="opacity-60" />
        </div>
        <div class="flex flex-col gap-1 max-w-[260px]">
          <h4 class="text-xs font-bold text-slate-200">Día en progreso</h4>
          <p class="text-[11px] text-slate-400 leading-relaxed">
            Aún no se han completado atenciones hoy. Conforme los clientes se atiendan en las sillas, las sesiones aparecerán y completarán el día automáticamente.
          </p>
        </div>

        <button
          type="button"
          @click="emit('switch-tab', 'calendar')"
          class="mt-2 text-[11px] text-blue-400 hover:text-blue-300 hover:underline flex items-center gap-1 cursor-pointer font-medium"
        >
          <span>Ver historial en Calendario</span>
          <AppIcon name="arrow_forward" :size="13" />
        </button>
      </div>

      <!-- Tarjetas de Atenciones de Hoy -->
      <div
        v-for="apt in todayAppointments"
        :key="apt.id"
        @click="openDetailModal(apt)"
        class="group bg-slate-900/90 hover:bg-slate-850 border border-slate-800 hover:border-blue-500/50 rounded-xl p-3 transition-all duration-200 cursor-pointer shadow-xs hover:shadow-md hover:-translate-y-0.5 relative overflow-hidden"
      >
        <!-- Tira lateral indicadora de silla -->
        <div
          :class="[
            'absolute left-0 top-0 bottom-0 w-1',
            apt.chairId === 'Silla 1' || (apt.chairId || '').includes('1') ? 'bg-blue-500' : 'bg-emerald-500'
          ]"
        ></div>

        <!-- Horario y Duración -->
        <div class="flex items-center justify-between text-[11px] font-semibold text-slate-300 mb-2 pl-1.5">
          <span class="flex items-center gap-1 text-blue-400">
            <AppIcon name="schedule" :size="13" />
            {{ formatTimeOnly(apt.startTime) }} - {{ formatTimeOnly(apt.endTime) }}
          </span>
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] bg-slate-950 px-1.5 py-0.5 rounded text-slate-400 border border-slate-800">
              {{ apt.durationMinutes || 45 }} min
            </span>
            <button
              type="button"
              @click.stop="promptDeleteAppointment(apt)"
              class="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
              title="Eliminar atención"
            >
              <AppIcon name="delete" :size="13" />
            </button>
          </div>
        </div>

        <!-- Datos del Cliente y Silla -->
        <div class="flex items-center gap-2.5 pl-1.5">
          <!-- Avatar del Cliente -->
          <div class="relative w-9 h-9 rounded-xl bg-slate-800 overflow-hidden flex-shrink-0 border border-slate-700 shadow-inner">
            <img
              v-if="getClientDisplayAvatar(apt)"
              :src="getClientDisplayAvatar(apt)"
              :alt="getClientDisplayName(apt)"
              class="w-full h-full object-cover group-hover:scale-105 transition duration-300"
              @error="apt.avatarUrl = ''"
            />
            <div v-else class="w-full h-full flex items-center justify-center text-slate-500 bg-slate-850">
              <AppIcon name="person" :size="18" />
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
              <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold bg-slate-950 text-blue-300 border border-blue-500/20">
                {{ getClientDisplayBadge(apt) }}
              </span>
            </div>
          </div>
        </div>

        <!-- Mini Footer con fotos capturadas y status completado -->
        <div class="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-400 pl-1.5">
          <span class="flex items-center gap-1">
            <AppIcon name="check_circle" :size="12" class="text-emerald-400" />
            <span class="text-emerald-400 font-medium">Completada</span>
            <template v-if="apt.photos && apt.photos.length > 0">
              <span class="text-slate-600">•</span>
              <span class="text-slate-400 flex items-center gap-0.5">
                <AppIcon name="photo_camera" :size="11" class="text-blue-400" />
                {{ apt.photos.length }}
              </span>
            </template>
          </span>
          <span class="text-blue-400 group-hover:translate-x-0.5 transition font-semibold flex items-center gap-0.5">
            Ver <AppIcon name="arrow_forward" :size="11" />
          </span>
        </div>
      </div>
    </div>

    <!-- Modal de Detalle de Atención -->
    <ModalTemplate
      :show="isDetailModalOpen"
      @close="closeDetailModal"
    >
      <ModalHeader
        title="Detalle de Atención del Día"
        icon="event_note"
        tag="Atención IA"
        @close="closeDetailModal"
      />

      <div v-if="selectedAppointment" class="p-4 sm:p-6 space-y-6 overflow-y-auto">
        <!-- Resumen de Atención -->
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

          <div
            v-if="!selectedAppointment.photos || selectedAppointment.photos.length === 0"
            class="text-center py-8 bg-slate-900/40 border border-slate-800 rounded-xl text-slate-500"
          >
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
              Ver Historial Completo
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

    <!-- Modal de Confirmación para Borrar Atención -->
    <DeleteAppointmentModal
      :show="isDeleteModalOpen"
      :appointment="appointmentToDelete"
      :person="getAppointmentClient(appointmentToDelete)"
      :loading="isDeleting"
      @close="closeDeleteModal"
      @confirm="handleConfirmDelete"
    />
  </div>
</template>
