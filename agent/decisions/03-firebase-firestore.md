# ADR 03: Base de Datos y Bus Reactivo con Cloud Firestore

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El sistema requiere:
1. Almacenar el registro histórico de las capturas (timestamp, ID del archivo en Storage, prompt utilizado y análisis textual de Gemini Vision).
2. Permitir la configuración en caliente del prompt y del intervalo de captura sin necesidad de reiniciar la máquina virtual ni conectarse por SSH.
3. Permitir disparar capturas manuales inmediatas desde cualquier cliente web sin abrir puertos HTTP de entrada en la máquina virtual ni configurar dominios con certificados SSL.

---

## Decisión Técnica

Se adoptó **Cloud Firestore** en modo nativo bajo el proyecto `skip-bigotes`, utilizándolo tanto como base de datos de documentos NoSQL como **bus de eventos reactivo bidireccional**:

### Estructura de Documentos y Colecciones:

1. **Configuración en Vivo (`camera_catcher/prompt`)**:
   ```json
   {
     "default": "Describe what do you see in the image",
     "intervalMinutes": 15,
     "updatedAt": "2026-10-02T18:33:23.000Z"
   }
   ```
   * La VM escucha este documento mediante `onSnapshot`. Si `intervalMinutes` cambia (incluso a valores decimales como `0.5` para 30 segundos), el daemon en la VM reprograma su temporizador `setInterval` en tiempo real de forma inmediata.

2. **Bus de Comandos Manuales (`camera_catcher/commands`)**:
   ```json
   {
     "action": "capture",
     "requestedAt": 1790965159814
   }
   ```
   * Cuando el usuario hace clic en "Capturar Ahora" en la interfaz web, el navegador escribe este documento.
   * La VM, que mantiene un `onSnapshot` por una conexión saliente WebSocket segura, recibe el evento en menos de 100 ms y dispara `executeCaptureProcess()`.

3. **Historial de Capturas (`camera_catcher/photos/photos/<docId>`)**:
   ```json
   {
     "id": "photo_1790965159814",
     "imageStoragePath": "camera_catcher/photos/photo_1790965159814.jpg",
     "createdAt": "2026-10-02T18:19:40.407Z",
     "epoch": 1790965159814,
     "promptUsed": "Describe what do you see in the image",
     "analysis": "This is a black-and-white security camera capture showing the interior of what appears to be a barber shop...",
     "camera": "barberia",
     "source": "gcp-e2-micro",
     "timestamp": "serverTimestamp()"
   }
   ```
   * **Regla estricta**: No se almacenan URLs públicas directas, sino el `imageStoragePath`. Las URLs de visualización se resuelven en el cliente mediante el SDK de Firebase Storage.

---

## Consecuencias

### Positivas:
* **Cero puertos de red expuestos**: El patrón de escucha mediante `onSnapshot` elimina la necesidad de exponer servidores HTTP públicos en la VM.
* **Sincronización en tiempo real**: Los cambios de configuración y las nuevas fotos aparecen instantáneamente en la interfaz web de todos los usuarios conectados sin necesidad de recargar la página (*push notifications* automáticas).
* **Consumo dentro de la cuota gratuita**: Con 96 capturas diarias, se realizan menos de 100 escrituras al día (frente a las 20,000 escrituras gratuitas diarias que ofrece el Free Tier de Firestore).
