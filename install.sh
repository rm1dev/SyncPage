#!/usr/bin/env bash
# =============================================================================
# SyncPage Master installer
# Usage:
#   bash <(curl -Ls https://raw.githubusercontent.com/rm1dev/SyncPage/main/install.sh)
# =============================================================================
set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
blue='\033[0;34m'
plain='\033[0m'

# Repo/branch are fixed — not prompted
SYNCPAGE_GITHUB_REPO="rm1dev/SyncPage"
SYNCPAGE_GITHUB_BRANCH="main"
INSTALL_DIR_DEFAULT="/opt/syncpage"
HTTP_PORT_DEFAULT="1313"
APP_PORT_DEFAULT="3000"
EDGE_PORT_DEFAULT="3000"
ADMIN_TOKEN_DEFAULT="$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)"
DB_PASS_DEFAULT="$(openssl rand -hex 12 2>/dev/null || head -c 16 /dev/urandom | xxd -p -c 16)"
RMQ_PASS_DEFAULT="$(openssl rand -hex 12 2>/dev/null || head -c 16 /dev/urandom | xxd -p -c 16)"

[[ $EUID -ne 0 ]] && echo -e "${red}Fatal: run as root${plain}" && exit 1

prompt() {
  # prompt "Question" "default" → sets REPLY
  local q="$1"
  local d="${2:-}"
  if [[ "${NONINTERACTIVE:-0}" == "1" ]] || [[ ! -t 0 ]]; then
    REPLY="$d"
    echo -e "${blue}${q}${plain}: ${yellow}${REPLY}${plain} (default)"
    return
  fi
  if [[ -n "$d" ]]; then
    read -rp "$(echo -e "${blue}${q}${plain} [${yellow}${d}${plain}]: ")" REPLY || true
    REPLY="${REPLY:-$d}"
  else
    read -rp "$(echo -e "${blue}${q}${plain}: ")" REPLY || true
  fi
}

# Short hint before a prompt
note() {
  echo -e "${yellow}$*${plain}"
}

detect_public_ip() {
  curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || echo "127.0.0.1"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo -e "${green}Docker already installed${plain}"
    return
  fi
  echo -e "${yellow}Installing Docker...${plain}"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker || true
  if ! docker compose version >/dev/null 2>&1; then
    echo -e "${red}docker compose plugin missing${plain}"
    exit 1
  fi
}

echo -e "${green}╔══════════════════════════════════════╗${plain}"
echo -e "${green}║     SyncPage Master Installer        ║${plain}"
echo -e "${green}╚══════════════════════════════════════╝${plain}"
echo -e "Repo: ${SYNCPAGE_GITHUB_REPO} @ ${SYNCPAGE_GITHUB_BRANCH}"
echo ""

PUBLIC_IP="$(detect_public_ip)"
echo -e "Detected server IP: ${yellow}${PUBLIC_IP}${plain}"
echo ""

prompt "Install directory" "$INSTALL_DIR_DEFAULT"
INSTALL_DIR="$REPLY"

echo ""
note "If you use a CDN/SSL domain, enter the hostname only (no https://)."
note "Example: land.sikaap.com"
note "Leave empty to use this server IP instead."
prompt "Public domain (optional)" ""
DOMAIN_RAW="$REPLY"
# Strip protocol and path if pasted
DOMAIN="$(echo "$DOMAIN_RAW" | sed -E 's#^https?://##; s#/.*$##; s/^[[:space:]]+//; s/[[:space:]]+$//' | tr '[:upper:]' '[:lower:]')"

if [[ -n "$DOMAIN" ]]; then
  HTTP_PORT_DEFAULT="80"
  # Public URL is HTTPS when a domain is set (CDN/SSL)
  PUBLIC_BASE_URL="https://${DOMAIN}"
  echo -e "Panel URL will be: ${green}${PUBLIC_BASE_URL}/spadmin${plain}"
else
  HTTP_PORT_DEFAULT="1313"
  PUBLIC_BASE_URL=""  # set after HTTP port is known
  echo -e "No domain — panel will use server IP."
fi

echo ""
note "Host port for nginx (CDN origin is usually port 80)."
prompt "HTTP publish port (nginx)" "$HTTP_PORT_DEFAULT"
HTTP_PORT="$REPLY"

if [[ -z "$DOMAIN" ]]; then
  PUBLIC_BASE_URL="http://${PUBLIC_IP}:${HTTP_PORT}"
  echo -e "Panel URL will be: ${green}${PUBLIC_BASE_URL}/spadmin${plain}"
fi

prompt "App internal port" "$APP_PORT_DEFAULT"
APP_PORT="$REPLY"

prompt "Admin token" "$ADMIN_TOKEN_DEFAULT"
ADMIN_TOKEN="$REPLY"

