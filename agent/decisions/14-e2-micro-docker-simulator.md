# ADR 14: Simulador Local de GCP Compute Engine e2-micro con Docker

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El daemon de captura e inferencia (`src/`) se ejecuta en producción sobre una máquina virtual **Google Compute Engine `e2-micro`** sujeta a restricciones de hardware estrictas (1 GB de memoria RAM física y 2 vCPUs compartidas con cuotas burstables).

Antes de esta decisión:
- El desarrollo local en máquinas de desarrollo (como macOS con 16-32 GB de RAM y múltiples núcleos) ocultaba posibles fugas de memoria, sobreconsumos o dependencias de bibliotecas que superaran el límite de 1 GB.
- Desplegar código sin validar el consumo de RAM conllevaba el riesgo de caídas por el **OOM Killer de Linux** en producción.
- El frontend web desconocía si el usuario estaba interactuando desde un entorno local (`localhost:8085`) o desde el hosting en producción (donde la VM opera con 0 puertos de entrada abiertos y recibe órdenes exclusivamente vía el bus de eventos de Firestore).

---

## Decisión Técnica

Se implementa un **Simulador Local de la VM `e2-micro`** utilizando contenedores Docker con límites estrictos de recursos gobernados por `cgroups`, complementado con detección dinámica de entorno en el frontend:

### 1. Especificaciones de Simulación de Hardware (`docker-compose.e2-sim.yml`)
* **Límite de Memoria RAM**: `1024M` (1 GB). Si Node.js o Sharp exceden 1024 MB, el kernel Linux dispara el OOM Killer (`exit code 137`) en local antes de llegar a GCP.
* **Memoria Swap**: `2048M` (1 GB de RAM física + 1 GB de swap), idéntico al aprovisionamiento estándar de Ubuntu en GCP.
* **Límite de CPU**: `0.5` core para reproducir con fidelidad la CPU compartida de GCP `e2-micro` (0.25 vCPU sostenida sujeta a throttling tras agotar burst credits).
* **Patrón Sibling Containers**: Se monta el socket `/var/run/docker.sock` del host para permitir que el daemon ejecute el contenedor Neolink P2P de forma idéntica a la VM.

### 2. Detección Inteligente de Entorno en el Frontend (`web/src/shared/lib/environment.js`)
* **Entorno Local (`localhost` / `127.0.0.1`)**:
  * Detecta que se está ejecutando el dashboard de desarrollo o el simulador E2.
  * Dirige el disparo manual ("Capturar Ahora") directamente vía HTTP hacia `http://localhost:8085/capture` con sincronización simultánea a Firestore.
* **Entorno Servidor Cloud (`*.web.app` / Firebase Hosting)**:
  * Detecta que se encuentra en producción.
  * Omite cualquier intento de conexión a `localhost:8085` (evitando timeouts o errores de red).
  * Despacha la orden de captura de forma inmediata y exclusiva al documento de Firestore `camera_catcher/commands`, donde el listener WebSocket del daemon en GCP lo procesa en < 100 ms.

---

## Consecuencias y Beneficios

### Positivas:
- **Detección temprana de OOM**: Pruebas con `npm run test:e2` validan la suite de tests bajo el techo estricto de 1 GB de RAM.
- **Enrutamiento óptimo de llamadas**: El frontend nunca se queda congelado intentando conectar a puertos cerrados en producción ni omite la velocidad de HTTP en local.
- **Fidelidad**: Emula el entorno Debian/Ubuntu y las bibliotecas binarias nativas de Linux (`glibc`) en lugar de depender del runtime de macOS.
