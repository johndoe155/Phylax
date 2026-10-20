import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parser = join(repo, "deploy", "env.mjs");
const service = readFileSync(join(repo, "deploy", "oci", "phylax.service"), "utf8");
const withEnv = (text: string, fn: (path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "phylax-env-test-"));
  const path = join(dir, "phylax.env");
  try { writeFileSync(path, text, { mode: 0o600 }); fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

describe("single strict environment parser (B21)", () => {
  it("accepts the checked-in template with no execution or shell evaluation", () => {
    expect(() => execFileSync(process.execPath, [parser, "--check", join(repo, ".env.example")])).not.toThrow();
  });

  it("preserves a quoted literal with shell operators as data, never as code", () => {
    withEnv('MAIL_FROM="Phylax; alerts & updates"\nTOKEN=hex-0123456789\n', (path) => {
      const parsed = JSON.parse(execFileSync(process.execPath, [parser, "--json", path], { encoding: "utf8" })) as Record<string, string>;
      expect(parsed.MAIL_FROM).toBe("Phylax; alerts & updates");
      expect(parsed.TOKEN).toBe("hex-0123456789");
    });
  });

  it.each([
    ["command substitution", "TOKEN=$(touch /tmp/phylax-env-parser-pwned)\n"],
    ["shell separator", "TOKEN=good;touch /tmp/phylax-env-parser-pwned\n"],
    ["shell expansion in quotes", 'TOKEN="${HOME}"\n'],
    ["backtick substitution", "TOKEN=`id`\n"],
    ["duplicate keys", "TOKEN=first\nTOKEN=second\n"],
    ["shell export syntax", "export TOKEN=bad\n"],
    ["inline comments", "TOKEN=ok # ambiguous\n"],
  ])("rejects %s", (_name, text) => {
    withEnv(text, (path) => {
      const result = spawnSync(process.execPath, [parser, "--check", path], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("phylax.env");
    });
  });

  it("systemd does not parse EnvironmentFile; the same Node parser launcher is the sole env reader", () => {
    expect(service).not.toMatch(/^EnvironmentFile=/m);
    expect(service).toContain("ExecStart=/usr/bin/node /opt/phylax/current/deploy/env-runner.mjs --no-migrate");
    expect(service).toContain("PHYLAX_ENV_FILE=/etc/phylax/phylax.env");
    expect(readFileSync(parser, "utf8")).toContain("export function parseEnvText");
  });
});
