# Operations and recovery — current corrective revision

See [release remediation](RELEASE-REMEDIATION.md) for configuration, actual local evidence and unfinished external acceptance. Nothing below asserts these root workflows were executed on OCI.

## Paths and routine checks

- App: `/opt/phylax/current` → immutable release; runtime writes `/opt/phylax/shared/var`.
- App environment `/etc/phylax/phylax.env`, root-owned/app-readable, not in source.
- Backup secrets `/etc/phylax/backup.env` and `/etc/phylax/backup.key`, root-only. Root-installed tools `/usr/local/lib/phylax-backup/`.
- Dump directory `/var/backups/phylax`, root 0700. Status/restore/PITR receipts `/var/lib/phylax-backup/`, root-owned.
- Cron `/etc/cron.d/phylax-backup`: daily encrypted remote dump 03:15; independent monitor every five minutes. No synthetic keepalive cron. pgBackRest full Sunday/differential other days at 02:30; WAL archive timeout configured 60 seconds.

```sh
systemctl status phylax
journalctl -u phylax --since '1 hour ago'
nginx -t
curl --fail http://127.0.0.1:3000/api/health
# Read independent logs/alerts:
tail /var/log/phylax-backup.log /var/log/phylax-monitor.log
```

Use root environment securely, never shell tracing or secrets in screenshots. For protected calls, supply `X-Ops-Token` via a secure header/input, not URL. GET `/api/ops/status` on loopback shows heartbeat/cursor, provider evidence, queue/dead/failed/bounced counts and notice age. Public nginx denies ops paths.

## Scheduler/delivery

Tick default 60 seconds; stale threshold max(180 seconds, 3 intervals). Collection uses a durable ID-only rotating pass plus a separate priority pass for accounts needing scans or approaching cutoffs; dispatch claims up to 80 across accounts, with workers bounded by the configured lock-pool budget. Per-account upcoming capacity 500; 5,000 total records. A sweep precomputes timezone spans; one conflict digest replaces pair fan-out. Cancellation digests include only conflicting shifts in the assumed-policy lead window. Six reminder dispatch attempts/account/hour plus recipient/global delivery budgets bound churn/abuse. SMS limits estimate segments, not monetary charges.

Retries are exponential up to one hour, max 48 attempts, subject to expiry. Claimed work recovers after 15 minutes; provider acceptance and DB commit are not atomic, so duplicates after a crash remain possible. Resend idempotency helps where supported. Security notices have independent leased durable outbox, max 48 attempts/24-hour expiry. Monitor alerts on old notices (>300 seconds), old due queue (>300 seconds), failed/bounced/dead entries, heartbeat error, stale dumps or WAL repository check failure. Repeated failure notifications are throttled to hourly; inspect logs even when throttled.

POST `/api/ops/probe` only to operator-owned email/phone; confirm real receipt and signed callbacks. `accepted` does not mean delivered. After investigating, POST `/api/ops/reminders/:id/replay` for live dead/failed reminders; each replay changes idempotency generation. POST `.../acknowledge` disposes dead/failed/bounced entries without pretending delivery. Do not remove recipient suppressions or replay permanent bounces without verified correction/consent.

## Backup and restore

Daily dump is AES-256-GCM authenticated, remotely uploaded and downloaded for verification before pruning; default local keep 14, managed-prefix remote age 30 days. AWS per-object retention failures fail the backup even if CLI returns zero. Failure is nonzero, local encrypted backup retained, independent HTTPS alert attempted. Store dump key **and** WAL cipher configuration/passphrase independently off-VM. Lost keys mean unrecoverable backups. Verify the actual selected storage/provider costs; encryption does not make remote storage free.

Root-installed `verify-remote-restore.sh` takes a fresh backup, downloads/decrypts it and restores into an isolated throwaway local database; writes database-bound receipt. `verify-pitr-restore.sh` creates a temporary live canary, switches WAL, restores from the real remote repository into isolated cluster/socket/port, verifies target recovery/promotion and removes canary/test cluster. Schedule with adequate spare disk/RAM. Scripts are Ubuntu/local-PG specific, static checked here, not root-host executed here. Review custom absolute PostgreSQL includes/extensions before drills.

Then perform **another restore on a separate clean VM** with independently saved keys/config. A same-host remote restore is not off-VM recovery evidence. Measure RPO/RTO. Daily dumps alone have nominal 24-hour RPO; 60-second WAL archive timeout is a target, not proof of a maximum data-loss window during outages.

