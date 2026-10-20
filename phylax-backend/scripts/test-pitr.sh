#!/usr/bin/env bash
# Disposable local pgBackRest/WAL target-time recovery drill. No production cluster is touched.
set -Eeuo pipefail
: "${PITR_TEST_PORT:=55439}"
WORK="$(mktemp -d)"
cleanup(){ [ "$RUNNING" = 0 ] || pg_ctl -D "$WORK/data" -m fast -w stop >/dev/null;rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/repo" "$WORK/log"
initdb -D "$WORK/data" -U "$(id -un)" --auth=trust >/dev/null
PASS="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
cat > "$WORK/backrest.conf" <<EOF
[global]
repo1-path=$WORK/repo
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PASS
repo1-retention-full=2
log-path=$WORK/log
log-level-console=warn
start-fast=y
[phylax]
pg1-path=$WORK/data
pg1-port=$PITR_TEST_PORT
pg1-user=$(id -un)
pg1-socket-path=$WORK
EOF
cat >> "$WORK/data/postgresql.conf" <<EOF
archive_mode=on
archive_command='$(command -v pgbackrest) --config=$WORK/backrest.conf --stanza=phylax archive-push %p'
archive_timeout=60
EOF
pg_ctl -D "$WORK/data" -o "-p $PITR_TEST_PORT -h 127.0.0.1 -k $WORK" -l "$WORK/postgres.log" -w start >/dev/null;RUNNING=1
sql(){ psql -h 127.0.0.1 -p "$PITR_TEST_PORT" -U "$(id -un)" -d postgres -v ON_ERROR_STOP=1 "$@"; }
backrest(){ pgbackrest --config="$WORK/backrest.conf" --stanza=phylax "$@"; }
sql -c "CREATE TABLE recovery_canary(value text); INSERT INTO recovery_canary VALUES('baseline');" >/dev/null
backrest stanza-create;backrest check;backrest --type=full backup
sql -c "SELECT pg_sleep(1.1);INSERT INTO recovery_canary VALUES('wanted');" >/dev/null
TARGET="$(sql -tAc 'SELECT clock_timestamp()')"
sql -c "SELECT pg_sleep(0.1);INSERT INTO recovery_canary VALUES('unwanted');SELECT pg_switch_wal();" >/dev/null
backrest check
pg_ctl -D "$WORK/data" -m fast -w stop >/dev/null
backrest --type=time --target="$TARGET" --target-action=promote --delta restore
pg_ctl -D "$WORK/data" -o "-p $PITR_TEST_PORT -h 127.0.0.1 -k $WORK" -l "$WORK/recovery.log" -w start >/dev/null;RUNNING=1
[ "$(sql -tAc "SELECT string_agg(value,',' ORDER BY value) FROM recovery_canary")" = baseline,wanted ]
[ "$(sql -tAc 'SELECT pg_is_in_recovery()')" = f ]
echo 'PASS: encrypted physical backup + archived WAL restored committed wanted row after full backup; excluded post-target row; promoted successfully. Repository was local, not off-VM.'
