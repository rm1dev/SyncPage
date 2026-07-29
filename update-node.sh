#!/usr/bin/env bash
# =============================================================================
# SyncPage Edge Node updater — .env حفظ می‌شه، کد از GitHub تازه می‌شه، ری‌بیلد
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/update-node.sh)
#   bash <(curl -Ls .../update-node.sh) /opt/syncpage-node
# =============================================================================
set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

[[ $EUID -ne 0 ]] && echo -e "${red}Fatal: run as root${plain}" && exit 1

INSTALL_DIR="${1:-/opt/syncpage-node}"
REPO="${SYNCPAGE_GITHUB_REPO:-rm1dev/SyncPage}"
BRANCH="${SYNCPAGE_GITHUB_BRANCH:-main}"
REPO_URL="https://github.com/${REPO}.git"

echo -e "${green}SyncPage Edge Node updater${plain}"
echo -e "Dir: ${INSTALL_DIR}"
echo ""

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo -e "${red}Install dir missing: ${INSTALL_DIR}${plain}"
  echo "Install the node first from Master panel command"
  exit 1
fi

cd "$INSTALL_DIR"

if [[ ! -f .env ]]; then
  echo -e "${red}.env not found in ${INSTALL_DIR}${plain}"
  exit 1
fi

if [[ ! -f docker-compose.node.yml ]]; then
  echo -e "${red}docker-compose.node.yml missing — wrong directory?${plain}"
  exit 1
fi

ENV_BAK="/tmp/syncpage-node.env.$(date +%s).bak"
cp -a .env "$ENV_BAK"
echo -e "${yellow}Backed up .env → ${ENV_BAK}${plain}"

# از .env یا bootstrap قبلی، ریپو/برنچ
if grep -q '^SYNCPAGE_GITHUB_REPO=' .env 2>/dev/null; then
  REPO="$(grep '^SYNCPAGE_GITHUB_REPO=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  REPO_URL="https://github.com/${REPO}.git"
fi
if grep -q '^SYNCPAGE_GITHUB_BRANCH=' .env 2>/dev/null; then
  BRANCH="$(grep '^SYNCPAGE_GITHUB_BRANCH=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi

# اگه توی .env نیست از مقادیر پیش‌فرض install-node استفاده می‌کنیم
# (نسخه‌های قدیمی ممکنه این کلیدها رو نداشته باشن)

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo -e "${red}Docker / compose required${plain}"
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo -e "${red}git required${plain}"
  exit 1
fi

echo -e "${yellow}Updating source from GitHub (${REPO}@${BRANCH})...${plain}"
if [[ -d .git ]]; then
  git fetch --all --tags
  git checkout "$BRANCH" || git checkout -B "$BRANCH" "origin/$BRANCH"
  git pull --ff-only || git reset --hard "origin/$BRANCH"
else
  TMP="$(mktemp -d)"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TMP"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.env' \
      --exclude '.git' \
      "${TMP}/" "${INSTALL_DIR}/"
  else
    # بدون rsync: فایل‌های کد رو جایگزین کن
    find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
    cp -a "${TMP}/." "${INSTALL_DIR}/"
    rm -rf "${INSTALL_DIR}/.git"
  fi
  rm -rf "$TMP"
fi

if [[ ! -f .env ]]; then
  cp -a "$ENV_BAK" .env
  echo -e "${yellow}Restored .env from backup${plain}"
fi

PORT="$(grep '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
PORT="${PORT:-$(grep '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)}"
PORT="${PORT:-3000}"

# اگه از قبل host mode ست شده، یا نود ریموت هست (host.docker.internal توی URL نیست)
EDGE_NETWORK_MODE="$(grep '^EDGE_NETWORK_MODE=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
RMQ_URL_NOW="$(grep '^RABBITMQ_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
COMPOSE_FILES=(-f docker-compose.node.yml)
if [[ "$EDGE_NETWORK_MODE" == "host" ]] || [[ "$RMQ_URL_NOW" != *"host.docker.internal"* ]]; then
  if [[ ! -f docker-compose.node.host.yml ]]; then
    echo -e "${red}docker-compose.node.host.yml missing — pull latest repo${plain}"
    exit 1
  fi
  COMPOSE_FILES+=(-f docker-compose.node.host.yml)
  # .env رو برای host network تنظیم کن (بدون عوض کردن پسوردها)
  if ! grep -q '^EDGE_NETWORK_MODE=host' .env 2>/dev/null; then
    echo "EDGE_NETWORK_MODE=host" >> .env
  fi
  if ! grep -q '^POSTGRES_HOST_PORT=' .env 2>/dev/null; then
    echo "POSTGRES_HOST_PORT=5433" >> .env
  fi
  # DATABASE_URL رو به 127.0.0.1:5433 ببر اگه هنوز @db:5432 هست
  if grep -q '@db:5432/' .env 2>/dev/null; then
    sed -i.bak 's#@db:5432/#@127.0.0.1:5433/#' .env || \
      sed -i '' 's#@db:5432/#@127.0.0.1:5433/#' .env
    echo -e "${yellow}Switched DATABASE_URL to 127.0.0.1:5433 for host network${plain}"
  fi
  echo -e "${yellow}Using host network compose override${plain}"
fi

echo -e "${yellow}Rebuilding Edge stack...${plain}"
docker compose "${COMPOSE_FILES[@]}" --env-file .env up -d --build

echo -e "${yellow}Waiting for health...${plain}"
OK=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 2
done

echo ""
if [[ "$OK" -eq 1 ]]; then
  VER="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  echo -e "${green}Edge node updated successfully${plain}"
  [[ -n "$VER" ]] && echo -e "Version: ${green}${VER}${plain}"
else
  echo -e "${yellow}Stack rebuilt — health not ready yet. Check logs:${plain}"
  echo "  docker compose -f ${INSTALL_DIR}/docker-compose.node.yml logs -f app"
fi
echo -e "Env backup: ${ENV_BAK}"
echo -e "${green}Back on Master panel → click تایید اتصال${plain}"
