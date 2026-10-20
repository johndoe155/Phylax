#!/usr/bin/env node
/**
 * The one Phylax environment-file parser, shared by the systemd launcher and root shell tooling.
 *
 * Accepted format is deliberately smaller than shell and systemd's full grammars: KEY=value, with blank lines
 * and whole-line comments. Values may be unquoted safe tokens, or one double-quoted literal. Quoted literals do
 * not perform variable expansion and may not contain backslash escapes, backticks or newlines. Duplicate keys,
 * malformed assignments and shell expansion/control syntax are rejected. This makes a file readable with the same
 * meaning by the app launcher and shell tools without ever evaluating it as code.
 *
 * CLI: node env.mjs --nul FILE emits KEY=value entries NUL-delimited (for safe `export "$entry"` in Bash),
 *      node env.mjs --check FILE validates without printing values, and `--json` emits a JSON object.
 */
import { readFileSync } from "node:fs";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_BARE = /^[A-Za-z0-9_./:@,+%=-]*$/;
const DANGEROUS_ALWAYS = /[\0\r\n$`\\]/;

export function parseEnvText(text, source = "environment file") {
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error(`${source}: file exceeds 1 MiB`);
  const values = Object.create(null);
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`${source}:${lineNumber}: expected KEY=value (no export, shell statements or inline comments)`);
    const [, key, encoded] = match;
    if (!KEY.test(key)) throw new Error(`${source}:${lineNumber}: invalid key`);
    if (Object.hasOwn(values, key)) throw new Error(`${source}:${lineNumber}: duplicate key ${key}`);
    let value;
    if (encoded.startsWith('"')) {
      if (!encoded.endsWith('"') || encoded.length < 2) throw new Error(`${source}:${lineNumber}: quoted values must use one complete double-quoted literal`);
      value = encoded.slice(1, -1);
      if (value.includes('"') || DANGEROUS_ALWAYS.test(value)) {
        throw new Error(`${source}:${lineNumber}: quoted values cannot contain quotes, $, backticks, backslashes, NUL or newlines`);
      }
      // Double quotes are interpreted literally by both this parser and the supported shell/systemd subset;
      // shell operators are not evaluated because this file is never sourced and systemd does not execute them.
    } else {
      value = encoded;
      if (!SAFE_BARE.test(value)) {
        throw new Error(`${source}:${lineNumber}: unsafe unquoted value; use a double-quoted literal, without $, backticks or backslashes`);
      }
    }
    values[key] = value;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const mode = process.argv[2];
    const path = process.argv[3];
    if (!path || !["--nul", "--check", "--json"].includes(mode)) {
      process.stderr.write("Usage: node env.mjs (--nul|--check|--json) FILE\n");
      process.exitCode = 2;
    } else {
      const parsed = parseEnvText(readFileSync(path, "utf8"), path);
      if (mode === "--nul") {
        for (const [key, value] of Object.entries(parsed)) process.stdout.write(`${key}=${value}\0`);
      } else if (mode === "--json") {
        process.stdout.write(`${JSON.stringify(parsed)}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
