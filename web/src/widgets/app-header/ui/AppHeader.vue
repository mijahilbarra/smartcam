<script setup>
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';

const emit = defineEmits(['open-settings', 'open-calibrator']);
</script>

<template>
  <header class="w-full flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
    <div class="flex items-center gap-3.5">
      <div class="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-blue-500 shadow-sm shrink-0">
        <AppIcon name="videocam" :size="28" />
      </div>
      <div>
        <h1 class="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          IOT Camera Catcher
        </h1>
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
