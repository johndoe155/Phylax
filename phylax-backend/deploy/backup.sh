#!/usr/bin/env bash
# shellcheck disable=SC1090
# Dynamic sources are operator-selected root-owned environment files, not request data.
# Authenticated encrypted logical backup. Production requires a remote destination.
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The same strict parser is used by systemd's env-runner. Never source an operator env file as root.
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/phylax/phylax.env}"
[ ! -f "$BACKUP_ENV_FILE" ] || phylax_load_env "$BACKUP_ENV_FILE"
BACKUP_SECRETS_FILE="${BACKUP_SECRETS_FILE:-/etc/phylax/backup.env}"
[ ! -f "$BACKUP_SECRETS_FILE" ] || phylax_load_env "$BACKUP_SECRETS_FILE"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/phylax}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_REMOTE_DAYS="${BACKUP_REMOTE_DAYS:-30}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-phylax}"
BACKUP_STATUS_FILE="${BACKUP_STATUS_FILE:-/var/lib/phylax-backup/status.json}"
export BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-/etc/phylax/backup.key}"
if [ "${NODE_ENV:-production}" = production ] && [ -n "${BACKUP_ALERT_URL:-}" ];then [[ "$BACKUP_ALERT_URL" == https://* ]] || { echo 'BACKUP_ALERT_URL requires HTTPS';exit 1; };fi
WORK=""
log(){ printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
# The receipt's database hash, derived EXACTLY the way the application derives it (server/db.ts:
# databaseReceiptHash). An HMAC keyed by DATABASE_HASH_KEY when that is set, so the file is not an unsalted
# digest of the database URL — a mode-644 status file holding a plain sha256 of a low-entropy password is
# brute-forceable. Set the SAME DATABASE_HASH_KEY in /etc/phylax/phylax.env and /etc/phylax/backup.env.
# One implementation, shared with the app, the release gate and the restore drills (deploy/db-hash.mjs). If these
# ever disagree, a legitimate receipt is rejected as tampered — so there is exactly one place that derives it.
database_hash(){ node "$HERE/db-hash.mjs"; }
# Write the receipt.
#
# 0644 in a root-owned 0755 directory, NOT 0600 in 0700. The receipt is read by two different users:
#
#   root  backup.sh, release-check.sh and the two restore drills
#   phylax  the SERVICE user, in server/db.ts `checkBackupReceipt`, which is the boot-time gate that refuses to
#           apply a pending migration without a fresh verified off-machine backup
#
# At 0600 inside a 0700 directory the second reader got EACCES, so the documented "restart the service after a
# failed deploy" flow could never succeed under systemd — only a root-run `--migrate-only` could pass the gate.
# This is safe to make world-READABLE because the file holds no secret: ok, a timestamp, and a databaseHash that
# is an HMAC under DATABASE_HASH_KEY. It is never world-WRITABLE, and root ownership is part of the check, because
# a receipt the service user could write would be worthless as a gate on its own migrations.
status(){
 local dir; dir="$(dirname "$BACKUP_STATUS_FILE")"
 install -d -m 0755 -o root -g root "$dir" 2>/dev/null || mkdir -p "$dir"
 printf '{"ok":%s,"timestamp":"%s","databaseHash":"%s"}\n' "$1" "$(date -u +%FT%TZ)" "$(database_hash)" > "$BACKUP_STATUS_FILE.tmp"
 chmod 0644 "$BACKUP_STATUS_FILE.tmp"; chown root:root "$BACKUP_STATUS_FILE.tmp" 2>/dev/null || true
 mv "$BACKUP_STATUS_FILE.tmp" "$BACKUP_STATUS_FILE"; }
cleanup(){ [ -z "${FILE:-}" ] || rm -f -- "$FILE.partial"; [ -z "$WORK" ] || rm -rf "$WORK"; }
failed(){ trap - ERR; cleanup; status false || true; log 'FAILED: encrypted backup or remote verification failed'; if [ -n "${BACKUP_ALERT_URL:-}" ]; then printf 'Authorization: Bearer %s\n' "${BACKUP_ALERT_TOKEN:-}" | curl --fail --silent --show-error --max-time 10 --retry 2 --header @- -H 'Content-Type: application/json' --data '{"service":"phylax-backup","ok":false}' "$BACKUP_ALERT_URL" || true; fi; exit 1; }
trap failed ERR
trap cleanup EXIT
[[ "$BACKUP_KEEP" =~ ^[1-9][0-9]*$ && "$BACKUP_REMOTE_DAYS" =~ ^[1-9][0-9]*$ ]] || { log 'invalid retention'; false; }
[[ "$BACKUP_S3_PREFIX" =~ ^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*$ && "$BACKUP_S3_PREFIX" != *..* ]] || { log 'invalid managed remote prefix'; false; }
[ -n "${DATABASE_URL:-}" ] && [ -r "$BACKUP_KEY_FILE" ] || { log 'DATABASE_URL and BACKUP_KEY_FILE are required'; false; }
if [ "${NODE_ENV:-production}" = production ]; then
 [ -n "${BACKUP_RCLONE_REMOTE:-}${BACKUP_S3_BUCKET:-}" ] || { log 'production backup requires an off-machine destination'; false; }
 [ -n "${BACKUP_ALERT_URL:-}" ] || { log 'production backup requires BACKUP_ALERT_URL'; false; }
 # The receipt is world-readable (the service user has to be able to read it to pass the migration gate), so its
 # databaseHash must be an HMAC rather than a bare digest of the connection string. Without the key this would
 # publish a brute-forceable sha256 of a low-entropy database password.
 [ -n "${DATABASE_HASH_KEY:-}" ] || { log 'production backup requires DATABASE_HASH_KEY: the receipt is world-readable, so its databaseHash must be keyed'; false; }
fi
phylax_parse_db_url "$DATABASE_URL"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
# Take the lock with a bounded wait, and treat "somebody else is backing up right now" as SUCCESS.
#
# It used to be `flock -n`, a non-blocking try. Under `set -Eeuo pipefail` with `trap failed ERR`, failing to
# acquire the lock ran the failure handler — which overwrote the last GOOD receipt with `ok:false` and fired the
# alert endpoint. So a second cron run, a manual run during the nightly one, or any overlap at all produced a
# page saying the backup had failed when in fact one was in progress and the previous one was perfectly good.
# The receipt now survives untouched, the operator gets one log line, and the exit status is 0.
exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -w "${BACKUP_LOCK_WAIT_SECONDS:-600}" 9; then
  trap - ERR EXIT
  log "another backup holds the lock after ${BACKUP_LOCK_WAIT_SECONDS:-600}s; leaving the existing receipt untouched and exiting successfully"
  exit 0
fi
WORK="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
NAME="phylax-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.enc"
FILE="$BACKUP_DIR/$NAME"
pg_dump --format=custom --no-owner --no-privileges --file="$WORK/plain.dump"
[ -s "$WORK/plain.dump" ]; pg_restore --list "$WORK/plain.dump" >/dev/null
node "$HERE/backup-crypto.mjs" encrypt "$WORK/plain.dump" "$FILE.partial"
node "$HERE/backup-crypto.mjs" verify "$FILE.partial"
mv "$FILE.partial" "$FILE"
rm -f "$WORK/plain.dump"
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
 REMOTE="${BACKUP_RCLONE_REMOTE}:${BACKUP_S3_PREFIX}/$NAME"
 rclone copyto "$FILE" "$REMOTE"
 rclone copyto "$REMOTE" "$WORK/remote.enc"
 cmp "$FILE" "$WORK/remote.enc"
 node "$HERE/backup-crypto.mjs" verify "$WORK/remote.enc"
 rclone delete "${BACKUP_RCLONE_REMOTE}:${BACKUP_S3_PREFIX}" --min-age "${BACKUP_REMOTE_DAYS}d" --include 'phylax-*.dump.enc'
elif [ -n "${BACKUP_S3_BUCKET:-}" ]; then
 export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:?}" AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:?}" AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
 EXTRA=(); [ -z "${BACKUP_S3_ENDPOINT:-}" ] || EXTRA+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
 REMOTE="${BACKUP_S3_BUCKET%/}/${BACKUP_S3_PREFIX}/$NAME"
 aws s3 cp "$FILE" "$REMOTE" "${EXTRA[@]}"
 aws s3 cp "$REMOTE" "$WORK/remote.enc" "${EXTRA[@]}"
 cmp "$FILE" "$WORK/remote.enc"
 node "$HERE/backup-crypto.mjs" verify "$WORK/remote.enc"
 export BACKUP_S3_BUCKET BACKUP_S3_PREFIX BACKUP_REMOTE_DAYS BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
 node "$HERE/remote-retention.mjs"
else
 log 'development-only local backup; not reclaim protection'
fi
# Prune only after successful encrypted remote read-back, never before.
find "$BACKUP_DIR" -maxdepth 1 -name 'phylax-*.dump.enc' -type f -printf '%T@ %p\n' | sort -rn | tail -n +$((BACKUP_KEEP+1)) | cut -d' ' -f2- | while IFS= read -r old; do rm -f -- "$old"; done
status true
log "encrypted backup verified: $NAME"
