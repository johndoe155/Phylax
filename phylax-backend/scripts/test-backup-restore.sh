#!/usr/bin/env bash
# Real PostgreSQL encryption/restore drill with a LOCAL remote-transport stub, not off-VM certification.
set -Eeuo pipefail
: "${TEST_DATABASE_URL:?Use a disposable local test database}"
[[ "$TEST_DATABASE_URL" == *127.0.0.1* || "$TEST_DATABASE_URL" == *localhost* ]] || { echo 'Drill requires a loopback test database'; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export DATABASE_URL="$TEST_DATABASE_URL"
. "$ROOT/deploy/lib.sh"; phylax_parse_db_url "$DATABASE_URL"
RESTORE_DB=phylax_restore_drill
createdb "$RESTORE_DB" 2>/dev/null || true
psql -v ON_ERROR_STOP=1 -c 'CREATE TABLE IF NOT EXISTS backup_canary(value text); TRUNCATE backup_canary; INSERT INTO backup_canary VALUES('\''encrypted round-trip'\'');' >/dev/null
mkdir -p "$WORK/bin" "$WORK/remote"
cat > "$WORK/bin/rclone" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "${MOCK_REMOTE_FAIL:-0}" = 1 ]; then exit 42; fi
case "$1" in
 copyto) a="$2";b="$3";[[ "$a" != test:* ]] || a="$MOCK_REMOTE_DIR/${a#test:}";[[ "$b" != test:* ]] || b="$MOCK_REMOTE_DIR/${b#test:}";mkdir -p "$(dirname "$b")";cp "$a" "$b";;
 delete) exit 0;;
 *) exit 1;;
esac
MOCK
chmod +x "$WORK/bin/rclone"
export PATH="$WORK/bin:$PATH" MOCK_REMOTE_DIR="$WORK/remote" NODE_ENV=test
export BACKUP_ENV_FILE=/dev/null BACKUP_SECRETS_FILE=/dev/null BACKUP_DIR="$WORK/backups" BACKUP_STATUS_FILE="$WORK/status.json" BACKUP_KEY_FILE="$WORK/key" BACKUP_RCLONE_REMOTE=test
node -e 'require("fs").writeFileSync(process.env.BACKUP_KEY_FILE,require("crypto").randomBytes(32).toString("hex"),{mode:0o600})'
bash "$ROOT/deploy/backup.sh"
FILE="$(find "$BACKUP_DIR" -name '*.dump.enc' | head -1)"
# The receipt this drill just wrote must carry the hash the release gate will look for. The derivation lives in one
# place (deploy/db-hash.mjs) so the application, the gate and this drill cannot drift apart — this is the check that
# proves it, including that setting DATABASE_HASH_KEY actually changes the digest.
UNKEYED="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.BACKUP_STATUS_FILE,"utf8")).databaseHash)')"
[ "$(node "$ROOT/deploy/db-hash.mjs")" = "$UNKEYED" ] || { echo 'receipt hash does not match the shared derivation'; exit 1; }
DRILL_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
DATABASE_HASH_KEY="$DRILL_KEY" bash "$ROOT/deploy/backup.sh"
KEYED="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.BACKUP_STATUS_FILE,"utf8")).databaseHash)')"
[ "$KEYED" = "$(DATABASE_HASH_KEY="$DRILL_KEY" node "$ROOT/deploy/db-hash.mjs")" ] || { echo 'keyed receipt hash does not match the shared derivation'; exit 1; }
[ "$KEYED" != "$UNKEYED" ] || { echo 'DATABASE_HASH_KEY did not change the receipt digest'; exit 1; }
unset DATABASE_HASH_KEY
DATABASE_URL="$(node -e 'const u=new URL(process.env.TEST_DATABASE_URL);u.pathname="/phylax_restore_drill";process.stdout.write(u.toString())')"
export DATABASE_URL
CONFIRM_RESTORE="$RESTORE_DB" bash "$ROOT/deploy/restore.sh" "$FILE"
phylax_parse_db_url "$DATABASE_URL"
[ "$(psql -tAc 'SELECT value FROM backup_canary')" = 'encrypted round-trip' ]
cp "$FILE" "$WORK/tampered.enc"
node -e 'const fs=require("fs"),p=process.argv[1],x=fs.readFileSync(p);x[x.length-1]^=1;fs.writeFileSync(p,x)' "$WORK/tampered.enc"
if CONFIRM_RESTORE="$RESTORE_DB" bash "$ROOT/deploy/restore.sh" "$WORK/tampered.enc"; then echo 'tampered restore was wrongly accepted';exit 1;fi
[ "$(psql -tAc 'SELECT value FROM backup_canary')" = 'encrypted round-trip' ]
export DATABASE_URL="$TEST_DATABASE_URL" MOCK_REMOTE_FAIL=1
if bash "$ROOT/deploy/backup.sh"; then echo 'failed upload wrongly returned success';exit 1;fi
[ -n "$(find "$BACKUP_DIR" -name '*.dump.enc' -type f -print -quit)" ]
echo 'PASS: real encrypted dump/restore, local transport read-back, tamper rejection, unchanged database after tamper, failed upload nonzero/local copy retained'
