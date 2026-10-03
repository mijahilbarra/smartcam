# ADR 09: Monitoreo Proactivo de Costos y Cuotas de Google Cloud

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El sistema **IOT Camera Catcher** opera de manera continua 24/7 procesando fotogramas de vigilancia, almacenando imágenes de alta resolución, ejecutando modelos de Machine Learning y sincronizando datos en tiempo real mediante múltiples servicios de Google Cloud Platform (GCP) y Firebase.

Para mantener una operación sostenible sin riesgo de facturaciones imprevistas o agotamiento de cuotas, es indispensable:
1. **Identificar y mapear formalmente los vectores de costo** de cada servicio activo (Compute Engine, Cloud Storage, Cloud Firestore, Firebase Hosting y APIs de IA).
2. **Monitorear en tiempo real** el consumo acumulado de almacenamiento y el ritmo de generación de datos.
3. **Ofrecer una interfaz interactiva y preventiva** en el dashboard web que alerte visualmente si la frecuencia de captura configurada por el usuario pone en riesgo la permanencia dentro del **Always Free Tier** de Google Cloud.

---

## Matriz de Consumos y Límites de la Capa Gratuita (Always Free Tier)

| Servicio GCP / Firebase | Recurso en Producción | Límite Gratuito Google Cloud (Always Free) | Consumo Típico del Sistema | Costo Mensual Estimado |
| :--- | :--- | :--- | :--- | :---: |
| **Compute Engine** | Instancia `e2-micro` en `us-central1-a` | 1 VM mensual (744 horas al mes) | 1 VM encendida 24/7 (744 horas) | **$0.00** |
| **Persistent Disk** | 20 GB `pd-standard` (Boot Disk) | Hasta 30 GB `pd-standard` al mes | 20 GB estándar en uso | **$0.00** |
| **Red / IP Pública** | IPv4 Efímera / Estática en VM | N/A (Política GCP Feb 2024: ~$0.005/h) | 730 horas/mes | **$0.00 - $3.65*** |
| **Cloud Storage** | Bucket `skip-bigotes.firebasestorage.app` | 5.0 GB-mes de almacenamiento | ~144 MB base (+ crecimiento según intervalo) | **$0.00** (bajo < 5 GB) |
| **Operaciones Storage** | Subidas de imágenes (Clase A) | 5,000 operaciones Clase A al mes | ~5,760 ops/mes (a 15 min de intervalo) | **<$0.01** |
| **Cloud Firestore** | Base de datos modo nativo (`nam5`) | 20,000 escrituras / 50,000 lecturas diarias | ~96 escrituras/día (a 15 min de intervalo) | **$0.00** |
| **Inferencia ML Local** | YOLOv8 Nano en ONNX Runtime | N/A (Cómputo en CPU local de la VM) | Inferencia local ~100 ms por fotograma | **$0.00** (100% ahorro) |
| **Gemini Vision AI API** | `gemini-flash-latest` (AI Studio) | 1,500 peticiones diarias / 15 RPM gratuitas | ~96 req/día (a 15 min si activo) | **$0.00** (o ~$0.00008/call) |
| **Firebase Hosting** | CDN global de distribución web | 10 GB de transferencia mensual / 360 MB | Assets estáticos cacheados en CDN | **$0.00** |

*\*Nota de IP Pública: Google Cloud introdujo a partir de febrero de 2024 un cargo estándar de ~$0.005/hora por direcciones IPv4 públicas asignadas a instancias en ejecución, lo que representa aproximadamente $3.65 al mes si no es cubierto por créditos promocionales.*

---

## Decisión Técnica

Se diseñó e implementó un **Monitor Reactivo de Costos y Cuotas de Google Cloud** integrado directamente en la interfaz del panel web de administración (`web/index.html`, `web/style.css`, `web/app.js`):

1. **Semáforo Dinámico de Seguridad Presupuestaria**:
   - 🟢 **Seguro ($0.00/mes)**: Intervalos $\ge 10$ minutos. Operaciones y volumen de almacenamiento dentro del Always Free Tier perpetuo.
   - 🟡 **Moderado (~$0.10 - $0.50/mes)**: Intervalos entre 2 y 9 minutos. Las operaciones Clase A de Storage exceden ligeramente la cuota gratuita mensual.
   - 🔴 **Intensivo / Alerta**: Intervalos $< 2$ minutos (ej. 30 segundos). Advierte que en operación 24/7 generaría ~170 GB de fotos al mes y agotaría rápidamente los 5 GB gratuitos.

2. **Métricas en Vivo (KPI Cards)**:
   - Visualización de la capacidad del bucket de Storage con barra de progreso porcentual respecto al umbral de 5.0 GB.
   - Cálculo del crecimiento diario de almacenamiento estimado (`+MB / día`).
   - Días restantes calculados antes de alcanzar el límite gratuito de Storage.
   - Porcentaje de cuota diaria consumida en Cloud Firestore (sobre el límite de 20,000 escrituras diarias).
   - Consumo diario y tasa de cuota de **Google Gemini Vision API** (sobre la cuota gratuita de 1,500 llamadas/día en Google AI Studio y costo por llamada Pay-as-you-go).

3. **Simulador Interactivo de Intervalos**:
   - Control deslizante y botones de preajuste rápido (`30s`, `1m`, `5m`, `15m`, `1h`).
   - Proyección matemática en tiempo real de capturas al día/mes, consumo de espacio proyectado en GB, operaciones de Storage y costo estimado resultante.
   - Botón de sincronización instantánea con el intervalo actualmente activo en Firestore.

4. **Recomendaciones de Mitigación y Buenas Prácticas**:
   - **Regla de Ciclo de Vida (GCS Lifecycle Policy)**: Recomendación documentada para configurar la auto-eliminación de objetos mayores a 30 días en el bucket, garantizando que el almacenamiento nunca supere los 5 GB sin importar el tiempo de funcionamiento.

---

## Consecuencias

### Positivas:
* **Transparencia absoluta**: El usuario conoce en todo momento qué servicios generan costo, cuáles son 100% gratuitos y el impacto de sus configuraciones.
* **Prevención de sorpresas**: Evita que una prueba con capturas frecuentes (ej. cada 30 segundos) se quede activa indefinidamente sin que el usuario sea consciente del crecimiento del bucket.
* **Cero sobrecosto de infraestructura**: El monitor corre íntegramente del lado cliente en Vanilla JS, leyendo los mismos metadatos que el dashboard ya sincroniza vía WebSockets con Firestore.

### Negativas / Mitigaciones:
* El cálculo de tamaño acumulado en el frontend se basa en una cota inicial calibrada (~144 MB) combinada con el número de documentos y tamaño promedio de las capturas (raw + anotada con marcos). Para auditorías oficiales a nivel de centavos, se recomienda consultar periódicamente la consola de Google Cloud Billing.
