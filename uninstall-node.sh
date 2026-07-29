#!/usr/bin/env bash
# =============================================================================
# SyncPage Edge Node — حذف کامل از سرور (کانتینر + volume + پوشه)
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/uninstall-node.sh)
#   bash <(curl -Ls .../uninstall-node.sh) /opt/syncpage-node
# =============================================================================
set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

[[ $EUID -ne 0 ]] && echo -e "${red}Fatal: run as root${plain}" && exit 1

INSTALL_DIR="${1:-/opt/syncpage-node}"

echo -e "${green}SyncPage Edge Node uninstaller${plain}"
echo -e "Dir: ${INSTALL_DIR}"
echo ""

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo -e "${yellow}Install dir already missing: ${INSTALL_DIR}${plain}"
  echo -e "${green}Nothing to do on this server${plain}"
  exit 0
fi

cd "$INSTALL_DIR"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo -e "${yellow}Docker/compose not found — removing directory only${plain}"
else
  echo -e "${yellow}Stopping Edge containers and removing volumes...${plain}"
  # هر سه مدل compose رو می‌بندیم (bridge / host override / remote)
  for f in docker-compose.node.remote.yml docker-compose.node.host.yml docker-compose.node.yml docker-compose.master.yml; do
    [[ -f "$f" ]] || continue
    if [[ -f .env ]]; then
      docker compose -f "$f" --env-file .env down -v --remove-orphans 2>/dev/null || true
    else
      docker compose -f "$f" down -v --remove-orphans 2>/dev/null || true
    fi
  done

  # اگه اسم پروژه جور دیگری بود، کانتینرهای باقی‌مونده رو هم جمع کن
  for c in $(docker ps -aq --filter "name=syncpage-node" 2>/dev/null || true); do
    docker rm -f "$c" 2>/dev/null || true
  done
  for v in $(docker volume ls -q --filter "name=syncpage-node" 2>/dev/null || true); do
    docker volume rm "$v" 2>/dev/null || true
  done
fi

cd /
echo -e "${yellow}Removing ${INSTALL_DIR}...${plain}"
rm -rf "${INSTALL_DIR}"

echo ""
echo -e "${green}Edge node fully removed from this server${plain}"
echo -e "از پنل Master هم نود را Delete کنید تا صف و رکورد دیتابیس پاک شود."
