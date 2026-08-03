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

EDGE_NETWORK_MODE="$(grep '^EDGE_NETWORK_MODE=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
RMQ_URL_NOW="$(grep '^RABBITMQ_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
COMPOSE_FILE="$(grep '^COMPOSE_FILE=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"

# ریموت (نه هم‌محل): همیشه host-network compose
is_remote=0
if [[ "$EDGE_NETWORK_MODE" == "host" ]]; then
  is_remote=1
elif [[ "$EDGE_NETWORK_MODE" == "bridge" ]]; then
  is_remote=0
elif [[ -n "$RMQ_URL_NOW" && "$RMQ_URL_NOW" != *"host.docker.internal"* ]]; then
  is_remote=1
fi

if [[ "$is_remote" -eq 1 ]]; then
  if [[ ! -f docker-compose.node.remote.yml ]]; then
    echo -e "${red}docker-compose.node.remote.yml missing — pull latest repo${plain}"
    exit 1
  fi
  COMPOSE_FILE="docker-compose.node.remote.yml"
  # .env رو برای host network یکدست کن
  if grep -q '^EDGE_NETWORK_MODE=' .env; then
    sed -i.bak 's/^EDGE_NETWORK_MODE=.*/EDGE_NETWORK_MODE=host/' .env || \
      sed -i '' 's/^EDGE_NETWORK_MODE=.*/EDGE_NETWORK_MODE=host/' .env
  else
    echo "EDGE_NETWORK_MODE=host" >> .env
  fi
  if ! grep -q '^POSTGRES_HOST_PORT=' .env 2>/dev/null; then
    echo "POSTGRES_HOST_PORT=5433" >> .env
  fi
  if grep -q '^COMPOSE_FILE=' .env; then
    sed -i.bak 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.node.remote.yml|' .env || \
      sed -i '' 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.node.remote.yml|' .env
  else
    echo "COMPOSE_FILE=docker-compose.node.remote.yml" >> .env
  fi
  if grep -q '@db:5432/' .env 2>/dev/null; then
    PGPORT="$(grep '^POSTGRES_HOST_PORT=' .env | head -1 | cut -d= -f2- || echo 5433)"
    PGPORT="${PGPORT:-5433}"
    sed -i.bak "s#@db:5432/#@127.0.0.1:${PGPORT}/#" .env || \
      sed -i '' "s#@db:5432/#@127.0.0.1:${PGPORT}/#" .env
    echo -e "${yellow}Switched DATABASE_URL to 127.0.0.1:${PGPORT} for host network${plain}"
  fi
  echo -e "${yellow}Using remote host-network compose${plain}"
else
  COMPOSE_FILE="docker-compose.node.yml"
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo -e "${red}${COMPOSE_FILE} missing${plain}"
    exit 1
  fi
fi

# --- تعمیر RABBITMQ_URL: پورت 5672↔45672 رو از این Edge تست کن ---
tcp_port_open() {
  local host="$1" port="$2" timeout_s="${3:-4}"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w "$timeout_s" "$host" "$port" >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_s" bash -c "echo >/dev/tcp/${host}/${port}" >/dev/null 2>&1 && return 0
    return 1
  fi
  (echo >/dev/tcp/"${host}"/"${port}") >/dev/null 2>&1 && return 0
  return 1
}

amqp_host() { echo "$1" | sed -E 's#^[a-zA-Z]+://([^@/]+@)?([^:/]+).*#\2#'; }
amqp_port() {
  local p; p="$(echo "$1" | sed -nE 's#^[a-zA-Z]+://([^@/]+@)?[^:/]+:([0-9]+).*#\2#p')"
  echo "${p:-5672}"
}
amqp_with_port() {
  local url="$1" new_port="$2"
  if echo "$url" | grep -qE ':[0-9]+(/|$)'; then
    echo "$url" | sed -E "s#:[0-9]+(/|$)#:${new_port}\\1#"
  else
    echo "$url" | sed -E "s#(://[^/]+)#\\1:${new_port}#"
  fi
}

