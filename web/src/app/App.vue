<script setup>
import { ref } from 'vue';
import MainLayout from '@/shared/ui/templates/MainLayout.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppHeader from '@/widgets/app-header/ui/AppHeader.vue';
import LiveMonitorPage from '@/pages/live-monitor/ui/LiveMonitorPage.vue';
import AppointmentsCalendar from '@/widgets/appointments-calendar/ui/AppointmentsCalendar.vue';
import QuadrantCalibratorModal from '@/widgets/quadrant-calibrator-modal/ui/QuadrantCalibratorModal.vue';
import SettingsModal from '@/widgets/settings-modal/ui/SettingsModal.vue';

// Active Tab state: 'live' | 'calendar'
const activeTab = ref('live');

// Modals state
const showSettings = ref(false);
const showCalibrator = ref(false);
</script>

<template>
  <MainLayout>
    <!-- Header slot -->
    <template #header>
      <AppHeader
        @open-settings="showSettings = true"
      />
    </template>

    <!-- Navigation Tabs slot -->
    <template #navigation>
      <nav class="flex items-center gap-2 border-b border-slate-800 pb-2 select-none" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'live'"
          @click="activeTab = 'live'"
          :class="[
            'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition cursor-pointer',
            activeTab === 'live'
              ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          ]"
        >
          <AppIcon name="videocam" :size="18" :class="activeTab === 'live' ? 'text-red-400' : ''" />
          <span>Sesión en Vivo en Tiempo Real</span>
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-950/80 text-red-400 border border-red-500/30">
            <span class="live-dot-pulse-red"></span>
            EN VIVO
          </span>
        </button>

        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'calendar'"
          @click="activeTab = 'calendar'"
          :class="[
            'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition cursor-pointer',
            activeTab === 'calendar'
              ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          ]"
        >
          <AppIcon name="calendar_month" :size="18" :class="activeTab === 'calendar' ? 'text-blue-400' : ''" />
          <span>Calendario de Atenciones</span>
        </button>
      </nav>
    </template>

    <!-- Main Content: Active View -->
    <LiveMonitorPage
      v-if="activeTab === 'live'"
      @open-settings="showSettings = true"
      @open-calibrator="showCalibrator = true"
    />

    <AppointmentsCalendar
      v-else-if="activeTab === 'calendar'"
    />

    <!-- Modals slot -->
    <template #modals>
      <!-- Settings Modal (Incluye pestaña Recursos y Cuotas) -->
      <SettingsModal
        :show="showSettings"
        @close="showSettings = false"
      />

      <!-- Quadrant Calibrator Modal -->
      <QuadrantCalibratorModal
        :show="showCalibrator"
        @close="showCalibrator = false"
      />
    </template>
  </MainLayout>
</template>
