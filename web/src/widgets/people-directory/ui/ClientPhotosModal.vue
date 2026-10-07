<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import { formatDateTime } from '@/shared/lib/date-utils';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  person: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['close']);

const selectedPhotoIndex = ref(0);

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

// Galería de fotos con soporte de fallback si person.photos no existe o está vacío
const photosList = computed(() => {
  if (!props.person) return [];
  if (Array.isArray(props.person.photos) && props.person.photos.length > 0) {
    return props.person.photos;
  }
  if (props.person.thumbnailBase64) {
    return [{
      thumbnailBase64: props.person.thumbnailBase64,
      sharpnessScore: props.person.bestFaceScore || 0,
      capturedAt: props.person.firstSeen || props.person.lastSeen || null,
      isFallback: true
    }];
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

// Total de ángulos registrados (acoplado directamente a la cantidad real de fotos)
const totalAngles = computed(() => photosList.value.length);

// Reiniciar índice seleccionado al abrir modal o cambiar de persona
watch(() => props.person?.id, () => {
  selectedPhotoIndex.value = 0;
});
watch(() => props.show, (newVal) => {
  if (newVal) selectedPhotoIndex.value = 0;
});

const selectPhoto = (index) => {
  selectedPhotoIndex.value = index;
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
                v-else-if="person.visitCount > 1"
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
            <span class="text-sm font-bold text-white font-mono">{{ photosList.length }} / 6</span>
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
          </div>

          <!-- Inspector Details -->
          <div class="flex-1 w-full space-y-3">
            <div class="flex items-center justify-between border-b border-slate-800/80 pb-2">
              <h4 class="text-sm font-bold text-white flex items-center gap-2">
                <AppIcon name="zoom_in" :size="18" class="text-sky-400" />
                <span>Detalles del Ángulo Facial #{{ selectedPhotoIndex + 1 }}</span>
              </h4>
              <span v-if="selectedPhoto.isFallback" class="text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                Foto principal de perfil
              </span>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
              <div class="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800">
                <span class="text-[11px] text-slate-400 block mb-0.5 flex items-center gap-1.5">
                  <AppIcon name="center_focus_strong" :size="14" class="text-emerald-400" />
                  <span>Nitidez biométrica:</span>
                </span>
                <span class="text-sm font-bold font-mono text-emerald-300">
                  {{ formatSharpness(selectedPhoto.sharpnessScore) }}
                </span>
              </div>

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
              Los ángulos biométricos complementarios permiten reconocer al cliente sin importar hacia dónde gire la cabeza en el sillón de atención.
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

          <!-- Grid of Photos -->
          <div v-else class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
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
      <div class="flex items-center justify-end p-4 border-t border-slate-800 bg-slate-950/60">
        <button
          type="button"
          @click="emit('close')"
          class="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 hover:border-slate-600 transition cursor-pointer"
        >
          Cerrar
        </button>
      </div>
    </div>
  </ModalTemplate>
</template>
