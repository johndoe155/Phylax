/**
 * Copy the migration files into the build output.
 *
 * The server reads its migrations from disk, so `dist/` needs its own copy of them. Run as part of `npm run build`.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "server", "migrations");
const to = path.join(root, "dist", "migrations");

if (!existsSync(from)) {
  console.error(`No migrations found at ${from}`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied migrations -> ${path.relative(root, to)}`);
