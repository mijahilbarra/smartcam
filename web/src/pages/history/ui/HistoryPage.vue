<script setup>
import CostMonitorWidget from '@/widgets/cost-monitor/ui/CostMonitorWidget.vue';
import PhotosTable from '@/widgets/photos-table/ui/PhotosTable.vue';

defineProps({
  photos: {
    type: Array,
    default: () => []
  },
  loading: {
    type: Boolean,
    default: false
  },
  currentPage: {
    type: Number,
    default: 1
  },
  pageSize: {
    type: Number,
    default: 10
  },
  totalPages: {
    type: Number,
    default: 1
  },
  totalPhotos: {
    type: Number,
    default: 0
  }
});

const emit = defineEmits([
  'update:currentPage',
  'update:pageSize',
  'view-detail',
  'calibrate-photo'
]);
</script>

<template>
  <div class="w-full flex flex-col gap-6">
    <!-- 1. Google Cloud Cost & Quotas Monitor -->
    <CostMonitorWidget
      :total-photos-count="totalPhotos"
    />

    <!-- 2. Photos Table -->
    <PhotosTable
      :photos="photos"
      :loading="loading"
      :current-page="currentPage"
      :page-size="pageSize"
      :total-pages="totalPages"
      :total-photos="totalPhotos"
      @update:current-page="emit('update:currentPage', $event)"
      @update:page-size="emit('update:pageSize', $event)"
      @view-detail="emit('view-detail', $event)"
      @calibrate-photo="emit('calibrate-photo', $event)"
    />
  </div>
</template>
