#!/usr/bin/env bash
# shellcheck disable=SC1090
# Dynamic sources are operator-selected root-owned environment files, not request data.
# ================================================================================================
# Phylax — the redeploy
#
# One command to put a new version of the app on the machine.
#
#   ./deploy/redeploy.sh                     # pull, build, migrate, restart, check
#   ./deploy/redeploy.sh --no-pull           # build what is already on the machine
#   ./deploy/redeploy.sh --ref v1.2.3        # a particular tag
#   ./deploy/redeploy.sh --rollback          # put the previous version back
#
# It is written to be safe to run at any time, and to be safe to run again if it half-failed. The order is:
#
#   1. build the new version in a fresh directory (the running one is never touched)
#   2. run the migrations (they are backwards compatible, so the old code keeps working)
#   3. swap the directories over
#   4. restart the service
#   5. check it is answering
#   6. if it is not, put the old version back and start that instead
#
# On a fresh instance (after Oracle reclaimed the old one), run deploy/oci/provision.sh first, then this.
# ================================================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- the layout --------------------------------------------------------------------------------
# /opt/phylax/current      the running version
# /opt/phylax/releases/x   each built version, kept for a while
# /opt/phylax/shared       the things that survive a release: logs, the .env, the uploads
APP_ROOT="${APP_ROOT:-/opt/phylax}"
CURRENT="$APP_ROOT/current"
RELEASES="$APP_ROOT/releases"
SHARED="$APP_ROOT/shared"
ENV_FILE="${ENV_FILE:-/etc/phylax/phylax.env}"
SERVICE="${SERVICE:-phylax}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
# The same strict parser is used by systemd's env-runner; root deployment tooling must never source the env as code.
# shellcheck source=deploy/lib.sh
. "$SCRIPT_DIR/lib.sh"

LOG_PREFIX="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log()  { printf '%s [deploy] %s\n' "$LOG_PREFIX" "$*"; }
fail() { printf '%s [deploy] FAILED: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }

# ---- who is running this, and what they may touch ----------------------------------------------------
#
# This script runs as root: it restarts services and writes into root-owned directories. Root must never
# execute build inputs out of a tree that another user can write to — `npm ci` runs arbitrary postinstall code,
# so that would be a direct privilege escalation from the service account to root. The source tree belongs to
# BUILD_USER, and this script refuses to build in a tree the service user (or anybody else) can write.
if [ "$(id -u)" -eq 0 ]; then
  BUILD_USER="${BUILD_USER:-phylax-build}"
  SOURCE_OWNER="$(stat -c '%U' "$REPO_ROOT" 2>/dev/null || echo unknown)"
  if [ "$SOURCE_OWNER" != "root" ] && [ "$SOURCE_OWNER" != "$BUILD_USER" ]; then
    fail "refusing to build as root from $REPO_ROOT, owned by $SOURCE_OWNER (expected $BUILD_USER); run: chown -R $BUILD_USER:$BUILD_USER $REPO_ROOT"
  fi
else
  BUILD_USER=""
fi

DO_PULL=1
REF=""
ROLLBACK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-pull) DO_PULL=0; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --ref) [ "$#" -ge 2 ] || fail "--ref requires a value"; REF="$2"; shift 2 ;;
    --ref=*) REF="${1#--ref=}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
mkdir -p "$RELEASES" "$SHARED"
exec 9>"$SHARED/deploy.lock"
flock -n 9 || fail "another deployment is running"
OLD_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || true)"

# Point `current` at a release.
#
# `current` is normally a symlink, and `mv -T` replaces a symlink atomically: there is never a moment when it
# points at nothing, so a request that arrives during a deploy still finds a server. On the very first run it
# is an ordinary directory, and that has to be removed first.
swap_release() {
  local target="$1"
  if [ -L "$CURRENT" ]; then
    ln -sfn "$target" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
  else
    if [ -d "$CURRENT" ]; then
      OLD_RELEASE="$RELEASES/bootstrap-$(date -u +%Y%m%dT%H%M%S)-$$"
      mv "$CURRENT" "$OLD_RELEASE"
      touch "$OLD_RELEASE/.complete"
    fi
    ln -sfn "$target" "$CURRENT"
  fi
}

