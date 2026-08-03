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

# آی‌پی تشخیص‌داده‌شده رو تایید می‌گیره؛ اگه نه، دستی وارد می‌کنه
confirm_or_enter_ip() {
  local detected="$1"
  if [[ "${NONINTERACTIVE:-0}" == "1" ]] || [[ ! -t 0 ]]; then
    PUBLIC_IP="${PUBLIC_IP:-$detected}"
    echo -e "Server IP: ${yellow}${PUBLIC_IP}${plain} (non-interactive)"
    return
  fi

  echo -e "Detected server IP: ${yellow}${detected}${plain}"
  prompt "Is this IP correct? (y/n)" "y"
  if [[ "$REPLY" =~ ^[Yy] ]]; then
    PUBLIC_IP="$detected"
  else
    note "Enter the public IP that Edge/CDN should reach (not a private LAN IP unless intentional)."
    prompt "Server public IP" "$detected"
    PUBLIC_IP="$REPLY"
  fi

  if [[ -z "$PUBLIC_IP" ]]; then
    echo -e "${red}Server IP is required${plain}"
    exit 1
  fi
  echo -e "Using server IP: ${green}${PUBLIC_IP}${plain}"
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

# پورت‌های AMQP رو برای Edge باز کن (اگه فایروال فعال باشه)
open_amqp_firewall() {
  local alt_port="${1:-45672}"
  echo -e "${yellow}Opening AMQP firewall ports ${alt_port}/tcp and 5672/tcp (if firewall active)...${plain}"
  if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -qi 'Status: active'; then
      ufw allow "${alt_port}/tcp" comment 'SyncPage RabbitMQ public' || true
      ufw allow 5672/tcp comment 'SyncPage RabbitMQ' || true
      echo -e "${green}ufw: allowed ${alt_port}/tcp and 5672/tcp${plain}"
      return
    fi
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-port="${alt_port}/tcp" || true
    firewall-cmd --permanent --add-port=5672/tcp || true
    firewall-cmd --reload || true
    echo -e "${green}firewalld: allowed ${alt_port}/tcp and 5672/tcp${plain}"
    return
  fi
  echo -e "${yellow}No active ufw/firewalld — ensure cloud security group allows ${alt_port}/tcp (and 5672) from Edge IPs${plain}"
}

echo -e "${green}╔══════════════════════════════════════╗${plain}"
echo -e "${green}║     SyncPage Master Installer        ║${plain}"
echo -e "${green}╚══════════════════════════════════════╝${plain}"
echo -e "Repo: ${SYNCPAGE_GITHUB_REPO} @ ${SYNCPAGE_GITHUB_BRANCH}"
echo ""

confirm_or_enter_ip "$(detect_public_ip)"
echo ""

prompt "Install directory" "$INSTALL_DIR_DEFAULT"
INSTALL_DIR="$REPLY"

echo ""
note "Optional landing/CDN hostname only (no https://). Example: landing.your-domain.com"
note "Admin panel stays on this server IP + dashboard port — do NOT put /spadmin behind the landing LB."
prompt "Public domain (optional)" ""
DOMAIN_RAW="$REPLY"
# Strip protocol and path if pasted
DOMAIN="$(echo "$DOMAIN_RAW" | sed -E 's#^https?://##; s#/.*$##; s/^[[:space:]]+//; s/[[:space:]]+$//' | tr '[:upper:]' '[:lower:]')"

echo ""
note "Host port for the Master dashboard and API (Nest app, no nginx)."
prompt "Dashboard HTTP port" "$HTTP_PORT_DEFAULT"
HTTP_PORT="$REPLY"

# پنل همیشه مستقیم روی همین سرور — نه دامنهٔ لندینگ پشت LB
PUBLIC_BASE_URL="http://${PUBLIC_IP}:${HTTP_PORT}"
echo -e "Panel URL will be: ${green}${PUBLIC_BASE_URL}/spadmin${plain}"

prompt "App container port" "$APP_PORT_DEFAULT"
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

# پورت عمومی AMQP — پیش‌فرض 45672 (نه 5672؛ خیلی از مسیرهای بین‌الملل 5672 را می‌بندند)
RABBITMQ_PUBLIC_PORT="${RABBITMQ_PUBLIC_PORT:-45672}"
# URL عمومی برای Edgeها رو خودمون می‌سازیم؛ دیگه به کاربر وابسته نیستیم
RABBITMQ_PUBLIC_URL="amqp://syncpage:${RMQ_PASS}@${PUBLIC_IP}:${RABBITMQ_PUBLIC_PORT}"
echo ""
note "Edge AMQP URL (auto): ${RABBITMQ_PUBLIC_URL}"
note "Ports ${RABBITMQ_PUBLIC_PORT} and 5672 will be published; Edge prefers :${RABBITMQ_PUBLIC_PORT}."

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
open_amqp_firewall "$RABBITMQ_PUBLIC_PORT"

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
RABBITMQ_PUBLIC_PORT=${RABBITMQ_PUBLIC_PORT}
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
echo -e "AMQP ports:  ${RABBITMQ_PUBLIC_PORT} (preferred) + 5672"
if [[ -n "$EDGE_NODE_ID" ]]; then
  echo -e "Local Edge:  http://${PUBLIC_IP}:${EDGE_PORT}/api/health  (id: ${EDGE_NODE_ID})"
  echo -e "Edge dir:    /opt/syncpage-node"
fi
echo ""
echo -e "Health: curl -fsS ${PUBLIC_BASE_URL}/api/health"
echo -e "Start:  make master-up      (or: docker compose -f docker-compose.master.yml --env-file .env up -d)"
echo -e "Logs:   make master-logs"
echo -e "Stop:   make master-down"
echo -e "Help:   make help"
echo ""
echo -e "${yellow}Important: do NOT run plain 'docker compose up' here (local dual stack).${plain}"
echo -e "${yellow}Master panel: ${PUBLIC_BASE_URL}/spadmin  (host port ${HTTP_PORT} → app)${plain}"
echo -e "${yellow}Cloud SG / firewall: allow TCP ${RABBITMQ_PUBLIC_PORT} (and 5672) from Edge IPs to this Master.${plain}"
if [[ ! "$INSTALL_LOCAL_EDGE" =~ ^[Yy] ]]; then
  echo ""
  echo -e "${yellow}Next: open Admin → Nodes → Add node → copy install command${plain}"
fi
