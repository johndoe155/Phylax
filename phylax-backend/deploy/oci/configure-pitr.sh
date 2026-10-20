#!/usr/bin/env bash
# Root-only pgBackRest S3 WAL archiving + encrypted physical backups. Ubuntu PostgreSQL deployment.
set -Eeuo pipefail
# Administrative commands must not inherit application credentials. Local Ubuntu cluster only.
unset PGHOST PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE
export PGHOST=/var/run/postgresql PGUSER=postgres PGDATABASE=postgres
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run as root'; exit 1; }
: "${PITR_S3_BUCKET:?}" "${PITR_S3_ENDPOINT:?hostname without scheme}" "${PITR_S3_REGION:?}" "${PITR_S3_KEY:?}" "${PITR_S3_SECRET:?}" "${PITR_CIPHER_PASSPHRASE:?store off-VM independently}"
# Only simple configuration values: do not interpolate newlines into root-owned config.
for name in PITR_S3_BUCKET PITR_S3_ENDPOINT PITR_S3_REGION PITR_S3_KEY PITR_S3_SECRET PITR_CIPHER_PASSPHRASE; do [[ "${!name}" != *$'\n'* && "${!name}" != *$'\r'* ]] || exit 1; done
[ "${#PITR_CIPHER_PASSPHRASE}" -ge 32 ]
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y pgbackrest
PGDATA="$(runuser -u postgres -- psql -tAc 'SHOW data_directory')"
PGCONF="$(runuser -u postgres -- psql -tAc 'SHOW config_file')"
install -d -m 750 -o postgres -g postgres /var/log/pgbackrest /var/lib/pgbackrest
cat > /etc/pgbackrest.conf <<EOF
[global]
repo1-type=s3
repo1-s3-bucket=$PITR_S3_BUCKET
repo1-s3-endpoint=$PITR_S3_ENDPOINT
repo1-s3-region=$PITR_S3_REGION
repo1-s3-key=$PITR_S3_KEY
repo1-s3-key-secret=$PITR_S3_SECRET
repo1-path=/phylax-pitr
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$PITR_CIPHER_PASSPHRASE
repo1-retention-full=4
repo1-retention-diff=7
archive-timeout=120
process-max=2
start-fast=y
log-level-console=info
[phylax]
pg1-path=$PGDATA
EOF
chown root:postgres /etc/pgbackrest.conf; chmod 640 /etc/pgbackrest.conf
# ALTER SYSTEM quotes are constants, never supplied secrets. A restart is necessary for archive_mode.
runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<'SQL'
ALTER SYSTEM SET archive_mode='on';
ALTER SYSTEM SET archive_command='pgbackrest --stanza=phylax archive-push %p';
ALTER SYSTEM SET archive_timeout='60s';
SQL
systemctl restart postgresql
runuser -u postgres -- pgbackrest --stanza=phylax stanza-create
runuser -u postgres -- pgbackrest --stanza=phylax check
runuser -u postgres -- pgbackrest --stanza=phylax --type=full backup
cat > /etc/cron.d/phylax-pitr <<'CRON'
30 2 * * 0 postgres pgbackrest --stanza=phylax --type=full backup
30 2 * * 1-6 postgres pgbackrest --stanza=phylax --type=diff backup
CRON
chmod 644 /etc/cron.d/phylax-pitr
printf '%s\n' 'PITR_ENABLED=true' >> /etc/phylax/backup.env
printf 'PITR configured. Copy /etc/pgbackrest.conf cipher passphrase OFF-VM; test target-time restoration before launch. PostgreSQL config: %s\n' "$PGCONF"
