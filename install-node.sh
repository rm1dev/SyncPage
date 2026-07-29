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

# استک قبلی رو با هر دو مدل compose می‌بندیم تا پورت/کانتینر گیر نکنه
stop_existing_edge() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  (
    cd "$dir"
    for f in docker-compose.node.remote.yml docker-compose.node.host.yml docker-compose.node.yml; do
      [[ -f "$f" ]] || continue
      docker compose -f "$f" --env-file .env down --remove-orphans 2>/dev/null || \
        docker compose -f "$f" down --remove-orphans 2>/dev/null || true
    done
  ) || true
}

# بعد از بالا اومدن، چک می‌کنیم واقعاً به RabbitMQ وصل می‌شیم
verify_amqp_from_app() {
  local compose_file="$1"
  echo -e "${yellow}Verifying AMQP from app container...${plain}"
  local i out rc
  for i in 1 2 3 4 5 6 7 8; do
    # checkQueue اگه صف هنوز ساخته نشده باشه خطا می‌ده؛ assertQueue امن‌تره
    set +e
    out="$(docker compose -f "$compose_file" --env-file .env exec -T app node -e '
const amqp=require("amqplib");
const net=require("net");
(async()=>{
  const url=process.env.RABBITMQ_URL||"";
  const q=process.env.RABBITMQ_QUEUE||"";
  if(!url||!q){ console.error("missing RABBITMQ_URL/QUEUE"); process.exit(2); }
  let host="?", port=5672;
  try {
    const u=new URL(url);
    host=u.hostname; port=Number(u.port||5672);
  } catch {}
  await new Promise((resolve,reject)=>{
    const s=net.connect(port,host,()=>{s.destroy();resolve();});
    s.setTimeout(8000,()=>{s.destroy();reject(new Error("tcp timeout "+host+":"+port));});
    s.on("error",e=>reject(new Error("tcp fail "+e.message)));
  });
  console.log("tcp ok "+host+":"+port);
  try{
    const c=await amqp.connect(url,{timeout:10000});
    const ch=await c.createChannel();
    const info=await ch.assertQueue(q,{durable:true});
    console.log("amqp ok queue="+info.queue+" messages="+info.messageCount);
    await c.close();
    process.exit(0);
  }catch(e){ console.error("amqp fail: "+e.message); process.exit(1); }
})();
' 2>&1)"
    rc=$?
    set -e
    echo "$out"
    if [[ "$rc" -eq 0 ]]; then
      return 0
    fi
    echo -e "${yellow}AMQP attempt ${i}/8 failed — retry...${plain}"
    sleep 3
  done
  return 1
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
COLOCATED=0
if [[ "${SYNCPAGE_COLOCATED:-0}" == "1" ]]; then
  COLOCATED=1
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

# قبل از دست زدن به سورس، استک قدیمی رو ببند
stop_existing_edge "$INSTALL_DIR"

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

# نود ریموت: compose جدا با host network (بدون merge با bridge)
# نود هم‌محل: bridge + host.docker.internal
EDGE_NETWORK_MODE="bridge"
POSTGRES_HOST_PORT="5433"
COMPOSE_FILE="docker-compose.node.yml"
if [[ "$COLOCATED" != "1" ]]; then
  EDGE_NETWORK_MODE="host"
  if [[ ! -f docker-compose.node.remote.yml ]]; then
    echo -e "${red}docker-compose.node.remote.yml missing — repo too old?${plain}"
    exit 1
  fi
  COMPOSE_FILE="docker-compose.node.remote.yml"
  echo -e "${yellow}Remote edge: host network compose (${COMPOSE_FILE})${plain}"
fi

# bridge → hostname db:5432 | host network → 127.0.0.1:5433
if [[ "$EDGE_NETWORK_MODE" == "host" ]]; then
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${POSTGRES_HOST_PORT}/${DB_NAME}?schema=public"
else
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@db:5432/${DB_NAME}?schema=public"
fi

cat > .env <<EOF
NODE_ROLE=EDGE
PORT=${PORT}
NODE_ENV=production
EDGE_NODE_ID=${NODE_ID}

POSTGRES_USER=${DB_USER}
POSTGRES_PASSWORD=${DB_PASS}
POSTGRES_DB=${DB_NAME}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT}
DATABASE_URL=${DATABASE_URL}

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
EDGE_NETWORK_MODE=${EDGE_NETWORK_MODE}
COMPOSE_FILE=${COMPOSE_FILE}
SYNCPAGE_GITHUB_REPO=${GITHUB_REPO}
SYNCPAGE_GITHUB_BRANCH=${GITHUB_BRANCH}
EOF

# دوباره استک قبلی رو با .env جدید ببند (پروژهٔ compose ممکنه اسم متفاوت داشته باشه)
stop_existing_edge "$INSTALL_DIR"

echo -e "${yellow}Building and starting Edge node (${COMPOSE_FILE})...${plain}"
docker compose -f "$COMPOSE_FILE" --env-file .env up -d --build --force-recreate

# صبر برای healthy شدن HTTP
sleep 5
HEALTH_OK=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 3
done

AMQP_OK=0
if [[ "$HEALTH_OK" -eq 1 ]]; then
  if verify_amqp_from_app "$COMPOSE_FILE"; then
    AMQP_OK=1
  fi
fi

# برای ریموت حتماً network_mode=host باشه
if [[ "$EDGE_NETWORK_MODE" == "host" ]]; then
  APP_CID="$(docker compose -f "$COMPOSE_FILE" --env-file .env ps -q app 2>/dev/null | head -1 || true)"
  if [[ -n "$APP_CID" ]]; then
    NET_MODE="$(docker inspect "$APP_CID" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || true)"
    echo -e "App NetworkMode: ${NET_MODE}"
    if [[ "$NET_MODE" != "host" ]]; then
      echo -e "${red}Expected NetworkMode=host but got: ${NET_MODE}${plain}"
      AMQP_OK=0
    fi
  fi
fi

echo ""
if [[ "$HEALTH_OK" -eq 1 && "$AMQP_OK" -eq 1 ]]; then
  echo -e "${green}Edge node installed, healthy, and AMQP connected${plain}"
elif [[ "$HEALTH_OK" -eq 1 ]]; then
  echo -e "${red}Edge HTTP is up but AMQP to Master failed${plain}"
  echo -e "${yellow}Check: RABBITMQ_URL, Master :5672 firewall, and compose file${plain}"
  echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs --tail=80 app"
  exit 1
else
  echo -e "${yellow}Edge node started — health not ready yet (check logs)${plain}"
  echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs --tail=80 app"
fi
echo -e "Title:  ${TITLE}"
echo -e "NodeId: ${NODE_ID}"
echo -e "Host:   ${HOST}:${PORT}"
echo -e "Queue:  ${QUEUE}"
echo -e "Dir:    ${INSTALL_DIR}"
echo -e "Mode:   ${EDGE_NETWORK_MODE} (${COMPOSE_FILE})"
echo -e "Health: curl -fsS http://127.0.0.1:${PORT}/api/health"
echo -e "Logs:   docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} --env-file ${INSTALL_DIR}/.env logs -f app"
echo ""
echo -e "${green}Back on Master panel → click Verify for this node${plain}"
