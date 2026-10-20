import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute, queryOne } from "./db.js";
import { identifierHash } from "./auth/tokens.js";
import { setupDatabase, teardownDatabase, TEST_DATABASE_URL } from "./test-helpers.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ops = join(repo, "scripts", "phylax-ops.mjs");
type OpsResult = {
  keys?: { key: string; fingerprint: string }[];
  suppressionRows?: number;
  suppressed?: boolean;
  matches?: { key: string; hash: string; reason: string; createdAt: string }[];
  cleared?: number;
  rows?: { recipient_hash: string; reason: string }[];
};
describe.skipIf(!TEST_DATABASE_URL)("hashed suppression operator CLI", () => {
  let dir: string;
  let envFile: string;
  const current = "c".repeat(64);
  const previous = "p".repeat(64);
  const env = { ...process.env };
  beforeAll(async () => {
    await setupDatabase();
    dir = mkdtempSync(join(tmpdir(), "phylax-ops-test-"));
    envFile = join(dir, "phylax.env");
    writeFileSync(envFile, [
      `NODE_ENV=test`,
      `DATABASE_URL=${TEST_DATABASE_URL}`,
      `SESSION_SECRET=${"s".repeat(64)}`,
      `IDENTIFIER_HASH_KEY=${current}`,
      `IDENTIFIER_HASH_PREVIOUS_KEYS=${previous}`,
      "DATABASE_SSL=false",
      "",
    ].join("\n"), { mode: 0o600 });
  });
  afterAll(async () => { if (dir) rmSync(dir, { recursive: true, force: true }); await teardownDatabase(); });
  const run = (...args: string[]): OpsResult => JSON.parse(execFileSync(process.execPath, [ops, "--env-file", envFile, ...args], {
    cwd: repo, env: { ...env, DATABASE_URL: TEST_DATABASE_URL }, encoding: "utf8",
  })) as OpsResult;

  it("checks a recipient across the previous key and clears it by its opaque hash", async () => {
    const address = `ops-${crypto.randomUUID()}@example.com`;
    const canonical = `email:${address.toLowerCase()}`;
    const oldHash = identifierHash({ identifierHashKey: previous }, canonical);
    await execute("INSERT INTO delivery_suppressions(recipient_hash,reason) VALUES($1,'complained')", [oldHash]);
    const checked = run("suppression", "check", "--channel", "email", "--address", address);
    expect(checked.suppressed).toBe(true);
    expect(checked.matches).toEqual([expect.objectContaining({ key: "previous-1", hash: oldHash, reason: "complained" })]);
    expect(JSON.stringify(checked)).not.toContain(address);
    const cleared = run("suppression", "clear", "--hash", oldHash, "--reason", "complained");
    expect(cleared.cleared).toBe(1);
    expect(await queryOne("SELECT recipient_hash FROM delivery_suppressions WHERE recipient_hash=$1", [oldHash])).toBeNull();
  });

  it("prints key fingerprints and row count, never the configured key material", async () => {
    const result = run("identifiers", "keys");
    const text = JSON.stringify(result);
    const keys = result.keys ?? [];
    expect(keys).toHaveLength(2);
    expect(keys[0]?.key).toBe("current");
    expect(keys[1]?.key).toBe("previous-1");
    expect(text).not.toContain(current);
    expect(text).not.toContain(previous);
    expect(result.suppressionRows).toEqual(expect.any(Number));
  });
});