`deploy/restore.sh` requires explicit destructive confirmation (`CONFIRM_RESTORE=<database name>`) and takes an encrypted pre-restore backup of the current database by default, so a restore that turns out to be wrong can itself be undone; set `SKIP_PRERESTORE_BACKUP=true` only when the current contents are worthless (a machine rebuilt from scratch). `deploy/restore-pitr.sh` requires root, PITR_TARGET and CONFIRM_PITR_RESTORE=STOP-AND-RESTORE-PHYLAX; it stops app/PostgreSQL and leaves application restart for human review. Use matching PostgreSQL major version. Never point test scripts at production.

After restore: inspect target/schema/account state, reconcile deletions made after the backup, invalidate/review recovered sessions/tokens/consent/delivery state, verify current secrets and provider suppression, run health and release gates, then reopen service. Restoring old backups can resurrect deleted records and queued work.

## First bootstrap (the receipt that has to exist before anything has been backed up)

Production refuses to apply a pending migration unless there is a root-owned, verified, encrypted, off-machine backup receipt less than 15 minutes old. That is deliberate: a migration is the one moment the schema can be lost, and a schema changed without a backup is unrecoverable.

It also means the very first boot on a brand-new machine cannot migrate, because no backup has ever been taken. That is not a bug to work around, it is the order you do it in:

1. `sudo deploy/oci/provision.sh` — packages, Node, PostgreSQL, the users, the directories, nginx, cron.
2. Put the Cloudflare origin certificate in place (`/etc/ssl/phylax/origin.pem` and `origin.key`).
3. Set `APP_URL`, `RP_ID`, `MAIL_PROVIDER`/`SMS_PROVIDER` and the legal values in `/etc/phylax/phylax.env`.
4. Configure the off-machine destination and the alert endpoint in `/etc/phylax/backup.env` (the same `DATABASE_HASH_KEY` is copied there automatically).
5. `sudo /usr/local/lib/phylax-backup/backup.sh` — the first receipt, which is what unblocks the first migration.
6. `sudo deploy/redeploy.sh` — builds, migrates (now that a receipt exists), swaps and starts.

A manual restart after a *failed* deploy works the same way: the failure message names `backup.sh`, because that is the only thing standing between a pending migration and a start.

## Monitoring

`/api/health` is public and answers two things: is the service up, and for how long. It deliberately does not publish the scheduler's internals. The operational detail is at `/api/ops/status`, behind the ops token, and it includes the pending migration count, the legal posture and the current delivery suppressions.

The unit sets `UV_THREADPOOL_SIZE=8`. Password hashing (scrypt at N=2^17) runs on libuv's thread pool, which by
default is four threads shared with DNS and file I/O; the application bounds its own concurrency to two, so this is
headroom rather than a limit, and it keeps a password change from queueing behind unrelated work. `CPUQuota=180%`
is the ceiling that keeps it honest.

`monitor.sh` runs from root cron every five minutes and checks the app, the scheduler heartbeat, the delivery queue, the security notices and the backup receipt. When everything passes it pings `EXTERNAL_PING_URL` — an HTTPS dead-man's switch on a service that is not this machine. That ping is the only signal that notices the failure that matters most: a scheduler that quietly stops sending, where nothing throws and nothing on the box looks wrong. Without it, a silent outage looks exactly like a quiet week.

## Ownership of /opt/phylax

`source/` belongs to `phylax-build` (non-login), `current/` and `releases/` to root, and `shared/var` plus `/var/lib/phylax` to the `phylax` service user. The build runs as `phylax-build`; the service never writes to a directory it can execute code from. Do not `chown -R phylax /opt/phylax` — that is the shape that let the internet-facing service write build inputs that root later executed.

## The receipt hash, in one place

Four tools read or write the backup receipt: the application (it refuses to migrate without one), `backup.sh` (it
writes one), `scripts/release-check.sh` (it validates one) and the two restore drills (they produce one). They all
call the same module, `deploy/db-hash.mjs`, so a change to the derivation is a change in exactly one place. The
form is `sha256("phylax-db-hash-v1:" + DATABASE_HASH_KEY + ":" + DATABASE_URL)` when the key is set, and the plain
digest when it is not — so receipts written before the key existed still validate.

If a legitimate receipt is ever rejected as tampered, the derivation has drifted; `npm test` includes a case that
pins the module against `server/db.ts`'s `databaseReceiptHash`, keyed and unkeyed.

## Release gate

Run `scripts/release-check.sh` as root after actual provider and restore drills. Requires production/PITR, independent secrets, healthy monitor/queue, current delivered callback evidence, operator-approved legal fields, public TLS health, alert endpoint acknowledgement, and root-owned database-bound fresh dump (26h), remote dump restore (7d), remote WAL restore (7d) receipts. It still requires human browser/device/physical receipt/off-VM/alert review. Do not synthesize proof receipts.
