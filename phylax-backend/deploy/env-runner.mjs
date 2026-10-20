#!/usr/bin/env node
/**
 * systemd launcher: parse the Phylax environment with the shared strict parser, then exec the server as a child.
 *
 * systemd's EnvironmentFile grammar is not shell's grammar. Rather than depend on two subtly different parsers,
 * this small main process is the ONLY reader of /etc/phylax/phylax.env; it spawns Node with the parsed key/value
 * map. It forwards termination signals and propagates the server's exit status, so systemd restart/watchdog
 * behaviour remains that of a normal Type=simple service.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseEnvText } from "./env.mjs";
import { readFileSync } from "node:fs";

const envPath = process.env.PHYLAX_ENV_FILE || "/etc/phylax/phylax.env";
const env = { ...process.env, ...parseEnvText(readFileSync(envPath, "utf8"), envPath) };
const appPath = resolve(process.env.PHYLAX_APP_ENTRY || "dist/index.js");
const child = spawn(process.execPath, [appPath, ...process.argv.slice(2)], { cwd: process.cwd(), env, stdio: "inherit" });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    if (!child.kill(signal)) process.exitCode = signal === "SIGINT" ? 130 : 143;
  });
}
child.on("error", (error) => {
  process.stderr.write(`Phylax server could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.exitCode = signal === "SIGINT" ? 130 : 143;
  else process.exitCode = code ?? 1;
});
