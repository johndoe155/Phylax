#!/usr/bin/env bash
# Irreversible physical restore. Root, same PostgreSQL major version, pgBackRest stanza configured.
set -Eeuo pipefail
# Administrative commands must not inherit application credentials. Local Ubuntu cluster only.
unset PGHOST PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE
export PGHOST=/var/run/postgresql PGUSER=postgres PGDATABASE=postgres
[ "$(id -u)" -eq 0 ] || { echo 'Run as root'; exit 1; }
: "${PITR_TARGET:?UTC timestamp, e.g. 2026-10-17 12:00:00+00}"
[ "${CONFIRM_PITR_RESTORE:-}" = 'STOP-AND-RESTORE-PHYLAX' ] || { echo 'Set CONFIRM_PITR_RESTORE=STOP-AND-RESTORE-PHYLAX'; exit 1; }
# Validate timestamp without shell evaluation; do not automatically restart on restoration failure.
node -e 'if(!Number.isFinite(Date.parse(process.env.PITR_TARGET)))process.exit(1)'
systemctl stop phylax
systemctl stop postgresql
EXTRA=(); [ -z "${PITR_BACKUP_SET:-}" ] || EXTRA+=(--set="$PITR_BACKUP_SET")
runuser -u postgres -- pgbackrest --stanza=phylax "${EXTRA[@]}" --type=time --target="$PITR_TARGET" --target-action=promote --delta restore
systemctl start postgresql
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c 'SELECT pg_is_in_recovery();'
echo 'Database is restored. Inspect target time, schema and account state before manually starting phylax.'
