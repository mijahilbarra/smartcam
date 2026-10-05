import { ref } from 'vue';
import { doc, setDoc } from 'firebase/firestore';
import { db, BACKEND_URL } from '@/shared/api/firebase';

export function useTriggerCapture() {
  const isTriggering = ref(false);
  const statusMessage = ref('');
  const statusType = ref('info');

  const triggerCapture = async (addLogCallback = null) => {
    isTriggering.value = true;
    statusMessage.value = 'Iniciando captura inmediata...';
    statusType.value = 'info';

    if (addLogCallback) {
      addLogCallback({
        title: '⚡ Disparo de Captura Solicitado',
        desc: 'El usuario pulsó Capturar Ahora en el Dashboard.',
        type: 'action'
      });
    }

    try {
      // 1. Try direct HTTP to daemon backend
      let fetchSuccess = false;
      try {
        const res = await fetch(`${BACKEND_URL}/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'dashboard_button', timestamp: new Date().toISOString() })
        });
        if (res.ok) {
          fetchSuccess = true;
          statusMessage.value = '¡Captura procesada con éxito por el daemon!';
          statusType.value = 'success';
        }
      } catch (httpErr) {
        console.warn('[TriggerCapture] Backend HTTP directo no respondió, enviando comando a Firestore:', httpErr);
      }

      // 2. Fallback to Firestore command queue
      if (!fetchSuccess) {
        const cmdRef = doc(db, 'camera_catcher', 'daemon_command');
        await setDoc(cmdRef, {
          command: 'TRIGGER_CYCLE',
          requestedAt: new Date().toISOString(),
          requestedBy: 'dashboard_ui'
        }, { merge: true });

        statusMessage.value = 'Comando enviado a la cola de Firestore';
        statusType.value = 'success';
      }

      if (addLogCallback) {
        addLogCallback({
          title: '✓ Ciclo activado',
          desc: 'El daemon ha recibido la orden de captura.',
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
    triggerCapture
  };
}
