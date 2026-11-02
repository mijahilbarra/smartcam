# ADR 02: Infraestructura de Producción en OVHcloud VPS (VPS-1 Starter)

* **Estado**: Aceptado / En Producción
* **Fecha**: Noviembre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

Durante las fases iniciales del proyecto, el daemon se ejecutó en una instancia `e2-micro` de Google Cloud Compute Engine bajo la premisa de costo $0 del *Free Tier*. Sin embargo:
1. **Cobros Ocultos de IPv4 Pública en GCP**: A partir de 2024–2025, Google Cloud comenzó a cobrar $0.005/hora por direcciones IPv4 públicas en uso, generando una factura recurrente de **~$3.60 a $7.20 USD mensuales** por una máquina con apenas 1 GB de RAM compartida.
2. **Restricción Crítica de Memoria (1 GB RAM)**: Con Ubuntu 22.04, Docker, Neolink, Node.js y los modelos ONNX (YOLOv8 + MobileFaceNet), la memoria RAM se mantenía al 85–90% de saturación, requiriendo 2 GB de swap en disco que degradaba la latencia de inferencia y generaba riesgo constante de activación del *OOM-killer*.

Se evaluó la migración hacia **OVHcloud VPS-1** ($5.35 USD/mes) frente a mantener GCP `e2-micro` ($7.00+ USD/mes).

---

## Decisión Técnica

Se migró la infraestructura del daemon de producción a una instancia **OVHcloud VPS-1** ubicada en el datacenter de **US-East (Virginia, EE.UU.)**:

| Parámetro | Configuración Implementada | Comparativa frente a GCP e2-micro |
| :--- | :--- | :--- |
| **Proveedor & Plan** | OVHcloud VPS-1 Starter ($5.35/mes) | Más económico que el costo de IP pública en GCP (~$7.00/mes). |
| **Ubicación / Datacenter** | `US-EAST-VA` (Vint Hill, Virginia, EE.UU.) | Latencia óptima hacia Perú (<120 ms) y hacia Google APIs (us-central1). |
| **Recursos de Cómputo** | 1 vCore dedicado (2.4+ GHz) | Rendimiento predecible sin *CPU burst credits* compartidos. |
| **Memoria RAM** | **4 GB RAM física** | **4× más memoria** que GCP (1 GB). El sistema opera al 6% de RAM (240 MB RSS). |
| **Almacenamiento** | 20 GB SSD NVMe | Lectura/escritura ultrarrápida para chunks temporales de video y base SQLite. |
| **Red & Ancho de Banda** | 100 Mbps no medido (unmetered) + Protección Anti-DDoS | Sin sorpresas de facturación por transferencia de datos saliente. |
| **Dirección IP** | 1 IPv4 pública dedicada incluida fija + IPv6 | Sin cargos adicionales por IP pública. |
| **Sistema Operativo** | Ubuntu 24.04 LTS x86_64 | Soporte a largo plazo, systemd moderno y compatibilidad nativa Docker. |
| **Gestión de Servicio** | `systemd` (`camera-catcher.service`) | Daemon persistente 24/7 con reinicio automático y `TimeoutStopSec=10s`. |
| **Túnel de Acceso Seguro**| Cloudflare Tunnel (`cloudflared`) | Tráfico HTTPS seguro hacia `https://stream.perrosuelto.com` con 0 puertos de entrada abiertos. |

---

## Consecuencias y Beneficios

### Positivas:
* **Ahorro Directo**: Reducción de costos mensuales de ~$7 USD a $5.35 USD fijos, eliminando cobros variables imprevistos.
* **4× Capacidad de Memoria RAM**: El consumo residente del daemon (~240 MB) representa solo el **6.2% de la memoria total**, liberando más de 2.5 GB de RAM para el sistema operativo y buffers de red.
* **Cero Paginación Swap**: No se requiere swap en disco para la inferencia de visión, eliminando cuellos de botella en I/O.
* **Soporte para Flujos de Mayor Frecuencia**: Permite procesar de forma holgada la arquitectura dual-stream a 10 FPS de video y 5.5 FPS de inferencia neuronal.
* **Conectividad P2P Robusta**: El túnel UDP Baichuan de Neolink opera de forma directa y estable hacia el CGNAT de Movistar Perú.

### Negativas / Consideraciones:
* **Migración de Facturación**: La infraestructura de cómputo reside en OVHcloud mientras los servicios serverless (Firestore, Storage, Hosting) continúan en Google Cloud Platform (skip-bigotes). La comunicación entre ambos opera mediante credenciales seguras de Service Account (`GOOGLE_APPLICATION_CREDENTIALS`).
