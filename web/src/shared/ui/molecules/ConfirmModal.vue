<script setup>
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: '¿Confirmar acción?'
  },
  message: {
    type: String,
    default: ''
  },
  confirmText: {
    type: String,
    default: 'Confirmar'
  },
  cancelText: {
    type: String,
    default: 'Cancelar'
  },
  confirmVariant: {
    type: String,
    default: 'danger' // 'danger' | 'primary' | 'secondary'
  },
  confirmIcon: {
    type: String,
    default: null
  },
  icon: {
    type: String,
    default: 'warning'
  },
  iconColor: {
    type: String,
    default: 'text-amber-400'
  },
  loading: {
    type: Boolean,
    default: false
  },
  maxWidth: {
    type: String,
    default: 'max-w-md'
  }
});

const emit = defineEmits(['confirm', 'close']);

const onConfirm = () => {
  if (!props.loading) {
    emit('confirm');
  }
};

const onClose = () => {
  if (!props.loading) {
    emit('close');
  }
};
</script>

<template>
  <ModalTemplate :show="show" :max-width="maxWidth" @close="onClose">
    <!-- Modal Header -->
    <div class="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800/80 bg-slate-950/60 shrink-0">
      <div class="flex items-center gap-3 min-w-0">
        <div
          v-if="icon"
          class="p-2 rounded-xl bg-slate-800/80 border border-slate-700/60 shrink-0 flex items-center justify-center"
          :class="iconColor"
        >
          <AppIcon :name="icon" :size="20" />
        </div>
        <h3 class="text-base sm:text-lg font-bold text-white truncate">
          {{ title }}
        </h3>
      </div>

      <button
        type="button"
        :disabled="loading"
        @click="onClose"
        class="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800/80 transition cursor-pointer shrink-0 disabled:opacity-40"
        title="Cerrar modal"
      >
        <AppIcon name="close" :size="20" />
      </button>
    </div>

    <!-- Modal Body -->
    <div class="p-4 sm:p-6 space-y-4 text-sm text-slate-300 overflow-y-auto flex-1 min-h-0">
      <slot>
        <p v-if="message" class="text-slate-300 leading-relaxed">{{ message }}</p>
      </slot>
    </div>

    <!-- Modal Footer -->
    <div class="flex items-center justify-end gap-3 p-4 border-t border-slate-800 bg-slate-950/80 shrink-0">
      <AppButton
        variant="secondary"
        size="sm"
        :disabled="loading"
        @click="onClose"
      >
        {{ cancelText }}
      </AppButton>

      <AppButton
        :variant="confirmVariant"
        size="sm"
        :icon="confirmIcon"
        :loading="loading"
        @click="onConfirm"
      >
        {{ confirmText }}
      </AppButton>
    </div>
  </ModalTemplate>
</template>
