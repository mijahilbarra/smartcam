<script setup>
import AppIcon from './AppIcon.vue';

const props = defineProps({
  variant: {
    type: String,
    default: 'default',
    validator: (v) => ['default', 'live', 'success', 'warning', 'info', 'free', 'danger'].includes(v)
  },
  icon: {
    type: String,
    default: null
  },
  pulsing: {
    type: Boolean,
    default: false
  }
});

const getBadgeClasses = () => {
  switch (props.variant) {
    case 'live':
      return 'bg-emerald-950/60 text-emerald-400 border border-emerald-500/30';
    case 'success':
      return 'bg-emerald-950/40 text-emerald-400 border border-emerald-600/30';
    case 'warning':
      return 'bg-amber-950/40 text-amber-300 border border-amber-500/30';
    case 'danger':
      return 'bg-red-950/40 text-red-400 border border-red-500/30';
    case 'info':
      return 'bg-sky-950/40 text-sky-400 border border-sky-500/30';
    case 'free':
      return 'bg-emerald-900/30 text-emerald-300 border border-emerald-500/40 font-semibold';
    case 'default':
    default:
      return 'bg-slate-800 text-slate-300 border border-slate-700';
  }
};
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium tracking-wide select-none',
      getBadgeClasses()
    ]"
  >
    <span v-if="pulsing || variant === 'live'" class="live-dot-pulse"></span>
    <AppIcon v-if="icon" :name="icon" :size="14" />
    <slot />
  </span>
</template>
