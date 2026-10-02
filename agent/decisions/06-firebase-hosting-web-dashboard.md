# ADR 06: Dashboard Web Reactivo con Firebase Hosting

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

Se requería una interfaz de usuario visual, ágil, accesible desde computadoras o teléfonos móviles sin necesidad de instalar aplicaciones nativas, que permita:
1. Visualizar en tiempo real el historial de capturas con sus miniaturas, marcas de tiempo y el análisis de Gemini.
2. Abrir las imágenes en resolución completa (HD) mediante un visor modal.
3. Modificar en caliente el prompt de Gemini y el intervalo de captura (en minutos o fracciones de minuto).
4. Forzar una captura inmediata mediante el botón "Capturar Ahora".

---

## Decisión Técnica

Se desarrolló una aplicación web de una sola página (**Single Page Application - SPA**) alojada en **Firebase Hosting**:

1. **Stack de Frontend**:
   * **HTML5 semántico y CSS3 puro** con diseño responsivo basado en CSS Variables y modo oscuro profesional.
   * **JavaScript ES Modules nativo** con el SDK modular de Firebase v10 (`@firebase/app`, `@firebase/firestore`, `@firebase/storage`).
   * **Cero dependencias de compilación**: No requiere Webpack, Vite ni Node.js en el cliente para ejecutarse; los módulos se cargan directamente desde la CDN de Google (`https://www.gstatic.com/firebasejs/10.12.0/`).
2. **Reactivad en Tiempo Real (No Polling)**:
   * Se utiliza `onSnapshot()` sobre la colección `camera_catcher/photos/photos` ordenada de forma descendente. Cuando la VM guarda un nuevo registro, la tabla del navegador se actualiza instantáneamente sin recargar la página.
3. **Resolución Asíncrona de Miniaturas**:
   * Para optimizar la carga, las filas se renderizan de inmediato con *spinners* de carga mientras el SDK de Firebase Storage resuelve las URLs de descarga en paralelo mediante `getDownloadURL()`.
4. **Despliegue Global en CDN**:
   * La aplicación está desplegada en el sitio `camera-catcher-bigotes` bajo el dominio oficial:
     👉 **`https://camera-catcher-bigotes.web.app`**
   * Servida con compresión Brotli/Gzip y certificados SSL automáticos de Google.

---

## Consecuencias

### Positivas:
* Latencia de carga de la web menor a 200 milisegundos gracias a la CDN global de Firebase.
* Costo de alojamiento: $0.00 (el almacenamiento y ancho de banda de Hosting están ampliamente cubiertos por el Free Tier de Firebase).
* Accesibilidad universal desde cualquier navegador sin requerir autenticaciones complejas iniciales.
