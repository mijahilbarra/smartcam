<script setup>
import AppIcon from './AppIcon.vue';
import AppSpinner from './AppSpinner.vue';

const props = defineProps({
  variant: {
    type: String,
    default: 'primary',
    validator: (v) => ['primary', 'secondary', 'danger', 'danger-outline', 'pagination'].includes(v)
  },
  size: {
    type: String,
    default: 'md',
    validator: (s) => ['sm', 'md', 'lg'].includes(s)
  },
  icon: {
    type: String,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  type: {
    type: String,
    default: 'button'
  },
  title: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['click']);

const getVariantClasses = () => {
  switch (props.variant) {
    case 'primary':
      return 'bg-blue-600 hover:bg-blue-700 text-white font-medium border border-blue-500 shadow-sm active:scale-[0.98]';
    case 'secondary':
      return 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 active:scale-[0.98]';
    case 'danger':
      return 'bg-red-600 hover:bg-red-700 text-white border border-red-500 active:scale-[0.98]';
    case 'danger-outline':
      return 'bg-transparent hover:bg-red-950/40 text-red-400 border border-red-800 hover:border-red-600 active:scale-[0.98]';
    case 'pagination':
      return 'bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none text-slate-300 border border-slate-700 font-mono text-sm px-2.5 py-1';
    default:
      return 'bg-blue-600 text-white';
  }
};

const getSizeClasses = () => {
  if (props.variant === 'pagination') return 'rounded-md';
  switch (props.size) {
    case 'sm':
      return 'text-xs px-2.5 py-1.5 rounded-lg gap-1.5';
    case 'lg':
      return 'text-base px-5 py-2.5 rounded-xl gap-2.5';
    case 'md':
    default:
      return 'text-sm px-3.5 py-2 rounded-xl gap-2';
  }
};
</script>

<template>
  <button
    :type="type"
    :title="title"
    :disabled="disabled || loading"
    :class="[
      'inline-flex items-center justify-center transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 select-none',
      getVariantClasses(),
      getSizeClasses()
    ]"
    @click="emit('click', $event)"
  >
    <AppSpinner v-if="loading" size="sm" />
    <AppIcon v-else-if="icon" :name="icon" :size="size === 'sm' ? 15 : 18" />
    <slot />
  </button>
</template>
