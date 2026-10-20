# Deployment — current corrective revision

Start with [the complete configuration and launch gates](RELEASE-REMEDIATION.md). This guide does not claim a remotely executed provisioning run.

## Target

OCI Always Free Ampere A1, selected envelope up to 2 OCPU / 12 GB RAM / 200 GB block storage; actual tenancy availability/eligibility must be checked. Local PostgreSQL, nginx, Cloudflare proxy and Full (strict) TLS, one long-lived Express process serving frontend/API and its in-process scheduler. No Vercel. Idle Always Free instances may be reclaimed; no synthetic keepalive guarantee. Official reference: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Bootstrap order

1. Create/review the Ubuntu/Ampere host, storage, SSH restrictions and OCI network security rules. Keep PostgreSQL and Express unreachable from the Internet.
2. Obtain real domain/origin TLS and install `/etc/ssl/phylax/origin.pem` plus root-readable private key before enabling nginx. Set Cloudflare proxied DNS and Full (strict). No self-signed fallback.
3. Place source in `/opt/phylax/source`. Review `deploy/oci/provision.sh` for the actual OS. Run as root with `PHYLAX_DOMAIN=your-real-domain bash deploy/oci/provision.sh --skip-app`.
4. Complete `/etc/phylax/phylax.env` from `.env.example`: database, cookie/origin/RP values, independent secrets, actual operator/legal approval, supported provider credentials and authenticated callback secrets. Production refuses incomplete legal/unsafe provider configuration. Providers default disabled; this is not a functioning alert service.
5. Install root backup tooling, configure `/etc/phylax/backup.env` from `deploy/backup.env.example`, independently save the dump key off-VM, verify remote encrypted backup/read-back and independent HTTPS alert receipt.
6. Configure real remote encrypted pgBackRest/WAL using `deploy/oci/configure-pitr.sh`. Required PITR variables and maintenance restart are documented in that script/template. Save its encryption configuration/passphrase independently off-VM.
7. Run `deploy/redeploy.sh` as root with the real environment. It builds immutable releases/dependency caches, stops the app, takes mandatory remote encrypted pre-migration backup, migrates, promotes and restarts. Keep the app stopped and investigate a failed migration; do not restore or roll back casually. Schema-contract mismatches require a compatible restore plan.
8. Validate nginx (`nginx -t`), service hardening, Cloudflare origin/Host rejection, root-owned cron/tool/key permissions, provider delivery/callbacks, browser/passkeys, real recovery and independent alert receipt. Nginx deliberately blocks `/api/ops/`; run operator calls against loopback Express.
9. Run isolated real remote restore verification, a separate clean-machine off-VM rebuild/restore, and root `scripts/release-check.sh`. See the remediation checklist for evidence freshness and manual requirements. Do not open production before acceptance.

Keep `/opt/phylax/current` and privileged scripts root-owned. Application writes are confined to `/opt/phylax/shared/var`. App-readable environment must never contain remote backup credentials or decryption keys. Real cron is `/etc/cron.d/phylax-backup`; WAL backups use `/etc/cron.d/phylax-pitr`. The obsolete keepalive cron is removed.
