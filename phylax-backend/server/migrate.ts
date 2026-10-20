import { loadConfig } from "./config.js";
import { initDb, migrate, closeDb } from "./db.js";
import { log, setLogLevel } from "./log.js";

/**
 * Apply the pending migrations and stop.
 *
 * The server also migrates on boot, which is what makes a redeploy a single command. This script exists for the
 * cases where the migrations should be applied BEFORE the new code starts serving: a migration that changes a
 * column the old code still reads, for instance.
 *
 *   pnpm migrate          apply what is pending
 *   pnpm migrate --status show what has run, without changing anything
 */

async function main() {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. There is nothing to migrate.");
  }
  initDb(config);

  const statusOnly = process.argv.includes("--status");
  if (statusOnly) {
    const { query } = await import("./db.js");
    const exists = await query<{ name: string | null }>("SELECT to_regclass('schema_migrations')::text AS name");
    const rows = exists[0]?.name ? await query<{ version: string; applied_at: Date }>(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    ) : [];
    const { MIGRATIONS } = await import("./migrations/index.js");
    for (const m of MIGRATIONS) {
      const applied = rows.find((r) => r.version === m.version);
      log.info(applied ? "applied" : "pending", {
        version: m.version,
        ...(applied ? { appliedAt: applied.applied_at } : {}),
      });
    }
    await closeDb();
    return;
  }

  const result = await migrate();
  log.info("migrations complete", { applied: result.applied.length, alreadyRun: result.skipped });
  await closeDb();
}

main().catch((err) => {
  log.error("migration failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  process.exit(1);
});
