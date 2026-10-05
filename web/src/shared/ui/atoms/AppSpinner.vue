<script setup>
defineProps({
  size: {
    type: String,
    default: 'md',
    validator: (s) => ['sm', 'md', 'lg'].includes(s)
  }
});
</script>

<template>
  <span
    :class="[
      'inline-block rounded-full border-2 border-slate-500/20 border-t-blue-500 animate-spin',
      size === 'sm' ? 'w-3.5 h-3.5' : size === 'lg' ? 'w-8 h-8' : 'w-5 h-5'
    ]"
    role="status"
    aria-label="Cargando"
  ></span>
</template>
