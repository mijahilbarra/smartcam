<script setup>
import { ref, computed } from 'vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppSlider from '@/shared/ui/atoms/AppSlider.vue';
import KpiGridTemplate from '@/shared/ui/templates/KpiGridTemplate.vue';
import { useCostQuotas } from '@/entities/cost-quota/model/useCostQuotas';

const props = defineProps({
  totalPhotosCount: {
    type: Number,
    default: 0
  },
  currentIntervalMinutes: {
    type: Number,
    default: 15
  }
});

const isCollapsed = ref(false);
const simInterval = ref(15);

const {
  currentStorageUsedMb,
  currentStorageProgressPercent,
  dailyGrowthMb,
  daysToLimit,
  firestoreDailyLimit,
  firestoreEstimatedWrites,
  firestoreProgressPercent,
  geminiDailyLimit,
  geminiEstimatedCalls,
  geminiProgressPercent,
  simulateInterval
} = useCostQuotas(props.totalPhotosCount, props.currentIntervalMinutes);

const simResult = computed(() => simulateInterval(simInterval.value));

const syncWithCurrentInterval = () => {
  simInterval.value = props.currentIntervalMinutes || 15;
};
</script>

<template>
  <section class="w-full bg-slate-850 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm flex flex-col">
    <!-- Header -->
    <div
      class="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800 bg-slate-900/60 cursor-pointer select-none"
      @click="isCollapsed = !isCollapsed"
      title="Clic para expandir o contraer"
    >
      <div class="flex items-center gap-3">
        <div class="p-2 rounded-xl bg-emerald-950/50 text-emerald-400 border border-emerald-500/20">
          <AppIcon name="payments" :size="22" />
        </div>
        <div>
          <h2 class="text-base sm:text-lg font-bold text-white">Monitor de Costos y Cuotas de Google Cloud</h2>
          <p class="text-xs text-slate-400">Seguimiento de consumos en Compute Engine, Storage, Firestore y ML Local</p>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <AppBadge variant="free" icon="shield">
          Seguro: $0.00 / mes (Always Free)
        </AppBadge>
        <AppButton
          size="sm"
          variant="secondary"
          :icon="isCollapsed ? 'expand_more' : 'expand_less'"
          @click.stop="isCollapsed = !isCollapsed"
        >
          {{ isCollapsed ? 'Expandir' : 'Contraer' }}
        </AppButton>
      </div>
    </div>

    <!-- Body -->
    <div v-show="!isCollapsed" class="p-4 sm:p-6 flex flex-col gap-6">
      <!-- Protection Banner -->
      <div class="bg-blue-950/30 border border-blue-500/30 rounded-xl p-4 flex items-start gap-3 text-xs sm:text-sm text-blue-200">
        <AppIcon name="shield" :size="24" class="text-blue-400 shrink-0 mt-0.5" />
        <div>
          <strong class="text-white">Protección de Facturación Activa:</strong> Tu stack opera principalmente dentro del
          <em>Always Free Tier</em> de Google Cloud. El cómputo en la VM <code>e2-micro</code>, almacenamiento (hasta 5 GB) y base de datos (20k escrituras/día) se mantienen en $0.00 bajo uso habitual.
        </div>
      </div>

      <!-- KPI Cards Grid -->
      <KpiGridTemplate>
        <!-- 1. Compute Engine -->
        <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-slate-300 font-semibold text-xs">
              <AppIcon name="memory" :size="18" class="text-blue-400" />
              <span>Compute Engine</span>
            </div>
            <AppBadge variant="free" class="text-[10px]">100% Free Tier</AppBadge>
          </div>
          <div>
            <div class="text-xl font-bold text-white font-mono">e2-micro</div>
            <div class="text-xs text-slate-400">Zona: <code class="text-slate-300">us-central1-a</code></div>
          </div>
          <div class="flex flex-col gap-1.5 text-xs text-slate-400 pt-2 border-t border-slate-800/80">
            <div class="flex justify-between">
              <span>Cómputo (CPU/RAM):</span>
              <strong class="text-emerald-400">744 hrs / $0.00</strong>
            </div>
            <div class="flex justify-between">
              <span>Disco (pd-standard):</span>
              <strong class="text-emerald-400">20 GB / 30 GB libre</strong>
            </div>
            <div class="flex justify-between">
              <span>IP Pública (IPv4):</span>
              <span class="text-amber-400" title="Cargo estándar de GCP por IPv4 activa (~$0.005/h)">~$3.65/mes máx*</span>
            </div>
          </div>
          <div class="text-[11px] font-medium text-emerald-400 bg-emerald-950/30 px-2 py-1 rounded text-center">
            Costo cómputo: $0.00/m
          </div>
        </div>

        <!-- 2. Firebase Storage -->
        <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-slate-300 font-semibold text-xs">
              <AppIcon name="cloud_upload" :size="18" class="text-blue-400" />
              <span>Cloud Storage</span>
            </div>
            <AppBadge variant="free" class="text-[10px]">En Cuota</AppBadge>
          </div>
          <div>
            <div class="text-xl font-bold text-white font-mono">
              ~{{ currentStorageUsedMb }} MB <small class="text-slate-400 text-xs font-normal">/ 5.0 GB</small>
            </div>
            <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden mt-2">
              <div
                class="bg-blue-500 h-full rounded-full transition-all duration-300"
                :style="{ width: `${currentStorageProgressPercent}%` }"
              ></div>
            </div>
          </div>
          <div class="flex flex-col gap-1.5 text-xs text-slate-400 pt-2 border-t border-slate-800/80">
            <div class="flex justify-between">
              <span>Fotos registradas:</span>
              <strong class="text-slate-200">{{ totalPhotosCount }}</strong>
            </div>
            <div class="flex justify-between">
              <span>Crecimiento diario:</span>
              <strong class="text-slate-200">+{{ dailyGrowthMb }} MB / día</strong>
            </div>
            <div class="flex justify-between">
              <span>Días hasta 5 GB:</span>
              <strong class="text-emerald-400">> {{ daysToLimit }} días</strong>
            </div>
          </div>
          <div class="text-[11px] font-medium text-emerald-400 bg-emerald-950/30 px-2 py-1 rounded text-center">
            Costo Storage: $0.00/m
          </div>
        </div>

        <!-- 3. Cloud Firestore -->
        <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-slate-300 font-semibold text-xs">
              <AppIcon name="database" :size="18" class="text-blue-400" />
              <span>Cloud Firestore</span>
            </div>
            <AppBadge variant="free" class="text-[10px]">Free Tier</AppBadge>
          </div>
          <div>
            <div class="text-xl font-bold text-white font-mono">
              {{ firestoreEstimatedWrites }} <small class="text-slate-400 text-xs font-normal">/ 20,000 día</small>
            </div>
            <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden mt-2">
              <div
                class="bg-emerald-500 h-full rounded-full transition-all duration-300"
                :style="{ width: `${firestoreProgressPercent}%` }"
              ></div>
            </div>
          </div>
          <div class="flex flex-col gap-1.5 text-xs text-slate-400 pt-2 border-t border-slate-800/80">
            <div class="flex justify-between">
              <span>Límite escrituras:</span>
              <strong class="text-emerald-400">20,000 / día ($0)</strong>
            </div>
            <div class="flex justify-between">
              <span>Límite lecturas:</span>
              <strong class="text-emerald-400">50,000 / día ($0)</strong>
            </div>
            <div class="flex justify-between">
              <span>Uso de cuota:</span>
              <strong class="text-emerald-400">&lt; 1%</strong>
            </div>
          </div>
          <div class="text-[11px] font-medium text-emerald-400 bg-emerald-950/30 px-2 py-1 rounded text-center">
            Costo Firestore: $0.00/m
          </div>
        </div>

        <!-- 4. Local ML (ONNX) & Gemini -->
        <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 flex flex-col justify-between gap-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 text-slate-300 font-semibold text-xs">
              <AppIcon name="psychology" :size="18" class="text-blue-400" />
              <span>ML Local (ONNX)</span>
            </div>
            <AppBadge variant="free" class="text-[10px]">100% Offline</AppBadge>
          </div>
          <div>
            <div class="text-xl font-bold text-white font-mono">YOLOv8 Nano</div>
            <div class="text-xs text-slate-400">Motor: <code class="text-slate-300">onnxruntime-node</code></div>
          </div>
          <div class="flex flex-col gap-1.5 text-xs text-slate-400 pt-2 border-t border-slate-800/80">
            <div class="flex justify-between">
              <span>Inferencia por imagen:</span>
              <strong class="text-emerald-400">~100 ms (CPU)</strong>
            </div>
            <div class="flex justify-between">
              <span>Costo por llamada:</span>
              <strong class="text-emerald-400">$0.00 (Local)</strong>
            </div>
            <div class="flex justify-between">
              <span>Ahorro vs API LLM:</span>
              <strong class="text-emerald-400">100% de ahorro</strong>
            </div>
          </div>
          <div class="text-[11px] font-medium text-emerald-400 bg-emerald-950/30 px-2 py-1 rounded text-center">
            Costo ML: $0.00/m
          </div>
        </div>
      </KpiGridTemplate>

      <!-- Simulator Section -->
      <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col gap-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm font-semibold text-white">
            <AppIcon name="tune" :size="20" class="text-blue-400" />
            <h3>Simulador Interactivo de Consumos según Intervalo</h3>
          </div>
          <AppButton size="sm" variant="secondary" icon="sync" @click="syncWithCurrentInterval">
            Sincronizar con intervalo actual
          </AppButton>
        </div>

        <!-- Slider -->
        <AppSlider v-model="simInterval">
          <template #label>
            <span class="text-xs text-slate-300">
              Probar intervalo de captura: <strong class="text-blue-400">{{ simInterval }} minutos</strong>
            </span>
          </template>
        </AppSlider>

        <!-- Dynamic Results Grid -->
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2 text-xs">
          <div class="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
            <span class="text-slate-400 block mb-1">Capturas / Día • Mes:</span>
            <strong class="text-white">{{ simResult.capsDay }} / día • {{ simResult.capsMonth }} / m</strong>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
            <span class="text-slate-400 block mb-1">Almacenamiento / Mes:</span>
            <strong class="text-white">~{{ simResult.storageMonthGb }} GB / m</strong>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
            <span class="text-slate-400 block mb-1">Operaciones Storage:</span>
            <strong class="text-white">~{{ simResult.storageOpsClassA }} / 5k cuota</strong>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
            <span class="text-slate-400 block mb-1">Escrituras Firestore:</span>
            <strong class="text-white">{{ simResult.firestoreWrites }} / 20k día</strong>
          </div>
          <div class="p-2.5 rounded-lg bg-slate-900 border border-slate-800">
            <span class="text-slate-400 block mb-1">Peticiones Gemini AI:</span>
            <strong class="text-white">{{ simResult.geminiCalls }} / 1.5k día</strong>
          </div>
        </div>

        <!-- Simulator Alert -->
        <div
          :class="[
            'p-3 rounded-lg text-xs flex items-center gap-2 border',
            simResult.alertType === 'warning'
              ? 'bg-amber-950/40 text-amber-200 border-amber-500/30'
              : 'bg-blue-950/40 text-blue-200 border-blue-500/30'
          ]"
        >
          <AppIcon :name="simResult.alertType === 'warning' ? 'warning' : 'lightbulb'" :size="18" />
          <span>{{ simResult.alertMsg }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
