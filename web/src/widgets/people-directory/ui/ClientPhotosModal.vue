<script setup>
import { ref, computed, watch } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ConfirmModal from '@/shared/ui/molecules/ConfirmModal.vue';
import { formatDateTime } from '@/shared/lib/date-utils';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  person: {
    type: Object,
    default: null
  },
  appointments: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['close', 'delete-person', 'delete-photo']);

const selectedPhotoIndex = ref(0);
const selectedAppointmentId = ref('all');

// Estado de modales de confirmación
const isConfirmDeletePersonOpen = ref(false);
const isDeletingPerson = ref(false);

const isConfirmDeletePhotoOpen = ref(false);
const photoToDeleteIndex = ref(null);
const isDeletingPhoto = ref(false);

// Formateador seguro de nitidez facial (soporta escala 0..1 o 0..100)
const formatSharpness = (val) => {
  if (val == null) return '0%';
  const num = Number(val);
  if (isNaN(num)) return '0%';
  if (num <= 1 && num > 0) return `${Math.round(num * 100)}%`;
  return `${Math.round(num)}%`;
};

// Formateador seguro de fecha
const formatTimeSafe = (val) => {
  if (!val) return 'Sin registro';
  return formatDateTime(val);
};

// Icono y etiqueta descriptiva de pose facial (Google Fonts Material Symbols Outlined exclusivo, sin emojis)
const getPoseIcon = (pose) => {
  switch (pose) {
    case 'profile_left':
    case 'semi_left':
      return 'turn_left';
    case 'profile_right':
    case 'semi_right':
      return 'turn_right';
    case 'tilted_up_left':
      return 'north_west';
    case 'tilted_up_right':
      return 'north_east';
    case 'tilted_down_left':
      return 'south_west';
    case 'tilted_down_right':
      return 'south_east';
    case 'tilted_up':
      return 'arrow_upward';
    case 'tilted_down':
      return 'arrow_downward';
    case 'frontal':
    default:
      return 'face';
  }
};

const getPoseLabel = (photo) => {
  if (!photo) return 'Frontal';
  return photo.poseLabel || photo.pose || 'Frontal';
};

// Lista de atenciones del cliente ordenadas cronológicamente (más recientes primero)
const clientAppointments = computed(() => {
  if (!Array.isArray(props.appointments)) return [];
  return [...props.appointments].sort((a, b) => {
    const timeA = new Date(a.startedAt || a.startTime || 0).getTime();
    const timeB = new Date(b.startedAt || b.startTime || 0).getTime();
    return timeB - timeA;
  });
});

// Galería de fotos del cliente (fuente canónica: fotos en los appointments del cliente)
const photosList = computed(() => {
  if (!props.person) return [];

  // Si se seleccionó una cita en particular
  if (selectedAppointmentId.value !== 'all') {
    const targetApt = clientAppointments.value.find(a => a.id === selectedAppointmentId.value);
    if (targetApt && Array.isArray(targetApt.photos)) {
      return targetApt.photos;
    }
  }

  // Si tiene citas, consolidar fotos de todas sus atenciones
  if (clientAppointments.value.length > 0) {
    const allPhotos = clientAppointments.value.flatMap(a => {
      if (!Array.isArray(a.photos)) return [];
      return a.photos.map(p => ({
        ...p,
        appointmentId: a.id,
        appointmentDate: a.startedAt || a.startTime,
        chairName: a.chairName || a.chairId
      }));
    });
    if (allPhotos.length > 0) return allPhotos;
  }

  // Fallback a person.photos (para staff o datos legacy)
  if (Array.isArray(props.person.photos)) {
    return props.person.photos;
  }
  return [];
});

// Foto actualmente seleccionada en el inspector
const selectedPhoto = computed(() => {
  if (photosList.value.length === 0) return null;
  const idx = selectedPhotoIndex.value;
  if (idx >= 0 && idx < photosList.value.length) {
    return photosList.value[idx];
  }
  return photosList.value[0];
});

// Mejor score de nitidez entre las fotos y bestFaceScore
const bestSharpness = computed(() => {
  if (!props.person) return '0%';
  const scores = photosList.value.map(p => {
    const s = Number(p.sharpnessScore || 0);
    return s <= 1 && s > 0 ? s * 100 : s;
  });
  if (props.person.bestFaceScore) {
    const s = Number(props.person.bestFaceScore);
    scores.push(s <= 1 && s > 0 ? s * 100 : s);
  }
  const max = scores.length > 0 ? Math.max(...scores) : 0;
  return `${Math.round(max)}%`;
});