# ---- the maintenance page ---------------------------------------------------------------------------
# nginx serves this while the schema is being changed, so a deploy that has to take the service down says so
# instead of returning connection errors. It is a static file the deploy script writes, and nginx checks for
# its existence on every request — so it works without a reload, and removing the file turns the app back on.
MAINTENANCE_FLAG="/var/lib/phylax/maintenance"
maintenance_on() {
  mkdir -p /var/lib/phylax
  cat > "$MAINTENANCE_FLAG" <<MAINT
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phylax is being updated</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e6edf7;display:grid;place-items:center;min-height:100vh;margin:0}
div{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}p{color:#9fb0c7;line-height:1.6}</style></head>
<body><div><h1>Phylax is being updated</h1>
<p>An update is being applied, including a change to the database schema. This usually takes a couple of minutes.
Your shifts and settings are safe. Please check back shortly.</p></div></body></html>
MAINT
  chmod 644 "$MAINTENANCE_FLAG"
  log "maintenance mode on"
}
maintenance_off() {
  rm -f "$MAINTENANCE_FLAG"
  log "maintenance mode off"
}

# ---- the rollback ------------------------------------------------------------------------------
if [ "$ROLLBACK" -eq 1 ]; then
  PREVIOUS="$(find "$RELEASES" -mindepth 2 -maxdepth 2 -name .complete -printf '%h\n' | sort -r | grep -vxF "$OLD_RELEASE" | head -1 || true)"
  [ -n "$PREVIOUS" ] || fail "there is no earlier release to go back to"
  [ "$(cat "$PREVIOUS/.schema-contract" 2>/dev/null || true)" = "$(cat "$OLD_RELEASE/.schema-contract" 2>/dev/null || true)" ] || fail "schema contract differs; restore the pre-migration backup in maintenance mode before rolling back"
  log "going back to $PREVIOUS"
  swap_release "$PREVIOUS"
  systemctl restart "$SERVICE"
  sleep 3
  curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null && log "the previous version is up" || fail "the previous version did not come up either"
  exit 0
fi

cd "$REPO_ROOT"

# ---- 1. the source -----------------------------------------------------------------------------
if [ "$DO_PULL" -eq 1 ]; then
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    log "pulling"
    if [ -n "$REF" ]; then git fetch --all --tags && git checkout "$REF"; else git pull --ff-only; fi
  else
    log "not a git checkout; building what is here"
  fi
fi

# ---- 2. build ----------------------------------------------------------------------------------
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RELEASE_DIR="$RELEASES/$RELEASE_ID"
log "building into $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# The manifest goes first: the runtime dependencies are installed into the release directory, so each release is
# complete and can be rolled back to on its own.
for f in package.json package-lock.json; do
  [ -f "$REPO_ROOT/$f" ] && cp "$REPO_ROOT/$f" "$RELEASE_DIR/"
done

# Runtime dependencies are cached by lockfile hash. Existing hashes can be deployed without fetching
# runtime packages; new hashes fail closed if the registry or installation is unavailable.
[ -f "$RELEASE_DIR/package-lock.json" ] || fail "a lockfile is required"
LOCK_HASH="$(sha256sum "$RELEASE_DIR/package-lock.json" | cut -d' ' -f1)"
DEPS_ROOT="$SHARED/dependencies/$LOCK_HASH"
if [ ! -f "$DEPS_ROOT/.complete" ]; then
  log "installing immutable dependencies for $LOCK_HASH"
  TMP_DEPS="$(mktemp -d "$SHARED/deps.XXXXXX")"
  cp "$RELEASE_DIR/package.json" "$RELEASE_DIR/package-lock.json" "$TMP_DEPS/"
  if ! (cd "$TMP_DEPS" && npm ci --omit=dev --no-audit --no-fund) >>"$RELEASE_DIR/npm.log" 2>&1; then
    rm -rf "$TMP_DEPS"
    fail "dependency install failed; the current release is unchanged"
  fi
  mkdir -p "$(dirname "$DEPS_ROOT")"
  touch "$TMP_DEPS/.complete"
  mv "$TMP_DEPS" "$DEPS_ROOT"
fi
ln -sfn "$DEPS_ROOT/node_modules" "$RELEASE_DIR/node_modules"
# Each release keeps its own content-addressed dependency symlink. Never replace an old release's modules.

