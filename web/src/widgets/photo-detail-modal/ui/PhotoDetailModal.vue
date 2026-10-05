<script setup>
import { ref } from 'vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import { formatDateTime } from '@/shared/lib/date-utils';
import { hexToRgba } from '@/shared/lib/geometry';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  photo: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['close', 'calibrate-with-photo']);

const copied = ref(false);

const copyDocId = () => {
  if (props.photo?.id && navigator?.clipboard) {
    navigator.clipboard.writeText(props.photo.id);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }
};
</script>

<template>
  <ModalTemplate :show="show" max-width="max-w-6xl" @close="emit('close')">
    <!-- Header -->
    <ModalHeader
      title="Detalle de Captura y Detección"
      icon="visibility"
      @close="emit('close')"
    >
      <template #subtitle>
        <div class="flex items-center gap-2 mt-1">
          <span class="text-xs text-slate-400 font-mono">Doc ID: {{ photo?.id }}</span>
          <button
            type="button"
            @click="copyDocId"
            class="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1 cursor-pointer font-sans"
          >
            <AppIcon :name="copied ? 'check' : 'content_copy'" :size="13" />
            <span>{{ copied ? '¡Copiado!' : 'Copiar' }}</span>
          </button>
        </div>
      </template>
      <template #actions>
        <AppButton
          size="sm"
          variant="secondary"
          icon="aspect_ratio"
          @click="emit('calibrate-with-photo', photo)"
        >
          Calibrar con esta foto
        </AppButton>
      </template>
    </ModalHeader>

    <!-- Body -->
    <div class="p-4 sm:p-6 overflow-y-auto max-h-[80vh] flex flex-col gap-6">
      <!-- Dual Comparison Grid -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Original Photo -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between text-xs font-semibold text-slate-300">
            <span class="flex items-center gap-1.5">
              <AppIcon name="photo_camera" :size="16" class="text-blue-400" />
              Foto Original
            </span>
            <a
              v-if="photo?.downloadUrl"
              :href="photo.downloadUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-400 hover:underline flex items-center gap-1"
            >
              <span>Ver HD ↗</span>
            </a>
          </div>

          <div class="w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
            <img
              v-if="photo?.downloadUrl"
              :src="photo.downloadUrl"
              alt="Foto Original"
              class="w-full h-full object-contain"
            />
            <div v-else class="text-xs text-slate-500">Cargando imagen...</div>
          </div>
        </div>

        <!-- Annotated Photo with SVG Overlays -->
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between text-xs font-semibold text-slate-300">
            <span class="flex items-center gap-1.5">
              <AppIcon name="center_focus_strong" :size="16" class="text-emerald-400" />
              Foto con Marcos (Frontend SVG)
            </span>
            <span class="text-slate-500 font-mono text-[11px]">Proyección ROI + YOLO</span>
          </div>

          <div class="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
            <img
              v-if="photo?.downloadUrl"
              :src="photo.downloadUrl"
              alt="Foto Anotada"
              class="w-full h-full object-contain"
            />

            <!-- SVG Overlay layer -->
            <svg
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              class="absolute inset-0 w-full h-full pointer-events-none"
            >
              <!-- Quadrants -->
              <polygon
                v-for="q in photo?.quadrants || []"
                :key="q.id || q.name"
                :points="(q.polygonNorm || []).map(p => `${p[0]},${p[1]}`).join(' ')"
                :fill="hexToRgba(q.color || '#3b82f6', 0.2)"
                :stroke="q.color || '#3b82f6'"
                stroke-width="3"
              />

              <!-- Humans Detected (YOLO) -->
              <g v-for="(box, i) in photo?.detections?.humans || []" :key="`human-${i}`">
                <!-- box: [ymin, xmin, ymax, xmax] -->
                <rect
                  :x="box[1]"
                  :y="box[0]"
                  :width="box[3] - box[1]"
                  :height="box[2] - box[0]"
                  fill="none"
                  stroke="#10b981"
                  stroke-width="4"
                />
              </g>
            </svg>
          </div>
        </div>
      </div>

      <!-- Metadata & Analysis Box -->
      <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div class="flex items-center gap-2">
            <span class="text-slate-400">Fecha y Hora:</span>
            <strong class="text-white font-mono">{{ formatDateTime(photo?.timestamp, photo?.epoch) }}</strong>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-slate-400">Ruta Firestore:</span>
            <code class="text-slate-300 font-mono text-[11px]">camera_catcher/photos/photos/{{ photo?.id }}</code>
          </div>
        </div>

        <div class="pt-3 border-t border-slate-800/80">
          <h4 class="text-xs uppercase tracking-wider font-semibold text-blue-400 mb-1.5 flex items-center gap-1.5">
            <AppIcon name="psychology" :size="16" />
            Análisis de Gemini Vision AI:
          </h4>
          <p class="text-sm text-slate-200 leading-relaxed font-sans whitespace-pre-line">
            {{ photo?.geminiAnalysis || photo?.analysis || 'Sin análisis textual registrado para esta captura.' }}
          </p>
        </div>
      </div>
    </div>
  </ModalTemplate>
</template>
