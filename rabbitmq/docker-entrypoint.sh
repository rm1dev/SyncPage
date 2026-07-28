#!/bin/sh
# تعریف‌ها رو با پسورد واقعی از env پر می‌کنیم، بعد سرور رو استارت می‌زنیم
set -eu

PASS="${RABBITMQ_DEFAULT_PASS:-syncpage}"

# با ENVIRON هر کاراکتری توی پسورد امنه (برخلاف sed)
PASS="$PASS" awk '
BEGIN { pass = ENVIRON["PASS"]; token = "__RABBITMQ_PASS__" }
{
  line = $0
  while ((i = index(line, token)) > 0) {
    line = substr(line, 1, i - 1) pass substr(line, i + length(token))
  }
  print line
}
' /etc/rabbitmq/definitions.template.json > /tmp/definitions.json

# conf.d داخل ایمیج writable هست
printf 'management.load_definitions = /tmp/definitions.json\n' \
  > /etc/rabbitmq/conf.d/99-load-definitions.conf

exec docker-entrypoint.sh rabbitmq-server "$@"
