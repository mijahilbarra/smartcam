<script setup>
import AppIcon from '../atoms/AppIcon.vue';
import AppBadge from '../atoms/AppBadge.vue';

defineProps({
  title: {
    type: String,
    required: true
  },
  icon: {
    type: String,
    default: null
  },
  iconColor: {
    type: String,
    default: 'text-blue-400'
  },
  tag: {
    type: String,
    default: null
  }
});

const emit = defineEmits(['close']);
</script>

<template>
  <div class="flex items-center justify-between p-4 sm:p-5 border-b border-slate-700/80 bg-slate-800/50">
    <div class="flex items-center gap-3">
      <AppIcon v-if="icon" :name="icon" :size="22" :class="iconColor || 'text-blue-400'" />
      <div>
        <div class="flex items-center gap-2">
          <h3 class="text-base sm:text-lg font-semibold text-slate-100">{{ title }}</h3>
          <AppBadge v-if="tag" variant="default" class="text-[11px] font-mono">{{ tag }}</AppBadge>
        </div>
        <slot name="subtitle" />
      </div>
    </div>
    <div class="flex items-center gap-3">
      <slot name="actions" />
      <button
        type="button"
        @click="emit('close')"
        title="Cerrar modal"
        class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-700/60 transition cursor-pointer text-xl leading-none flex items-center justify-center"
      >
        <AppIcon name="close" :size="20" />
      </button>
    </div>
  </div>
</template>
