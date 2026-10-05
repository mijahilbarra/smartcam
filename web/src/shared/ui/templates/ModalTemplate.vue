<script setup>
import { onMounted, onUnmounted, watch } from 'vue';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  maxWidth: {
    type: String,
    default: 'max-w-4xl'
  }
});

const emit = defineEmits(['close']);

const onKeyDown = (e) => {
  if (e.key === 'Escape' && props.show) {
    emit('close');
  }
};

watch(() => props.show, (newVal) => {
  if (typeof document !== 'undefined') {
    if (newVal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (typeof document !== 'undefined') {
    document.body.style.overflow = '';
  }
});
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="show"
        class="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
        role="dialog"
        aria-modal="true"
      >
        <!-- Overlay backdrop -->
        <div
          class="fixed inset-0 bg-black/75 backdrop-blur-xs transition-opacity"
          @click="emit('close')"
        ></div>

        <!-- Dialog Box -->
        <div
          :class="[
            'relative w-full bg-slate-850 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col z-10 my-auto max-h-[92vh]',
            maxWidth
          ]"
          @click.stop
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