if [[ "$is_remote" -eq 1 && -n "$RMQ_URL_NOW" && "$RMQ_URL_NOW" != *"host.docker.internal"* ]]; then
  RMQ_HOST="$(amqp_host "$RMQ_URL_NOW")"
  RMQ_PORT="$(amqp_port "$RMQ_URL_NOW")"
  if [[ "$RMQ_PORT" == "5672" ]]; then RMQ_ALT="45672"; else RMQ_ALT="5672"; fi
  echo -e "${yellow}Probing AMQP ${RMQ_HOST}:${RMQ_PORT} ...${plain}"
  if tcp_port_open "$RMQ_HOST" "$RMQ_PORT" 4; then
    echo -e "${green}AMQP reachable at :${RMQ_PORT}${plain}"
  elif tcp_port_open "$RMQ_HOST" "$RMQ_ALT" 4; then
    NEW_RMQ="$(amqp_with_port "$RMQ_URL_NOW" "$RMQ_ALT")"
    sed -i.bak "s|^RABBITMQ_URL=.*|RABBITMQ_URL=${NEW_RMQ}|" .env || \
      sed -i '' "s|^RABBITMQ_URL=.*|RABBITMQ_URL=${NEW_RMQ}|" .env
    echo -e "${green}Switched RABBITMQ_URL to :${RMQ_ALT}${plain}"
    RMQ_URL_NOW="$NEW_RMQ"
  else
    echo -e "${yellow}Neither :${RMQ_PORT} nor :${RMQ_ALT} reachable — open Master firewall/SG${plain}"
    # ترجیح پروژه: 45672
    if [[ "$RMQ_PORT" == "5672" ]]; then
      NEW_RMQ="$(amqp_with_port "$RMQ_URL_NOW" "45672")"
      sed -i.bak "s|^RABBITMQ_URL=.*|RABBITMQ_URL=${NEW_RMQ}|" .env || \
        sed -i '' "s|^RABBITMQ_URL=.*|RABBITMQ_URL=${NEW_RMQ}|" .env
      echo -e "${yellow}Prefwrote RABBITMQ_URL to :45672 for when firewall opens${plain}"
    fi
  fi
fi

# HTTP pull همیشه روشن باشه روی Edge ریموت
if ! grep -q '^SYNC_PULL_ENABLED=' .env 2>/dev/null; then
  echo "SYNC_PULL_ENABLED=1" >> .env
  echo "SYNC_PULL_MS=20000" >> .env
elif grep -q '^SYNC_PULL_ENABLED=0' .env 2>/dev/null; then
  : # کاربر عمداً خاموش کرده
fi

# استک قدیمی (مدل قبلی) رو ببند تا با remote تداخل نکنه
for f in docker-compose.node.yml docker-compose.node.host.yml docker-compose.node.remote.yml; do
  [[ -f "$f" ]] || continue
  [[ "$f" == "$COMPOSE_FILE" ]] && continue
  docker compose -f "$f" --env-file .env down --remove-orphans 2>/dev/null || true
done

echo -e "${yellow}Rebuilding Edge stack (${COMPOSE_FILE})...${plain}"
docker compose -f "$COMPOSE_FILE" --env-file .env up -d --build --force-recreate

echo -e "${yellow}Waiting for health...${plain}"
OK=0
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 2
done

AMQP_OK=0
if [[ "$OK" -eq 1 ]]; then
  # یک peek فوری — ۳۰ثانیه منتظر AMQP نمی‌مونیم
  LOGS="$(docker compose -f "$COMPOSE_FILE" --env-file .env logs --tail=60 app 2>/dev/null || true)"
  if echo "$LOGS" | grep -qE 'Microservices listening|Outbox connected to RabbitMQ|HTTP sync pull enabled'; then
    AMQP_OK=1
    if echo "$LOGS" | grep -qE 'HTTP sync pull enabled'; then
      echo -e "${green}HTTP sync pull enabled${plain}"
    else
      echo -e "${green}AMQP connected${plain}"
    fi
  elif echo "$LOGS" | grep -qE 'connect ETIMEDOUT'; then
    echo -e "${yellow}AMQP ETIMEDOUT — HTTP pull will sync landings${plain}"
  fi
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  if echo "$HEALTH_JSON" | grep -qE '"rabbitmq"[^}]*"ok"[[:space:]]*:[[:space:]]*true'; then
    AMQP_OK=1
    echo -e "${green}Health rabbitmq.ok=true${plain}"
  fi
fi

echo ""
if [[ "$OK" -eq 1 ]]; then
  VER="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  echo -e "${green}Edge node updated successfully${plain}"
  [[ -n "$VER" ]] && echo -e "Version: ${green}${VER}${plain}"
  echo -e "RABBITMQ_URL: $(grep '^RABBITMQ_URL=' .env | head -1 | cut -d= -f2-)"
  if [[ "$AMQP_OK" -ne 1 ]]; then
    echo -e "${yellow}Note: AMQP may still be down; landings sync via HTTP pull${plain}"
  fi
else
  echo -e "${yellow}Stack rebuilt — health not ready yet. Check logs:${plain}"
  echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} --env-file ${INSTALL_DIR}/.env logs -f app"
fi
echo -e "Compose: ${COMPOSE_FILE}"
echo -e "Env backup: ${ENV_BAK}"
echo -e "${green}Back on Master panel → click تایید اتصال${plain}"
exit 0