<script setup>
import { ref, computed, watch } from 'vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppInput from '@/shared/ui/atoms/AppInput.vue';
import AppSelect from '@/shared/ui/atoms/AppSelect.vue';
import { useQuadrants } from '@/entities/quadrant/model/useQuadrants';
import { useDaemonState } from '@/entities/daemon/model/useDaemonState';
import { useCalibratorTools } from '@/features/calibrate-quadrants/model/useCalibratorTools';
import { hexToRgba, boxNormToPolygonNorm, toPointObject } from '@/shared/lib/geometry';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close']);

const {
  quadrants,
  saving,
  selectedIndex,
  addQuadrant,
  deleteQuadrant,
  resetToDefaults,
  saveToFirebase
} = useQuadrants();

const {
  currentMode,
  isDragging,
  isDrawing,
  drawCurrentBox,
  setMode,
  startDrag,
  updateDrag,
  endDrag,
  startDrawing,
  updateDrawing,
  finishDrawing
} = useCalibratorTools(quadrants);

const statusMessage = ref('');
const statusType = ref('info');
const stageRef = ref(null);

const { snapshotUrl } = useDaemonState();
const snapshotTimestamp = ref(Date.now());
const refreshSnapshot = () => {
  snapshotTimestamp.value = Date.now();
};
const liveImageUrl = computed(() => {
  if (!snapshotUrl.value) return null;
  return `${snapshotUrl.value}?t=${snapshotTimestamp.value}`;
});

watch(() => props.show, (isOpen) => {
  if (isOpen) refreshSnapshot();
});

const zoneTypeOptions = [
  { value: 'barber_chair', label: 'Silla de Barbero (Corte)' },
  { value: 'waiting_chair', label: 'Silla de Espera' },
  { value: 'barber_workstation', label: 'Puesto de Barbero (Personal)' },
  { value: 'walking_zone', label: 'Zona de Tránsito / Puerta' },
  { value: 'custom_zone', label: 'Otra Zona' }
];

const roleOptions = [
  { value: 'client', label: 'Cliente' },
  { value: 'staff', label: 'Personal / Barbero' },
  { value: 'visitor', label: 'Visitante' }
];

const onSave = async () => {
  statusMessage.value = 'Guardando cuadrantes en Firestore...';
  statusType.value = 'info';
  const res = await saveToFirebase();
  if (res.success) {
    statusMessage.value = '✓ Cuadrantes guardados correctamente en Firebase.';
    statusType.value = 'success';
    setTimeout(() => {
      statusMessage.value = '';
    }, 2500);
  } else {
    statusMessage.value = `Error: ${res.error}`;
    statusType.value = 'error';
  }
};

// Generador de puntos SVG en escala 0..1000
const getPolygonPoints = (q) => {
  if (!q) return '';
  const poly = q.polygonNorm && q.polygonNorm.length >= 3
    ? q.polygonNorm
    : boxNormToPolygonNorm(q.boxNorm || [0.2, 0.2, 0.6, 0.6]);

  return poly
    .map(p => {
      const pt = toPointObject(p);
      return `${(pt.x * 1000).toFixed(1)},${(pt.y * 1000).toFixed(1)}`;
    })
    .join(' ');
};

const getCentroid = (q) => {
  if (!q) return { x: 500, y: 500 };
  const poly = q.polygonNorm && q.polygonNorm.length >= 3
    ? q.polygonNorm
    : boxNormToPolygonNorm(q.boxNorm || [0.2, 0.2, 0.6, 0.6]);

  const avgX = poly.reduce((acc, p) => acc + toPointObject(p).x, 0) / poly.length;
  const avgY = poly.reduce((acc, p) => acc + toPointObject(p).y, 0) / poly.length;
  return {
    x: Math.round(avgX * 1000),
    y: Math.round(avgY * 1000)
  };
};

const getCornerPoint = (q, cornerIdx) => {
  if (!q) return { x: 0, y: 0 };
  const poly = q.polygonNorm && q.polygonNorm.length >= 4
    ? q.polygonNorm
    : boxNormToPolygonNorm(q.boxNorm || [0.2, 0.2, 0.6, 0.6]);

  const pt = toPointObject(poly[cornerIdx] || poly[0]);
  return {
    x: Math.round(pt.x * 1000),
    y: Math.round(pt.y * 1000)
  };
};

