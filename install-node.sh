#!/usr/bin/env bash
# =============================================================================
# SyncPage Edge Node installer — NON-INTERACTIVE
# Usage (from Admin panel):
#   bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/install-node.sh) \
#     https://MASTER/api/nodes/bootstrap/TOKEN
# =============================================================================
set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

[[ $EUID -ne 0 ]] && echo -e "${red}Fatal: run as root${plain}" && exit 1

BOOTSTRAP_URL="${1:-}"
if [[ -z "$BOOTSTRAP_URL" ]]; then
  echo -e "${red}Usage: $0 <bootstrap-url>${plain}"
  echo "Example: bash <(curl -Ls .../install-node.sh) https://master/api/nodes/bootstrap/TOKEN"
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo -e "${red}Missing command: $1${plain}"
    exit 1
  }
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi
  echo -e "${yellow}Installing Docker...${plain}"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker || true
}

echo -e "${green}SyncPage Edge Node installer (silent)${plain}"
echo -e "Bootstrap: ${BOOTSTRAP_URL}"

need_cmd curl
CONFIG_JSON="$(curl -fsSL --max-time 30 "$BOOTSTRAP_URL")" || {
  echo -e "${red}Failed to fetch bootstrap config${plain}"
  exit 1
}

# پارس JSON با node یا python — بدون jq اجباری
parse_json() {
  local key="$1"
  if command -v node >/dev/null 2>&1; then
    node -e "const j=JSON.parse(process.argv[1]); const v=j[process.argv[2]]; if(v===undefined||v===null) process.exit(2); process.stdout.write(String(v))" "$CONFIG_JSON" "$key"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; j=json.loads(sys.argv[1]); v=j.get(sys.argv[2]); 
assert v is not None; print(v, end="")' "$CONFIG_JSON" "$key"
  else
    echo -e "${red}Need node or python3 to parse bootstrap JSON${plain}"
    exit 1
  fi
}

NODE_ID="$(parse_json nodeId)"
TITLE="$(parse_json title)"
HOST="$(parse_json host)"
PORT="$(parse_json port)"
QUEUE="$(parse_json queueName)"
RMQ_URL="$(parse_json rabbitmqUrl)"
MASTER_URL="$(parse_json masterInternalUrl)"
PUBLIC_URL="$(parse_json publicBaseUrl)"
GITHUB_REPO="$(parse_json githubRepo)"
GITHUB_BRANCH="$(parse_json githubBranch)"
DB_NAME="$(parse_json databaseName)"
DB_USER="$(parse_json databaseUser)"
DB_PASS="$(parse_json databasePassword)"

# نصب هم‌محل با Master: AMQP و دانلود پکیج از gateway هاست
if [[ "${SYNCPAGE_COLOCATED:-0}" == "1" ]]; then
  RMQ_URL="$(echo "$RMQ_URL" | sed -E 's#@[^/:]+:#@host.docker.internal:#')"
  MASTER_URL="$(echo "$MASTER_URL" | sed -E 's#://[^/:]+#://host.docker.internal#')"
  echo -e "${yellow}Co-located mode: RabbitMQ/Master via host.docker.internal${plain}"
fi

INSTALL_DIR="${SYNCPAGE_NODE_DIR:-/opt/syncpage-node}"
REPO_URL="https://github.com/${GITHUB_REPO}.git"

echo -e "Node: ${TITLE} (${NODE_ID})"
echo -e "Bind port: ${PORT}"

install_docker
need_cmd git

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [[ "${SYNCPAGE_SKIP_CLONE:-0}" == "1" ]]; then
  # نصب هم‌محل: کد از قبل کپی شده (هم‌نسخه با Master)
  if [[ ! -f docker-compose.node.yml ]]; then
    echo -e "${red}SYNCPAGE_SKIP_CLONE=1 but docker-compose.node.yml missing in ${INSTALL_DIR}${plain}"
    exit 1
  fi
  echo -e "${yellow}Using pre-seeded sources in ${INSTALL_DIR}${plain}"
elif [[ -d .git ]]; then
  git fetch --all --tags
  git checkout "$GITHUB_BRANCH" || git checkout -B "$GITHUB_BRANCH" "origin/$GITHUB_BRANCH"
  git pull --ff-only || true
else
  if [[ -n "$(ls -A . 2>/dev/null || true)" ]]; then
    # پوشه پره ولی git نیست — پاک می‌کنیم چون silent نصبه
    rm -rf "${INSTALL_DIR:?}"/*
    rm -rf "${INSTALL_DIR}/".[!.]* 2>/dev/null || true
  fi
  git clone --branch "$GITHUB_BRANCH" --depth 1 "$REPO_URL" .
fi

cat > .env <<EOF
NODE_ROLE=EDGE
PORT=${PORT}
NODE_ENV=production
EDGE_NODE_ID=${NODE_ID}

POSTGRES_USER=${DB_USER}
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=${DB_NAME}
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@db:5432/${DB_NAME}?schema=public

RABBITMQ_URL=${RMQ_URL}
RABBITMQ_QUEUE=${QUEUE}
RABBITMQ_MASTER_QUEUE=form.submission

ADMIN_TOKEN=unused-on-edge

STATIC_PAGES_PATH=/app/static_pages
TEMP_PATH=/app/temp

MASTER_INTERNAL_URL=${MASTER_URL}
PUBLIC_BASE_URL=${PUBLIC_URL}

OUTBOX_POLL_MS=3000
OUTBOX_MAX_ATTEMPTS=10

APP_PORT=${PORT}
HTTP_PORT=${PORT}
EOF

echo -e "${yellow}Building and starting Edge node...${plain}"
docker compose -f docker-compose.node.yml --env-file .env up -d --build

# صبر کوتاه برای healthy شدن
sleep 5
HEALTH_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 3
done

echo ""
if [[ "$HEALTH_OK" -eq 1 ]]; then
  echo -e "${green}Edge node installed and healthy${plain}"
else
  echo -e "${yellow}Edge node started — health not ready yet (check logs)${plain}"
fi
echo -e "Title:  ${TITLE}"
echo -e "NodeId: ${NODE_ID}"
echo -e "Host:   ${HOST}:${PORT}"
echo -e "Queue:  ${QUEUE}"
echo -e "Dir:    ${INSTALL_DIR}"
echo -e "Health: curl -fsS http://127.0.0.1:${PORT}/api/health"
echo -e "Logs:   docker compose -f ${INSTALL_DIR}/docker-compose.node.yml logs -f"
echo ""
echo -e "${green}Back on Master panel → click Verify for this node${plain}"
