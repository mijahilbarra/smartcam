import { ref, computed, onMounted, onUnmounted } from 'vue';
import { collection, doc, onSnapshot, updateDoc, deleteDoc, writeBatch, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/shared/api/firebase';
import { computeMergedPersonData, extractPersonPhotos, toFirestoreEmbeddings } from './person-merge';

export function usePeople() {
  const people = ref([]);
  const loading = ref(true);
  const error = ref(null);

  let unsubscribe = null;

  const subscribe = () => {
    loading.value = true;
    error.value = null;

    // Colección oficial de perfiles biométricos de personas detectadas
    const colRef = collection(db, 'camera_catcher_people');
    unsubscribe = onSnapshot(colRef, (snap) => {
      const list = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        const photos = Array.isArray(data.photos) ? data.photos : [];
        const status = data.status || (Boolean(data.isStaff) ? 'barber' : ((data.visitCount ?? data.visitsCount ?? 1) > 1 ? 'frequent' : 'new'));
        list.push({
          id: docSnap.id,
          name: data.name || 'Cliente sin nombre',
          isStaff: Boolean(data.isStaff),
          role: data.role || (data.isStaff ? 'barber' : 'client'),
          status,
          visitCount: data.visitCount ?? data.visitsCount ?? 1,
          bestFaceScore: data.bestFaceScore ?? 0,
          thumbnailBase64: photos[0]?.thumbnailBase64 || data.thumbnailBase64 || null,
          thumbnailPath: data.thumbnailPath || data.lastThumbnailPath || null,
          photos,
          embeddings: Array.isArray(data.embeddings)
            ? data.embeddings.map(e => (e && typeof e === 'object' && Array.isArray(e.vector) ? e.vector : e))
            : (data.embedding ? [data.embedding] : []),
          firstSeen: data.firstSeen || null,
          lastSeen: data.lastSeen || null
        });
      });

        const parseDateMs = (val) => {
          if (!val) return 0;
          if (typeof val === 'number') return val;
          if (typeof val.toDate === 'function') return val.toDate().getTime();
          if (typeof val.seconds === 'number') return val.seconds * 1000;
          const d = new Date(val).getTime();
          return isNaN(d) ? 0 : d;
        };

        // Ordenar: Staff/Barberos primero, luego por fecha de última vez desc (más reciente primero), luego por cantidad de visitas desc
        list.sort((a, b) => {
          if (a.isStaff !== b.isStaff) {
            return a.isStaff ? -1 : 1;
          }
          const timeA = parseDateMs(a.lastSeen);
          const timeB = parseDateMs(b.lastSeen);
          if (timeB !== timeA) {
            return timeB - timeA;
          }
          return (b.visitCount || 1) - (a.visitCount || 1);
        });

      people.value = list;
      loading.value = false;
    }, (err) => {
      console.warn('[People] Error cargando directorio de personas:', err);
      error.value = err.message;
      loading.value = false;
    });
  };

  /**
   * Cambia el rol de una persona entre Cliente y Barbero (Staff)
   * Al pasar a Barbero (isStaff: true), el modelo YOLO y el tracker lo reconocen automáticamente como Staff.
   */
  const toggleRole = async (person) => {
    if (!person || !person.id) return;
    const newIsStaff = !person.isStaff;
    const newRole = newIsStaff ? 'barber' : 'client';

    try {
      const docRef = doc(db, 'camera_catcher_people', person.id);
      await updateDoc(docRef, {
        isStaff: newIsStaff,
        role: newRole,
        updatedAt: new Date().toISOString()
      });
      return { success: true, isStaff: newIsStaff, role: newRole };
    } catch (err) {
      console.error('[People] Error alternando rol de persona:', err);
      throw err;
    }
  };

  /**
   * Actualiza el nombre personalizado de una persona
   */
  const updatePersonName = async (personId, newName) => {
    if (!personId || !newName?.trim()) return;
    const cleanName = newName.trim();
    try {
      const batch = writeBatch(db);
      const docRef = doc(db, 'camera_catcher_people', personId);
      batch.update(docRef, {
        name: cleanName,
        updatedAt: new Date().toISOString()
      });

      // Sincronizar en cascada en las atenciones asociadas
      const apptCol = collection(db, 'camera_catcher_appointments');
      const q1 = query(apptCol, where('clientId', '==', personId));
      const qSnap1 = await getDocs(q1);
      qSnap1.forEach(d => {
        batch.update(d.ref, { clientName: cleanName });
      });

      await batch.commit();
      return { success: true };
    } catch (err) {
      console.error('[People] Error actualizando nombre:', err);
      throw err;
    }
  };

  /**
   * Elimina un perfil biométrico y sus citas asociadas para evitar huérfanos
   */
  const deletePerson = async (personId) => {
    if (!personId) return;
    try {
      const batch = writeBatch(db);
      const docRef = doc(db, 'camera_catcher_people', personId);
      batch.delete(docRef);

      // Limpiar citas asociadas en camera_catcher_appointments
      const apptCol = collection(db, 'camera_catcher_appointments');
      const qAppts = query(apptCol, where('clientId', '==', personId));
      const qSnap = await getDocs(qAppts);
      qSnap.forEach(d => {
        batch.delete(d.ref);
      });

      await batch.commit();
      return { success: true };
    } catch (err) {
      console.error('[People] Error eliminando persona y atenciones:', err);
      throw err;
    }
  };

  /**
   * Elimina múltiples perfiles biométricos en una operación atómica por lotes (Batch)
   * @param {Array<string>} personIds
   */
  const batchDeletePeople = async (personIds) => {
    if (!Array.isArray(personIds) || personIds.length === 0) return { deletedCount: 0 };
    try {
      let deletedCount = 0;
      for (const id of personIds) {
        await deletePerson(id);
        deletedCount++;
      }
      return { success: true, deletedCount };
    } catch (err) {
      console.error('[People] Error en batch delete de personas:', err);
      throw err;
    }
  };

  /**
   * Fusiona múltiples perfiles seleccionados en uno solo de forma atómica:
   * combina fotos (máx 6 mayor nitidez), embeddings, rango de tiempo, suma de visitas y elimina los duplicados.
   * Reasigna además las atenciones de los perfiles absorbidos hacia el perfil objetivo.
   * @param {Array<Object>} selectedProfiles
   * @param {Object} [options]
   */
  const mergePeople = async (selectedProfiles, options = {}) => {
    const { targetId, deleteIds, mergedData } = computeMergedPersonData(selectedProfiles, options);
    try {
      const batch = writeBatch(db);
      const targetRef = doc(db, 'camera_catcher_people', targetId);
      batch.update(targetRef, mergedData);

      const apptCol = collection(db, 'camera_catcher_appointments');
      for (const delId of deleteIds) {
        batch.delete(doc(db, 'camera_catcher_people', delId));

        // Reasignar citas del perfil absorbido al perfil destino
        const qDel = query(apptCol, where('clientId', '==', delId));
        const qSnapDel = await getDocs(qDel);
        qSnapDel.forEach(d => {
          batch.update(d.ref, {
            clientId: targetId,
            personId: targetId,
            clientName: mergedData.name
          });
        });
      }
      await batch.commit();
      return { success: true, targetId, mergedData };
    } catch (err) {
      console.error('[People] Error en fusión de perfiles:', err);
      throw err;
    }
  };

  /**
   * Elimina un ángulo/foto específico de la galería de un perfil
   * Actualiza el array de fotos, embeddings correlacionados, miniatura y nitidez máxima.
   * @param {string} personId
   * @param {number} photoIndex
   */
  const deletePersonPhoto = async (personId, photoIndex) => {
    if (!personId || photoIndex == null || photoIndex < 0) return;
    const person = people.value.find(p => p.id === personId);
    if (!person) throw new Error('Perfil biométrico no encontrado');

    const photos = extractPersonPhotos(person);
    if (photoIndex >= photos.length) throw new Error('Índice de foto no válido');

    const updatedPhotos = photos.filter((_, idx) => idx !== photoIndex);

    let currentEmbeddings = Array.isArray(person.embeddings) && person.embeddings.length > 0
      ? [...person.embeddings]
      : (Array.isArray(person.embedding) ? [person.embedding] : []);
    let updatedEmbeddings = currentEmbeddings.filter((_, idx) => idx !== photoIndex);

    const bestFaceScore = updatedPhotos.length > 0
      ? Math.max(...updatedPhotos.map(p => p.sharpnessScore || 0))
      : 0;

    const thumbnailBase64 = updatedPhotos.length > 0
      ? updatedPhotos[0].thumbnailBase64
      : null;

    try {
      const docRef = doc(db, 'camera_catcher_people', personId);
      const firestoreEmbeddings = toFirestoreEmbeddings(updatedEmbeddings);
      await updateDoc(docRef, {
        photos: updatedPhotos,
        embeddings: firestoreEmbeddings,
        ...(firestoreEmbeddings[0]?.vector ? { embedding: firestoreEmbeddings[0].vector } : {}),
        thumbnailBase64,
        bestFaceScore,
        updatedAt: new Date().toISOString()
      });
      return { success: true, remainingPhotos: updatedPhotos.length };
    } catch (err) {
      console.error('[People] Error eliminando foto de persona:', err);
      throw err;
    }
  };

  const barbersCount = computed(() => people.value.filter(p => p.isStaff).length);
  const frequentCount = computed(() => people.value.filter(p => !p.isStaff && p.status !== 'to_verify' && (p.status === 'frequent' || p.visitCount > 1)).length);
  const newClientsCount = computed(() => people.value.filter(p => !p.isStaff && p.status !== 'to_verify' && p.visitCount <= 1).length);
  const toVerifyCount = computed(() => people.value.filter(p => !p.isStaff && p.status === 'to_verify').length);

  onMounted(() => {
    subscribe();
  });

  onUnmounted(() => {
    if (unsubscribe) unsubscribe();
  });

  return {
    people,
    loading,
    error,
    barbersCount,
    frequentCount,
    newClientsCount,
    toVerifyCount,
    toggleRole,
    updatePersonName,
    deletePerson,
    batchDeletePeople,
    mergePeople,
    deletePersonPhoto
  };
}