# The build itself needs the development dependencies (vite, esbuild), so the build happens where the source is
# and the output is copied across.
if [ ! -f "$REPO_ROOT/node_modules/.phylax-build-hash" ] || [ "$(cat "$REPO_ROOT/node_modules/.phylax-build-hash" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  npm ci --include=dev --no-audit --no-fund >>"$RELEASE_DIR/build.log" 2>&1 || fail "build dependency install failed"
  printf '%s' "$LOCK_HASH" > "$REPO_ROOT/node_modules/.phylax-build-hash"
fi
log "building"
npm run build >>"$RELEASE_DIR/build.log" 2>&1 || {
  log "the build failed; the log is at $RELEASE_DIR/build.log"
  tail -30 "$RELEASE_DIR/build.log" || true
  fail "the build failed"
}

npm run check >>"$RELEASE_DIR/build.log" 2>&1 || fail "typecheck failed"
[ -f "$REPO_ROOT/dist/index.js" ] || fail "the build produced no server"
[ -f "$REPO_ROOT/dist/public/index.html" ] || fail "the build produced no frontend"

# What the release needs at runtime.
mkdir -p "$RELEASE_DIR/dist"
cp -r "$REPO_ROOT/dist/." "$RELEASE_DIR/dist/"
cp -r "$SCRIPT_DIR" "$RELEASE_DIR/deploy" 2>/dev/null || true

# ---- 3. migrate --------------------------------------------------------------------------------
# The app is stopped before a mandatory pre-migration backup and schema changes; incompatible session/queue
# contracts must never overlap old/new processes. Restore across schema changes only in maintenance mode.
#
# The contract is DERIVED from the migration count, not hardcoded. A hardcoded number silently claims every
# release is a schema release, which means every deploy stops the service and takes a full encrypted backup
# for a change that touched no schema at all — the most expensive possible way to deploy a documentation fix.
# The number is compared between releases: it only differs when the schema actually differs, which is the only
# time a rollback needs the pre-migration backup.
if [ -f "$ENV_FILE" ]; then
  phylax_load_env "$ENV_FILE" || fail "cannot parse the Phylax environment file safely: $ENV_FILE"
fi
SCHEMA_CONTRACT="$(ls "$RELEASE_DIR/dist/migrations"/*.sql 2>/dev/null | wc -l | tr -d ' ')"
[ "$SCHEMA_CONTRACT" -gt 0 ] || SCHEMA_CONTRACT="unknown"
printf '%s\n' "$SCHEMA_CONTRACT" > "$RELEASE_DIR/.schema-contract"
if [ -n "${DATABASE_URL:-}" ]; then
  # ---- how many migrations this release would apply -----------------------------------------------
  #
  # Three separate defects made this gate fail OPEN, which is the worst direction a deployment gate can fail:
  #
  #   1. `node dist/index.js --migration-status` used to run `migrate()` BEFORE it checked the flag, so the
  #      command that DECIDES whether a release needs a maintenance window was itself applying the schema while
  #      the OLD release was still serving traffic. Migration 010 rewrites session ids to digests, which old code
  #      cannot read: asking "are there pending migrations?" signed everybody out. Fixed in server/index.ts,
  #      where the status branch now runs first and writes nothing.
  #   2. `2>/dev/null` threw away the reason. A missing backup receipt, a database that would not accept a
  #      connection and a syntax error all produced exactly the same silence.
  #   3. `|| echo '{"pending":[]}'` turned that silence into "nothing was pending", and the JSON parser's own
  #      `catch` printed "0" for any output that was not JSON at all.
  #
  # Put together: if the status call failed for ANY reason, this deploy skipped the maintenance page, skipped
  # stopping the service, skipped the mandatory encrypted off-machine pre-migration backup, promoted the release
  # and restarted it against a schema it had just failed to inspect. That is a data-loss path with no operator in
  # it. It now fails CLOSED, before anything is stopped: stderr is kept, the exit status is checked, the output is
  # required to be one line of JSON of the expected shape, and a failure aborts the deploy with the old release
  # still running and the service still up.
  STATUS_OUT="$(mktemp)"
  STATUS_ERR="$(mktemp)"
  set +e
  ( cd "$RELEASE_DIR" && node dist/index.js --migration-status ) >"$STATUS_OUT" 2>"$STATUS_ERR"
  STATUS_RC=$?
  set -e
  if [ "$STATUS_RC" -ne 0 ]; then
    sed 's/^/    /' "$STATUS_ERR" >&2 || true
    rm -f "$STATUS_OUT" "$STATUS_ERR"
    fail "could not read the migration status of this release (exit $STATUS_RC). Nothing was stopped and no schema was changed. The output above says why; a missing or unreadable backup receipt and a database that will not accept a connection are the two common causes."
  fi
  # Exactly one line of JSON comes out of that branch, so anything else means the process wrote something
  # unexpected and the answer cannot be trusted.
  if [ "$(wc -l < "$STATUS_OUT" | tr -d ' ')" != "1" ]; then
    sed 's/^/    /' "$STATUS_OUT" >&2 || true
    rm -f "$STATUS_OUT" "$STATUS_ERR"
    fail "--migration-status wrote something other than one line of JSON. Nothing was stopped and no schema was changed."
  fi
  STATUS_FILE="$STATUS_OUT" node -e "
    const raw = require('node:fs').readFileSync(process.env.STATUS_FILE, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { process.stderr.write('not valid JSON: ' + raw.slice(0, 400) + '\n'); process.exit(3); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.pending)) {
      process.stderr.write('not the expected shape {pending: string[]}: ' + raw.slice(0, 400) + '\n');
      process.exit(3);
    }
    if (parsed.readOnly !== true) {
      process.stderr.write('the status command did not report itself read-only; refusing to trust it\n');
      process.exit(3);
    }
    require('node:fs').writeFileSync(process.env.STATUS_FILE + '.count', String(parsed.pending.length));
  " || {
    rm -f "$STATUS_OUT" "$STATUS_ERR" "$STATUS_OUT.count"
    fail "the migration status was not a usable answer. Nothing was stopped and no schema was changed."
  }
  PENDING_COUNT="$(cat "$STATUS_OUT.count")"
  rm -f "$STATUS_OUT" "$STATUS_ERR" "$STATUS_OUT.count"
  case "$PENDING_COUNT" in (*[!0-9]*|'') fail "the migration status produced a count that is not a number: '$PENDING_COUNT'." ;; esac
  log "migration status: $PENDING_COUNT pending"
  if [ "$PENDING_COUNT" -gt 0 ]; then
    log "$PENDING_COUNT migration(s) pending; this release needs a maintenance window"
    bash "$SCRIPT_DIR/install-backup-tools.sh"
    # Maintenance mode first: a migration that takes the schema somewhere new leaves the app answering 503 from
    # nginx with a page that explains itself, instead of a half-migrated API returning 500s to real people.
    maintenance_on
    systemctl stop "$SERVICE"
    log "taking mandatory encrypted off-machine pre-migration backup"
    /usr/local/lib/phylax-backup/backup.sh || { maintenance_off; systemctl start "$SERVICE"; fail "pre-migration backup failed; current release restarted without database changes"; }
    log "applying the migrations"
    MIGRATOR_ENV_FILE="${MIGRATOR_ENV_FILE:-/etc/phylax/migrator.env}"
    [ -r "$MIGRATOR_ENV_FILE" ] || { maintenance_off; systemctl start "$SERVICE"; fail "the root-only migration credential file is missing: $MIGRATOR_ENV_FILE"; }
    phylax_load_env "$MIGRATOR_ENV_FILE" || { maintenance_off; systemctl start "$SERVICE"; fail "the migration credential file could not be parsed safely"; }
    [ -n "${DATABASE_MIGRATION_URL:-}" ] || { maintenance_off; systemctl start "$SERVICE"; fail "DATABASE_MIGRATION_URL is missing from $MIGRATOR_ENV_FILE"; }
    ( cd "$RELEASE_DIR" && MIGRATIONS_DIR="$RELEASE_DIR/dist/migrations" node dist/index.js --migrate-only ) \
      || { maintenance_off; systemctl start "$SERVICE"; fail "migration failed; the previous release was restarted with the schema as it was"; }
  else
    log "no pending migrations; deploying without a maintenance window"
  fi
