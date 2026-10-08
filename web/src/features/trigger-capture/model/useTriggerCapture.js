import { ref } from 'vue';
import { doc, setDoc } from 'firebase/firestore';
import { db, getEnvironmentInfo } from '@/shared/api/firebase';

export function useTriggerCapture() {
  const isTriggering = ref(false);
  const statusMessage = ref('');
  const statusType = ref('info');
  const envInfo = getEnvironmentInfo();

  const triggerCapture = async (addLogCallback = null) => {
    isTriggering.value = true;
    statusMessage.value = 'Iniciando captura inmediata...';
    statusType.value = 'info';

    const timestampNow = Date.now();

    if (addLogCallback) {
      addLogCallback({
        title: 'Disparo de Captura Solicitado',
        desc: `Entorno: ${envInfo.environmentLabel}. Destino: Firestore Event Bus`,
        type: 'action'
      });
    }

    try {
      const cmdRef = doc(db, 'camera_catcher', 'commands');
      await setDoc(cmdRef, {
        action: 'capture',
        source: 'dashboard-web',
        requestedAt: timestampNow
      }, { merge: true });

      statusMessage.value = 'Comando de captura emitido a Firestore';
      statusType.value = 'success';

      if (addLogCallback) {
        addLogCallback({
          title: 'Ciclo enviado a Firestore',
          desc: `Orden enviada vía Firestore [${envInfo.databaseId}].`,
          type: 'success'
        });
      }
    } catch (err) {
      console.error('[TriggerCapture] Error disparando ciclo:', err);
      statusMessage.value = `Error: ${err.message}`;
      statusType.value = 'error';
    } finally {
      setTimeout(() => {
        isTriggering.value = false;
      }, 1000);
    }
  };

  return {
    isTriggering,
    statusMessage,
    statusType,
    envInfo,
    triggerCapture
  };
}
