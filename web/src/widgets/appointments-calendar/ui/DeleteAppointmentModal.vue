<script setup>
import { ref, computed, watch } from 'vue';
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  appointment: {
    type: Object,
    default: null
  },
  person: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close', 'confirm']);



const formatTimeOnly = (isoString) => {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
};

const isValidImageUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:');
};

const getAvatarUrl = computed(() => {
  if (!props.appointment) return '';
  if (isValidImageUrl(props.appointment.avatarUrl)) return props.appointment.avatarUrl;
  if (isValidImageUrl(props.person?.thumbnailBase64)) return props.person.thumbnailBase64;
  if (Array.isArray(props.appointment.photos)) {
    for (const p of props.appointment.photos) {
      if (!p) continue;
      const candidate = p.thumbnailBase64 || p.base64 || (typeof p === 'string' ? p : '') || p.url;
      if (isValidImageUrl(candidate)) return candidate;
    }
  }
  return '';
});

const personId = computed(() => {
  return props.person?.id || props.appointment?.personId || props.appointment?.clientId || null;
});

const hasAssociatedPerson = computed(() => {
  return Boolean(personId.value);
});

const clientDisplayName = computed(() => {
  return props.person?.name || props.appointment?.clientName || 'Cliente';
});

const onClose = () => {
  if (!props.loading) {
    emit('close');
  }
};

const onConfirm = () => {
  if (!props.loading && props.appointment) {
    emit('confirm', {
      appointmentId: props.appointment.id
    });
  }
};
</script>

<template>
  <ModalTemplate
    :show="show"
    max-width="max-w-lg"
    @close="onClose"
  >
    <!-- Encabezado del Modal -->
    <ModalHeader
      title="Eliminar Atención"
      icon="delete_forever"
      tag="Confirmación"
      @close="onClose"
    />

    <!-- Contenido del Modal -->
    <div v-if="appointment" class="p-4 sm:p-6 space-y-5 text-sm overflow-y-auto">
      <!-- Tarjeta Resumen de la Cita a Eliminar -->
      <div class="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-3.5 flex items-center gap-3">
        <!-- Avatar / Miniatura -->
        <div class="w-12 h-12 rounded-xl bg-slate-700 overflow-hidden flex-shrink-0 border border-slate-600 shadow-inner flex items-center justify-center">
          <img
            v-if="getAvatarUrl"
            :src="getAvatarUrl"
            :alt="clientDisplayName"
            class="w-full h-full object-cover"
          />
          <AppIcon v-else name="person" :size="24" class="text-slate-400" />
        </div>

        <!-- Info principal de la cita -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <h4 class="text-sm font-bold text-white truncate">{{ clientDisplayName }}</h4>
            <span
              v-if="appointment.clientBadge"
              class="px-2 py-0.2 rounded text-[10px] font-semibold bg-slate-900 text-blue-300 border border-blue-500/20"
            >
              {{ appointment.clientBadge }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-400 mt-1">
            <span class="flex items-center gap-1 text-blue-300">
              <AppIcon name="schedule" :size="13" />
              {{ formatTimeOnly(appointment.startTime) }} - {{ formatTimeOnly(appointment.endTime) }}
            </span>
            <span>•</span>
            <span class="text-slate-300 font-medium">
              {{ appointment.chairName || appointment.chairId }}
            </span>
            <span v-if="appointment.photos?.length">•</span>
            <span v-if="appointment.photos?.length" class="text-emerald-400">
              {{ appointment.photos.length }} fotos
            </span>
          </div>
        </div>
      </div>

      <!-- Confirmación de Eliminación -->
      <div class="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/60 flex items-start gap-3">
        <AppIcon name="info" :size="20" class="text-blue-400 shrink-0 mt-0.5" />
        <p class="text-xs text-slate-300 leading-relaxed">
          Esta acción eliminará únicamente el registro de esta atención del calendario. El perfil del cliente <strong class="text-white">{{ clientDisplayName }}</strong> continuará existiendo en el sistema con su código e historial restante.
        </p>
      </div>
    </div>

    <!-- Acciones del Modal -->
    <div class="flex items-center justify-end gap-3 p-4 border-t border-slate-800 bg-slate-950/80 shrink-0">
      <AppButton
        variant="secondary"
        size="sm"
        :disabled="loading"
        @click="onClose"
      >
        Cancelar
      </AppButton>

      <AppButton
        variant="danger"
        size="sm"
        icon="delete"
        :loading="loading"
        @click="onConfirm"
      >
        Eliminar Atención
      </AppButton>
    </div>
  </ModalTemplate>
</template>