prompt "Postgres password" "$DB_PASS_DEFAULT"
DB_PASS="$REPLY"

prompt "RabbitMQ password" "$RMQ_PASS_DEFAULT"
RMQ_PASS="$REPLY"

echo ""
note "Internal Master URL for Edge package download — prefer this server IP (not CDN)."
prompt "Master internal URL" "http://${PUBLIC_IP}:${HTTP_PORT}"
MASTER_INTERNAL_URL="$REPLY"

echo ""
note "AMQP URL Edge nodes use for queues — must be Master IP, not the CDN domain."
prompt "RabbitMQ URL for Edge nodes" "amqp://syncpage:${RMQ_PASS}@${PUBLIC_IP}:5672"
RABBITMQ_PUBLIC_URL="$REPLY"

echo ""
note "Also install an Edge node on this same server? (landings on a separate port)"
prompt "Install Edge on this server too? (y/n)" "y"
INSTALL_LOCAL_EDGE="$REPLY"

EDGE_PORT="$EDGE_PORT_DEFAULT"
if [[ "$INSTALL_LOCAL_EDGE" =~ ^[Yy] ]]; then
  prompt "Edge HTTP port (host)" "$EDGE_PORT_DEFAULT"
  EDGE_PORT="$REPLY"
  if [[ "$EDGE_PORT" == "$HTTP_PORT" ]]; then
    echo -e "${red}Edge port must differ from Master HTTP port (${HTTP_PORT})${plain}"
    exit 1
  fi
fi

install_docker

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

REPO_URL="https://github.com/${SYNCPAGE_GITHUB_REPO}.git"
if [[ -d .git ]]; then
  echo -e "${yellow}Updating existing repo...${plain}"
  git fetch --all --tags
  git checkout "$SYNCPAGE_GITHUB_BRANCH" || git checkout -B "$SYNCPAGE_GITHUB_BRANCH" "origin/$SYNCPAGE_GITHUB_BRANCH"
  git pull --ff-only || true
else
  if [[ -n "$(ls -A . 2>/dev/null || true)" ]]; then
    echo -e "${red}Install dir is not empty and not a git repo: $INSTALL_DIR${plain}"
    exit 1
  fi
  echo -e "${yellow}Cloning ${REPO_URL} ...${plain}"
  git clone --branch "$SYNCPAGE_GITHUB_BRANCH" --depth 1 "$REPO_URL" .
fi

# .env for Master
cat > .env <<EOF
NODE_ROLE=MASTER
PORT=${APP_PORT}
NODE_ENV=production

POSTGRES_USER=syncpage
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=syncpage
DATABASE_URL=postgresql://syncpage:${DB_PASS}@db:5432/syncpage?schema=public

RABBITMQ_USER=syncpage
RABBITMQ_PASS=${RMQ_PASS}
RABBITMQ_URL=amqp://syncpage:${RMQ_PASS}@rabbitmq:5672
RABBITMQ_PUBLIC_URL=${RABBITMQ_PUBLIC_URL}
RABBITMQ_QUEUE=landing.sync
RABBITMQ_MASTER_QUEUE=form.submission

ADMIN_TOKEN=${ADMIN_TOKEN}

STATIC_PAGES_PATH=/app/static_pages
TEMP_PATH=/app/temp

MASTER_INTERNAL_URL=${MASTER_INTERNAL_URL}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}

OUTBOX_POLL_MS=3000
OUTBOX_MAX_ATTEMPTS=10

SYNCPAGE_GITHUB_REPO=${SYNCPAGE_GITHUB_REPO}
SYNCPAGE_GITHUB_BRANCH=${SYNCPAGE_GITHUB_BRANCH}

DOMAIN=${DOMAIN}
HTTP_PORT=${HTTP_PORT}
APP_PORT=${APP_PORT}
EOF

echo -e "${yellow}Building and starting Master stack...${plain}"
docker compose -f docker-compose.master.yml --env-file .env up -d --build

wait_master_health() {
  echo -e "${yellow}Waiting for Master health...${plain}"
  local i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/health" >/dev/null 2>&1; then
      echo -e "${green}Master is healthy${plain}"
      return 0
    fi
    sleep 2
  done
  echo -e "${red}Master health check timed out${plain}"
  return 1
}

parse_json_field() {
  local json="$1"
  local key="$2"
  if command -v node >/dev/null 2>&1; then
    node -e "const j=JSON.parse(process.argv[1]); const v=j[process.argv[2]]; if(v===undefined||v===null) process.exit(2); process.stdout.write(String(v))" "$json" "$key"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; j=json.loads(sys.argv[1]); v=j.get(sys.argv[2]);
assert v is not None; print(v, end="")' "$json" "$key"
  else
    echo -e "${red}Need node or python3 to parse API JSON${plain}"
    exit 1
  fi
}