fi

# ---- 4. swap -----------------------------------------------------------------------------------
log "switching to the new release"
swap_release "$RELEASE_DIR"

# The shared directory is a symlink into the release, so the logs survive the swap.
mkdir -p "$SHARED/var"
rm -rf "${CURRENT:?}/var" 2>/dev/null || true
ln -sfn "$SHARED/var" "$CURRENT/var"

# ---- 5. restart --------------------------------------------------------------------------------
log "restarting $SERVICE"
systemctl restart "$SERVICE" || log "restart failed; checking health before rollback"

# ---- 6. check ----------------------------------------------------------------------------------
# The check waits out the app's own startup grace (see routes/health.ts): the first tick after a migration is
# the one that legitimately takes a while, and rolling back a healthy release because it was still starting would
# be the worst possible outcome of a deploy.
log "checking"
OK=0
for _ in $(seq 1 40); do
  sleep 1
  if curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
done

if [ "$OK" -eq 0 ]; then
  log "the new version did not come up; putting the old one back"
  PREVIOUS="$OLD_RELEASE"
  if [ -n "$PREVIOUS" ] && [ "$(cat "$PREVIOUS/.schema-contract" 2>/dev/null || true)" = "$(cat "$RELEASE_DIR/.schema-contract" 2>/dev/null || true)" ]; then
    swap_release "$PREVIOUS"
    systemctl restart "$SERVICE"
    sleep 3
    if curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      log "the old version is back up and answering"
      fail "the new release was rolled back"
    fi
  fi
  fail "the new version did not come up, and the old one did not come back either"
fi

log "the new version is up"
maintenance_off
touch "$RELEASE_DIR/.complete"

# ---- 7. tidy up -------------------------------------------------------------------------------
# Old releases are kept, but only a few of them.
ls -1dt "$RELEASES"/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  log "removing the old release $(basename "$old")"
  rm -rf "$old"
done

log "done"
