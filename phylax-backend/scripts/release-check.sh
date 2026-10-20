#!/usr/bin/env bash
# shellcheck disable=SC1090
# Dynamic sources are operator-selected root-owned environment files, not request data.
# Host release gate. Never substitutes local mocked acceptance for real credentials/infrastructure proof.
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo 'Run on the production host as root';exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The same strict parser is used by systemd's env-runner. Never source operator files as root.
# shellcheck source=deploy/lib.sh
. "$ROOT/deploy/lib.sh"
phylax_load_env "${ENV_FILE:-/etc/phylax/phylax.env}"
phylax_load_env "${BACKUP_SECRETS_FILE:-/etc/phylax/backup.env}"
[ "${NODE_ENV:-}" = production ]
[ "${PITR_ENABLED:-}" = true ]
# Production monitoring must cover the public origin and send a dead-man ping to an external monitor. The former
# detects DNS/edge/TLS failures from the host; the latter is what can page when the entire VM is gone.
MONITOR_PUBLIC="${MONITOR_PUBLIC_URL:-${APP_URL:-}}"
[[ "$MONITOR_PUBLIC" == https://* ]] || { echo 'Set MONITOR_PUBLIC_URL (or APP_URL) to the public HTTPS origin'; exit 1; }
[[ "${EXTERNAL_PING_URL:-}" == https://* ]] || {
  echo 'Set EXTERNAL_PING_URL to an HTTPS dead-man monitor URL'; exit 1;
}
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
node --input-type=module - <<'JS'
import {readFileSync,statSync} from 'node:fs';import {createHash} from 'node:crypto';
// The SAME function the application and the backup tool use — imported from the installed copy, not re-derived
// here. One implementation (deploy/db-hash.mjs) means a change to the derivation is a change in one place, and
// every receipt written by every tool still validates. It is an HMAC keyed by DATABASE_HASH_KEY when that is set,
// and the plain digest when it is not.
const hash=(await import('/usr/local/lib/phylax-backup/db-hash.mjs')).databaseHash(process.env.DATABASE_URL);
for(const [name,max] of [['status',26*3600000],['restore-status',7*86400000],['pitr-status',7*86400000]]){
 const path=`/var/lib/phylax-backup/${name}.json`,s=statSync(path),x=JSON.parse(readFileSync(path));
 const age=Date.now()-Date.parse(x.timestamp);
 if(s.uid!==0||(s.mode&0o022)!==0||!x.ok||x.databaseHash!==hash||!Number.isFinite(age)||age<0||age>max)throw Error(`Invalid or stale real-host proof: ${name}`);
}
JS
bash /usr/local/lib/phylax-backup/monitor.sh
STATUS="$(printf 'X-Ops-Token: %s\n' "${OPS_TOKEN:?}" | curl --fail --silent --show-error --max-time 10 --header @- http://127.0.0.1:3000/api/ops/status)"
printf '%s' "$STATUS" | node -e 'let v="";process.stdin.on("data",d=>v+=d);process.stdin.on("end",()=>{const s=JSON.parse(v);const enabled=c=>!["disabled","log"].includes(c);if(!enabled(s.providers.email)&&!enabled(s.providers.sms))process.exit(1);if(enabled(s.providers.email)&&!s.delivery.email_delivered)process.exit(1);if(enabled(s.providers.sms)&&!s.delivery.sms_delivered)process.exit(1);});'
LEGAL="$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/api/legal)"
printf '%s' "$LEGAL" | node -e 'let v="";process.stdin.on("data",d=>v+=d);process.stdin.on("end",()=>{const s=JSON.parse(v);if(!s.approved||!s.operator||!s.contact||!s.jurisdiction)process.exit(1);});'
# The deployment must be running the version of the documents that was actually approved. A mismatch means the
# code was released against terms the operator never signed off.
export LEGAL_VERSION_REQUIRED="${LEGAL_APPROVED_VERSION:?Set LEGAL_APPROVED_VERSION in the environment file}"
printf '%s' "$LEGAL" | node -e 'let v="";process.stdin.on("data",d=>v+=d);process.stdin.on("end",()=>{const s=JSON.parse(v);
 if(s.currentVersion && s.currentVersion !== process.env.LEGAL_VERSION_REQUIRED) process.exit(1);
 if(s.approvedVersion && s.approvedVersion !== process.env.LEGAL_VERSION_REQUIRED) process.exit(1);});'
# Nobody should be receiving alerts without having accepted the current terms. A legal bump that does not stop
# alerts is not a legal bump.
printf '%s' "$STATUS" | node -e 'let v="";process.stdin.on("data",d=>v+=d);process.stdin.on("end",()=>{const s=JSON.parse(v);
 if(s.legal && s.legal.currentVersion && s.legal.approvedVersion && s.legal.currentVersion !== s.legal.approvedVersion) process.exit(1);});'
curl --fail --silent --show-error --max-time 15 "$APP_URL/api/health" >/dev/null
printf 'Authorization: Bearer %s\n' "${BACKUP_ALERT_TOKEN:-}" | curl --fail --silent --show-error --max-time 10 --header @- -H 'Content-Type: application/json' --data '{"service":"phylax-release-probe","ok":true}' "${BACKUP_ALERT_URL:?}"
echo 'PASS: real-host automated release checks. Also require operator review of policies, real phone/passkey/browser acceptance and confirmation that the alert probe reached the operator.'
