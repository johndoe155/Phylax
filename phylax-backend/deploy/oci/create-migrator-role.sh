#!/usr/bin/env bash
# Create/configure the least-privilege migration role and its root-only DSN.
#
# Run as root on the self-hosted OCI PostgreSQL instance. The script connects to PostgreSQL over its local Unix
# socket as the postgres OS account; it never embeds the migrator credential in a command-line argument or log.
# For managed PostgreSQL, an administrator must run the equivalent ownership/grant statements for that provider.
set -Eeuo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run this migration-role setup as root'; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "$HERE/../lib.sh"
ENV_FILE="${ENV_FILE:-/etc/phylax/phylax.env}"
MIGRATOR_ENV_FILE="${MIGRATOR_ENV_FILE:-/etc/phylax/migrator.env}"
phylax_load_env "$ENV_FILE"
[ -n "${DATABASE_URL:-}" ] || { echo 'DATABASE_URL is missing from the app environment'; exit 1; }
phylax_parse_db_url "$DATABASE_URL" || { echo 'DATABASE_URL is invalid'; exit 1; }
DB_NAME="$PGDATABASE"
APP_ROLE="$PGUSER"
DB_HOST="$PGHOST"
DB_PORT="$PGPORT"
case "$DB_HOST" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing local postgres-admin role setup for non-local DATABASE_URL host: $DB_HOST" >&2; exit 1 ;; esac
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ && "$APP_ROLE" =~ ^[A-Za-z0-9_]+$ && "$DB_PORT" =~ ^[0-9]+$ ]] || { echo 'Database, role, or port contains unsupported characters'; exit 1; }

if [ -f "$MIGRATOR_ENV_FILE" ]; then
  phylax_load_env "$MIGRATOR_ENV_FILE"
  [ -n "${DATABASE_MIGRATION_URL:-}" ] || { echo "DATABASE_MIGRATION_URL is missing from $MIGRATOR_ENV_FILE"; exit 1; }
  phylax_parse_db_url "$DATABASE_MIGRATION_URL" || { echo 'Existing DATABASE_MIGRATION_URL is invalid'; exit 1; }
  MIGRATOR_PASSWORD="$PGPASSWORD"
  [ "$PGDATABASE" = "$DB_NAME" ] || { echo 'Migrator DSN points at a different database'; exit 1; }
else
  MIGRATOR_PASSWORD="$(openssl rand -hex 32)"
  install -d -o root -g root -m 700 "$(dirname "$MIGRATOR_ENV_FILE")"
  tmp="$(mktemp "${MIGRATOR_ENV_FILE}.XXXXXX")"
  printf 'DATABASE_MIGRATION_URL=postgresql://phylax_migrator:%s@%s:%s/%s\n' "$MIGRATOR_PASSWORD" "$DB_HOST" "$DB_PORT" "$DB_NAME" > "$tmp"
  chown root:root "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$MIGRATOR_ENV_FILE"
fi
[ -n "$MIGRATOR_PASSWORD" ] || { echo 'Migrator DSN must contain a password'; exit 1; }

ROLE_EXISTS="$(runuser -u postgres -- psql --no-psqlrc --username=postgres --host=/var/run/postgresql --tuples-only --no-align --dbname postgres -c "SELECT 1 FROM pg_roles WHERE rolname='phylax_migrator'")"
ROLE_SQL="$(mktemp)"
trap 'rm -f "$ROLE_SQL"' EXIT
if [ "$ROLE_EXISTS" = 1 ]; then
  # The credential file is the authority. When it already exists, preserve the role password; when it was just
  # created, MIGRATOR_PASSWORD is the freshly generated value. SQL is in a root-only temp file, never argv/logs.
  printf "ALTER ROLE phylax_migrator WITH LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n" "$MIGRATOR_PASSWORD" > "$ROLE_SQL"
else
  printf "CREATE ROLE phylax_migrator LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n" "$MIGRATOR_PASSWORD" > "$ROLE_SQL"
fi
chmod 600 "$ROLE_SQL"
runuser -u postgres -- psql --no-psqlrc --username=postgres --host=/var/run/postgresql --set ON_ERROR_STOP=1 --dbname postgres < "$ROLE_SQL" >/dev/null
rm -f "$ROLE_SQL"
trap - EXIT

# The migrator owns schema objects so it can ALTER them; the app role gets DML on current and future objects.
# Do NOT use REASSIGN OWNED here: PostgreSQL applies it to shared objects too, including every database owned by
# the app role on the cluster. Transfer only migration-managed objects in this database/schema, so another Phylax
# database (or an unrelated database) is never silently taken away from its owner.
runuser -u postgres -- psql --no-psqlrc --username=postgres --host=/var/run/postgresql --set ON_ERROR_STOP=1 --dbname "$DB_NAME" \
  --set app_role="$APP_ROLE" --set db_name="$DB_NAME" <<'SQL'
GRANT CONNECT, CREATE ON DATABASE :"db_name" TO phylax_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO phylax_migrator;
SELECT format('ALTER TABLE %I.%I OWNER TO phylax_migrator', schemaname, tablename)
  FROM pg_tables WHERE schemaname='public' AND tableowner=:'app_role' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO phylax_migrator', ns.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
  WHERE ns.nspname='public' AND c.relkind='S' AND r.rolname=:'app_role' \gexec
SELECT format('ALTER %s %I.%I OWNER TO phylax_migrator', CASE c.relkind WHEN 'v' THEN 'VIEW' ELSE 'MATERIALIZED VIEW' END, ns.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
  WHERE ns.nspname='public' AND c.relkind IN ('v','m') AND r.rolname=:'app_role' \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE phylax_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO %I', :'app_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE phylax_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'app_role') \gexec
ALTER ROLE phylax_migrator SET search_path = public;
SQL

log() { printf '%s [migrator-role] %s\n' "$(date -u +%FT%TZ)" "$*"; }
log "phylax_migrator is configured for $DB_NAME; credential stored root-only in $MIGRATOR_ENV_FILE (not the service environment)"
