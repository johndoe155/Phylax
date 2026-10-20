#!/usr/bin/env bash
# Independent root cron checks application, public origin, scheduler, queue, disk, TLS, PostgreSQL and backup freshness.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The same strict parser is used by systemd's env-runner. Never source operator files as root.
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
ENV_FILE="${ENV_FILE:-/etc/phylax/phylax.env}"
[ ! -f "$ENV_FILE" ] || phylax_load_env "$ENV_FILE"
BACKUP_SECRETS_FILE="${BACKUP_SECRETS_FILE:-/etc/phylax/backup.env}"
[ ! -f "$BACKUP_SECRETS_FILE" ] || phylax_load_env "$BACKUP_SECRETS_FILE"
if [ "${NODE_ENV:-production}" = production ] && [ -n "${BACKUP_ALERT_URL:-}" ];then [[ "$BACKUP_ALERT_URL" == https://* ]] || { echo 'BACKUP_ALERT_URL requires HTTPS';exit 1; };fi
failed(){
 trap - ERR
 mkdir -p /var/lib/phylax-backup
 LAST=/var/lib/phylax-backup/monitor-last-alert
 if [ -f "$LAST" ] && [ $(( $(date +%s)-$(stat -c %Y "$LAST") )) -lt 3600 ];then exit 1;fi
 touch "$LAST"
 logger -t phylax-monitor 'ALERT application, public origin, TLS, disk, PostgreSQL, delivery queue, PITR or backup health check failed'
 if [ -n "${BACKUP_ALERT_URL:-}" ]; then printf 'Authorization: Bearer %s\n' "${BACKUP_ALERT_TOKEN:-}" | curl --fail --silent --show-error --retry 2 --max-time 10 --header @- -H 'Content-Type: application/json' --data '{"service":"phylax-monitor","ok":false}' "$BACKUP_ALERT_URL" || true; fi
 exit 1
}
trap failed ERR
BASE="${MONITOR_ORIGIN:-http://127.0.0.1:3000}"
curl --fail --silent --show-error --max-time 10 "$BASE/api/health" >/dev/null
PUBLIC="${MONITOR_PUBLIC_URL:-${APP_URL:-}}"
if [ "${NODE_ENV:-production}" = production ] && [ -z "$PUBLIC" ]; then echo 'MONITOR_PUBLIC_URL (or APP_URL) is required in production'; exit 1; fi
if [ -n "$PUBLIC" ]; then
  [[ "$PUBLIC" == https://* ]] || { echo 'MONITOR_PUBLIC_URL requires HTTPS'; exit 1; }
  curl --fail --silent --show-error --max-time 15 "$PUBLIC/api/health" >/dev/null
  HOST="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.hostname)' "$PUBLIC")"
  # Check the publicly served leaf certificate, not only the file on disk: this catches a failed renewal/reload as
  # well as expiry. 86400 seconds per day; `-checkend` exits nonzero when expiry is within the configured window.
  CERT_SECONDS=$(( ${MONITOR_CERT_MIN_DAYS:-14} * 86400 ))
  timeout 12 openssl s_client -connect "${HOST}:443" -servername "$HOST" -showcerts </dev/null 2>/dev/null \
    | openssl x509 -noout -checkend "$CERT_SECONDS" >/dev/null
fi
# A full filesystem can prevent Postgres from checkpointing and make both the app and its recovery path fail.
DISK_PATH="${MONITOR_DISK_PATH:-/}"
DISK_USED="$(df -P "$DISK_PATH" | awk 'NR==2 { gsub(/%/, "", $5); print $5 }')"
[[ "$DISK_USED" =~ ^[0-9]+$ ]] || { echo "Could not read disk usage for $DISK_PATH"; exit 1; }
if [ "$DISK_USED" -ge "${MONITOR_DISK_WARN_PERCENT:-85}" ]; then echo "Disk usage ${DISK_USED}% is over threshold ${MONITOR_DISK_WARN_PERCENT:-85}%"; exit 1; fi
STATUS="$(printf 'X-Ops-Token: %s\n' "${OPS_TOKEN:?OPS_TOKEN required}" | curl --fail --silent --show-error --max-time 10 --header @- "$BASE/api/ops/status")"
printf '%s' "$STATUS" | node -e 'let x="";process.stdin.on("data",d=>x+=d);process.stdin.on("end",()=>{const s=JSON.parse(x);if(!s.queue||s.queue.dead>0||s.queue.delivery_failed>0||s.queue.oldest_due_seconds>300||s.heartbeat?.error_code||s.securityNotices?.oldest_seconds>300)process.exit(1);const d=s.databaseConnections;if(!d||!Number.isFinite(d.used)||!Number.isFinite(d.max)||d.max<1||100*d.used/d.max>=Number(process.env.MONITOR_PG_MAX_CONN_PERCENT||80))process.exit(1);});'
node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.env.BACKUP_STATUS_FILE||"/var/lib/phylax-backup/status.json"));if(!s.ok||Date.now()-Date.parse(s.timestamp)>26*3600000)process.exit(1);'
if [ "${PITR_ENABLED:-false}" = true ]; then
 runuser -u postgres -- pgbackrest --stanza=phylax check
 runuser -u postgres -- pgbackrest --stanza=phylax --output=json info | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s)[0];if(x.status.code!==0||!x.backup?.length||Date.now()/1000-x.backup.at(-1).timestamp.stop>26*3600)process.exit(1);});'
fi

# ---- the dead-man's switch ---------------------------------------------------------------------------
# A successful ping is sent only after all local and public checks pass. Its monitor must page when the expected
# interval is missed, so VM failure and a dead scheduler are visible from outside the machine.
if [ "${NODE_ENV:-production}" = production ] && [ -z "${EXTERNAL_PING_URL:-}" ]; then
  echo 'REQUIRE_EXTERNAL_PING=true but EXTERNAL_PING_URL is empty'; exit 1
fi
if [ -n "${EXTERNAL_PING_URL:-}" ]; then
  [[ "$EXTERNAL_PING_URL" == https://* ]] || { echo 'EXTERNAL_PING_URL requires HTTPS'; exit 1; }
  curl --fail --silent --show-error --max-time 10 --retry 2 "$EXTERNAL_PING_URL" >/dev/null || {
    logger -t phylax-monitor 'ALERT external dead-man switch did not accept the ping'
    exit 1
  }
fi
