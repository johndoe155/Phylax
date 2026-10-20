#!/usr/bin/env bash
# shellcheck disable=SC1090
# Dynamic sources are operator-selected root-owned environment files, not request data.
# ================================================================================================
# Phylax — the restore
#
# Puts a backup back into a database. This is the other half of the backup, and it is the one that matters
# when Oracle has reclaimed the instance and a new one has been built from scratch.
#
#   ./deploy/restore.sh                              # the newest copy on this machine
#   ./deploy/restore.sh /var/backups/phylax/phylax-20261017T030000Z.dump
#   ./deploy/restore.sh s3://my-bucket/phylax/phylax-20261017T030000Z.dump
#
# WHAT IT DOES
#   1. finds the copy (or takes the one it is given)
#   2. checks the copy is readable
#   3. drops and recreates the schema — NOT the database itself, so the role and the password are untouched
#   4. restores into it
#   5. leaves the migrations table alone: the server applies any migration that is newer than the backup
#
# CONFIGURATION (in /etc/phylax/phylax.env, or the environment)
#   DATABASE_URL    the database to restore into
#   SKIP_PRERESTORE_BACKUP=true   do not keep a copy of what is there now (rebuild-from-scratch only)
# ================================================================================================

set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The same strict parser is used by systemd's env-runner. Never source an operator env file as root.
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/phylax/phylax.env}"
if [ -f "$BACKUP_ENV_FILE" ]; then phylax_load_env "$BACKUP_ENV_FILE"; fi
BACKUP_SECRETS_FILE="${BACKUP_SECRETS_FILE:-/etc/phylax/backup.env}"
[ ! -f "$BACKUP_SECRETS_FILE" ] || phylax_load_env "$BACKUP_SECRETS_FILE"
export BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-/etc/phylax/backup.key}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
LOG_PREFIX="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log()  { printf '%s [restore] %s\n' "$LOG_PREFIX" "$*"; }
fail() { printf '%s [restore] FAILED: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set (look in $BACKUP_ENV_FILE)"

phylax_parse_db_url "$DATABASE_URL" || fail "could not read DATABASE_URL"

# ---- find the copy ----------------------------------------------------------------------------
SOURCE="${1:-}"
if [ -z "$SOURCE" ]; then
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/phylax}"
  SOURCE="$(ls -1t "$BACKUP_DIR"/phylax-*.dump.enc 2>/dev/null | head -1 || true)"
  [ -n "$SOURCE" ] || fail "there is no backup in $BACKUP_DIR and none was named"
  log "using the newest copy: $SOURCE"
else
  log "using $SOURCE"
fi

# A copy that lives in a bucket is fetched first.
if printf '%s' "$SOURCE" | grep -q '^s3://'; then
  TMP="$WORK/$(basename "$SOURCE")"
  log "fetching $SOURCE"
  export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:-}" AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:-}" AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
  EXTRA=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && EXTRA+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  aws s3 cp "$SOURCE" "$TMP" "${EXTRA[@]}" || fail "the download failed"
  SOURCE="$TMP"
fi

if [[ "$SOURCE" == rclone:* ]]; then
  rclone copyto "${SOURCE#rclone:}" "$WORK/remote.dump.enc" || fail "remote download failed"
  SOURCE="$WORK/remote.dump.enc"
fi
if [[ "$SOURCE" == *.enc ]]; then
  node "$HERE/backup-crypto.mjs" decrypt "$SOURCE" "$WORK/plain.dump" || fail "authentication/decryption failed; database unchanged"
  SOURCE="$WORK/plain.dump"
elif [ "${ALLOW_LEGACY_BACKUP:-false}" != true ]; then
  fail "plaintext legacy restore requires ALLOW_LEGACY_BACKUP=true"
fi
[ "${CONFIRM_RESTORE:-}" = "$PGDATABASE" ] || fail "Stop the application and set CONFIRM_RESTORE to the exact destination database name"
[ -f "$SOURCE" ] || fail "$SOURCE is not a file"
[ -s "$SOURCE" ] || fail "$SOURCE is empty"
pg_restore --list "$SOURCE" >/dev/null 2>&1 || fail "$SOURCE cannot be read; it is not a usable backup"
log "the copy is readable"

# ---- a pre-restore backup ----------------------------------------------------------------------
# A restore is destructive by definition: it drops the schema and puts back whatever was in the copy. If the copy
# turns out to be older than expected, or the restore half-fails, the CURRENT database is gone. So a copy of it is
# taken first — unless the operator has explicitly said the current contents are worthless (a machine being
# rebuilt from scratch after Oracle reclaimed the instance, say), which is what SKIP_PRERESTORE_BACKUP is for.
if [ "${SKIP_PRERESTORE_BACKUP:-false}" != true ]; then
  log "taking a pre-restore backup of the current database"
  BACKUP_DIR="${BACKUP_DIR:-/var/backups/phylax}"
  PRE="$BACKUP_DIR/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
  pg_dump --format=custom --no-owner --no-privileges --file="$WORK/pre-restore.dump" || fail "the pre-restore backup failed; database unchanged"
  node "$HERE/backup-crypto.mjs" encrypt "$WORK/pre-restore.dump" "$PRE" || fail "could not encrypt the pre-restore backup; database unchanged"
  node "$HERE/backup-crypto.mjs" verify "$PRE" || fail "the pre-restore backup did not verify; database unchanged"
  rm -f "$WORK/pre-restore.dump"
  log "the pre-restore copy is at $PRE"
else
  log "SKIP_PRERESTORE_BACKUP=true: the current database contents will not be kept"
fi

# ---- restore ----------------------------------------------------------------------------------
# The schema is dropped, not the database: the role, the password and the ownership stay as they are.
# Render the complete SQL before touching the database. A corrupt dump cannot leave a wiped schema.
SQL_FILE="$WORK/restore.sql"
{
  printf '%s\n' 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
  pg_restore --no-owner --no-privileges --exit-on-error --file=- "$SOURCE"
} > "$SQL_FILE" || fail "could not render backup SQL; database unchanged"
log "restoring in one transaction (stop the application before running this)"
psql --set=ON_ERROR_STOP=1 --single-transaction --file="$SQL_FILE" \
  || fail "restore failed and was rolled back"

log "verifying"
TABLES="$(psql -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
log "the database now has $TABLES tables"

if [ "${1:-}" = "" ]; then
  log "the migrations table was restored as it was; the server will apply anything newer on its next start"
fi

log "done"
