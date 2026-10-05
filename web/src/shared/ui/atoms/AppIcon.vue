<script setup>
defineProps({
  name: {
    type: String,
    required: true
  },
  size: {
    type: [Number, String],
    default: null
  },
  customClass: {
    type: String,
    default: ''
  }
});
</script>

<template>
  <span 
    class="material-symbols-outlined select-none align-middle"
    :class="customClass"
    :style="size ? { fontSize: typeof size === 'number' ? `${size}px` : size } : {}"
    aria-hidden="true"
  >
    {{ name }}
  </span>
</template>