// Reiniciar índice seleccionado al abrir modal o cambiar de persona
watch(() => props.person?.id, () => {
  selectedPhotoIndex.value = 0;
  selectedAppointmentId.value = 'all';
});
watch(() => props.show, (newVal) => {
  if (newVal) {
    selectedPhotoIndex.value = 0;
    selectedAppointmentId.value = 'all';
    isConfirmDeletePersonOpen.value = false;
    isConfirmDeletePhotoOpen.value = false;
    photoToDeleteIndex.value = null;
  }
});

const selectPhoto = (index) => {
  selectedPhotoIndex.value = index;
};

const promptDeletePhoto = (index) => {
  photoToDeleteIndex.value = index;
  isConfirmDeletePhotoOpen.value = true;
};

const handleConfirmDeletePerson = async () => {
  if (!props.person?.id) return;
  isDeletingPerson.value = true;
  try {
    emit('delete-person', props.person);
    isConfirmDeletePersonOpen.value = false;
  } finally {
    isDeletingPerson.value = false;
  }
};

const handleConfirmDeletePhoto = async () => {
  if (photoToDeleteIndex.value == null || !props.person?.id) return;
  isDeletingPhoto.value = true;
  try {
    emit('delete-photo', {
      personId: props.person.id,
      photoIndex: photoToDeleteIndex.value
    });
    isConfirmDeletePhotoOpen.value = false;
    if (selectedPhotoIndex.value >= photosList.value.length - 1) {
      selectedPhotoIndex.value = Math.max(0, photosList.value.length - 2);
    }
  } finally {
    isDeletingPhoto.value = false;
    photoToDeleteIndex.value = null;
  }
};
</script>

