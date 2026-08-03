#!/usr/bin/env bash
# =============================================================================
# SyncPage Master updater — .env حفظ می‌شه، کد از GitHub تازه می‌شه، ری‌بیلد
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/update.sh)
#   bash <(curl -Ls .../update.sh) /opt/syncpage
# =============================================================================
set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

[[ $EUID -ne 0 ]] && echo -e "${red}Fatal: run as root${plain}" && exit 1

INSTALL_DIR="${1:-/opt/syncpage}"
REPO="${SYNCPAGE_GITHUB_REPO:-rm1dev/SyncPage}"
BRANCH="${SYNCPAGE_GITHUB_BRANCH:-main}"
REPO_URL="https://github.com/${REPO}.git"

echo -e "${green}╔══════════════════════════════════════╗${plain}"
echo -e "${green}║     SyncPage Master Updater          ║${plain}"
echo -e "${green}╚══════════════════════════════════════╝${plain}"
echo -e "Dir: ${INSTALL_DIR}"
echo -e "Repo: ${REPO} @ ${BRANCH}"
echo ""

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo -e "${red}Install dir missing: ${INSTALL_DIR}${plain}"
  echo "First install with install.sh"
  exit 1
fi

cd "$INSTALL_DIR"

if [[ ! -f .env ]]; then
  echo -e "${red}.env not found in ${INSTALL_DIR}${plain}"
  exit 1
fi

if [[ ! -f docker-compose.master.yml ]] && [[ ! -d .git ]]; then
  echo -e "${red}Does not look like a SyncPage Master install${plain}"
  exit 1
fi

# بکاپ .env قبل از هر دستکاری
ENV_BAK="/tmp/syncpage-master.env.$(date +%s).bak"
cp -a .env "$ENV_BAK"
echo -e "${yellow}Backed up .env → ${ENV_BAK}${plain}"

# از .env مقادیر گیت رو بخون اگه هست
if grep -q '^SYNCPAGE_GITHUB_REPO=' .env 2>/dev/null; then
  REPO="$(grep '^SYNCPAGE_GITHUB_REPO=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  REPO_URL="https://github.com/${REPO}.git"
fi
if grep -q '^SYNCPAGE_GITHUB_BRANCH=' .env 2>/dev/null; then
  BRANCH="$(grep '^SYNCPAGE_GITHUB_BRANCH=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo -e "${red}Docker / compose required${plain}"
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo -e "${red}git required${plain}"
  exit 1
fi

echo -e "${yellow}Updating source from GitHub...${plain}"
if [[ -d .git ]]; then
  git fetch --all --tags
  git checkout "$BRANCH" || git checkout -B "$BRANCH" "origin/$BRANCH"
  git pull --ff-only || git reset --hard "origin/$BRANCH"
else
  TMP="$(mktemp -d)"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TMP"
  # کد رو عوض می‌کنیم ولی .env و دیتا رو دست نمی‌زنیم
  rsync -a --delete \
    --exclude '.env' \
    --exclude '.git' \
    "${TMP}/" "${INSTALL_DIR}/"
  rm -rf "$TMP"
fi

# اگه اتفاقی .env پرید، از بکاپ برگردون
if [[ ! -f .env ]]; then
  cp -a "$ENV_BAK" .env
  echo -e "${yellow}Restored .env from backup${plain}"
fi

# --- تعمیر AMQP عمومی برای Edgeها (نصب‌های قدیمی بدون RABBITMQ_PUBLIC_URL یا با :5672) ---
env_get() {
  grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true
}

