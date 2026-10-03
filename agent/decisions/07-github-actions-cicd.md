# ADR 07: CI/CD Selectivo con GitHub Actions

* **Estado**: Aceptado / En Producción
* **Fecha**: Octubre 2026
* **Responsable**: Antigravity & Javier

---

## Contexto y Problema

El repositorio contiene múltiples componentes con diferentes destinos de despliegue:
* El código del daemon y captura (`src/`, `neolink.toml`, `package.json`), que se ejecuta en la máquina virtual **Compute Engine `e2-micro`**.
* La interfaz web del panel (`web/`, `firebase.json`, `storage.rules`), que se aloja en **Firebase Hosting CDN**.
* La documentación técnica de arquitectura (`agent/decisions/`).

Desplegar todos los componentes a todos lados en cada commit es ineficiente, desperdicia minutos de GitHub Actions, incrementa el riesgo de interrupciones innecesarias en la VM y ralentiza el ciclo de desarrollo.

---

## Decisión Técnica

Se implementaron flujos de trabajo (**Workflows**) separados en GitHub Actions utilizando la directiva nativa `paths:` para **detección selectiva de cambios por carpeta**:

### 1. Despliegue de la VM (`.github/workflows/deploy-vm.yml`)
* **Filtro de rutas**:
  ```yaml
  paths:
    - 'src/**'
    - 'neolink.toml'
    - 'package.json'
    - 'package-lock.json'
  ```
* **Mecanismo de Despliegue**:
  * Autenticación SSH segura mediante llave privada dedicada almacenada en GitHub Secrets (`VM_SSH_KEY`).
  * Sincronización atómica de archivos con `rsync` hacia `/opt/camera-catcher/` en la VM (incluyendo `package-lock.json`).
  * **Verificación inteligente de dependencias**: Validación vía checksum SHA-256 de `package-lock.json` para evitar ejecuciones innecesarias de `npm` y prevenir el agotamiento de CPU burst credits / swap thrashing en la instancia `e2-micro`. Si no hay cambios, se omite `npm ci`.
  * Reinicio sin caída del servicio con `sudo systemctl restart camera-catcher.service` y verificación con `systemctl is-active`.

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
* **Aislamiento total**: Cambios en la web no tocan la VM; cambios en la VM no redeployan el frontend; cambios en la documentación no disparan ningún pipeline.
* **Velocidad**: El despliegue a la VM toma menos de 10 segundos vía `rsync` diferencial sobre SSH.
* **Seguridad**: El usuario `deploy` en la VM solo tiene permisos acotados en `sudoers` para reiniciar el servicio `camera-catcher.service`.
