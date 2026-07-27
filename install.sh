#!/usr/bin/env bash
# =============================================================================
# SyncPage Master installer
# Usage (recommended — works with sudo):
#   curl -fsSL https://raw.githubusercontent.com/rm1dev/SyncPage/main/install.sh | sudo bash -s --
#   curl -fsSL .../install.sh | sudo bash -s -- main   # optional tag/branch
# Interactive (prompts on a TTY):
#   curl -fsSL .../install.sh -o /tmp/syncpage-install.sh
#   sudo bash /tmp/syncpage-install.sh
# =============================================================================
set -euo pipefail

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
blue='\033[0;34m'
plain='\033[0m'

# اول root رو چک کن — قبل از هر چیزی که ممکنه با set -e بی‌صدا بترکه
if [[ ${EUID} -ne 0 ]]; then
  echo -e "${red}Fatal: run as root${plain}" >&2
  echo "Example:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/rm1dev/SyncPage/main/install.sh | sudo bash -s --" >&2
  exit 1
fi

# هگز تصادفی بدون وابستگی به xxd (روی خیلی از اوبونتوهای مینیمال نیست)
rand_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return 0
  fi
  if command -v xxd >/dev/null 2>&1; then
    head -c "$bytes" /dev/urandom | xxd -p -c "$bytes"
    return 0
  fi
  if command -v hexdump >/dev/null 2>&1; then
    head -c "$bytes" /dev/urandom | hexdump -ve '1/1 "%02x"'
    return 0
  fi
  head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# ---- defaults (override via env before running) ----
SYNCPAGE_GITHUB_REPO="${SYNCPAGE_GITHUB_REPO:-rm1dev/SyncPage}"
SYNCPAGE_GITHUB_BRANCH="${1:-${SYNCPAGE_GITHUB_BRANCH:-main}}"
INSTALL_DIR_DEFAULT="/opt/syncpage"
HTTP_PORT_DEFAULT="80"
APP_PORT_DEFAULT="3000"
ADMIN_TOKEN_DEFAULT="$(rand_hex 16)"
DB_PASS_DEFAULT="$(rand_hex 12)"
RMQ_PASS_DEFAULT="$(rand_hex 12)"

prompt() {
  # prompt "Question" "default" → sets REPLY
  local q="$1"
  local d="${2:-}"
  # وقتی از pipe میاد (curl | bash)، stdin اسکریپته — فقط default
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

prompt "Install directory" "$INSTALL_DIR_DEFAULT"
INSTALL_DIR="$REPLY"

prompt "HTTP publish port (host)" "$HTTP_PORT_DEFAULT"
HTTP_PORT="$REPLY"

prompt "App internal port" "$APP_PORT_DEFAULT"
APP_PORT="$REPLY"

prompt "Admin token" "$ADMIN_TOKEN_DEFAULT"
ADMIN_TOKEN="$REPLY"

prompt "Postgres password" "$DB_PASS_DEFAULT"
DB_PASS="$REPLY"

prompt "RabbitMQ password" "$RMQ_PASS_DEFAULT"
RMQ_PASS="$REPLY"

prompt "Public base URL (panel / bootstrap)" "http://${PUBLIC_IP}:${HTTP_PORT}"
PUBLIC_BASE_URL="$REPLY"

prompt "Master internal URL (Edge package download)" "http://${PUBLIC_IP}:${HTTP_PORT}"
MASTER_INTERNAL_URL="$REPLY"

prompt "RabbitMQ public URL (for Edge nodes)" "amqp://syncpage:${RMQ_PASS}@${PUBLIC_IP}:5672"
RABBITMQ_PUBLIC_URL="$REPLY"

prompt "GitHub repo (owner/name)" "$SYNCPAGE_GITHUB_REPO"
SYNCPAGE_GITHUB_REPO="$REPLY"

prompt "GitHub branch/tag" "$SYNCPAGE_GITHUB_BRANCH"
SYNCPAGE_GITHUB_BRANCH="$REPLY"

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

# .env برای Master
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

HTTP_PORT=${HTTP_PORT}
APP_PORT=${APP_PORT}
EOF

echo -e "${yellow}Building and starting Master stack...${plain}"
docker compose -f docker-compose.master.yml --env-file .env up -d --build

echo ""
echo -e "${green}════════════════════════════════════════${plain}"
echo -e "${green}SyncPage Master installed successfully${plain}"
echo -e "${green}════════════════════════════════════════${plain}"
echo -e "Panel:       ${PUBLIC_BASE_URL}/admin"
echo -e "Admin token: ${ADMIN_TOKEN}"
echo -e "Install dir: ${INSTALL_DIR}"
echo -e "RabbitMQ:    ${RABBITMQ_PUBLIC_URL}"
echo ""
echo -e "Health: curl -fsS ${PUBLIC_BASE_URL}/api/health"
echo -e "Logs:   docker compose -f ${INSTALL_DIR}/docker-compose.master.yml logs -f"
echo ""
echo -e "${yellow}Next: open Admin → Nodes → Add node → copy install command${plain}"
