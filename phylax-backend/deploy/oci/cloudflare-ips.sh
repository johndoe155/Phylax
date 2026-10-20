#!/usr/bin/env bash
# ================================================================================================
# Phylax — the Cloudflare address list
#
# nginx trusts the CF-Connecting-IP header only when it comes from Cloudflare. If the list of Cloudflare's
# addresses goes stale, a stranger could send that header and pretend to be anyone. So the list is fetched
# from Cloudflare and kept up to date.
#
# Run it from cron, monthly:
#
#   17 4 1 * *  root /opt/phylax/current/deploy/oci/cloudflare-ips.sh
#
# Cloudflare publishes the list at:
#   https://www.cloudflare.com/ips-v4
#   https://www.cloudflare.com/ips-v6
# ================================================================================================

set -euo pipefail

NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/phylax}"
LOG_PREFIX="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log() { printf '%s [cloudflare-ips] %s\n' "$LOG_PREFIX" "$*"; }

[ -f "$NGINX_SITE" ] || { log "$NGINX_SITE is not there"; exit 1; }

V4="$(curl -fsS --max-time 30 https://www.cloudflare.com/ips-v4)" || { log "could not fetch the IPv4 list"; exit 1; }
V6="$(curl -fsS --max-time 30 https://www.cloudflare.com/ips-v6)" || { log "could not fetch the IPv6 list"; exit 1; }

BLOCK="$(printf '%s\n%s\n' "$V4" "$V6" | grep -E '^[0-9a-fA-F:.]+/[0-9]+$' | sort -u | sed 's|^|set_real_ip_from |; s|$|;|')"
[ -n "$BLOCK" ] || { log "the list came back empty; leaving the configuration alone"; exit 1; }

# Replace the run of set_real_ip_from lines with the new list. The new configuration is checked before it
# replaces the old one, so a bad fetch can never take nginx down.
export CF_BLOCK="$BLOCK"
python3 - "$NGINX_SITE" <<'PY'
import os, pathlib, re, sys, ipaddress

path = pathlib.Path(sys.argv[1])
text = path.read_text()
block = os.environ["CF_BLOCK"].strip()
networks=[ipaddress.ip_network(line.split()[1].rstrip(';')) for line in block.splitlines()]
assert sum(n.version==4 for n in networks)>=10 and sum(n.version==6 for n in networks)>=5
assert all(n.prefixlen>0 for n in networks)

pattern = re.compile(r"(?m)^(set_real_ip_from\s+\S+;\n)+")
if not pattern.search(text):
    print("no set_real_ip_from lines were found", file=sys.stderr)
    sys.exit(1)

new_text = pattern.sub(block + "\n", text, count=1)
geo="geo $realip_remote_addr $from_cloudflare {\n default 0;\n"+"\n".join(f" {n} 1;" for n in networks)+"\n}"
new_text=re.sub(r"geo \$realip_remote_addr \$from_cloudflare \{[^}]*\}",lambda _:geo,new_text)
pathlib.Path(str(path)+".new").write_text(new_text)
print("prepared")
PY

if [ ! -f "${NGINX_SITE}.new" ]; then
  log "the list was not updated; leaving the configuration alone"
  exit 1
fi

# Test the actual candidate, not the old active file. Running nginx retains its in-memory
# config until successful reload; restore the disk config on either validation or reload failure.
cp -p "$NGINX_SITE" "${NGINX_SITE}.previous"
cp "${NGINX_SITE}.new" "$NGINX_SITE"
if nginx -t && systemctl reload nginx; then
  rm -f "${NGINX_SITE}.new" "${NGINX_SITE}.previous"
  log "nginx reloaded with validated Cloudflare addresses"
else
  cp -p "${NGINX_SITE}.previous" "$NGINX_SITE"
  rm -f "${NGINX_SITE}.new" "${NGINX_SITE}.previous"
  log "validation or reload failed; original configuration restored"
  exit 1
fi
