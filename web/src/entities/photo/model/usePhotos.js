import { ref, computed, onMounted, onUnmounted } from 'vue';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db, resolveStorageUrl } from '@/shared/api/firebase';

export function usePhotos() {
  const allPhotos = ref([]);
  const loading = ref(true);
  const currentPage = ref(1);
  const pageSize = ref(10);
  const selectedPhoto = ref(null);

  let unsubscribe = null;

  const totalPhotos = computed(() => allPhotos.value.length);
  const totalPages = computed(() => Math.max(1, Math.ceil(totalPhotos.value / pageSize.value)));

  const paginatedPhotos = computed(() => {
    const start = (currentPage.value - 1) * pageSize.value;
    return allPhotos.value.slice(start, start + pageSize.value);
  });

  const latestPhoto = computed(() => (allPhotos.value.length > 0 ? allPhotos.value[0] : null));

  const setPage = (page) => {
    if (page >= 1 && page <= totalPages.value) {
      currentPage.value = page;
    }
  };

  const setPageSize = (size) => {
    pageSize.value = size;
    currentPage.value = 1;
  };

  const subscribe = () => {
    loading.value = true;
    const photosCol = collection(db, 'camera_catcher', 'photos', 'photos');

    unsubscribe = onSnapshot(photosCol, async (snapshot) => {
      const list = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        list.push({
          id: docSnap.id,
          ...data
        });
      });

      // Sort descending by timestamp or epoch
      list.sort((a, b) => {
        const timeA = a.epoch || (a.timestamp?.toMillis ? a.timestamp.toMillis() : new Date(a.timestamp || 0).getTime());
        const timeB = b.epoch || (b.timestamp?.toMillis ? b.timestamp.toMillis() : new Date(b.timestamp || 0).getTime());
        return timeB - timeA;
      });

      allPhotos.value = list;
      loading.value = false;

      // Asynchronously resolve image URLs in background
      list.slice(0, 30).forEach(async (photo) => {
        if (photo.imageStoragePath && !photo.downloadUrl) {
          photo.downloadUrl = await resolveStorageUrl(photo.imageStoragePath);
        }
      });
    }, (err) => {
      console.warn('[Photos] Error en snapshot de fotos:', err);
      loading.value = false;
    });
  };

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribe) unsubscribe();
  });

  return {
    allPhotos,
    loading,
    currentPage,
    pageSize,
    totalPhotos,
    totalPages,
    paginatedPhotos,
    latestPhoto,
    selectedPhoto,
    setPage,
    setPageSize
  };
}
