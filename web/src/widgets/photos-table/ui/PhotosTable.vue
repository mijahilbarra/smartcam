<script setup>
import { ref } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppSpinner from '@/shared/ui/atoms/AppSpinner.vue';
import PaginationNav from '@/shared/ui/molecules/PaginationNav.vue';
import { formatDateTime } from '@/shared/lib/date-utils';

const props = defineProps({
  photos: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  },
  currentPage: {
    type: Number,
    default: 1
  },
  pageSize: {
    type: Number,
    default: 10
  },
  totalPages: {
    type: Number,
    default: 1
  },
  totalPhotos: {
    type: Number,
    default: 0
  }
});

const emit = defineEmits([
  'update:currentPage',
  'update:pageSize',
  'view-detail',
  'calibrate-photo'
]);

const copiedId = ref(null);

const copyDocId = (id) => {
  if (navigator?.clipboard) {
    navigator.clipboard.writeText(id);
    copiedId.value = id;
    setTimeout(() => {
      copiedId.value = null;
    }, 1500);
  }
};
</script>

<template>
  <section class="w-full bg-slate-850 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm flex flex-col">
    <!-- Header -->
    <div class="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800 bg-slate-900/60">
      <div class="flex items-center gap-2.5">
        <AppIcon name="photo_library" :size="22" class="text-blue-400" />
        <h2 class="text-base sm:text-lg font-bold text-white">Registro de Fotogramas y Análisis</h2>
      </div>
      <div class="flex items-center gap-2">
        <span class="live-dot-pulse" title="Sincronización en tiempo real activa"></span>
        <span class="text-xs text-slate-400 font-mono">{{ totalPhotos }} capturas</span>
      </div>
    </div>

    <!-- Table -->
    <div class="w-full overflow-x-auto">
      <table class="w-full text-left text-xs border-collapse">
        <thead class="bg-slate-950/80 text-slate-400 uppercase text-[11px] tracking-wider border-b border-slate-800">
          <tr>
            <th class="py-3 px-4 w-36">Miniatura (Cliente)</th>
            <th class="py-3 px-4 w-52">Fecha, Hora y Doc ID</th>
            <th class="py-3 px-4 min-w-[280px]">Cuadrantes y Análisis</th>
            <th class="py-3 px-4 w-32 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-800/80 text-slate-300">
          <tr v-if="loading && photos.length === 0">
            <td colspan="4" class="py-12 text-center text-slate-400">
              <div class="flex flex-col items-center justify-center gap-2">
                <AppSpinner size="lg" />
                <span>Cargando capturas en tiempo real...</span>
              </div>
            </td>
          </tr>

          <tr v-else-if="photos.length === 0">
            <td colspan="4" class="py-12 text-center text-slate-500">
              No hay fotogramas registrados en Firestore aún.
            </td>
          </tr>

          <tr
            v-for="photo in photos"
            :key="photo.id"
            class="hover:bg-slate-800/40 transition-colors"
          >
            <!-- Thumbnail -->
            <td class="py-3 px-4 align-top">
              <div
                class="w-24 h-16 bg-slate-950 rounded-lg overflow-hidden border border-slate-800 relative cursor-pointer group flex items-center justify-center"
                @click="emit('view-detail', photo)"
              >
                <img
                  v-if="photo.downloadUrl"
                  :src="photo.downloadUrl"
                  alt="Miniatura"
                  loading="lazy"
                  class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                />
                <div v-else class="flex flex-col items-center gap-1 text-[10px] text-slate-500">
                  <AppSpinner size="sm" />
                </div>
                <div class="absolute inset-0 bg-blue-600/10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <AppIcon name="visibility" :size="20" class="text-white drop-shadow" />
                </div>
              </div>
            </td>

            <!-- Date, Time and Doc ID -->
            <td class="py-3 px-4 align-top font-mono">
              <div class="text-slate-200 font-semibold mb-1">
                {{ formatDateTime(photo.timestamp, photo.epoch) }}
              </div>
              <div class="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span class="truncate max-w-[120px]">{{ photo.id }}</span>
                <button
                  type="button"
                  @click="copyDocId(photo.id)"
                  class="hover:text-blue-400 p-0.5 rounded cursor-pointer transition"
                  :title="copiedId === photo.id ? '¡Copiado!' : 'Copiar Doc ID'"
                >
                  <AppIcon :name="copiedId === photo.id ? 'check' : 'content_copy'" :size="14" />
                </button>
              </div>
            </td>

            <!-- Quadrants & Analysis -->
            <td class="py-3 px-4 align-top font-sans text-xs">
              <!-- Occupancy tags if present -->
              <div v-if="photo.quadrantStatus" class="flex flex-wrap gap-1.5 mb-2">
                <span
                  v-for="(st, qName) in photo.quadrantStatus"
                  :key="qName"
                  :class="[
                    'px-2 py-0.5 rounded text-[11px] font-medium border',
                    st.occupied
                      ? 'bg-red-950/40 text-red-300 border-red-800/40'
                      : 'bg-emerald-950/40 text-emerald-300 border-emerald-800/40'
                  ]"
                >
                  {{ qName }}: {{ st.occupied ? 'Ocupado' : 'Libre' }}
                </span>
              </div>

              <!-- Gemini Text Analysis -->
              <p class="text-slate-300 line-clamp-3 leading-relaxed">
                {{ photo.geminiAnalysis || photo.analysis || 'Sin análisis textual registrado.' }}
              </p>
            </td>

            <!-- Actions -->
            <td class="py-3 px-4 align-top text-right">
              <div class="flex flex-col items-end gap-1.5">
                <AppButton
                  size="sm"
                  variant="primary"
                  icon="visibility"
                  @click="emit('view-detail', photo)"
                >
                  Detalle
                </AppButton>
                <AppButton
                  size="sm"
                  variant="secondary"
                  icon="aspect_ratio"
                  @click="emit('calibrate-photo', photo)"
                  title="Abrir esta foto en el calibrador para ajustar zonas"
                >
                  Calibrar
                </AppButton>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <PaginationNav
      :current-page="currentPage"
      :total-pages="totalPages"
      :page-size="pageSize"
      :total-items="totalPhotos"
      @update:current-page="emit('update:currentPage', $event)"
      @update:page-size="emit('update:pageSize', $event)"
    />
  </section>
</template>