install_colocated_edge() {
  echo ""
  echo -e "${yellow}Installing co-located Edge node on this server...${plain}"
  wait_master_health || return 1

  # Register in Master DB so it appears under Admin → Nodes
  local node_json
  node_json="$(curl -fsS -X POST "http://127.0.0.1:${HTTP_PORT}/api/nodes" \
    -H "Content-Type: application/json" \
    -H "x-admin-token: ${ADMIN_TOKEN}" \
    -d "{\"title\":\"Local Edge (same server)\",\"host\":\"${PUBLIC_IP}\",\"port\":${EDGE_PORT},\"notes\":\"Co-located with Master — installed by install.sh\"}")" || {
    echo -e "${red}Failed to register Edge node in Master panel${plain}"
    return 1
  }

  local bootstrap_url node_id
  bootstrap_url="$(parse_json_field "$node_json" "bootstrapUrl")"
  node_id="$(parse_json_field "$node_json" "id")"

  echo -e "${green}Registered in Admin → Nodes${plain}"
  echo -e "Title:    Local Edge (same server)"
  echo -e "Node id:  ${node_id}"
  echo -e "Address:  ${PUBLIC_IP}:${EDGE_PORT}"
  echo -e "Bootstrap: ${bootstrap_url}"

  # Copy Master sources so Edge matches this install (no GitHub dependency)
  local edge_dir="/opt/syncpage-node"
  mkdir -p "$edge_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.env' \
      --exclude '.git' \
      "${INSTALL_DIR}/" "${edge_dir}/"
  else
    find "$edge_dir" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} + 2>/dev/null || true
    cp -a "${INSTALL_DIR}/." "${edge_dir}/"
    rm -rf "${edge_dir}/.git" "${edge_dir}/.env" 2>/dev/null || true
  fi

  SYNCPAGE_COLOCATED=1 SYNCPAGE_SKIP_CLONE=1 SYNCPAGE_NODE_DIR="$edge_dir" \
    bash "${INSTALL_DIR}/install-node.sh" "$bootstrap_url"

  echo -e "${yellow}Verifying Edge node (status → ONLINE in panel)...${plain}"
  local verify_ok=0
  local v
  for v in 1 2 3 4 5; do
    if curl -fsS -X POST "http://127.0.0.1:${HTTP_PORT}/api/nodes/${node_id}/verify" \
      -H "x-admin-token: ${ADMIN_TOKEN}" >/dev/null 2>&1; then
      verify_ok=1
      break
    fi
    sleep 3
  done
  if [[ "$verify_ok" -eq 1 ]]; then
    echo -e "${green}Edge node verified ONLINE — visible in Admin → Nodes${plain}"
  else
    echo -e "${yellow}Edge is registered in the panel but still PENDING/OFFLINE — open Admin → Nodes and click Verify${plain}"
  fi

  EDGE_NODE_ID="$node_id"
}

EDGE_NODE_ID=""
if [[ "$INSTALL_LOCAL_EDGE" =~ ^[Yy] ]]; then
  install_colocated_edge || echo -e "${yellow}Co-located Edge install skipped/failed — you can add a node from the panel later${plain}"
fi

echo ""
echo -e "${green}════════════════════════════════════════${plain}"
echo -e "${green}SyncPage Master installed successfully${plain}"
echo -e "${green}════════════════════════════════════════${plain}"
echo -e "Panel:       ${PUBLIC_BASE_URL}/spadmin"
echo -e "Admin token: ${ADMIN_TOKEN}"
echo -e "Install dir: ${INSTALL_DIR}"
echo -e "RabbitMQ:    ${RABBITMQ_PUBLIC_URL}"
if [[ -n "$EDGE_NODE_ID" ]]; then
  echo -e "Local Edge:  http://${PUBLIC_IP}:${EDGE_PORT}/api/health  (id: ${EDGE_NODE_ID})"
  echo -e "Edge dir:    /opt/syncpage-node"
fi
echo ""
echo -e "Health: curl -fsS ${PUBLIC_BASE_URL}/api/health"
echo -e "Start:  docker compose -f docker-compose.master.yml --env-file .env up -d"
echo -e "Logs:   docker compose -f docker-compose.master.yml --env-file .env logs -f"
echo -e "Stop:   docker compose -f docker-compose.master.yml --env-file .env down"
echo ""
echo -e "${yellow}Important: do NOT run plain 'docker compose up' here (local dual stack).${plain}"
echo -e "${yellow}Master panel path is always /spadmin (via nginx on host port ${HTTP_PORT}).${plain}"
if [[ ! "$INSTALL_LOCAL_EDGE" =~ ^[Yy] ]]; then
  echo ""
  echo -e "${yellow}Next: open Admin → Nodes → Add node → copy install command${plain}"
fi
