#!/usr/bin/env bash
# shellcheck disable=SC1090
# Dynamic sources are operator-selected root-owned environment files, not request data.
# Root-only online production WAL restore drill into an isolated local cluster/port.
set -Eeuo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || exit 1
HERE="$(cd "$(dirname "$0")" && pwd)"
# The same strict parser is used by systemd's env-runner. Never source operator files as root.
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
phylax_load_env "${BACKUP_ENV_FILE:-/etc/phylax/phylax.env}"
phylax_parse_db_url "$DATABASE_URL"
grep -Eq '^repo1-type=s3$' /etc/pgbackrest.conf || { echo 'Real remote pgBackRest S3 repository required';exit 1; }
LIVE_PORT="$PGPORT"
DB="$PGDATABASE";unset PGPASSWORD PGUSER PGDATABASE PGHOST PGSERVICE PGSERVICEFILE
PORT="${PITR_DRILL_PORT:-55439}"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" != "$LIVE_PORT" ]] || exit 1
MAJOR="$(runuser -u postgres -- psql --username=postgres --host=/var/run/postgresql --port="$LIVE_PORT" --dbname=postgres -tAc "SELECT current_setting('server_version_num')::int/10000")"
BIN="/usr/lib/postgresql/$MAJOR/bin"
WORK="$(mktemp -d /var/lib/phylax-pitr-drill.XXXXXX)";chown postgres:postgres "$WORK";chmod 700 "$WORK"
CANARY="phylax_drill_$(date +%s)_$$";NONCE="$(openssl rand -hex 16)"
live(){ runuser -u postgres -- psql --username=postgres --host=/var/run/postgresql --port="$LIVE_PORT" --dbname="$DB" -v ON_ERROR_STOP=1 "$@"; }
cleanup(){ if runuser -u postgres -- "$BIN/pg_ctl" -D "$WORK/data" status >/dev/null 2>&1;then runuser -u postgres -- "$BIN/pg_ctl" -D "$WORK/data" -m fast -w stop || true;fi;live -c "DROP TABLE IF EXISTS $CANARY" >/dev/null || true;rm -rf "$WORK"; }
trap cleanup EXIT
live -c "SELECT pg_sleep(1.1);CREATE TABLE $CANARY(value text);INSERT INTO $CANARY VALUES('$NONCE');" >/dev/null
TARGET="$(live -tAc 'SELECT clock_timestamp()')"
live -c 'SELECT pg_switch_wal()' >/dev/null
runuser -u postgres -- pgbackrest --stanza=phylax check
runuser -u postgres -- pgbackrest --stanza=phylax --pg1-path="$WORK/data" --type=time --target="$TARGET" --target-action=promote restore
CONF="$(runuser -u postgres -- psql --username=postgres --host=/var/run/postgresql --port="$LIVE_PORT" --dbname=postgres -tAc 'SHOW config_file')"
[ ! -d "$(dirname "$CONF")/conf.d" ] || cp -r "$(dirname "$CONF")/conf.d" "$WORK/conf.d"
cp "$CONF" "$WORK/postgresql.conf"
 printf 'local all postgres peer\nlocal all all reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n' > "$WORK/pg_hba.conf"
 touch "$WORK/pg_ident.conf";chown -R postgres:postgres "$WORK"
# Explicit overrides prevent a test restore from binding production's port/data path or pushing test WAL.
runuser -u postgres -- "$BIN/pg_ctl" -D "$WORK/data" -l "$WORK/recovery.log" -o "-c config_file=$WORK/postgresql.conf -c data_directory=$WORK/data -c archive_mode=off -c ssl=off -c external_pid_file=$WORK/external.pid -c hba_file=$WORK/pg_hba.conf -c ident_file=$WORK/pg_ident.conf -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK -p $PORT" -w start
GOT="$(runuser -u postgres -- psql --username=postgres --host="$WORK" --port="$PORT" --dbname="$DB" -tAc "SELECT value FROM $CANARY")"
[ "$GOT" = "$NONCE" ]
[ "$(runuser -u postgres -- psql --username=postgres --host="$WORK" --port="$PORT" --dbname="$DB" -tAc 'SELECT pg_is_in_recovery()')" = f ]
install -d -m 755 /var/lib/phylax-backup
# The receipt hash comes from the one shared implementation (deploy/db-hash.mjs), so the release gate, the
# application and this drill can never disagree about what a valid receipt looks like.
DATABASE_HASH="$(node "$HERE/db-hash.mjs")"; export DATABASE_HASH
node --input-type=module - <<'JS'
import {writeFileSync,renameSync} from 'node:fs';
const p='/var/lib/phylax-backup/pitr-status.json';writeFileSync(p+'.tmp',JSON.stringify({ok:true,timestamp:new Date().toISOString(),databaseHash:process.env.DATABASE_HASH,source:'remote-wal',canaryRecovered:true})+'\n',{mode:0o644});renameSync(p+'.tmp',p);
JS
echo 'PASS: real remote physical/WAL recovery into isolated cluster recovered the post-backup canary. Production data was not replaced.'
