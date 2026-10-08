<script setup>
import ModalTemplate from '@/shared/ui/templates/ModalTemplate.vue';
import ModalHeader from '@/shared/ui/molecules/ModalHeader.vue';
import AppButton from '@/shared/ui/atoms/AppButton.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  clientName: {
    type: String,
    default: 'Cliente'
  },
  conflictingAppointments: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close', 'confirm-delete-appointment-only']);

const formatFullDate = (isoString) => {
  if (!isoString) return 'Fecha no especificada';
  try {
    const d = new Date(isoString);
    const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    const dateStr = d.toLocaleDateString('es-ES', options);
    const timeStr = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    const capitalized = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    return `${capitalized} a las ${timeStr}`;
  } catch {
    return isoString;
  }
};

const onClose = () => {
  if (!props.loading) {
    emit('close');
  }
};
</script>

<template>
  <ModalTemplate
    :show="show"
    max-width="max-w-lg"
    @close="onClose"
  >
    <!-- Header -->
    <ModalHeader
      title="Cliente Vinculado a Otra Atención"
      icon="warning"
      icon-color="text-amber-400"
      tag="Atención Existente"
      @close="onClose"
    />

    <!-- Body -->
    <div class="p-4 sm:p-6 space-y-4 text-sm overflow-y-auto">
      <!-- Mensaje destacado de advertencia -->
      <div class="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
        <AppIcon name="error_outline" :size="20" class="text-amber-400 shrink-0 mt-0.5" />
        <p class="text-xs sm:text-sm leading-relaxed text-amber-200">
          No es posible eliminar el perfil de <strong class="font-bold text-white">{{ clientName }}</strong> porque tiene otra(s) cita(s) registrada(s) en el sistema.
        </p>
      </div>

      <!-- Lista de atenciones encontradas -->
      <div class="space-y-2.5 max-h-56 overflow-y-auto pr-1">
        <div
          v-for="apt in conflictingAppointments"
          :key="apt.id"
          class="bg-slate-800/80 border border-slate-700/80 rounded-xl p-3 flex items-start gap-3"
        >
          <div class="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 shrink-0">
            <AppIcon name="event" :size="18" />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white">
              {{ formatFullDate(apt.startTime) }}
            </p>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400 mt-1">
              <span class="text-slate-300">
                {{ apt.chairName || apt.chairId || 'Silla' }}
              </span>
              <span>•</span>
              <span>{{ apt.durationMinutes || 45 }} min</span>
              <template v-if="apt.photos?.length">
                <span>•</span>
                <span class="text-emerald-400 font-medium">
                  {{ apt.photos.length }} {{ apt.photos.length === 1 ? 'foto' : 'fotos' }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Párrafo explicativo -->
      <p class="text-xs text-slate-400 leading-relaxed">
        Para conservar la integridad del historial de sus otras citas, el perfil de usuario debe mantenerse. Puedes optar por eliminar únicamente la cita actual o cancelar la operación.
      </p>
    </div>

    <!-- Footer -->
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
        @click="$emit('confirm-delete-appointment-only')"
      >
        Solo Eliminar Esta Cita
      </AppButton>
    </div>
  </ModalTemplate>
</template>
