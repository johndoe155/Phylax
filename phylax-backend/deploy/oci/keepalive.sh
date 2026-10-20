#!/usr/bin/env bash
# Diagnostic health check only. Artificial load is not a reclaim guarantee and is not installed in cron.
set -euo pipefail
curl --fail --silent --show-error --connect-timeout 2 --max-time 10 "${KEEPALIVE_HEALTH_ORIGIN:-http://127.0.0.1:3000}/api/health"
