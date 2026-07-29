#!/usr/bin/env bash
# انتخاب فایل compose درست برای Edge (bridge هم‌محل / host ریموت)
# Usage: scripts/compose-node.sh [--dir /opt/syncpage-node] up -d --build
set -euo pipefail

DIR="."
if [[ "${1:-}" == "--dir" ]]; then
  DIR="${2:?}"
  shift 2
fi

cd "$DIR"

if [[ ! -f docker-compose.node.yml ]] && [[ ! -f docker-compose.node.remote.yml ]]; then
  echo "No edge compose file in $(pwd)" >&2
  exit 1
fi

MODE="$(grep '^EDGE_NETWORK_MODE=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
RMQ="$(grep '^RABBITMQ_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- || true)"

# ریموت = host | هم‌محل = bridge (از طریق host.docker.internal)
if [[ "$MODE" == "host" ]] || { [[ -n "$RMQ" ]] && [[ "$RMQ" != *"host.docker.internal"* ]] && [[ "$MODE" != "bridge" ]]; }; then
  if [[ ! -f docker-compose.node.remote.yml ]]; then
    echo "docker-compose.node.remote.yml missing" >&2
    exit 1
  fi
  exec docker compose -f docker-compose.node.remote.yml --env-file .env "$@"
fi

exec docker compose -f docker-compose.node.yml --env-file .env "$@"
