import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The migration list, read from the `.sql` files on disk.
 *
 * The files are read rather than imported so that the same code runs in three places without any loader
 * configuration: `tsx` while developing, `vitest` in the tests, and the bundled `dist/index.js` in production.
 * (esbuild can import a `.sql` file as text, but only the bundled build could, and a build step that copies files
 * around is a build step that can be forgotten.)
 *
 * The build copies `server/migrations/*.sql` into `dist/migrations`, so the deployed server is self-contained.
 *
 * To add a migration: create `server/migrations/0NN_name.sql` and add it to `server/migrations/index.ts`.
 * Never edit a migration that has already been applied — add a new one.
 */

export type Migration = { version: string; sql: string };

/** Where the `.sql` files might be, in the order they are tried. */
function candidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.MIGRATIONS_DIR,
    // the bundled build: dist/migrations
    path.resolve(here, "migrations"),
    // the source tree while developing: server/migrations
    path.resolve(here, "..", "migrations"),
    path.resolve(process.cwd(), "server", "migrations"),
    path.resolve(process.cwd(), "dist", "migrations"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
}

/** The directory the migrations were found in. */
export function migrationsDir(): string {
  for (const candidate of candidates()) {
    if (existsSync(candidate) && existsSync(path.join(candidate, "001_init.sql"))) return candidate;
  }
  throw new Error(
    `The migration files were not found. Looked in:\n${candidates().map((c) => `  - ${c}`).join("\n")}\n` +
      `Set MIGRATIONS_DIR to point at the directory that holds them.`,
  );
}

/** Every migration, in order. The version is the file name without its extension. */
export function loadMigrations(): Migration[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      version: name.replace(/\.sql$/, ""),
      sql: readFileSync(path.join(dir, name), "utf8"),
    }));
}
