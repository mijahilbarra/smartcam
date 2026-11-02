<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';

const props = defineProps({
  allTrackBlocks: {
    type: Array,
    default: () => []
  }
});

// Filtro por estado: 'all' | 'confirmado' | 'fusionado' | 'eliminado' | 'puente_presencia'
const selectedStatusFilter = ref('all');
// Filtro por duración: 'all' | 'ge10' | 'lt10'
const selectedDurationFilter = ref('all');
const hoveredBlock = ref(null);
const mousePos = ref({ x: 0, y: 0 });

const handleMouseEnter = (block, event) => {
  hoveredBlock.value = block;
  if (event) {
    mousePos.value = { x: event.clientX, y: event.clientY };
  }
};

const handleMouseMove = (event) => {
  if (event) {
    mousePos.value = { x: event.clientX, y: event.clientY };
  }
};

const handleMouseLeave = () => {
  hoveredBlock.value = null;
};

const tooltipStyle = computed(() => {
  const offset = 16;
  const tooltipWidth = 360;
  const estimatedHeight = 180;

  const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const winHeight = typeof window !== 'undefined' ? window.innerHeight : 1080;

  let left = mousePos.value.x + offset;
  let top = mousePos.value.y + offset;

  // Boundary check derecha: si se sale a la derecha de la ventana, mostrar a la izquierda del cursor
  if (left + tooltipWidth > winWidth - 16) {
    left = Math.max(16, mousePos.value.x - tooltipWidth - offset);
  }

  // Boundary check inferior: si se sale por abajo de la ventana, mostrar por encima del cursor
  if (top + estimatedHeight > winHeight - 16) {
    top = Math.max(16, mousePos.value.y - estimatedHeight - offset);
  }

  return {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    zIndex: 9999,
    pointerEvents: 'none'
  };
});

const formatTimeSeconds = (isoString) => {
  if (!isoString) return '--:--:--';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  } catch {
    return '--:--:--';
  }
};

