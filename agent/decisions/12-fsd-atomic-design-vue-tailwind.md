# ADR 12: Arquitectura Frontend Feature-Sliced Design (FSD) con Atomic Design en Vue 3 y Tailwind CSS

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El dashboard web original de IOT Camera Catcher (`web/`) fue concebido inicialmente como una SPA en JavaScript ES Modules nativo con manipulación manual del DOM (`document.getElementById`). Con la incorporación sucesiva del visualizador en vivo del daemon, canvas interactivo multinivel, calibrador ROI poligonal con ratón, visor modal dual con marcas SVG, monitor de cuotas Google Cloud Always Free y directorio biométrico ArcFace, el archivo `web/app.js` alcanzó más de 3,100 líneas monolíticas y `web/style.css` más de 2,700 líneas.

Este crecimiento monolítico ocasionaba:
1. **Dificultad de Mantenimiento y Escalabilidad**: Lógica de renderizado, controladores de eventos DOM y llamadas a Firestore/Storage fuertemente acopladas.
2. **Fragilidad ante Cambios**: Modificar un componente (e.g. el calibrador o el stepper) implicaba el riesgo de romper eventos o selectores en otras secciones.
3. **Falta de Reutilización Estructurada**: Botones, modales, píldoras de estado y tarjetas KPI se duplicaban en marcado HTML sin abstracción de diseño.

---

## Decisión Técnica

Se rediseña la arquitectura frontend migrando a **Vue 3 (Composition API)** con **Tailwind CSS**, integrando **Feature-Sliced Design (FSD)** con **Atomic Design**:

### 1. Fusión Arquitectónica FSD + Atomic Design

| Capa FSD | Nivel Atomic Design | Responsabilidad | Implementación |
| :--- | :--- | :--- | :--- |
| **`shared/ui/atoms/`** | **Átomos** | Primitivas visuales independientes sin lógica de dominio. | `AppButton`, `AppIcon`, `AppBadge`, `AppInput`, `AppTextarea`, `AppSelect`, `AppSlider`, `AppSpinner`. |
| **`shared/ui/molecules/`** | **Moléculas** | Composiciones simples de átomos con propósitos específicos de interfaz. | `StatusPill`, `TimeRangeField`, `StatPill`, `ModalHeader`, `PaginationNav`. |
| **`shared/ui/templates/`** | **Templates** | Esqueletos y layouts estructurales sin acoplamiento a datos. | `MainLayout`, `ModalTemplate`, `SplitGridTemplate`, `KpiGridTemplate`. |
| **`entities/`** | **Moléculas de Dominio** | Modelos de negocio, estado y reactividad con Firebase. | `daemon`, `photo`, `quadrant`, `person`, `cost-quota`. |
| **`features/`** | **Organismos Funcionales** | Acciones de usuario con efectos colaterales e interacciones. | `trigger-capture`, `calibrate-quadrants`, `configure-settings`, `simulate-costs`. |
| **`widgets/`** | **Organismos Mayores** | Secciones completas de la interfaz autocontenidas. | `AppHeader`, `DaemonLiveMonitor`, `PhotosTable`, `CostMonitorWidget`, `PeopleDirectoryWidget`, `PhotoDetailModal`, `QuadrantCalibratorModal`, `SettingsModal`. |
| **`pages/`** | **Vistas / Pages** | Vistas finales de usuario ensambladas. | `LiveMonitorPage`, `HistoryPage`. |
| **`app/`** | **App Shell** | Inicialización, estilos globales de Tailwind y montaje. | `App.vue`, `main.js`, `styles/index.css`. |

### 2. Estándares Tipográficos y Visuales
- Se mantiene el cumplimiento estricto del **ADR 11 (Google Fonts)**: fuentes `Inter`, `JetBrains Mono` y ligaduras vectoriales `Material Symbols Outlined`.
- Se preserva el *Font Loading Visibility Gate* en `index.html` para garantizar cero parpadeo tipográfico (FOUT).

### 3. Pipeline de Construcción y Despliegue
- **Vite 8** con `@vitejs/plugin-vue` y `@tailwindcss/vite` nativo para compilación de producción en menos de 300 ms.
- Salida de build dirigida a `web/dist`.
- `firebase.json` actualizado a `"public": "web/dist"`.
- Pipeline `.github/workflows/deploy-hosting.yml` actualizado con paso previo `npm run build:web`.

---

## Consecuencias y Beneficios

### Positivas:
- **Cero Regresiones**: La aplicación conserva el 100% de la funcionalidad interactiva, compatibilidad con Firestore y rendimiento en tiempo real.
- **Mantenibilidad Extrema**: Cada componente posee responsabilidades delimitadas y ciclo de vida predecible.
- **Velocidad de Carga**: Bundle empaquetado, minificado y con purga automática de clases Tailwind no utilizadas.
- **Seguridad**: Respaldo completo en `web-legacy/` garantizando rollbacks instantáneos ante cualquier contingencia.
