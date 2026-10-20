#!/usr/bin/env bash
# Run as root. Root cron must never execute app-user-writable deployment scripts.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Run as root'; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
# Keep the parser beside the installed root-only scripts; it is also used by systemd's env-runner.
# shellcheck source=deploy/lib.sh
. "$HERE/lib.sh"
install -d -m 755 /usr/local/lib/phylax-backup /var/lib/phylax-backup
install -d -m 700 /var/backups/phylax
for file in backup.sh restore.sh lib.sh env.mjs backup-crypto.mjs remote-retention.mjs db-hash.mjs monitor.sh verify-remote-restore.sh verify-pitr-restore.sh; do install -o root -g root -m 755 "$HERE/$file" /usr/local/lib/phylax-backup/; done
install -o root -g root -m 755 "$(dirname "$HERE")/scripts/phylax-ops.mjs" /usr/local/lib/phylax-backup/
if [ ! -f /etc/phylax/backup.key ]; then umask 077; openssl rand -hex 32 > /etc/phylax/backup.key; fi
chown root:root /etc/phylax/backup.key; chmod 600 /etc/phylax/backup.key
if [ ! -f /etc/phylax/backup.env ]; then install -o root -g root -m 600 /dev/null /etc/phylax/backup.env; fi
# The backup receipt hash key, kept in step with the app's own copy. The app checks the receipt the backup tool
# writes; if the two derive different hashes, a perfectly good backup is refused and production will not migrate.
# It is read from the root-readable app environment and written to the root-ONLY backup environment — it is never
# exposed to the service user, and it is never printed.
if ! grep -q '^DATABASE_HASH_KEY=' /etc/phylax/backup.env 2>/dev/null; then
  phylax_load_env /etc/phylax/phylax.env
  APP_HASH_KEY="${DATABASE_HASH_KEY:-}"
  if [ -n "$APP_HASH_KEY" ]; then
    printf 'DATABASE_HASH_KEY=%s\n' "$APP_HASH_KEY" >> /etc/phylax/backup.env
    chmod 600 /etc/phylax/backup.env
  fi
fi
# The Cloudflare address list is installed into cron here.
#
# It was not: `deploy/oci/cloudflare-ips.sh` existed, its own header documented the cron line to add, and nothing
# ever added it. nginx therefore trusted whatever `set_real_ip_from` list was compiled into the shipped config,
# forever. Cloudflare adds and withdraws ranges, and a stale list fails in the dangerous direction — a range that
# is no longer theirs is still trusted, so a stranger can send CF-Connecting-IP and be believed about who the
# client is, which is the input to every rate limit and abuse budget in the application.
# Monthly, at a minute that is not on the hour, and only when the site config is in place.
CF_IPS_JOB='17 4 1 * * root [ -x /opt/phylax/current/deploy/oci/cloudflare-ips.sh ] && /opt/phylax/current/deploy/oci/cloudflare-ips.sh >> /var/log/phylax-cloudflare-ips.log 2>&1'
printf '%s\n' \
  '15 3 * * * root /usr/local/lib/phylax-backup/backup.sh >> /var/log/phylax-backup.log 2>&1' \
  '*/5 * * * * root /usr/local/lib/phylax-backup/monitor.sh >> /var/log/phylax-monitor.log 2>&1' \
  "$CF_IPS_JOB" > /etc/cron.d/phylax-backup
touch /var/log/phylax-cloudflare-ips.log; chmod 600 /var/log/phylax-cloudflare-ips.log
chown root:root /etc/cron.d/phylax-backup; chmod 644 /etc/cron.d/phylax-backup
printf '%s\n' 'Back up /etc/phylax/backup.key OFF THE VM in a password manager before first backup. Loss of this key makes backups unrecoverable.'
