import { loadMigrations, type Migration } from "./loader.js";

/**
 * The migration list, in order.
 *
 * The SQL lives in `server/migrations/*.sql` and is read from disk, so the same code runs under `tsx` while
 * developing and inside the bundled server in production. The build copies the files into `dist/migrations`.
 *
 * To add a migration: create `server/migrations/0NN_name.sql` and add it to the list below. Never edit a migration
 * that has already been applied — add a new one.
 */
export { loadMigrations, migrationsDir } from "./loader.js";
export type { Migration } from "./loader.js";

export const MIGRATIONS: Migration[] = loadMigrations();
