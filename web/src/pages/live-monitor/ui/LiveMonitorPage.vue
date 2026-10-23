<script setup>
import DaemonLiveMonitor from '@/widgets/daemon-monitor/ui/DaemonLiveMonitor.vue';
import PeopleDirectoryWidget from '@/widgets/people-directory/ui/PeopleDirectoryWidget.vue';

const emit = defineEmits(['open-settings', 'open-calibrator']);
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- 1. Sesión en Vivo y Transmisión con YOLOv8 -->
    <DaemonLiveMonitor
      @open-settings="emit('open-settings')"
      @open-calibrator="emit('open-calibrator')"
    />

    <!-- 2. Directorio de Personas Guardadas y Asignación Manual de Barberos -->
    <PeopleDirectoryWidget />
  </div>
</template>