// Coordenadas normalizadas 0..1 para eventos de puntero
const getStageCoords = (e) => {
  const rect = stageRef.value?.getBoundingClientRect();
  if (!rect) return { normX: 0, normY: 0, clientX: 0, clientY: 0, w: 1, h: 1 };
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const normX = Math.max(0, Math.min(1.0, (clientX - rect.left) / rect.width));
  const normY = Math.max(0, Math.min(1.0, (clientY - rect.top) / rect.height));
  return { normX, normY, clientX, clientY, w: rect.width, h: rect.height };
};

const onPointerDown = (e, idx = null, handle = null) => {
  const { normX, normY, clientX, clientY } = getStageCoords(e);

  if (currentMode.value === 'draw') {
    startDrawing(normX, normY);
  } else if (idx !== null) {
    selectedIndex.value = idx;
    startDrag(idx, handle || 'body', clientX, clientY);
  }
};

const onPointerMove = (e) => {
  if (isDragging.value) {
    const { clientX, clientY, w, h } = getStageCoords(e);
    updateDrag(clientX, clientY, w, h);
  } else if (isDrawing.value) {
    const { normX, normY } = getStageCoords(e);
    updateDrawing(normX, normY);
  }
};

const onPointerUp = () => {
  if (isDragging.value) {
    endDrag();
  } else if (isDrawing.value) {
    const newBox = finishDrawing();
    if (newBox) {
      const nextIdx = quadrants.value.length + 1;
      quadrants.value.push({
        id: `zone_${Date.now()}`,
        name: `Zona ${nextIdx}`,
        badge: `Z${nextIdx}`,
        color: '#FFD700',
        type: 'barber_chair',
        capturePerson: true,
        role: 'client',
        labelOnOccupied: '',
        boxNorm: newBox,
        polygonNorm: boxNormToPolygonNorm(newBox)
      });
      selectedIndex.value = quadrants.value.length - 1;
      setMode('move');
    }
  }
};
</script>

