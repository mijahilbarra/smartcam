<script setup>
import AppIcon from '../atoms/AppIcon.vue';
import AppInput from '../atoms/AppInput.vue';

defineProps({
  startTime: {
    type: String,
    default: '11:00'
  },
  endTime: {
    type: String,
    default: '23:00'
  }
});

const emit = defineEmits(['update:startTime', 'update:endTime']);
</script>

<template>
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
    <div class="flex flex-col gap-1.5">
      <label class="text-xs text-slate-300 font-medium flex items-center gap-1.5">
        <AppIcon name="storefront" :size="14" class="text-blue-400" />
        Hora de Apertura:
      </label>
      <AppInput
        type="time"
        :model-value="startTime"
        @update:model-value="emit('update:startTime', $event)"
      />
    </div>

    <div class="flex flex-col gap-1.5">
      <label class="text-xs text-slate-300 font-medium flex items-center gap-1.5">
        <AppIcon name="lock" :size="14" class="text-blue-400" />
        Hora de Cierre:
      </label>
      <AppInput
        type="time"
        :model-value="endTime"
        @update:model-value="emit('update:endTime', $event)"
      />
    </div>
  </div>
</template>
