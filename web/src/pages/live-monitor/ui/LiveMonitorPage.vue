<script setup>
import DaemonLiveMonitor from '@/widgets/daemon-monitor/ui/DaemonLiveMonitor.vue';

const emit = defineEmits(['open-calibrator-photo']);
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <DaemonLiveMonitor @open-calibrator-photo="emit('open-calibrator-photo', $event)" />
  </div>
</template>