<template>
  <ModalTemplate :show="show" max-width="max-w-6xl" @close="emit('close')">
    <!-- Header -->
    <ModalHeader
      title="Calibrador Visual de Cuadrantes (Zonas ROI)"
      icon="aspect_ratio"
      tag="camera_catcher/quadrants"
      @close="emit('close')"
    >
      <template #actions>
        <AppButton size="sm" variant="secondary" icon="add_box" @click="addQuadrant('barber_chair')">
          Crear Zona
        </AppButton>
        <AppButton
          size="sm"
          variant="danger-outline"
          icon="delete"
          :disabled="quadrants.length === 0 || selectedIndex < 0"
          @click="deleteQuadrant(selectedIndex)"
        >
          Eliminar Zona
        </AppButton>
        <AppButton size="sm" variant="secondary" icon="layers_clear" :disabled="quadrants.length === 0" @click="resetToDefaults">
          Limpiar Zonas
        </AppButton>
        <AppButton size="sm" variant="primary" icon="save" :loading="saving" @click="onSave">
          Guardar en Firebase
        </AppButton>
      </template>
    </ModalHeader>

    <!-- Feedback Banner -->
    <div
      v-if="statusMessage"
      :class="[
        'mx-5 mt-3 p-2.5 rounded-lg text-xs font-medium',
        statusType === 'success' ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/30' : 'bg-blue-950/60 text-blue-300 border border-blue-500/30'
      ]"
    >
      {{ statusMessage }}
    </div>

    <!-- Main Layout: Canvas Viewport & Sidebar -->
    <div class="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
      <!-- Left: Interactive Canvas / SVG -->
      <div class="lg:col-span-8 flex flex-col gap-3">
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center justify-between gap-3 bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 text-xs">
          <!-- Live Snapshot Refresh -->
          <div class="flex items-center gap-2">
            <AppButton
              size="sm"
              variant="secondary"
              icon="refresh"
              title="Obtener fotograma actual de la cámara"
              @click="refreshSnapshot"
            >
              Capturar de Cámara
            </AppButton>
          </div>

          <!-- Tool Modes -->
          <div class="flex items-center gap-2">
            <span class="text-slate-400">Modo:</span>
            <AppButton
              size="sm"
              :variant="currentMode === 'move' ? 'primary' : 'secondary'"
              icon="pan_tool"
              @click="setMode('move')"
            >
              Mover/Ajustar
            </AppButton>
            <AppButton
              size="sm"
              :variant="currentMode === 'draw' ? 'primary' : 'secondary'"
              icon="draw"
              @click="setMode('draw')"
            >
              Dibujar con Ratón
            </AppButton>
          </div>
        </div>

        <!-- Interactive Viewport Stage -->
        <div
          ref="stageRef"
          class="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 select-none cursor-crosshair touch-none"
          @pointerdown="onPointerDown($event)"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <!-- Base Image -->
          <img
            v-if="liveImageUrl"
            :src="liveImageUrl"
            alt="Imagen de calibración"
            class="w-full h-full object-contain pointer-events-none"
          />
          <div
            v-else
            class="w-full h-full flex flex-col items-center justify-center text-slate-500 text-xs"
          >
            Esperando transmisión o fotograma de la cámara...
          </div>

          <!-- Overlay si no hay zonas configuradas -->
          <div
            v-if="quadrants.length === 0"
            class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none bg-black/40 text-center p-4 z-10"
          >
            <div class="bg-slate-900/90 border border-slate-700/80 rounded-xl p-4 max-w-sm backdrop-blur-sm shadow-xl">
              <p class="text-amber-400 font-bold text-xs flex items-center justify-center gap-1.5 mb-1">
                <AppIcon name="warning" :size="16" />
                Calibración Inicial Requerida
              </p>
              <p class="text-slate-300 text-xs">
                No hay zonas configuradas. Usa el botón <strong>Crear Zona</strong> o activa <strong>Dibujar con Ratón</strong> para delimitar tus sillas y áreas.
              </p>
            </div>
          </div>

          <!-- Interactive SVG layer -->
          <svg
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            class="absolute inset-0 w-full h-full"
          >
            <!-- Quadrants Polygons & Labels -->
            <g
              v-for="(q, idx) in quadrants"
              :key="q.id || `quad-${idx}`"
              class="cursor-pointer"
              @pointerdown.stop="onPointerDown($event, idx, 'body')"
            >
              <!-- Perspective Polygon -->
              <polygon
                :points="getPolygonPoints(q)"
                :fill="hexToRgba(q.color, idx === selectedIndex ? 0.38 : 0.18)"
                :stroke="q.color"
                :stroke-width="idx === selectedIndex ? 3.5 : 2"
                :stroke-dasharray="idx === selectedIndex ? 'none' : '5,3'"
              />

              <!-- Label Badge on SVG at centroid -->
              <g :transform="`translate(${getCentroid(q).x}, ${getCentroid(q).y})`">
                <rect
                  :x="-((q.badge || q.name).length * 8 + 14) / 2"
                  :y="-14"
                  :width="(q.badge || q.name).length * 8 + 14"
                  :height="24"
                  rx="6"
                  :fill="q.color"
                  fill-opacity="0.9"
                />
                <text
                  x="0"
                  y="2"
                  fill="#ffffff"
                  font-family="Inter, sans-serif"
                  font-size="12"
                  font-weight="bold"
                  text-anchor="middle"
                  dominant-baseline="middle"
                >
                  {{ q.badge || q.name }}
                </text>
              </g>

              <!-- Resize handles for selected quadrant -->
              <template v-if="idx === selectedIndex && currentMode === 'move'">
                <!-- NW (Corner 0) -->
                <circle
                  :cx="getCornerPoint(q, 0).x"
                  :cy="getCornerPoint(q, 0).y"
                  r="12"
                  fill="#ffffff"
                  :stroke="q.color"
                  stroke-width="3"
                  class="cursor-nwse-resize"
                  @pointerdown.stop="onPointerDown($event, idx, 'nw')"
                />
                <!-- NE (Corner 1) -->
                <circle
                  :cx="getCornerPoint(q, 1).x"
                  :cy="getCornerPoint(q, 1).y"
                  r="12"
                  fill="#ffffff"
                  :stroke="q.color"
                  stroke-width="3"
                  class="cursor-nesw-resize"
                  @pointerdown.stop="onPointerDown($event, idx, 'ne')"
                />
                <!-- SE (Corner 2) -->
                <circle
                  :cx="getCornerPoint(q, 2).x"
                  :cy="getCornerPoint(q, 2).y"
                  r="12"
                  fill="#ffffff"
                  :stroke="q.color"
                  stroke-width="3"
                  class="cursor-nwse-resize"
                  @pointerdown.stop="onPointerDown($event, idx, 'se')"
                />
                <!-- SW (Corner 3) -->
                <circle
                  :cx="getCornerPoint(q, 3).x"
                  :cy="getCornerPoint(q, 3).y"
                  r="12"
                  fill="#ffffff"
                  :stroke="q.color"
                  stroke-width="3"
                  class="cursor-nesw-resize"
                  @pointerdown.stop="onPointerDown($event, idx, 'sw')"
                />
              </template>
            </g>

            <!-- Real-time drawing preview -->
            <rect
              v-if="isDrawing && drawCurrentBox"
              :x="drawCurrentBox[1] * 1000"
              :y="drawCurrentBox[0] * 1000"
              :width="(drawCurrentBox[3] - drawCurrentBox[1]) * 1000"
              :height="(drawCurrentBox[2] - drawCurrentBox[0]) * 1000"
              fill="rgba(56, 189, 248, 0.25)"
              stroke="#38bdf8"
              stroke-width="2.5"
              stroke-dasharray="6,4"
            />
          </svg>
        </div>

        <div class="text-[11px] text-slate-400 flex items-center gap-1.5">
          <AppIcon name="lightbulb" :size="15" class="text-amber-400" />
          <span>Arrastra cualquier zona para moverla o ajusta sus 4 esquinas blancas. En modo dibujo, haz clic y arrastra sobre la imagen.</span>
        </div>
      </div>

      <!-- Right: Sidebar List of Quadrants -->
      <div class="lg:col-span-4 bg-slate-950/60 border border-slate-800 rounded-xl p-4 flex flex-col gap-3 max-h-[560px] overflow-y-auto">
        <div class="flex items-center justify-between pb-2 border-b border-slate-800">
          <h4 class="text-xs font-bold text-white uppercase tracking-wider">
            Zonas y Cuadrantes ({{ quadrants.length }})
          </h4>
          <span class="text-[10px] text-slate-500 font-mono">[ymin, xmin, ymax, xmax]</span>
        </div>

        <div v-if="quadrants.length === 0" class="py-10 px-3 text-center text-slate-500 text-xs flex flex-col items-center gap-2">
          <AppIcon name="crop_free" :size="32" class="text-slate-600 mb-1" />
          <span class="font-medium text-slate-300">Sin zonas configuradas</span>
          <span class="text-[11px] text-slate-500 leading-relaxed">Las zonas se configuran 100% dinámicamente. Haz clic en "Crear Zona" para agregar tu primer puesto o silla.</span>
        </div>

        <div v-else class="flex flex-col gap-2.5">
          <div
            v-for="(q, idx) in quadrants"
            :key="q.id || `quad-side-${idx}`"
            :class="[
              'p-3 rounded-xl border transition-all cursor-pointer flex flex-col gap-2',
              idx === selectedIndex
                ? 'bg-slate-900 border-blue-500 shadow-sm'
                : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700'
            ]"
            @click="selectedIndex = idx"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  v-model="q.color"
                  class="w-6 h-6 rounded cursor-pointer border-none bg-transparent"
                  title="Cambiar color"
                />
                <span class="font-bold text-xs text-white">{{ q.name }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <AppBadge v-if="q.capturePerson !== false" variant="primary" class="text-[9px] flex items-center gap-1">
                  <AppIcon name="face" :size="12" />
                  Captura Facial
                </AppBadge>
                <AppBadge variant="default" class="text-[10px] font-mono">
                  {{ q.badge || q.name }}
                </AppBadge>
              </div>
            </div>

            <!-- Form fields for selected quadrant -->
            <div v-if="idx === selectedIndex" class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800">
              <div class="col-span-2 flex flex-col gap-1">
                <label class="text-[10px] text-slate-400">Tipo / Categoría de Zona:</label>
                <AppSelect v-model="q.type" :options="zoneTypeOptions" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-slate-400">Nombre:</label>
                <AppInput v-model="q.name" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-slate-400">Etiqueta:</label>
                <AppInput v-model="q.badge" />
              </div>

              <!-- Controles de captura de personas y biometría -->
              <div class="col-span-2 flex items-center justify-between p-2 rounded-lg bg-slate-900/80 border border-slate-800">
                <div class="flex items-center gap-2">
                  <AppIcon name="face" :size="16" class="text-blue-400" />
                  <span class="text-xs text-slate-200">Capturar personas en esta zona</span>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    v-model="q.capturePerson"
                    class="sr-only peer"
                  />
                  <div class="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-slate-400">Rol:</label>
                <AppSelect v-model="q.role" :options="roleOptions" />
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-slate-400">Etiqueta al ocuparse:</label>
                <AppInput v-model="q.labelOnOccupied" placeholder="Ej: Cliente en corte" />
              </div>

              <div class="col-span-2 text-[10px] text-slate-500 font-mono pt-1">
                Coords: [{{ (q.boxNorm || []).map(v => Number(v).toFixed(3)).join(', ') }}]
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </ModalTemplate>
</template>