const formatDuration = (sec) => {
  const s = Math.max(0, Number(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
};

const formatPoseShort = (pose) => {
  if (!pose) return 'Frontal';
  const p = pose.toLowerCase();
  if (p === 'frontal') return 'Frontal';
  if (p.includes('semi_left') || p === 'left') return 'Semi Izq';
  if (p.includes('semi_right') || p === 'right') return 'Semi Der';
  if (p.includes('profile_left')) return 'Perfil Izq';
  if (p.includes('profile_right')) return 'Perfil Der';
  if (p.includes('tilted_down') || p.includes('down')) return 'Abajo';
  if (p.includes('tilted_up') || p.includes('up')) return 'Arriba';
  return pose;
};

const getStatusBadgeConfig = (block) => {
  const st = block?.status || 'en_analisis';
  if (st === 'en_analisis' || block?.isLive) {
    return {
      label: block?.statusLabel || 'En Análisis',
      icon: 'sensors',
      badgeClass: 'bg-cyan-950/85 text-cyan-300 border-cyan-500/40',
      cardBorder: 'border-cyan-500/40 bg-gradient-to-br from-cyan-950/25 via-slate-900/90 to-slate-950/90',
      stripClass: 'bg-cyan-400 animate-pulse'
    };
  }
  if (st === 'confirmado') {
    return {
      label: block?.statusLabel || 'Confirmado',
      icon: 'verified',
      badgeClass: 'bg-emerald-950/85 text-emerald-300 border-emerald-500/40',
      cardBorder: 'border-emerald-500/35 bg-slate-900/90 hover:border-emerald-500/60',
      stripClass: 'bg-emerald-500'
    };
  }
  if (st === 'fusionado') {
    return {
      label: block?.statusLabel || (block?.mergedWithTrackId ? `Fusionado con #${block.mergedWithTrackId}` : 'Fusionado'),
      icon: 'merge',
      badgeClass: 'bg-sky-950/85 text-sky-300 border-sky-500/40',
      cardBorder: 'border-sky-500/35 bg-slate-900/90 hover:border-sky-500/60',
      stripClass: 'bg-sky-500'
    };
  }
  if (st === 'puente_presencia') {
    return {
      label: block?.statusLabel || 'Puente sin rostro',
      icon: 'visibility_off',
      badgeClass: 'bg-indigo-950/85 text-indigo-300 border-indigo-500/40',
      cardBorder: 'border-indigo-500/30 bg-slate-900/80 hover:border-indigo-500/60',
      stripClass: 'bg-indigo-400'
    };
  }
  // eliminado
  return {
    label: block?.statusLabel || 'Eliminado',
    icon: 'cancel',
    badgeClass: 'bg-rose-950/85 text-rose-300 border-rose-500/40',
    cardBorder: 'border-rose-500/25 bg-slate-950/75 opacity-85 hover:opacity-100 hover:border-rose-500/55',
    stripClass: 'bg-rose-500'
  };
};

const sortedBlocks = computed(() => {
  let list = Array.isArray(props.allTrackBlocks) ? [...props.allTrackBlocks] : [];
  list.sort((a, b) => (a.startedAtEpoch || 0) - (b.startedAtEpoch || 0));

  // Filtro por estado
  if (selectedStatusFilter.value !== 'all') {
    list = list.filter((b) => {
      if (selectedStatusFilter.value === 'confirmado') return b.status === 'confirmado';
      if (selectedStatusFilter.value === 'fusionado') return b.status === 'fusionado' || b.status === 'puente_presencia';
      if (selectedStatusFilter.value === 'eliminado') return b.status === 'eliminado';
      return true;
    });
  }

  // Filtro por duración
  if (selectedDurationFilter.value === 'ge10') {
    list = list.filter((b) => (b.durationSeconds ?? 0) >= 10);
  } else if (selectedDurationFilter.value === 'lt10') {
    list = list.filter((b) => (b.durationSeconds ?? 0) < 10);
  }

  return list;
});

const counts = computed(() => {
  const list = Array.isArray(props.allTrackBlocks) ? props.allTrackBlocks : [];
  return {
    total: list.length,
    confirmed: list.filter((b) => b.status === 'confirmado').length,
    merged: list.filter((b) => b.status === 'fusionado' || b.status === 'puente_presencia').length,
    discarded: list.filter((b) => b.status === 'eliminado').length,
    live: list.filter((b) => b.status === 'en_analisis' || b.isLive).length,
    ge10: list.filter((b) => (b.durationSeconds ?? 0) >= 10).length,
    lt10: list.filter((b) => (b.durationSeconds ?? 0) < 10).length
  };
});

const scrollContainer = ref(null);
const scrollToBottom = async (smooth = true, force = false) => {
  await nextTick();
  const el = scrollContainer.value;
  if (!el) return;
  // Solo hacer scroll hacia abajo si el usuario ya está cerca del fondo (<= 80px) o si es forzado (ej. carga inicial)
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
  if (force || isNearBottom) {
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
};

watch(
  () => sortedBlocks.value.length,
  () => scrollToBottom(true, false)
);
onMounted(() => scrollToBottom(false, true));
</script>

<template>
  <div class="flex flex-col bg-slate-950/70 border border-slate-800 rounded-xl overflow-hidden h-[820px] shadow-sm">
    <!-- Header de la Barra de TrackBlocks -->
    <div class="p-3.5 border-b border-slate-800 bg-slate-900/90 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="p-2 rounded-lg bg-purple-950/70 text-purple-400 border border-purple-500/30">
            <AppIcon name="view_timeline" :size="18" />
          </div>
          <div>
            <h3 class="text-sm font-bold text-white flex items-center gap-2">
              Barra de TrackBlocks
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-950/80 text-purple-300 border border-purple-500/30">
                SIN BORRAR
              </span>
            </h3>
            <p class="text-[11px] text-slate-400 font-medium">
              Todos los bloques detectados (pasa el cursor para ver el motivo)
            </p>
          </div>
        </div>

        <AppBadge variant="default" class="text-[11px] font-mono">
          {{ sortedBlocks.length }} / {{ counts.total }} bloques
        </AppBadge>
      </div>

      <!-- Contadores Rápidos por Estado -->
      <div class="grid grid-cols-3 gap-1.5 pt-1 text-[10px]">
        <div class="bg-emerald-950/30 border border-emerald-500/20 rounded-lg px-2 py-1 flex items-center justify-between">
          <span class="text-emerald-300 font-medium">Confirmados:</span>
          <span class="font-bold text-emerald-400 font-mono">{{ counts.confirmed }}</span>
        </div>
        <div class="bg-sky-950/30 border border-sky-500/20 rounded-lg px-2 py-1 flex items-center justify-between">
          <span class="text-sky-300 font-medium">Fusionados:</span>
          <span class="font-bold text-sky-400 font-mono">{{ counts.merged }}</span>
        </div>
        <div class="bg-rose-950/30 border border-rose-500/20 rounded-lg px-2 py-1 flex items-center justify-between">
          <span class="text-rose-300 font-medium">Eliminados:</span>
          <span class="font-bold text-rose-400 font-mono">{{ counts.discarded }}</span>
        </div>
      </div>

      <!-- Filtro por Duración (< 10s / >= 10s) -->
      <div class="flex items-center justify-between gap-1 pt-0.5">
        <div class="flex items-center gap-1 bg-slate-950/90 border border-slate-800 rounded-lg p-0.5 text-[10px] w-full">
          <div class="flex items-center gap-1 px-1.5 text-slate-400 font-semibold text-[10px]">
            <AppIcon name="timer" :size="12" class="text-amber-400" />
            <span>Duración:</span>
          </div>
          <button
            type="button"
            @click="selectedDurationFilter = 'all'"
            :class="[
              'flex-1 px-1.5 py-0.5 rounded font-medium transition cursor-pointer text-center',
              selectedDurationFilter === 'all' ? 'bg-amber-600/80 text-white font-bold' : 'text-slate-400 hover:text-white'
            ]"
          >
            Todas ({{ counts.total }})
          </button>
          <button
            type="button"
            @click="selectedDurationFilter = 'ge10'"
            :class="[
              'flex-1 px-1.5 py-0.5 rounded font-medium transition cursor-pointer text-center',
              selectedDurationFilter === 'ge10' ? 'bg-emerald-600/80 text-white font-bold' : 'text-slate-400 hover:text-white'
            ]"
          >
            ≥ 10s ({{ counts.ge10 }})
          </button>
          <button
            type="button"
            @click="selectedDurationFilter = 'lt10'"
            :class="[
              'flex-1 px-1.5 py-0.5 rounded font-medium transition cursor-pointer text-center',
              selectedDurationFilter === 'lt10' ? 'bg-purple-600/80 text-white font-bold' : 'text-slate-400 hover:text-white'
            ]"
          >
            &lt; 10s ({{ counts.lt10 }})
          </button>
        </div>
      </div>

      <!-- Filtros Rápidos de Estado -->
      <div class="flex items-center justify-between gap-1 pt-0.5">
        <div class="flex items-center gap-1 bg-slate-950/80 border border-slate-800/80 rounded-lg p-0.5 text-[10px] w-full">
          <button
            type="button"
            @click="selectedStatusFilter = 'all'"
            :class="[
              'flex-1 px-2 py-0.5 rounded-md font-medium transition cursor-pointer text-center',
              selectedStatusFilter === 'all' ? 'bg-purple-600 text-white' : 'text-slate-400 hover:text-white'
            ]"
          >
            Todos
          </button>
          <button
            type="button"
            @click="selectedStatusFilter = 'confirmado'"
            :class="[
              'flex-1 px-2 py-0.5 rounded-md font-medium transition cursor-pointer text-center',
              selectedStatusFilter === 'confirmado' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
            ]"
          >
            Confirmados ({{ counts.confirmed }})
          </button>
          <button
            type="button"
            @click="selectedStatusFilter = 'fusionado'"
            :class="[
              'flex-1 px-2 py-0.5 rounded-md font-medium transition cursor-pointer text-center',
              selectedStatusFilter === 'fusionado' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'
            ]"
          >
            Fusionados ({{ counts.merged }})
          </button>
          <button
            type="button"
            @click="selectedStatusFilter = 'eliminado'"
            :class="[
              'flex-1 px-2 py-0.5 rounded-md font-medium transition cursor-pointer text-center',
              selectedStatusFilter === 'eliminado' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-white'
            ]"
          >
            Eliminados ({{ counts.discarded }})
          </button>
        </div>
      </div>
    </div>

    <!-- Lista Cronológica de TODOS los TrackBlocks -->
    <div ref="scrollContainer" class="flex-1 p-3 overflow-y-auto space-y-2">
      <div
        v-if="sortedBlocks.length === 0"
        class="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 gap-2.5"
      >
        <div class="w-11 h-11 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500">
          <AppIcon name="Layers" :size="24" class="opacity-60" />
        </div>
        <h4 class="text-xs font-bold text-slate-200">Sin TrackBlocks registrados aún</h4>
        <p class="text-[11px] text-slate-400 max-w-[240px] leading-relaxed">
          Aquí aparecerán absolutamente todos los bloques de YOLO en la silla (confirmados, fusionados y eliminados) sin borrarse nunca.
        </p>
      </div>

      <div
        v-for="block in sortedBlocks"
        :key="block.id || block.trackId"
        @mouseenter="(e) => handleMouseEnter(block, e)"
        @mousemove="handleMouseMove"
        @mouseleave="handleMouseLeave"
        :class="[
          'group relative rounded-xl border p-2.5 transition-all duration-200 select-none cursor-help',
          getStatusBadgeConfig(block).cardBorder
        ]"
      >
        <!-- Tira lateral de color según decisión -->
        <div :class="['absolute left-0 top-0 bottom-0 w-1 rounded-l-xl', getStatusBadgeConfig(block).stripClass]"></div>

        <!-- Fila Superior: TrackID + Horario + Etiqueta de Estado -->
        <div class="flex items-center justify-between gap-1.5 pl-1.5">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="font-mono text-xs font-extrabold text-white">
              #{{ block.trackId }}
            </span>
            <span class="text-[10px] font-mono text-slate-400">
              {{ formatTimeSeconds(block.startTime) }} → {{ formatTimeSeconds(block.endTime) }}
            </span>
            <span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-950 text-slate-300 border border-slate-800">
              {{ formatDuration(block.durationSeconds) }}
            </span>
          </div>

          <!-- Etiqueta Principal (Eliminado / Fusionado con / Confirmado / En Análisis) -->
          <span
            :class="[
              'px-2 py-0.5 rounded-full text-[10px] font-bold border flex items-center gap-1 flex-shrink-0 max-w-[195px] truncate',
              getStatusBadgeConfig(block).badgeClass
            ]"
          >
            <AppIcon :name="getStatusBadgeConfig(block).icon" :size="11" />
            <span class="truncate">{{ getStatusBadgeConfig(block).label }}</span>
          </span>
        </div>

        <!-- Fila Central: Miniatura + Métricas del Bloque -->
        <div class="flex items-center gap-2.5 mt-2 pl-1.5">
          <!-- Miniatura si tuvo rostro -->
          <div class="w-9 h-9 rounded-lg bg-slate-950 border border-slate-800 overflow-hidden flex-shrink-0 flex items-center justify-center">
            <img
              v-if="block.thumbnailBase64"
              :src="block.thumbnailBase64"
              :alt="`Track #${block.trackId}`"
              class="w-full h-full object-cover"
            />
            <AppIcon
              v-else
              :name="block.status === 'eliminado' ? 'person_off' : 'visibility_off'"
              :size="16"
              class="text-slate-600"
            />
          </div>

          <div class="min-w-0 flex-1 flex flex-col gap-0.5 text-[10px]">
            <div class="flex items-center gap-2 text-slate-300 flex-wrap">
              <span class="flex items-center gap-0.5 font-mono">
                <AppIcon name="photo_camera" :size="11" class="text-blue-400" />
                {{ block.photosCount || 0 }} fotos ({{ block.anatomicalFacesCount || 0 }} anat.)
              </span>
              <span class="text-slate-600">•</span>
              <span class="font-mono text-slate-400">
                StaffSim: <strong :class="(block.maxStaffSim || 0) >= 0.46 ? 'text-rose-400' : 'text-slate-200'">{{ block.maxStaffSim ?? 0 }}</strong>
              </span>
              <span class="text-slate-600">•</span>
              <span class="font-mono text-slate-400">
                Pie: <strong :class="(block.standingRatio || 0) >= 0.65 ? 'text-rose-400' : 'text-slate-200'">{{ Math.round((block.standingRatio || 0) * 100) }}%</strong>
              </span>
            </div>

            <!-- Poses o destino de fusión -->
            <div class="flex items-center justify-between gap-1 text-[9px] text-slate-400">
              <div class="flex items-center gap-1 truncate">
                <span v-if="block.mergedWithLabel" class="text-sky-300 font-semibold truncate">
                  🔗 Destino: {{ block.mergedWithLabel }}
                </span>
                <span v-else-if="block.clientName" class="text-emerald-300 font-semibold truncate">
                  👤 {{ block.clientName }}
                </span>
                <span v-else-if="block.poses && block.poses.length > 0" class="truncate">
                  Poses: {{ block.poses.map(formatPoseShort).join(', ') }}
                </span>
                <span v-else class="text-slate-500 italic">
                  Sin rostro capturado
                </span>
              </div>
              <span class="text-purple-400/80 font-sans flex items-center gap-0.5 flex-shrink-0">
                <AppIcon name="info" :size="11" />
                Hover para motivo
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tooltip Flotante de Motivo / Veredicto que sigue al cursor -->
    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-150 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition-opacity duration-100 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="hoveredBlock"
          :style="tooltipStyle"
          class="bg-slate-950/95 backdrop-blur-md border border-purple-500/50 shadow-2xl rounded-xl p-3.5 max-w-[360px] text-xs space-y-2 select-none"
        >
          <div class="flex items-center justify-between gap-2 pb-1.5 border-b border-purple-500/20 text-[11px] font-bold uppercase tracking-wider text-purple-300">
            <span class="flex items-center gap-1.5">
              <AppIcon name="psychology" :size="14" class="text-purple-400" />
              ¿Por qué fue {{ getStatusBadgeConfig(hoveredBlock).label }}?
            </span>
            <span
              v-if="hoveredBlock.verdict"
              class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-500/40"
            >
              {{ hoveredBlock.verdict }}
            </span>
          </div>

          <p class="text-xs text-slate-200 leading-relaxed font-sans">
            {{ hoveredBlock.reason || 'Sin detalle registrado.' }}
          </p>

          <div
            v-if="hoveredBlock.initialReason && hoveredBlock.initialReason !== hoveredBlock.reason"
            class="text-[10px] text-slate-400 pt-1.5 border-t border-slate-800/80 font-mono"
          >
            <span class="text-purple-400/80 font-semibold">Decisión inicial:</span> {{ hoveredBlock.initialReason }}
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
