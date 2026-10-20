#!/usr/bin/env node
/**
 * The one implementation of the backup-receipt hash.
 *
 * Every tool that writes or checks a receipt has to agree on this, byte for byte: the application refuses to
 * migrate without a matching receipt (server/db.ts, databaseReceiptHash), the backup tool writes it, the release
 * gate reads it, and the restore drills produce it. Four copies of the same three lines is four chances for one of
 * them to drift — and a drift shows up as "tampered receipt" on a host where nothing was tampered with.
 *
 * The form is an HMAC keyed by DATABASE_HASH_KEY when that is set: sha256("phylax-db-hash-v1:" + key + ":" + url).
 * Without the key it is the plain digest, so receipts written before the key existed still validate.
 *
 * Usage: node db-hash.mjs [url]      (defaults to $DATABASE_URL)
 */
import { createHash } from "node:crypto";

export function databaseHash(url) {
  const key = (process.env.DATABASE_HASH_KEY ?? "").trim();
  const hash = createHash("sha256");
  if (key) hash.update(`phylax-db-hash-v1:${key}:`);
  hash.update(url ?? "");
  return hash.digest("hex");
}

// Running it directly prints the digest, which is what the shell scripts want.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^\.\//, ""))) {
  process.stdout.write(databaseHash(process.argv[2] ?? process.env.DATABASE_URL ?? ""));
}
