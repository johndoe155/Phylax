#!/usr/bin/env node
/**
 * Phylax operator CLI for hashed delivery suppressions and identifier-key rotation.
 *
 * Never prints an address or key. Addresses are canonicalised then HMAC'd with the same v1 domain separator as
 * server/auth/tokens.ts; suppression rows are irreversible keyed hashes, so the operator can look up/clear one by
 * hash or test an address against all current/previous keys without storing plaintext.
 *
 * Usage:
 *   node scripts/phylax-ops.mjs [--env-file /etc/phylax/phylax.env] identifiers keys
 *   node scripts/phylax-ops.mjs suppression hash --channel email --address person@example.com
 *   node scripts/phylax-ops.mjs suppression check --channel sms --address +2348012345678
 *   node scripts/phylax-ops.mjs suppression list [--limit 200] [--reason complained]
 *   node scripts/phylax-ops.mjs suppression clear --hash <64-hex> [--reason complained]
 *
 * Key rotation: set IDENTIFIER_HASH_KEY to a freshly generated key and place EVERY retired key in
 * IDENTIFIER_HASH_PREVIOUS_KEYS. Old suppression rows are one-way HMACs: they CANNOT be rehashed without the
 * original address, which the system intentionally does not retain. Previous keys therefore remain part of the
 * read set for as long as rows hashed with them may exist. Do not remove a previous key merely because the new key
 * is deployed; use `suppression check --address ...` to verify behavior, and retain old keys in encrypted DR copies.
 */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
// When run from the repository the shared parser is ../deploy/env.mjs; install-backup-tools.sh places both files
// side by side under /usr/local/lib/phylax-backup for root-only operation.
const parserModule = await import(existsSync(new URL("../deploy/env.mjs", import.meta.url)) ? "../deploy/env.mjs" : "./env.mjs");
const { parseEnvText } = parserModule;

const usage = `Usage: phylax-ops.mjs [--env-file FILE] <identifiers keys | suppression hash|check|list|clear ...>`;
const args = process.argv.slice(2);
let envFile = process.env.ENV_FILE || "/etc/phylax/phylax.env";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--env-file") {
    if (!args[i + 1]) throw new Error("--env-file requires a path");
    envFile = args[i + 1]; args.splice(i, 2); i--;
  }
}
if (!args.length) throw new Error(usage);
const fileConfig = parseEnvText(readFileSync(envFile, "utf8"), envFile);
const env = { ...fileConfig, ...process.env };
const currentKey = env.IDENTIFIER_HASH_KEY?.trim() || env.SESSION_SECRET?.trim();
if (!currentKey || currentKey.length < 32) throw new Error("IDENTIFIER_HASH_KEY (or SESSION_SECRET fallback) must be configured and at least 32 characters.");
const previousKeys = (env.IDENTIFIER_HASH_PREVIOUS_KEYS || "").split(",").map((k) => k.trim()).filter((k) => k && k !== currentKey);
const uniqueKeys = [...new Set([currentKey, ...previousKeys])];
const keyHash = (key, value) => createHmac("sha256", key).update("phylax-identifier-v1:").update(value).digest("hex");
const canonicalAddress = (channel, address) => {
  if (!['email', 'sms'].includes(channel)) throw new Error("--channel must be email or sms");
  const value = address.trim().toLowerCase();
  if (channel === "email" && (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) || value.length > 320)) throw new Error("--address must be a valid email address");
  if (channel === "sms" && !/^\+[1-9][0-9]{7,14}$/.test(value)) throw new Error("--address must be an E.164 number, such as +2348012345678");
  return `${channel}:${value}`;
};
function option(name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function fingerprint(key) { return createHash("sha256").update(key).digest("hex").slice(0, 12); }
const ssl = env.DATABASE_SSL === "true"
  ? { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: readFileSync(env.DATABASE_CA_CERT, "utf8") } : {}) }
  : undefined;
const db = new pg.Pool({ connectionString: env.DATABASE_URL, ssl, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: "phylax-ops" });

async function main() {
  const [group, action] = args;
  if (group === "identifiers" && action === "keys") {
    const result = await db.query("SELECT count(*)::int AS suppression_rows FROM delivery_suppressions");
    const rows = uniqueKeys.map((key, index) => ({ key: index === 0 ? "current" : `previous-${index}`, fingerprint: fingerprint(key) }));
    process.stdout.write(`${JSON.stringify({ keys: rows, suppressionRows: result.rows[0].suppression_rows, rotationRule: "Keep previous keys until every row written under them is deliberately cleared; hashes cannot be rehashed without plaintext addresses." }, null, 2)}\n`);
    return;
  }
  if (group !== "suppression") throw new Error(usage);
  if (action === "hash" || action === "check") {
    const channel = option("--channel");
    const address = option("--address");
    if (!channel || !address) throw new Error("suppression hash/check requires --channel and --address");
    const canonical = canonicalAddress(channel, address);
    const hashes = uniqueKeys.map((key, index) => ({ key: index === 0 ? "current" : `previous-${index}`, hash: keyHash(key, canonical) }));
    if (action === "hash") {
      process.stdout.write(`${JSON.stringify({ hashes }, null, 2)}\n`);
      return;
    }
    const found = await db.query("SELECT recipient_hash,reason,created_at FROM delivery_suppressions WHERE recipient_hash=ANY($1::text[])", [hashes.map((row) => row.hash)]);
    const byHash = new Map(found.rows.map((row) => [row.recipient_hash, row]));
    const matches = hashes.flatMap(({ key, hash }) => {
      const row = byHash.get(hash);
      return row ? [{ key, hash, reason: row.reason, createdAt: row.created_at }] : [];
    });
    process.stdout.write(`${JSON.stringify({ suppressed: matches.length > 0, matches }, null, 2)}\n`);
    return;
  }
  if (action === "list") {
    const rawLimit = Number(option("--limit") || 200);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) throw new Error("--limit must be a whole number from 1 to 1000");
    const reason = option("--reason");
    const result = await db.query(
      `SELECT recipient_hash,reason,created_at FROM delivery_suppressions
        WHERE ($1::text IS NULL OR reason=$1) ORDER BY created_at DESC LIMIT $2`,
      [reason || null, rawLimit],
    );
    process.stdout.write(`${JSON.stringify({ suppressions: result.rows }, null, 2)}\n`);
    return;
  }
  if (action === "clear") {
    const hash = option("--hash");
    const reason = option("--reason");
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("suppression clear requires --hash with a 64-character lowercase hex digest");
    const result = await db.query(
      "DELETE FROM delivery_suppressions WHERE recipient_hash=$1 AND ($2::text IS NULL OR reason=$2) RETURNING recipient_hash,reason",
      [hash, reason || null],
    );
    process.stdout.write(`${JSON.stringify({ cleared: result.rowCount ?? 0, rows: result.rows }, null, 2)}\n`);
    return;
  }
  throw new Error(usage);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`phylax-ops: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await db.end();
}
