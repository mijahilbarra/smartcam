# Decisión de Arquitectura 11: Estandarización de Iconografía y Tipografía con Google Fonts

## Estado
Aprobado e Implementado en Producción.

## Contexto y Problema
En las etapas iniciales del dashboard web de IOT Camera Catcher (`web/index.html`), se empleaban emojis nativos del sistema operativo (`📸`, `⚙️`, `⚡`, `👤`, `📐`, etc.) para ilustrar botones, tarjetas, pestañas y pasos del flujo de trabajo del daemon.

Este enfoque generaba los siguientes problemas:
1. **Inconsistencia Visual entre Plataformas**: Cada sistema operativo (macOS, Windows, Linux, Android, iOS) renderiza los emojis con estilos gráficos, paletas de colores y dimensiones sustancialmente distintas.
2. **Imposibilidad de Tematización CSS**: Los emojis nativos no responden a propiedades CSS vectoriales como `color`, `fill` o variables de tema (`var(--primary)`, `var(--text-muted)`).
3. **Alineación Vertical Defectuosa**: La caja de texto (`line-height` y `vertical-align`) de los glifos emoji varía según el motor tipográfico de la plataforma, provocando desalineaciones en botones y barras de estado.

## Decisión Adoptada
Estandarizar toda la tipografía e iconografía de la aplicación web bajo el ecosistema de **Google Fonts**:

1. **Tipografía de Sistema**:
   - `Inter` (sans-serif): Fuente primaria para textos, cabeceras, botones y formularios.
   - `JetBrains Mono` (monospace): Fuente para código, hashes, IDs de Firestore y telemetría de consola.
2. **Biblioteca de Iconos**:
   - **Google Fonts Material Symbols Outlined**:
     ```html
     <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
     ```
   - Uso de glifos vectoriales basados en ligaduras ligadas mediante `<span class="material-symbols-outlined">icon_name</span>`.

## Mapeo de Iconografía Clave

| Uso en Interfaz | Glifo Anterior (Emoji) | Material Symbol Outlined |
| :--- | :---: | :--- |
| Marca principal / Cámara | `📸` | `videocam` / `photo_camera` |
| Configuración | `⚙️` | `settings` |
| Calibrador / Geometría ROI | `📐` | `aspect_ratio` / `crop_free` |
| Pestaña Telemetría Daemon | `📡` | `sensors` |
| Pestaña Historial y Fotos | `🖼️` | `photo_library` |
| Disparo Manual / Acción Rápida | `⚡` | `bolt` |
| Contador / Intervalo | `⏱️` | `timer` |
| Horario de Atención | `🕒` | `schedule` |
| Detección de Humanos (YOLOv8) | `👤` | `person_search` |
| Biometría / Perfiles ArcFace | `👥` | `badge` / `group` |
| Bitácora de Telemetría | `📋` | `terminal` / `content_copy` |
| Costos y Facturación GCP | `💰` | `payments` |
| Seguridad y Blindaje | `🛡️` | `shield` |
| Servidor Compute Engine | `🖥️` | `memory` |
| Almacenamiento Storage | `📦` | `cloud_upload` |
| Base de Datos Firestore | `🗄️` | `database` |
| Motor ML Local (ONNX) | `🧠` | `neurology` / `psychology` |
| Gemini Vision AI | `✨` | `auto_awesome` |
| Simulador de Consumos | `🎛️` | `tune` |
| Sincronización en Vivo | `🔄` | `sync` |
| Guardar en Firebase | `💾` | `save` |
| Crear / Eliminar Cuadrante | `➕` / `🗑️` | `add_box` / `delete` |
| Modos de Calibración | `✋` / `✏️` | `pan_tool` / `draw` |

## Consecuencias y Beneficios
- **Consistencia Visual del 100%**: Aspecto uniforme y profesional en cualquier navegador y dispositivo.
- **Optimización y Carga Eficiente**: Aprovechamiento de la CDN global de Google Fonts con HTTP/2 caching y sincronización con el `fonts-loading` gate del documento.
- **Flexibilidad de Color**: Los iconos heredan dinámicamente los estilos `var(--primary)`, `var(--text-muted)` y estados interactivos hover/focus.
