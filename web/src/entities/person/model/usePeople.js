import { ref, onMounted, onUnmounted } from 'vue';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';

export function usePeople() {
  const people = ref([]);
  const loading = ref(true);

  let unsubscribe = null;

  const subscribe = () => {
    loading.value = true;
    const colRef = collection(db, 'camera_catcher', 'frequent_customers', 'profiles');
    unsubscribe = onSnapshot(colRef, (snap) => {
      const list = [];
      snap.forEach((docSnap) => {
        list.push({
          id: docSnap.id,
          ...docSnap.data()
        });
      });
      // Sort by visits desc
      list.sort((a, b) => (b.visitsCount || 0) - (a.visitsCount || 0));
      people.value = list;
      loading.value = false;
    }, (err) => {
      console.warn('[People] Error cargando directorio de personas:', err);
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
    people,
    loading
  };
}
