#!/usr/bin/env bash
# shellcheck disable=SC1090
# Dynamic sources are operator-selected root-owned environment files, not request data.
# Root-only real remote restore into an isolated throwaway local database. Never restore over production.
set -Eeuo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run on the OCI host as root'; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
# The same strict parser is used by systemd's env-runner. Never source operator files as root.
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
phylax_load_env "${BACKUP_ENV_FILE:-/etc/phylax/phylax.env}"
phylax_load_env "${BACKUP_SECRETS_FILE:-/etc/phylax/backup.env}"
export BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-/etc/phylax/backup.key}"
bash "$HERE/backup.sh"
phylax_parse_db_url "$DATABASE_URL"
LIVE_PORT="$PGPORT"
unset PGPASSWORD PGUSER PGDATABASE PGHOST PGSERVICE PGSERVICEFILE
FILE="$(find "${BACKUP_DIR:-/var/backups/phylax}" -maxdepth 1 -name 'phylax-*.dump.enc' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
NAME="$(basename "$FILE")"
WORK="$(mktemp -d)";DB="phylax_verify_$(date +%s)_$$"
cleanup(){ runuser -u postgres -- dropdb --host=/var/run/postgresql --port="$LIVE_PORT" --username=postgres --if-exists "$DB" || true;rm -rf "$WORK"; }
trap cleanup EXIT
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ];then
 rclone copyto "${BACKUP_RCLONE_REMOTE}:${BACKUP_S3_PREFIX:-phylax}/$NAME" "$WORK/remote.enc"
else
 export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:?}" AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:?}" AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
 EXTRA=();[ -z "${BACKUP_S3_ENDPOINT:-}" ] || EXTRA+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
 aws s3 cp "${BACKUP_S3_BUCKET%/}/${BACKUP_S3_PREFIX:-phylax}/$NAME" "$WORK/remote.enc" "${EXTRA[@]}"
fi
cmp "$FILE" "$WORK/remote.enc"
node "$HERE/backup-crypto.mjs" decrypt "$WORK/remote.enc" "$WORK/plain.dump"
pg_restore --exit-on-error --no-owner --no-privileges --file="$WORK/restore.sql" "$WORK/plain.dump"
runuser -u postgres -- createdb --host=/var/run/postgresql --port="$LIVE_PORT" --username=postgres "$DB"
runuser -u postgres -- psql --username=postgres --host=/var/run/postgresql --port="$LIVE_PORT" --dbname="$DB" --set=ON_ERROR_STOP=1 --single-transaction --file=- < "$WORK/restore.sql" >/dev/null
COUNT="$(runuser -u postgres -- psql --username=postgres --host=/var/run/postgresql --port="$LIVE_PORT" --dbname="$DB" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$COUNT" -ge 13 ]
install -d -o root -g root -m 755 /var/lib/phylax-backup
# The receipt hash comes from the one shared implementation (deploy/db-hash.mjs), so the release gate, the
# application and this drill can never disagree about what a valid receipt looks like.
DATABASE_HASH="$(node "$HERE/db-hash.mjs")"; export DATABASE_HASH
node --input-type=module - <<'JS'
import {writeFileSync,renameSync} from 'node:fs';
const file='/var/lib/phylax-backup/restore-status.json';writeFileSync(file+'.tmp',JSON.stringify({ok:true,timestamp:new Date().toISOString(),databaseHash:process.env.DATABASE_HASH,source:'remote',encrypted:true,restored:true})+'\n',{mode:0o644});renameSync(file+'.tmp',file);
JS
echo 'PASS: fresh remote encrypted backup downloaded, authenticated and fully restored into an isolated local database. Receipt written.'
