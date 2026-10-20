#!/usr/bin/env bash
# ================================================================================================
# Phylax — the provisioner for Oracle Cloud Infrastructure
#
# This is the script that turns a fresh Always Free Ampere A1 instance into a running Phylax. Run it ONCE,
# on a new instance, as root:
#
#   sudo ./deploy/oci/provision.sh
#
# It is also the script you run after Oracle reclaims the instance, so it is written to be safe to run again on
# a machine that is already set up: everything it does is idempotent.
#
# WHAT IT DOES
#   1. the system packages: PostgreSQL, nginx, the firewall
#   2. Node.js 24 (from NodeSource)
#   3. the PostgreSQL database, role and password
#   4. the phylax user, the phylax-build user and the directory layout
#   5. the systemd unit
#   6. nginx in front of the app, with the Cloudflare origin certificate
#   7. the backup, the keepalive and the log rotation, all on cron
#   8. the first build and start
#
# THE OWNERSHIP MODEL (this is the part that used to be wrong)
#   /opt/phylax/source     owned by phylax-build (the only user that may write build inputs)
#   /opt/phylax/current    root-owned, 755: the service reads it, nobody writes it
#   /opt/phylax/releases   root-owned, 755: the deploy script writes it, the service reads it
#   /opt/phylax/shared/var owned by phylax: the only place the service writes
#   /var/lib/phylax        owned by phylax
#
# The whole machine used to be one user: /opt/phylax was chowned to the SERVICE user, and root then ran
# `npm ci` and `npm run build` inside it. Every dependency install runs arbitrary postinstall code, so anybody
# who could write a file in that tree — which the internet-facing service could — could execute code as root on
# the next deploy. The build now happens as a separate non-login user (phylax-build) that owns only the source
# tree, the service owns only its own writable state, and root owns everything the service merely reads.
#
# WHAT IT DOES NOT DO
# It does not touch Oracle, and it does not touch Cloudflare. The instance is created in the OCI console (or
# with the OCI CLI — see docs/DEPLOYMENT.md), and the DNS record is pointed at Cloudflare by hand.
# ================================================================================================

set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/phylax}"
APP_USER="${APP_USER:-phylax}"
BUILD_USER="${BUILD_USER:-phylax-build}"
ENV_DIR="${ENV_DIR:-/etc/phylax}"
ENV_FILE="$ENV_DIR/phylax.env"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/phylax}"
SERVICE_FILE="${SERVICE_FILE:-/etc/systemd/system/phylax.service}"
SOURCE_DIR="${SOURCE_DIR:-/opt/phylax/source}"
NODE_MAJOR="${NODE_MAJOR:-24}"
SKIP_APP=0
SKIP_CRON=0

for arg in "$@"; do
  case "$arg" in
    --skip-app) SKIP_APP=1 ;;
    --skip-cron) SKIP_CRON=1 ;;
    --source=*) SOURCE_DIR="${arg#--source=}" ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
  esac
done

