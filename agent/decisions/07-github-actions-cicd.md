# ADR 07: CI/CD Selectivo con GitHub Actions

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026 (Actualizado: Noviembre 2026 para Producción en OVHcloud)
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El repositorio contiene múltiples componentes con diferentes destinos de despliegue:
* El código del daemon y captura (`src/`, `scripts/`, `config/`, `neolink.toml`, `package.json`), que se ejecuta en la máquina virtual de producción (**VPS Linux en OVHcloud**).
* La interfaz web del panel (`web/`, `firebase.json`, `storage.rules`), que se aloja en **Firebase Hosting CDN**.
* La documentación técnica de arquitectura (`agent/decisions/`).

Desplegar todos los componentes a todos lados en cada commit es ineficiente, desperdicia minutos de GitHub Actions, incrementa el riesgo de interrupciones innecesarias en el servidor de producción y ralentiza el ciclo de desarrollo.

---

## Decisión Técnica

Se implementaron flujos de trabajo (**Workflows**) separados en GitHub Actions utilizando la directiva nativa `paths:` para **detección selectiva de cambios por carpeta** y soporte para ejecución manual bajo demanda (`workflow_dispatch`):

### 1. Despliegue de la VM de Producción (`.github/workflows/deploy-vm.yml`)
* **Nombre del Flujo**: `Deploy to Production VM (Camera Catcher)`
* **Eventos y Filtro de rutas**:
  ```yaml
  on:
    push:
      branches:
        - main
      paths:
        - 'src/**'
        - 'scripts/**'
        - 'config/**'
        - 'neolink.toml'
        - 'package.json'
        - 'package-lock.json'
        - '.github/workflows/deploy-vm.yml'
    workflow_dispatch:
  ```
* **Mecanismo de Despliegue**:
  * Autenticación SSH segura mediante llave privada dedicada almacenada en GitHub Secrets (`VM_SSH_KEY`) y host (`VM_HOST`, `VM_USER`).
  * Sincronización atómica diferencial de archivos con `rsync -avz --delete` hacia `/opt/camera-catcher/` en la VM para los directorios y archivos: `src`, `scripts`, `config`, `package.json`, `package-lock.json`, `neolink.toml`.
  * **Exclusiones críticas de protección en destino**:
    * `--exclude 'node_modules'` (conserva dependencias instaladas en el servidor).
    * `--exclude '.git'` (evita sobreescribir metadatos locales si los hubiera).
    * `--exclude '.package-lock.hash'` (mantiene el cache de checksum de dependencias).
    * `--exclude '.env'` (protege credenciales y secretos de entorno de producción).
    * `--exclude 'service-account.json'` (protege la cuenta de servicio de Firebase / GCP).
    * `--exclude 'data'` (protege la base de datos SQLite persistente `data/barberia.db` y datos locales).
    * `--exclude 'daemon.log'` (evita borrar bitácoras activas del daemon).
  * **Verificación inteligente de dependencias**: Validación vía checksum SHA-256 de `package-lock.json` y presencia de librerías nativas (`onnxruntime-node`, `sharp`) para ejecutar `npm install --omit=dev` únicamente cuando hay cambios de dependencias.
  * **Limpieza de procesos y reinicio de servicio**: Eliminación preventiva de contenedores Neolink huérfanos (`neolink-capture`), reinicio con `sudo systemctl restart camera-catcher.service` y verificación de salud con `systemctl is-active`.

### 2. Despliegue de Hosting (`.github/workflows/deploy-hosting.yml`)
* **Filtro de rutas**:
  ```yaml
  paths:
    - 'web/**'
    - 'firebase.json'
    - 'storage.rules'
  ```
* **Mecanismo de Despliegue**:
  * Utiliza Firebase CLI para compilar y desplegar exclusivamente los activos estáticos y reglas de seguridad hacia Firebase Hosting global.

---

## Consecuencias

### Positivas:
* **Despliegue 100% Automático**: Cada push a `main` que modifique el backend, scripts, configuraciones canónicas o dependencias se despliega inmediatamente en el VPS de OVHcloud sin intervención manual.
* **Aislamiento total**: Cambios en la web no tocan la VM; cambios en la VM no redeployan el frontend; cambios en la documentación no disparan ningún pipeline.
* **Velocidad**: El despliegue a la VM toma pocos segundos vía `rsync` diferencial sobre SSH.
* **Seguridad y Persistencia**: Se garantiza que bases de datos SQLite (`data/`), credenciales (`.env`, `service-account.json`) y bitácoras del daemon nunca sean sobreescritas ni eliminadas en producción.
* **Permisos Acotados**: El usuario `deploy` en la VM solo tiene permisos acotados en `sudoers` para reiniciar el servicio `camera-catcher.service`.
