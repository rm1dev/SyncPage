#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${ADMIN_TOKEN:-change-me-admin-token}"
BASE="${BASE_URL:-http://localhost}"
ZIP="$ROOT/scripts/sample-landing.zip"
TS="$(date +%s)"
FORM_KEY="contact-${TS}"
SLUG="sample-${TS}"

echo "==> Health check"
curl -sf "$BASE/api/health"
echo

echo "==> Create form on Master"
FORM_PAYLOAD=$(mktemp)
cat > "$FORM_PAYLOAD" <<EOF
{
  "title": "Contact Form",
  "key": "${FORM_KEY}",
  "slug": "${FORM_KEY}",
  "body": [
    {"type":"text","name":"fullName","label":"Full name","required":true},
    {"type":"email","name":"email","label":"Email","required":true}
  ]
}
EOF
FORM_JSON=$(curl -sf -X POST "$BASE/api/forms" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $TOKEN" \
  --data-binary @"$FORM_PAYLOAD")
rm -f "$FORM_PAYLOAD"
echo "$FORM_JSON"
echo

echo "==> Submit form (public)"
curl -sf -X POST "$BASE/api/forms/${FORM_KEY}/submit" \
  -H "Content-Type: application/json" \
  -d '{"fullName":"Ada Lovelace","email":"ada@example.com"}'
echo
echo

echo "==> Upload ZIP"
UPLOAD=$(curl -sf -X POST "$BASE/api/landings/upload" \
  -H "x-admin-token: $TOKEN" \
  -F "slug=$SLUG" \
  -F "file=@${ZIP}")
echo "$UPLOAD"
PREVIEW_ID=$(node -e "const u=JSON.parse(process.argv[1]); process.stdout.write(u.previewId)" "$UPLOAD")
CHECKSUM=$(node -e "const u=JSON.parse(process.argv[1]); process.stdout.write(u.checksum)" "$UPLOAD")
echo "previewId=$PREVIEW_ID checksum=$CHECKSUM"
echo

echo "==> Confirm deploy"
CONFIRM=$(curl -sf -X POST "$BASE/api/landings/confirm" \
  -H "Content-Type: application/json" \
  -H "x-admin-token: $TOKEN" \
  -d "{\"previewId\":\"$PREVIEW_ID\",\"slug\":\"$SLUG\"}")
echo "$CONFIRM"
VERSION=$(node -e "const u=JSON.parse(process.argv[1]); process.stdout.write(String(u.version))" "$CONFIRM")
IDEM="landing:${SLUG}:v${VERSION}:${CHECKSUM}"
echo "idempotencyKey=$IDEM"
echo

echo "==> Wait for outbox + edge sync"
sleep 8

echo "==> Check static page via nginx"
curl -sf "$BASE/$SLUG/" | head -n 5
echo

echo "==> Check edge logs for sync"
docker compose -f "$ROOT/docker-compose.yml" logs --no-color --tail=120 app-edge | tee /tmp/spage-edge-logs.txt
grep -Eq "Landing synced on edge: ${SLUG}" /tmp/spage-edge-logs.txt
echo "Edge sync observed in logs"

echo "==> Re-publish same message for idempotency check"
NEST_MSG=$(IDEM="$IDEM" SLUG="$SLUG" VERSION="$VERSION" CHECKSUM="$CHECKSUM" node -e '
const p = {
  pattern: "landing.sync",
  data: {
    idempotencyKey: process.env.IDEM,
    slug: process.env.SLUG,
    version: Number(process.env.VERSION),
    checksum: process.env.CHECKSUM,
    downloadUrl: "http://app-master:3000/api/internal/landings/" + process.env.SLUG + "/package",
  },
};
process.stdout.write(JSON.stringify({
  properties: {},
  routing_key: "landing.sync",
  payload: JSON.stringify(p),
  payload_encoding: "string",
}));
')

curl -sf -u spage:spage -H 'Content-Type: application/json' \
  -X POST "http://localhost:15672/api/exchanges/%2F/amq.default/publish" \
  -d "$NEST_MSG"
echo

sleep 5
docker compose -f "$ROOT/docker-compose.yml" logs --no-color --tail=50 app-edge | tee /tmp/spage-edge-idem.txt
grep -F "Duplicate sync ignored (idempotent): ${IDEM}" /tmp/spage-edge-idem.txt
echo "Idempotent duplicate confirmed"

echo
echo "Smoke test passed"
