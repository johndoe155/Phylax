#!/usr/bin/env bash
# ================================================================================================
# Phylax — the shared shell helpers
#
# Sourced by the backup, the restore and the keepalive. Nothing in here runs on its own.
# ================================================================================================

# phylax_load_env <file>
#
# Parse a Phylax environment file with the single strict Node parser also used by env-runner.mjs. Never `source`
# an operator-controlled env file as root: `$()`, semicolons and redirections are shell syntax, not data. The
# parser emits NUL-delimited KEY=value pairs; `export "$entry"` is a literal assignment (no eval, splitting or
# pathname expansion). Values containing NUL/newlines are rejected by the parser because Bash cannot represent them.
phylax_load_env() {
  local file="${1:-}" parser output entry
  [ -n "$file" ] && [ -r "$file" ] || { printf 'Cannot read environment file: %s\\n' "$file" >&2; return 1; }
  parser="${PHYLAX_ENV_PARSER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.mjs}"
  [ -r "$parser" ] || { printf 'Environment parser is missing: %s\\n' "$parser" >&2; return 1; }
  output="$(mktemp)" || return 1
  if ! node "$parser" --nul "$file" > "$output"; then rm -f "$output"; return 1; fi
  while IFS= read -r -d '' entry; do
    # `entry` is a literal KEY=value argument, not the variable to export by name.
    # shellcheck disable=SC2163
    export "$entry"
  done < "$output"
  rm -f "$output"
}

# phylax_parse_db_url <url>
#
# Takes a PostgreSQL connection URL and sets PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE from it.
#
#   postgresql://user:password@host:5432/database?sslmode=require
#
# A URL with no port uses 5432. A URL with no password leaves PGPASSWORD empty, and pg then falls back to
# ~/.pgpass or the environment. A password containing a colon or an at sign has to be percent-encoded, which
# is what a URL requires anyway.
phylax_parse_db_url() {
  local url="${1:-}"
  local -a fields
  mapfile -d '' -t fields < <(PHYLAX_DB_URL="$url" node --input-type=module - <<'JS'
try {
  const url = new URL(process.env.PHYLAX_DB_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("invalid scheme");
  const values = [url.hostname.replace(/^\[|\]$/g, ""), url.port || "5432",
    decodeURIComponent(url.username) || process.env.PGUSER || "postgres",
    decodeURIComponent(url.password) || process.env.PGPASSWORD || "",
    decodeURIComponent(url.pathname.slice(1)) || "postgres", url.searchParams.get("sslmode") || process.env.PGSSLMODE || "prefer"];
  if (values.some(value => value.includes("\0"))) throw new Error("invalid URL");
  process.stdout.write(values.join("\0") + "\0");
} catch { process.stderr.write("Invalid PostgreSQL URL\n"); process.exitCode = 1; }
JS
  )
  [ "${#fields[@]}" -eq 6 ] || return 1
  PGHOST="${fields[0]}"; PGPORT="${fields[1]}"; PGUSER="${fields[2]}"
  PGPASSWORD="${fields[3]}"; PGDATABASE="${fields[4]}"; PGSSLMODE="${fields[5]}"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
  return 0
}

# phylax_log <prefix> <message...>
phylax_log() {
  local prefix="$1"; shift
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$prefix" "$*"
}
