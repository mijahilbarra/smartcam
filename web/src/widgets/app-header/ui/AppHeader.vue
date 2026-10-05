<script setup>
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import { getEnvironmentInfo } from '@/shared/api/firebase';

const emit = defineEmits(['open-settings', 'open-calibrator']);
const env = getEnvironmentInfo();
</script>

<template>
  <header class="w-full flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
    <div class="flex items-center gap-3.5">
      <div class="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-blue-500 shadow-sm shrink-0">
        <AppIcon name="videocam" :size="28" />
      </div>
      <div>
        <div class="flex items-center gap-2 flex-wrap">
          <h1 class="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            IOT Camera Catcher
          </h1>
          <!-- Insignia de Entorno y Base de Datos Detectada -->
          <AppBadge
            :variant="env.isLocal ? 'success' : 'info'"
            class="text-[10px] font-mono tracking-wide py-0.5 px-2 flex items-center gap-1.5"
            :title="`Modo: ${env.environmentLabel} | Base de Datos: ${env.databaseId} | Destino: ${env.dispatchTarget}`"
          >
            <span class="w-1.5 h-1.5 rounded-full" :class="env.isLocal ? 'bg-emerald-400 animate-pulse' : 'bg-blue-400'"></span>
            <span>{{ env.isLocal ? `Local: E2 Sim [${env.databaseId}]` : `Cloud: GCP VM [${env.databaseId}]` }}</span>
          </AppBadge>
        </div>
        <p class="text-xs sm:text-sm text-slate-400">
          Monitoreo y Análisis Visual con Gemini Vision • Barbería
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2.5 w-full md:w-auto justify-end">
      <AppButton
        variant="secondary"
        icon="settings"
        @click="emit('open-settings')"
        title="Configuración del capturador y horario de atención"
      >
        <span>Configuración</span>
      </AppButton>

      <AppButton
        variant="secondary"
        icon="aspect_ratio"
        @click="emit('open-calibrator')"
        title="Calibrar zonas ROI"
      >
        <span>Calibrar Cuadrantes</span>
      </AppButton>
    </div>
  </header>
</template>