LOG_PREFIX="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log()  { printf '%s [provision] %s\n' "$LOG_PREFIX" "$*"; }
fail() { printf '%s [provision] FAILED: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "this script has to run as root"
command -v apt-get >/dev/null 2>&1 || fail "this script is written for Ubuntu (apt-get)"

export DEBIAN_FRONTEND=noninteractive

# ---- 1. the packages ------------------------------------------------------------------------------
: "${PHYLAX_DOMAIN:?Set PHYLAX_DOMAIN to your actual public hostname}"
[[ "$PHYLAX_DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ && "$PHYLAX_DOMAIN" != *example.* ]] || fail "invalid/example hostname"
log "installing the system packages"
apt-get update -qq
apt-get install -y -qq \
  postgresql postgresql-contrib postgresql-client \
  nginx ufw curl ca-certificates gnupg unzip rsync logrotate build-essential \
  >/dev/null

# ---- 2. Node.js -----------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 24 ]; then
  log "installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "node $(node -v)"

# ---- 3. PostgreSQL --------------------------------------------------------------------------------
DB_NAME="${DB_NAME:-phylax}"
DB_USER="${DB_USER:-phylax}"
DB_PASSWORD="${DB_PASSWORD:-}"
if [ -z "$DB_PASSWORD" ]; then
  if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
    DB_PASSWORD="$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')"
  fi
  [ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
fi

log "setting up the database $DB_NAME"
systemctl enable --now postgresql >/dev/null 2>&1 || true
# The role and the database are created only if they are not there already.
if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\"" | grep -q 1; then
  su - postgres -c "psql -c \"CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD'\"" >/dev/null
  log "created the role $DB_USER"
fi
if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\"" | grep -q 1; then
  su - postgres -c "createdb -O $DB_USER $DB_NAME" >/dev/null
  log "created the database $DB_NAME"
fi

# The application connects over TCP, so the password is not the only thing standing between it and the world:
# pg_hba.conf is set to require a password for any connection that is not local.
PGHBA="$(su - postgres -c "psql -tAc 'SHOW hba_file'")"
if [ -f "$PGHBA" ]; then
  if ! grep -q '^host phylax' "$PGHBA"; then
    log "allowing password authentication for the app database"
    printf 'host %s %s 127.0.0.1/32 scram-sha-256\nhost %s %s ::1/128 scram-sha-256\n' \
      "$DB_NAME" "$DB_USER" "$DB_NAME" "$DB_USER" >> "$PGHBA"
  fi
  # The listen address stays local: the database is not exposed to the internet.
  sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost'/" /etc/postgresql/*/main/postgresql.conf 2>/dev/null || true
  systemctl reload postgresql || systemctl restart postgresql
fi

# ---- 4. the users and the directories ----------------------------------------------------------------
log "setting up the $APP_USER user, the $BUILD_USER user and the directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
# The build user: non-login, no home of its own, and it owns ONLY the source tree. It exists so that `npm ci`
# (which runs dependency postinstall scripts) never runs as root inside a directory the service can write to.
id -u "$BUILD_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --no-create-home "$BUILD_USER"
mkdir -p "$APP_ROOT"/{current,releases,shared/var} "$SOURCE_DIR" "$ENV_DIR" /var/backups/phylax /var/lib/phylax

# Ownership, explicitly and in this order. Nothing here is `chown -R $APP_USER $APP_ROOT` any more.
chown root:root "$APP_ROOT" "$APP_ROOT/current" "$APP_ROOT/releases"
chmod 755 "$APP_ROOT" "$APP_ROOT/current" "$APP_ROOT/releases"
# The service writes its own state and nothing else.
chown "$APP_USER:$APP_USER" "$APP_ROOT/shared" "$APP_ROOT/shared/var" /var/lib/phylax
# The build user owns the source tree, and the service user is deliberately NOT in that group.
chown "$BUILD_USER:$BUILD_USER" "$SOURCE_DIR"

chmod 700 /var/backups/phylax
chown root:root /var/backups/phylax
touch /var/log/phylax-backup.log
chown root:root /var/log/phylax-backup.log
chmod 600 /var/log/phylax-backup.log
touch /var/log/phylax-keepalive.log
chmod 600 /var/log/phylax-keepalive.log
chmod 750 "$ENV_DIR"

# ---- 4b. host hardening ------------------------------------------------------------------------------
# Best-effort and idempotent: a machine that already has these configured is left alone. SSH hardening is
# OPT-IN, because changing the port or disabling password authentication can lock an operator out of a machine
# they reach over the network, and that is a decision for the operator, not for a provisioner.
if [ "${PHYLAX_HARDEN_SSH:-0}" = "1" ]; then
  log "hardening sshd (PHYLAX_HARDEN_SSH=1)"
  install -d -m 755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/60-phylax.conf <<'SSHCONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 4
ClientAliveInterval 300
ClientAliveCountMax 2
SSHCONF
  sshd -t 2>/dev/null && systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
else
  log "leaving sshd alone (set PHYLAX_HARDEN_SSH=1 to disable password sign-in and root login)"
fi
if ! command -v fail2ban-client >/dev/null 2>&1; then
  apt-get install -y -qq fail2ban >/dev/null 2>&1 || log "fail2ban is not available in this image; continuing"
fi
if command -v fail2ban-client >/dev/null 2>&1; then
  install -d -m 755 /etc/fail2ban/jail.d
  cat > /etc/fail2ban/jail.d/phylax.conf <<'F2B'
[sshd]
enabled = true
maxretry = 5
findtime = 600
bantime = 3600
[nginx-limit-req]
enabled = true
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 20
findtime = 60
bantime = 600
F2B
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
fi
if ! systemctl is-enabled unattended-upgrades >/dev/null 2>&1; then
  apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 || true
  cat > /etc/apt/apt.conf.d/52unattended-upgrades-phylax <<'APT'
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::SyslogEnable "true";
APT
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
fi
# The journal is capped, so a chatty day cannot fill the disk and take the database down with it.
install -d -m 755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/phylax.conf <<'JOURNAL'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=2week
JOURNAL
systemctl restart systemd-journald >/dev/null 2>&1 || true

# ---- 5. the environment file ------------------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  log "writing $ENV_FILE"
  SECRET="$(openssl rand -hex 32)"
  OPS="$(openssl rand -hex 24)"
  # The key the pre-migration backup receipt is hashed with. The app derives the hash to CHECK the receipt
  # (server/db.ts), and the root-only backup tool derives the same hash to WRITE it (deploy/backup.sh). They must
  # be the same value or a good backup is rejected as tampered. install-backup-tools.sh copies it into the
  # root-only backup environment, which is the only other place it is allowed to live.
  HASH_KEY="$(openssl rand -hex 32)"
  IDENTIFIER_KEY="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
# Phylax — the environment. Generated by provision.sh.
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
APP_URL=https://$PHYLAX_DOMAIN
TZ=UTC
LOG_LEVEL=info
TRUST_PROXY=true
# Production provisioning replaces this with true only after the Cloudflare Origin Pull CA file is present and
# nginx is installed with ssl_verify_client on. The app refuses to start with this false while TRUST_PROXY is on.
REQUIRE_AUTHENTICATED_ORIGIN_PULLS=false
CF_ORIGIN_CA_CERT=/etc/ssl/certs/cloudflare-origin-pull-ca.pem
MONITOR_PUBLIC_URL=https://$PHYLAX_DOMAIN
MONITOR_DISK_WARN_PERCENT=85
MONITOR_CERT_MIN_DAYS=14
MONITOR_PG_MAX_CONN_PERCENT=80
REQUIRE_EXTERNAL_PING=true
# Set this to an HTTPS dead-man-monitor URL (Healthchecks.io, Better Stack, etc.) before release-check.
EXTERNAL_PING_URL=

DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
DATABASE_POOL_MAX=10
# Advisory locks are session-scoped: every held lock pins a connection for the whole operation, so this pool has
# to cover the scheduler's leadership lock, its dispatch workers AND the HTTP account-write guards. Must be >=
# DATABASE_POOL_MAX. The dispatch worker count is derived from it (server/db.ts dispatchWorkerBudget).
DATABASE_LOCK_POOL_MAX=16

SESSION_SECRET=$SECRET
SESSION_TTL_DAYS=365
# Idle expiry, in minutes. 10080 = one week. Without it a lifted cookie stays valid for the whole absolute TTL.
SESSION_IDLE_TIMEOUT_MINUTES=10080
DATABASE_HASH_KEY=$HASH_KEY
# Recipient identifiers (delivery suppressions, per-recipient budgets) are HMAC'd with this. Keeping it separate
# from SESSION_SECRET means a session-secret rotation cannot silently orphan every existing suppression and start
# texting people who replied STOP. Back it up off the VM with the other secrets.
IDENTIFIER_HASH_KEY=$IDENTIFIER_KEY
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax

RP_ID=$PHYLAX_DOMAIN

# If you use SMTP rather than an API provider: set MAIL_PROVIDER=smtp, SMTP_HOST/USER/PASSWORD, and
# MAIL_DELIVERY_EVIDENCE=probe. Ordinary SMTP relays do not post delivery callbacks, so the callback-based gate
# can never be satisfied by one; the probe proves delivery with an operator-confirmed POST /api/ops/probe instead.
MAIL_PROVIDER=disabled
# The real domain, not an example one: config.ts refuses to boot in production with a MAIL_FROM on an
# example/test/localhost domain, because no provider will relay mail from a domain you do not own and the failure
# would otherwise arrive at runtime on the first sign-in link. Change the mailbox if no-reply is not right.
MAIL_FROM=no-reply@$PHYLAX_DOMAIN

SMS_PROVIDER=disabled

SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MS=60000

OPS_TOKEN=$OPS

BACKUP_DIR=/var/backups/phylax
BACKUP_KEEP=14
# Required before production deployment: actual reviewed operator/legal values.
# SERVICE_OPERATOR="Actual operator"
# SERVICE_CONTACT_EMAIL=support@your-real-domain
# SERVICE_JURISDICTION="Actual jurisdiction"
# LEGAL_APPROVED_VERSION=2026-10-17.2
EOF
  chmod 640 "$ENV_FILE"
  chown "root:$APP_USER" "$ENV_FILE"
  log "CHANGE the APP_URL, the RP_ID and the mail provider in $ENV_FILE before going live"
else
  log "$ENV_FILE already exists; leaving it alone"
fi

# Schema changes run under a dedicated non-superuser role with ownership of migration-managed objects. Its DSN is
# stored in /etc/phylax/migrator.env (root:root 0600) and is never included in the phylax service environment.
# The long-running service uses the DML-only phylax role and systemd starts it with --no-migrate.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/create-migrator-role.sh"

# ---- 6. the systemd unit ---------------------------------------------------------------------------
log "installing the systemd unit"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0644 "$SCRIPT_DIR/phylax.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable phylax >/dev/null 2>&1 || true

# ---- 7. nginx --------------------------------------------------------------------------------------
log "installing the nginx configuration"
# Authenticated Origin Pulls is mandatory when Express trusts proxy headers. The CA is public but must be supplied
# explicitly by the operator (download it from Cloudflare's official Authenticated Origin Pulls documentation and
# verify it out-of-band); silently falling back to IP-only trust would let any Cloudflare tenant spoof this zone's
# client IP. The file path is shared with nginx.conf and CF_ORIGIN_CA_CERT in the application environment.
CF_AOP_CA="/etc/ssl/certs/cloudflare-origin-pull-ca.pem"
if [ ! -s "$CF_AOP_CA" ]; then
  fail "Authenticated Origin Pulls is required. Install the Cloudflare Origin Pull CA at $CF_AOP_CA before provisioning nginx."
fi
chmod 0644 "$CF_AOP_CA"
# Update only these exact KEY=value lines without sourcing the application env as shell code. This preserves every
# other value byte-for-byte and makes a second provisioning run idempotent.
python3 - "$ENV_FILE" "$CF_AOP_CA" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
ca = sys.argv[2]
lines = path.read_text().splitlines()
updates = {"REQUIRE_AUTHENTICATED_ORIGIN_PULLS": "true", "CF_ORIGIN_CA_CERT": ca}
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
if [ -f "$NGINX_SITE" ]; then
  cp "$NGINX_SITE" "$NGINX_SITE.bak.$(date +%s)"
fi
install -m 0644 "$SCRIPT_DIR/nginx.conf" "$NGINX_SITE"
sed -i "s/phylax.example.com/$PHYLAX_DOMAIN/g" "$NGINX_SITE"
ln -sfn "$NGINX_SITE" /etc/nginx/sites-enabled/phylax
rm -f /etc/nginx/sites-enabled/default

# The origin certificate, if one has been placed there. Cloudflare's origin CA is what terminates TLS
# between Cloudflare and this machine.
if [ -f /etc/ssl/phylax/origin.pem ] && [ -f /etc/ssl/phylax/origin.key ]; then
  log "using the Cloudflare origin certificate"
else
  fail "Install a valid Cloudflare origin or publicly trusted certificate at /etc/ssl/phylax/origin.pem and origin.key before enabling nginx. No self-signed production fallback."
fi

# ---- 8. the firewall -------------------------------------------------------------------------------
log "setting up the firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
# Only nginx is reachable from the internet. The app is behind it, and the database is not exposed at all.
ufw allow 'Nginx Full' >/dev/null 2>&1 || ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ufw status verbose || true

# ---- 9. cron ---------------------------------------------------------------------------------------
if [ "$SKIP_CRON" -eq 0 ]; then
  log "installing the cron jobs"
  bash "$SCRIPT_DIR/../install-backup-tools.sh"
  rm -f /etc/cron.d/phylax # retire the old app-writable root keepalive and plaintext backup jobs
  service cron restart >/dev/null 2>&1 || systemctl restart cron || true
fi

# ---- 10. the log rotation ---------------------------------------------------------------------------
log "setting up the log rotation"
cat > /etc/logrotate.d/phylax <<EOF
/var/log/phylax-*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

# ---- 11. the app -------------------------------------------------------------------------------------
if [ "$SKIP_APP" -eq 0 ]; then
  if [ -d "$SOURCE_DIR/.git" ] || [ -f "$SOURCE_DIR/package.json" ]; then
    log "building the app from $SOURCE_DIR"
    # The source tree belongs to the build user. If it was left owned by the service user by an older run of
    # this script, that is fixed here before anything is executed out of it.
    chown -R "$BUILD_USER:$BUILD_USER" "$SOURCE_DIR"
    # The build dependencies are installed as the BUILD user, never as root and never as the service user.
    runuser -u "$BUILD_USER" -- bash -c "cd '$SOURCE_DIR' && npm ci --no-audit --no-fund" \
      || fail "build dependencies could not be installed"
    APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" SERVICE=phylax BUILD_USER="$BUILD_USER" \
      bash "$SOURCE_DIR/deploy/redeploy.sh" --no-pull \
      || fail "the application deployment failed; inspect the deployment log"
    # Root owns what the service reads; the service owns only its own state.
    chown -R root:root "$APP_ROOT/current" "$APP_ROOT/releases"
    chown "$APP_USER:$APP_USER" "$APP_ROOT/shared" "$APP_ROOT/shared/var"

  else
    log "no source at $SOURCE_DIR — put the repository there, or copy the build across by hand"
  fi
fi

# ---- 12. nginx and the service ----------------------------------------------------------------------
systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
systemctl enable nginx >/dev/null 2>&1 || true

log ""
log "Host provisioning completed; this is not release acceptance. Configure providers, legal approval, encrypted backup/WAL, then run scripts/release-check.sh."
log ""
log "  the service     systemctl status phylax"
log "  the logs        journalctl -u phylax -f"
log "  the health      curl -s http://127.0.0.1:3000/api/health"
log "  the environment $ENV_FILE   (change APP_URL, RP_ID and MAIL_PROVIDER)"
log "  a backup        sudo /usr/local/lib/phylax-backup/backup.sh"
log ""
log "Origin TLS is a prerequisite. Confirm proxied Cloudflare DNS and Full (strict) TLS."
log "The certificate locations are"
log "  /etc/ssl/phylax/origin.pem and /etc/ssl/phylax/origin.key"
log ""
log "The database credentials are stored in $ENV_FILE (not printed to logs)."
log ""
