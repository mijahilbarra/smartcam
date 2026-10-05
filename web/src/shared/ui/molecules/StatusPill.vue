<script setup>
import AppIcon from '../atoms/AppIcon.vue';

defineProps({
  text: {
    type: String,
    required: true
  },
  active: {
    type: Boolean,
    default: true
  },
  icon: {
    type: String,
    default: null
  }
});
</script>

<template>
  <div
    :class="[
      'inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium border select-none',
      active
        ? 'bg-emerald-950/40 text-emerald-400 border-emerald-500/30'
        : 'bg-slate-800 text-slate-400 border-slate-700'
    ]"
  >
    <span v-if="active" class="live-dot-pulse"></span>
    <span v-else class="w-2 h-2 rounded-full bg-slate-500"></span>
    <AppIcon v-if="icon" :name="icon" :size="14" />
    <span>{{ text }}</span>
  </div>
</template>
