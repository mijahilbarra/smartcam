#!/usr/bin/env bash
# ==============================================================================
# Script de Purga y Saneamiento de Conexiones (FFmpeg, Neolink, Docker y Sockets)
# ==============================================================================
# Funciona de manera transparente tanto en macOS (Local) como en Debian/Ubuntu (GCP).
# Se invoca automáticamente al inicio del daemon (prestart) o bajo demanda:
#   npm run purge
# ==============================================================================

set -o pipefail

echo -e "\033[36m[Purge]\033[0m Iniciando saneamiento de procesos y conexiones de cámara..."

# 1. Purgar procesos zombies o bloqueados de FFmpeg asociados a Neolink / RTSP
echo -e "\033[36m[Purge]\033[0m Eliminando instancias huérfanas de FFmpeg..."
pkill -9 -f 'ffmpeg.*8554' 2>/dev/null || true
pkill -9 -f 'ffmpeg.*barberia' 2>/dev/null || true
pkill -9 -f 'ffmpeg.*snap_clear' 2>/dev/null || true

# 2. Purgar procesos huérfanos de capturas Neolink
echo -e "\033[36m[Purge]\033[0m Eliminando procesos huérfanos de Neolink..."
pkill -9 -f 'neolink image' 2>/dev/null || true

# 3. Limpieza de contenedores efímeros de Docker (neolink-capture) si Docker está activo
if command -v docker &> /dev/null; then
  # Verificar si el demonio de Docker responde
  if docker info &> /dev/null; then
    echo -e "\033[36m[Purge]\033[0m Purgando contenedores efímeros de captura en Docker..."
    docker rm -f neolink-capture 2>/dev/null || true
    # Limpiar cualquier contenedor huérfano con prefijo neolink-capture
    ephemeral_containers=$(docker ps -a -q --filter name=neolink-capture 2>/dev/null || true)
    if [ -n "$ephemeral_containers" ]; then
      echo "$ephemeral_containers" | xargs docker rm -f 2>/dev/null || true
    fi
  else
    echo -e "\033[33m[Purge]\033[0m Docker no está en ejecución o no responde. Omitiendo limpieza de contenedores."
  fi
fi

# 4. Limpieza de fotogramas temporales acumulados en /tmp
echo -e "\033[36m[Purge]\033[0m Limpiando archivos temporales en /tmp..."
rm -f /tmp/snap_*.jpeg 2>/dev/null || true
rm -f /tmp/snap_clear_*.jpeg 2>/dev/null || true

echo -e "\033[32m[Purge]\033[0m ✔ Saneamiento de conexiones completado exitosamente."
exit 0