<template>
  <ModalTemplate :show="show" max-width="max-w-4xl" @close="emit('close')">
    <div v-if="person" class="flex flex-col bg-slate-900 border border-slate-800 text-slate-100 max-h-[92vh] overflow-hidden">
      <!-- Modal Header -->
      <div class="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800 bg-slate-950/60">
        <div class="flex items-center gap-3 min-w-0">
          <div class="p-2.5 rounded-xl bg-sky-950/70 text-sky-400 border border-sky-500/30 shrink-0 flex items-center justify-center">
            <AppIcon name="photo_library" :size="22" />
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2.5 flex-wrap">
              <h3 class="text-base sm:text-lg font-bold text-white truncate">
                {{ person.name }}
              </h3>
              <!-- Role Badge -->
              <span
                v-if="person.isStaff"
                class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-sky-950 text-sky-300 border border-sky-500/40"
              >
                <AppIcon name="badge" :size="13" />
                Barbero
              </span>
              <span
                v-else-if="person.status === 'to_verify'"
                class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-purple-950/80 text-purple-300 border border-purple-500/40"
              >
                <AppIcon name="pending" :size="13" />
                Por verificar
              </span>
              <span
                v-else-if="person.status === 'frequent' || person.visitCount > 1"
                class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-950/80 text-amber-300 border border-amber-500/40"
              >
                <AppIcon name="star" :size="13" />
                Cliente Frecuente
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-500/30"
              >
                <AppIcon name="person_add" :size="13" />
                Cliente Nuevo
              </span>
            </div>
            <p class="text-xs text-slate-400 font-mono mt-0.5 truncate">
              ID: {{ person.id }}
            </p>
          </div>
        </div>

        <!-- Close Button -->
        <button
          type="button"
          @click="emit('close')"
          class="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/80 transition cursor-pointer shrink-0 ml-2"
          title="Cerrar ventana"
        >
          <AppIcon name="close" :size="20" />
        </button>
      </div>

      <!-- Metrics Strip -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 bg-slate-950/40 border-b border-slate-800/80">
        <!-- Total Ángulos -->
        <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
          <div class="p-2 rounded-lg bg-sky-950/60 text-sky-400 border border-sky-500/20 shrink-0">
            <AppIcon name="collections" :size="18" />
          </div>
          <div class="min-w-0">
            <span class="block text-[11px] text-slate-400 font-medium">Total Ángulos</span>
            <span class="text-sm font-bold text-white font-mono">{{ photosList.length }} / 20</span>
          </div>
        </div>

        <!-- Entrada -->
        <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
          <div class="p-2 rounded-lg bg-emerald-950/60 text-emerald-400 border border-emerald-500/20 shrink-0">
            <AppIcon name="login" :size="18" />
          </div>
          <div class="min-w-0">
            <span class="block text-[11px] text-slate-400 font-medium">Entrada</span>
            <span class="text-xs font-semibold text-slate-200 font-mono truncate block" :title="formatTimeSafe(person.firstSeen)">
              {{ formatTimeSafe(person.firstSeen) }}
            </span>
          </div>
        </div>

        <!-- Salida / Última vez -->
        <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
          <div class="p-2 rounded-lg bg-amber-950/60 text-amber-400 border border-amber-500/20 shrink-0">
            <AppIcon name="schedule" :size="18" />
          </div>
          <div class="min-w-0">
            <span class="block text-[11px] text-slate-400 font-medium">Salida / Última vez</span>
            <span class="text-xs font-semibold text-slate-200 font-mono truncate block" :title="formatTimeSafe(person.lastSeen)">
              {{ formatTimeSafe(person.lastSeen) }}
            </span>
          </div>
        </div>

        <!-- Mejor nitidez -->
        <div class="flex items-center gap-2.5 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
          <div class="p-2 rounded-lg bg-purple-950/60 text-purple-400 border border-purple-500/20 shrink-0">
            <AppIcon name="center_focus_strong" :size="18" />
          </div>
          <div class="min-w-0">
            <span class="block text-[11px] text-slate-400 font-medium">Mejor nitidez</span>
            <span class="text-sm font-bold text-purple-300 font-mono">{{ bestSharpness }}</span>
          </div>
        </div>
      </div>

      <!-- Selector de Atenciones / Visitas del Cliente -->
      <div v-if="clientAppointments.length > 0" class="px-4 sm:px-6 py-2.5 flex items-center gap-2 overflow-x-auto bg-slate-950/60 border-b border-slate-800/80">
        <span class="text-xs font-semibold text-slate-400 shrink-0 flex items-center gap-1.5">
          <AppIcon name="event" :size="14" class="text-blue-400" />
          <span>Visitas:</span>
        </span>
        <button
          type="button"
          @click="selectedAppointmentId = 'all'; selectedPhotoIndex = 0"
          :class="[
            'px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition flex items-center gap-1.5 cursor-pointer',
            selectedAppointmentId === 'all'
              ? 'bg-blue-600 text-white font-bold shadow-sm'
              : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'
          ]"
        >
          <span>Todas ({{ clientAppointments.reduce((sum, a) => sum + (a.photos?.length || 0), 0) }})</span>
        </button>
        <button
          v-for="(apt, idx) in clientAppointments"
          :key="apt.id"
          type="button"
          @click="selectedAppointmentId = apt.id; selectedPhotoIndex = 0"
          :class="[
            'px-2.5 py-1 rounded-lg text-xs font-medium shrink-0 transition flex items-center gap-1.5 cursor-pointer',
            selectedAppointmentId === apt.id
              ? 'bg-blue-600 text-white font-bold shadow-sm'
              : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'
          ]"
        >
          <AppIcon name="content_cut" :size="12" />
          <span>Visita #{{ clientAppointments.length - idx }} ({{ apt.photos?.length || 0 }})</span>
        </button>
      </div>

      <!-- Main Body Content: Inspector + Grid -->
      <div class="p-4 sm:p-6 overflow-y-auto space-y-5">
        <!-- Inspector View (Vista ampliada) -->
        <div v-if="selectedPhoto" class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-center gap-5">
          <!-- Large Photo Container -->
          <div class="relative w-48 h-48 sm:w-56 sm:h-56 rounded-xl overflow-hidden border-2 border-sky-500/50 shadow-xl shadow-sky-950/40 bg-slate-950 shrink-0 group">
            <img
              :src="selectedPhoto.thumbnailBase64"
              :alt="`Ángulo facial #${selectedPhotoIndex + 1}`"
              class="w-full h-full object-cover transition duration-200 group-hover:scale-105"
            />
            <div class="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900/90 text-sky-300 border border-sky-500/30">
              Ángulo #{{ selectedPhotoIndex + 1 }}
            </div>
            <!-- Pose Badge on Large Inspector Photo -->
            <div class="absolute bottom-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-900/90 text-sky-300 border border-sky-500/40">
              <AppIcon :name="getPoseIcon(selectedPhoto.pose)" :size="13" />
              <span>{{ getPoseLabel(selectedPhoto) }}</span>
            </div>
          </div>

          <!-- Inspector Details -->
          <div class="flex-1 w-full space-y-3">
            <div class="flex items-center justify-between border-b border-slate-800/80 pb-2 flex-wrap gap-2">
              <div class="flex items-center gap-2 flex-wrap">
                <AppIcon name="zoom_in" :size="18" class="text-sky-400" />
                <h4 class="text-sm font-bold text-white">
                  Detalles del Ángulo Facial #{{ selectedPhotoIndex + 1 }}
                </h4>
                <span class="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-md bg-sky-950/80 text-sky-300 border border-sky-500/30">
                  <AppIcon :name="getPoseIcon(selectedPhoto.pose)" :size="12" />
                  <span>{{ getPoseLabel(selectedPhoto) }}</span>
                </span>
                <span v-if="selectedPhoto.isFallback" class="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  Foto principal
                </span>
              </div>

              <!-- Botón Eliminar Ángulo en Inspector -->
              <AppButton
                v-if="photosList.length > 0"
                variant="danger-outline"
                size="sm"
                icon="delete"
                :disabled="isDeletingPhoto"
                @click="promptDeletePhoto(selectedPhotoIndex)"
                title="Eliminar este ángulo facial de la galería"
              >
                Eliminar ángulo
              </AppButton>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
              <!-- Posición / Pose -->
              <div class="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                <span class="text-[11px] text-slate-400 block mb-0.5 flex items-center gap-1.5">
                  <AppIcon :name="getPoseIcon(selectedPhoto.pose)" :size="14" class="text-sky-400" />
                  <span>Posición / Pose:</span>
                </span>
                <span class="text-sm font-bold font-mono text-sky-300 truncate block">
                  {{ getPoseLabel(selectedPhoto) }}
                </span>
              </div>

              <!-- Nitidez biométrica -->
              <div class="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                <span class="text-[11px] text-slate-400 block mb-0.5 flex items-center gap-1.5">
                  <AppIcon name="center_focus_strong" :size="14" class="text-emerald-400" />
                  <span>Nitidez biométrica:</span>
                </span>
                <span class="text-sm font-bold font-mono text-emerald-300">
                  {{ formatSharpness(selectedPhoto.sharpnessScore) }}
                </span>
              </div>

              <!-- Momento de captura -->
              <div class="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                <span class="text-[11px] text-slate-400 block mb-0.5 flex items-center gap-1.5">
                  <AppIcon name="schedule" :size="14" class="text-sky-400" />
                  <span>Momento de captura:</span>
                </span>
                <span class="text-xs font-semibold font-mono text-slate-200">
                  {{ formatTimeSafe(selectedPhoto.capturedAt) }}
                </span>
              </div>
            </div>

            <p class="text-[11px] text-slate-400 italic">
              Los ángulos biométricos complementarios diversificados por posición garantizan el reconocimiento continuo del cliente sin importar su orientación hacia el barbero o el espejo.
            </p>
          </div>
        </div>

        <!-- Thumbnails Gallery Grid -->
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <AppIcon name="grid_view" :size="16" class="text-slate-400" />
              <span>Galería de Ángulos ({{ photosList.length }})</span>
            </h4>
            <span class="text-[11px] text-slate-500">
              Haz clic en cualquier ángulo para examinarlo
            </span>
          </div>

          <!-- Empty State -->
          <div
            v-if="photosList.length === 0"
            class="py-10 text-center text-slate-500 text-xs flex flex-col items-center justify-center gap-2 bg-slate-950/40 rounded-xl border border-slate-800"
          >
            <AppIcon name="no_photography" :size="32" class="text-slate-600" />
            <span>Sin fotos faciales capturadas para este perfil.</span>
          </div>

          <!-- Grid of Photos: 20 responsive layout -->
          <div v-else class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3">
            <button
              v-for="(photo, index) in photosList"
              :key="index"
              type="button"
              @click="selectPhoto(index)"
              :class="[
                'group relative flex flex-col rounded-xl overflow-hidden border p-1.5 text-left transition-all cursor-pointer',
                selectedPhotoIndex === index
                  ? 'bg-slate-800 border-sky-400 ring-2 ring-sky-400/30 shadow-lg shadow-sky-950/50 scale-[1.02]'
                  : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900/60'
              ]"
            >
              <!-- Thumbnail Image Container -->
              <div class="relative aspect-square w-full rounded-lg overflow-hidden bg-slate-950 border border-slate-800/80">
                <img
                  :src="photo.thumbnailBase64"
                  :alt="`Ángulo #${index + 1}`"
                  class="w-full h-full object-cover group-hover:scale-105 transition duration-150"
                />

                <!-- Angle badge -->
                <span class="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-950/85 text-slate-200 border border-slate-700 font-mono">
                  #{{ index + 1 }}
                </span>

                <!-- Sharpness score badge -->
                <span class="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-950/85 text-emerald-400 border border-slate-700 font-mono">
                  {{ formatSharpness(photo.sharpnessScore) }}
                </span>

                <!-- Pose badge on thumbnail -->
                <span class="absolute bottom-1 left-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-950/85 text-sky-300 border border-slate-700">
                  <AppIcon :name="getPoseIcon(photo.pose)" :size="11" />
                  <span class="truncate max-w-[65px]">{{ getPoseLabel(photo) }}</span>
                </span>

                <!-- Botón eliminar ángulo en tarjeta -->
                <button
                  type="button"
                  @click.stop="promptDeletePhoto(index)"
                  class="absolute bottom-1 right-1 p-1 rounded-md bg-slate-950/90 text-slate-400 hover:text-red-400 hover:bg-red-950/90 border border-slate-800 hover:border-red-500/40 opacity-0 group-hover:opacity-100 transition cursor-pointer"
                  title="Eliminar este ángulo"
                >
                  <AppIcon name="delete" :size="13" />
                </button>
              </div>

              <!-- Caption -->
              <div class="mt-1.5 px-0.5">
                <span class="text-[10px] text-slate-400 font-mono block truncate" :title="formatTimeSafe(photo.capturedAt)">
                  {{ formatTimeSafe(photo.capturedAt) }}
                </span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- Modal Footer -->
      <div class="flex items-center justify-between p-4 border-t border-slate-800 bg-slate-950/60">
        <!-- Botón Eliminar este perfil -->
        <AppButton
          type="button"
          variant="danger-outline"
          size="sm"
          icon="delete"
          @click="isConfirmDeletePersonOpen = true"
        >
          Eliminar este perfil
        </AppButton>

        <AppButton
          type="button"
          variant="secondary"
          size="sm"
          @click="emit('close')"
        >
          Cerrar
        </AppButton>
      </div>
    </div>

    <!-- Modal de confirmación para eliminar perfil completo -->
    <ConfirmModal
      :show="isConfirmDeletePersonOpen"
      :title="`¿Eliminar perfil de '${person?.name}'?`"
      :message="`Se eliminará permanentemente este perfil biométrico de Firestore, junto con sus ${photosList.length} ángulos faciales y su historial de visitas. Esta acción no se puede revertir.`"
      confirm-text="Eliminar perfil"
      confirm-variant="danger"
      confirm-icon="delete"
      icon="person_remove"
      icon-color="text-red-400"
      :loading="isDeletingPerson"
      @confirm="handleConfirmDeletePerson"
      @close="isConfirmDeletePersonOpen = false"
    />

    <!-- Modal de confirmación para eliminar un ángulo facial individual -->
    <ConfirmModal
      :show="isConfirmDeletePhotoOpen"
      :title="`¿Eliminar ángulo facial #${(photoToDeleteIndex ?? 0) + 1}?`"
      :message="`Esta foto y su vector biométrico se removerán de la galería de este perfil. Esta acción no se puede deshacer.`"
      confirm-text="Eliminar ángulo"
      confirm-variant="danger"
      confirm-icon="delete"
      icon="delete"
      icon-color="text-amber-400"
      :loading="isDeletingPhoto"
      @confirm="handleConfirmDeletePhoto"
      @close="isConfirmDeletePhotoOpen = false"
    />
  </ModalTemplate>
</template>
