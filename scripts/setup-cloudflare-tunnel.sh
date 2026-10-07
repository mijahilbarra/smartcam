#!/usr/bin/env bash
# ==============================================================================
# Setup Cloudflare Tunnel para IOT Camera Catcher (Live Stream & Telemetría SSE)
# ==============================================================================
# Destino: GCP Compute Engine e2-micro (Debian/Ubuntu amd64)
# Propósito: Exponer de forma segura vía HTTPS el puerto 8085 del daemon local
#            para permitir streaming MJPEG (/api/stream) y telemetría SSE (/api/yolo/stream)
#            en Firebase Hosting sin exponer puertos públicos ni abrir firewalls.
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}  Instalación y Configuración de Cloudflare Tunnel   ${NC}"
echo -e "${BLUE}     IOT Camera Catcher - GCP e2-micro (Puerto 8085) ${NC}"
echo -e "${BLUE}======================================================${NC}"

# 1. Comprobación de privilegios de superusuario
if [ "$EUID" -ne 0 ]; then
  echo -e "${YELLOW}[!] Este script requiere permisos de administrador para instalar paquetes y crear servicios systemd.${NC}"
  echo -e "${YELLOW}    Ejecutando con sudo...${NC}"
  exec sudo "$0" "$@"
fi

# 2. Detección de Arquitectura
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)
    CLOUDFLARED_ARCH="amd64"
    ;;
  aarch64|arm64)
    CLOUDFLARED_ARCH="arm64"
    ;;
  *)
    echo -e "${RED}[ERROR] Arquitectura no soportada: $ARCH${NC}"
    exit 1
    ;;
esac

echo -e "${GREEN}[1/4] Detectada arquitectura:${NC} $ARCH ($CLOUDFLARED_ARCH)"

# 3. Descarga e Instalación de cloudflared
if command -v cloudflared &> /dev/null; then
  echo -e "${GREEN}[2/4] cloudflared ya está instalado:${NC} $(cloudflared --version)"
else
  echo -e "${BLUE}[2/4] Descargando e instalando cloudflared desde GitHub Releases...${NC}"
  DEB_FILE="/tmp/cloudflared-linux-${CLOUDFLARED_ARCH}.deb"
  curl -fsSL -o "$DEB_FILE" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CLOUDFLARED_ARCH}.deb"
  dpkg -i "$DEB_FILE" || apt-get install -f -y
  rm -f "$DEB_FILE"
  echo -e "${GREEN}[✔] cloudflared instalado exitosamente:${NC} $(cloudflared --version)"
fi

# Ruta canónica del binario
CLOUDFLARED_BIN=$(command -v cloudflared || echo "/usr/local/bin/cloudflared")

# 4. Configuración del Servicio Systemd
TUNNEL_TOKEN="${1:-${CLOUDFLARE_TUNNEL_TOKEN:-}}"
SERVICE_PATH="/etc/systemd/system/camera-tunnel.service"

if [ -n "$TUNNEL_TOKEN" ]; then
  echo -e "${BLUE}[3/4] Configurando servicio systemd con token permanente...${NC}"

  cat <<EOF > "$SERVICE_PATH"
[Unit]
Description=Cloudflare Tunnel for Camera Catcher Daemon (Live Stream & Telemetry)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
TimeoutStartSec=0
Restart=always
RestartSec=5s
ExecStart=${CLOUDFLARED_BIN} tunnel run --token ${TUNNEL_TOKEN}

# Políticas de aislamiento seguro
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable camera-tunnel.service
  systemctl restart camera-tunnel.service

  echo -e "${GREEN}[4/4] Servicio camera-tunnel.service habilitado e iniciado exitosamente.${NC}"
  echo -e "Estado del servicio:"
  systemctl status camera-tunnel.service --no-pager || true

  echo -e "\n${GREEN}✔ Configuración completada.${NC}"
  echo -e "Tu túnel Cloudflare está activo y transmitirá el puerto 8085 de la VM 24/7."
  echo -e "Recuerda registrar la URL asignada (ej: https://stream.tudominio.com) en el modal de Ajustes del Web Dashboard."

else
  echo -e "${YELLOW}[3/4] No se proporcionó un token de Cloudflare Tunnel.${NC}"
  echo -e "Se ha creado una plantilla de servicio en ${SERVICE_PATH}.template"

  cat <<EOF > "${SERVICE_PATH}.template"
[Unit]
Description=Cloudflare Tunnel for Camera Catcher Daemon (Live Stream & Telemetry)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
TimeoutStartSec=0
Restart=always
RestartSec=5s
ExecStart=${CLOUDFLARED_BIN} tunnel run --token TU_CLOUDFLARE_TUNNEL_TOKEN_AQUI

NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

  echo -e "\n${BLUE}======================================================${NC}"
  echo -e "${BLUE}  Opciones para ejecutar el túnel:                   ${NC}"
  echo -e "${BLUE}======================================================${NC}"
  echo -e "${GREEN}Opción A: Quick Tunnel (Prueba rápida sin dominio registrado):${NC}"
  echo -e "  Ejecuta directamente en la terminal:"
  echo -e "    ${YELLOW}cloudflared tunnel --url http://localhost:8085${NC}"
  echo -e "  Cloudflare te entregará una URL temporal (ej: https://random-subdomain.trycloudflare.com)."
  echo -e "  Copia esa URL en el panel web (Ajustes -> URL del Túnel del Stream)."
  echo -e ""
  echo -e "${GREEN}Opción B: Túnel Permanente 24/7 (Recomendado para Producción):${NC}"
  echo -e "  1. Crea un túnel en Cloudflare Zero Trust (https://one.dash.cloudflare.com/):"
  echo -e "     Networks -> Tunnels -> Create Tunnel -> Cloudflared"
  echo -e "  2. Apunta el servicio público a: HTTP -> localhost:8085"
  echo -e "  3. Obtén el token e instala el servicio systemd ejecutando:"
  echo -e "     ${YELLOW}sudo ./scripts/setup-cloudflare-tunnel.sh <TU_TOKEN_DE_CLOUDFLARE>${NC}"
  echo -e "  4. El túnel quedará corriendo como servicio systemd permanente ('camera-tunnel.service')."
fi
