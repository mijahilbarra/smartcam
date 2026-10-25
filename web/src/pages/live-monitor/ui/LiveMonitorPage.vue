<script setup>
import DaemonLiveMonitor from '@/widgets/daemon-monitor/ui/DaemonLiveMonitor.vue';

const emit = defineEmits(['open-settings', 'open-calibrator', 'switch-tab']);
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- Análisis en Tiempo Real: Video YOLO, Logs y Calendario de Hoy -->
    <DaemonLiveMonitor
      @open-settings="emit('open-settings')"
      @open-calibrator="emit('open-calibrator')"
      @switch-tab="emit('switch-tab', $event)"
    />
  </div>
</template>