env_set() {
  local key="$1" val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env || sed -i '' "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

detect_public_ip() {
  curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || echo ""
}

RMQ_PASS="$(env_get RABBITMQ_PASS)"
RMQ_PASS="${RMQ_PASS:-syncpage}"
RMQ_USER="$(env_get RABBITMQ_USER)"
RMQ_USER="${RMQ_USER:-syncpage}"
PUBLIC_PORT="$(env_get RABBITMQ_PUBLIC_PORT)"
PUBLIC_PORT="${PUBLIC_PORT:-45672}"
env_set RABBITMQ_PUBLIC_PORT "$PUBLIC_PORT"

PUBLIC_URL_NOW="$(env_get RABBITMQ_PUBLIC_URL)"
PUBLIC_BASE="$(env_get PUBLIC_BASE_URL)"
MASTER_IP=""
if [[ -n "$PUBLIC_BASE" ]]; then
  MASTER_IP="$(echo "$PUBLIC_BASE" | sed -E 's#^https?://##; s#/.*##; s#:.*##')"
fi
if [[ -z "$MASTER_IP" || "$MASTER_IP" == "localhost" || "$MASTER_IP" == "127.0.0.1" ]]; then
  MASTER_IP="$(detect_public_ip)"
fi

need_fix_public=0
if [[ -z "$PUBLIC_URL_NOW" ]]; then
  need_fix_public=1
  echo -e "${yellow}RABBITMQ_PUBLIC_URL missing — will set for Edge bootstrap${plain}"
elif echo "$PUBLIC_URL_NOW" | grep -qE '@(localhost|127\.0\.0\.1|rabbitmq)(:|/)'; then
  need_fix_public=1
  echo -e "${yellow}RABBITMQ_PUBLIC_URL is internal/localhost — rewriting for Edge${plain}"
elif echo "$PUBLIC_URL_NOW" | grep -qE ':5672(/|$)'; then
  # نصب‌های قدیمی اغلب :5672 دارن؛ به پورت جایگزین سوییچ کن
  need_fix_public=1
  echo -e "${yellow}RABBITMQ_PUBLIC_URL uses :5672 — switching to :${PUBLIC_PORT}${plain}"
fi

if [[ "$need_fix_public" -eq 1 ]]; then
  if [[ -z "$MASTER_IP" ]]; then
    echo -e "${yellow}Could not detect Master public IP — set RABBITMQ_PUBLIC_URL manually${plain}"
  else
    NEW_PUBLIC="amqp://${RMQ_USER}:${RMQ_PASS}@${MASTER_IP}:${PUBLIC_PORT}"
    env_set RABBITMQ_PUBLIC_URL "$NEW_PUBLIC"
    echo -e "${green}RABBITMQ_PUBLIC_URL=${NEW_PUBLIC}${plain}"
  fi
fi

# فایروال AMQP (اگه فعال باشه)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active'; then
  ufw allow "${PUBLIC_PORT}/tcp" comment 'SyncPage RabbitMQ public' || true
  ufw allow 5672/tcp comment 'SyncPage RabbitMQ' || true
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
  firewall-cmd --permanent --add-port="${PUBLIC_PORT}/tcp" || true
  firewall-cmd --permanent --add-port=5672/tcp || true
  firewall-cmd --reload || true
fi

echo -e "${yellow}Rebuilding Master stack...${plain}"
docker compose -f docker-compose.master.yml --env-file .env up -d --build

HTTP_PORT="$(grep '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
HTTP_PORT="${HTTP_PORT:-1313}"

echo -e "${yellow}Waiting for health...${plain}"
OK=0
for i in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 2
done

echo ""
if [[ "$OK" -eq 1 ]]; then
  VER="$(curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  echo -e "${green}Master updated successfully${plain}"
  [[ -n "$VER" ]] && echo -e "Version: ${green}${VER}${plain}"
  FINAL_PUBLIC="$(env_get RABBITMQ_PUBLIC_URL)"
  [[ -n "$FINAL_PUBLIC" ]] && echo -e "Edge AMQP: ${FINAL_PUBLIC}"
  echo -e "${yellow}Cloud SG: allow TCP ${PUBLIC_PORT} (and 5672) from Edge IPs${plain}"
else
  echo -e "${yellow}Stack rebuilt — health not ready yet. Check logs:${plain}"
  echo "  docker compose -f ${INSTALL_DIR}/docker-compose.master.yml logs -f app"
fi
echo -e "Env backup: ${ENV_BAK}"
