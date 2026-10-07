# ADR 02: Infraestructura en Google Compute Engine (e2-micro Free Tier)

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El sistema requiere capturar fotogramas periódicamente (cada 15 minutos o intervalos personalizados) las 24 horas del día sin depender de una computadora personal encendida en local. 

Las plataformas serverless convencionales (Firebase Functions y Google Cloud Run) demostraron ser inviables debido a que el enrutador de red interno (*Google Serverless VPC NAT*) descarta los paquetes UDP bidireccionales asimétricos necesarios para el protocolo P2P de la cámara.

Asimismo, no se deseaba incurrir en costos mensuales ni comprar hardware físico adicional (como una Raspberry Pi o Mini PC) para la barbería.

---

## Decisión Técnica

Se aprovisionó una máquina virtual en **Google Compute Engine** configurada rigurosamente bajo los parámetros del **Free Tier perpetuo de Google Cloud**:

| Parámetro | Configuración Implementada | Razón Técnica |
| :--- | :--- | :--- |
| **Zona / Región** | `us-central1-a` (Iowa) | Región cubierta por la cuota Always Free de GCP. |
| **Tipo de Instancia** | `e2-micro` (2 vCPUs compartidas, 1 GB RAM) | Google cubre 744 horas mensuales ($0.00). Un mes de 31 días tiene exactamente 744 horas. |
| **Disco de Arranque** | 20 GB `pd-standard` (Standard Persistent Disk) | La cuota gratuita cubre hasta 30 GB de `pd-standard`. Evitamos discos `pd-balanced` o `pd-ssd` para asegurar costo cero. |
| **Memoria Swap** | 2 GB Swapfile (`/swapfile` en disco) | Previene Out-Of-Memory (OOM) en la instancia de 1 GB RAM física. Esencial para compilación nativa de C++ (`better-sqlite3`, `node-gyp`) y estabilidad del runtime. |
| **Sistema Operativo** | Ubuntu 22.04 LTS x86_64 | Ligero, altamente compatible con Docker y Node.js. |
| **Gestión de Proceso** | `systemd` (`camera-catcher.service`) | Daemon persistente con reinicio automático (`Restart=always`) ante caídas o reinicios de la máquina. |
| **Seguridad de Red** | 0 puertos de entrada abiertos | La VM no expone ningún puerto hacia internet; todas las instrucciones se reciben por conexiones salientes WebSocket a Firestore y túnel Cloudflare. |

---

## Consecuencias

### Positivas:
* **Costo mensual garantizado de $0.00**: Opera dentro de la capa gratuita perpetua de Google Cloud.
* **Stack de Red UDP Completo**: La VM cuenta con una tarjeta de red virtual estándar que gestiona el *hole-punching* UDP sin que ningún proxy o NAT serverless descarte los paquetes.
* **Autonomía 24/7/365**: El sistema sigue funcionando independientemente del estado de la computadora del usuario.
* **Tiempos de respuesta inmediatos**: Al estar siempre encendida, responde en ~10-15 segundos cuando el usuario pulsa "Capturar Ahora" desde el panel web.
* **Estabilidad de Memoria con 2 GB Swap**: La adición del archivo swap de 2 GB en disco permite que operaciones de compilación nativa de librerías C++ (como `better-sqlite3` vía `node-gyp`) y picos de inferencia se ejecuten sin riesgo de activación del OOM Killer de Linux, manteniendo `vm.swappiness=10` para priorizar el uso de RAM física.

### Negativas / Restricciones:
* La instancia `e2-micro` tiene 1 GB de memoria RAM y CPU burstable con cuotas de uso compartido. Para evitar throttling, las capturas se ejecutan de manera secuencial (con un semáforo booleano `isCapturing`), evitando ejecuciones concurrentes pesadas.

