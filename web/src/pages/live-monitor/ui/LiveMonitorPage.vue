<script setup>
import DaemonLiveMonitor from '@/widgets/daemon-monitor/ui/DaemonLiveMonitor.vue';
import PeopleDirectoryWidget from '@/widgets/people-directory/ui/PeopleDirectoryWidget.vue';

const emit = defineEmits(['open-calibrator-photo', 'open-settings']);
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- 1. Sesión en Vivo y Transmisión con YOLOv8 -->
    <DaemonLiveMonitor
      @open-calibrator-photo="emit('open-calibrator-photo', $event)"
      @open-settings="emit('open-settings')"
    />

    <!-- 2. Directorio de Personas Guardadas y Asignación Manual de Barberos -->
    <PeopleDirectoryWidget />
  </div>
</template>
