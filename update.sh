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
else
  echo -e "${yellow}Stack rebuilt — health not ready yet. Check logs:${plain}"
  echo "  docker compose -f ${INSTALL_DIR}/docker-compose.master.yml logs -f app"
fi
echo -e "Env backup: ${ENV_BAK}"
