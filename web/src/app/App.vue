<script setup>
import { ref } from 'vue';
import MainLayout from '@/shared/ui/templates/MainLayout.vue';
import AppIcon from '@/shared/ui/atoms/AppIcon.vue';
import AppBadge from '@/shared/ui/atoms/AppBadge.vue';
import AppHeader from '@/widgets/app-header/ui/AppHeader.vue';
import LiveMonitorPage from '@/pages/live-monitor/ui/LiveMonitorPage.vue';
import HistoryPage from '@/pages/history/ui/HistoryPage.vue';
import PhotoDetailModal from '@/widgets/photo-detail-modal/ui/PhotoDetailModal.vue';
import QuadrantCalibratorModal from '@/widgets/quadrant-calibrator-modal/ui/QuadrantCalibratorModal.vue';
import SettingsModal from '@/widgets/settings-modal/ui/SettingsModal.vue';
import { usePhotos } from '@/entities/photo/model/usePhotos';

// Active Tab state: 'live' | 'history'
const activeTab = ref('live');

// Modals state
const showSettings = ref(false);
const showCalibrator = ref(false);
const showPhotoDetail = ref(false);
const selectedPhotoForDetail = ref(null);
const calibratorPreselectedPhotoId = ref(null);

// Shared photos state
const {
  allPhotos,
  loading: photosLoading,
  currentPage,
  pageSize,
  totalPhotos,
  totalPages,
  paginatedPhotos,
  setPage,
  setPageSize
} = usePhotos();

const openPhotoDetail = (photo) => {
  selectedPhotoForDetail.value = photo;
  showPhotoDetail.value = true;
};

const openCalibratorWithPhoto = (photo) => {
  calibratorPreselectedPhotoId.value = photo?.id || null;
  showPhotoDetail.value = false;
  showCalibrator.value = true;
};
</script>

<template>
  <MainLayout>
    <!-- Header slot -->
    <template #header>
      <AppHeader
        @open-settings="showSettings = true"
        @open-calibrator="showCalibrator = true"
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
          <AppIcon name="sensors" :size="18" :class="activeTab === 'live' ? 'text-blue-400' : ''" />
          <span>Monitor en Vivo del Daemon</span>
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
            <span class="live-dot-pulse"></span>
            EN VIVO
          </span>
        </button>

        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'history'"
          @click="activeTab = 'history'"
          :class="[
            'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition cursor-pointer',
            activeTab === 'history'
              ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          ]"
        >
          <AppIcon name="photo_library" :size="18" :class="activeTab === 'history' ? 'text-blue-400' : ''" />
          <span>Historial y Métricas</span>
        </button>
      </nav>
    </template>

    <!-- Main Content: Active View -->
    <LiveMonitorPage
      v-if="activeTab === 'live'"
      @open-calibrator-photo="openCalibratorWithPhoto"
    />

    <HistoryPage
      v-else-if="activeTab === 'history'"
      :photos="paginatedPhotos"
      :loading="photosLoading"
      :current-page="currentPage"
      :page-size="pageSize"
      :total-pages="totalPages"
      :total-photos="totalPhotos"
      @update:current-page="setPage"
      @update:page-size="setPageSize"
      @view-detail="openPhotoDetail"
      @calibrate-photo="openCalibratorWithPhoto"
    />

    <!-- Modals slot -->
    <template #modals>
      <!-- Settings Modal -->
      <SettingsModal
        :show="showSettings"
        @close="showSettings = false"
      />

      <!-- Quadrant Calibrator Modal -->
      <QuadrantCalibratorModal
        :show="showCalibrator"
        :photos="allPhotos"
        :preselected-photo-id="calibratorPreselectedPhotoId"
        @close="showCalibrator = false"
      />

      <!-- Photo Detail Modal -->
      <PhotoDetailModal
        :show="showPhotoDetail"
        :photo="selectedPhotoForDetail"
        @close="showPhotoDetail = false"
        @calibrate-with-photo="openCalibratorWithPhoto"
      />
    </template>
  </MainLayout>
</template>
