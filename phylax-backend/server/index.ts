import { createServer, type Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { initDb, migrate, closeDb, isDbEnabled, migrationStatus } from "./db.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import { log, setLogLevel } from "./log.js";
import { startSystemdWatchdog } from "./watchdog.js";

/**
 * THE SERVER ENTRY POINT.
 *
 * The order of everything here matters, and it is the order the whole deployment depends on:
 *
 *   1. read and validate the environment. If it is wrong, stop now, loudly.
 *   2. open the database and apply any pending migration.
 *   3. build the app and start listening. The site answers requests from this moment.
 *   4. start the scheduler, once the server is up, so the first request is never delayed by it.
 *   5. on SIGTERM (what systemd sends when it stops the unit), shut down in the reverse order:
 *        stop accepting connections
 *        stop the scheduler and wait for the reminder it is sending
 *        close the database pool
 *        exit
 *
 * The shutdown is the part that matters most for a service that is restarted often: a reminder must never be half
 * sent, and a request that is already running must be given its chance to finish.
 */

const SHUTDOWN_GRACE_MS = 75000; // systemd's default TimeoutStopSec is 90s; this is comfortably inside it
const startedAt = Date.now();

let httpServer: Server | null = null;
let scheduler: Scheduler | null = null;
let shuttingDown = false;

async function main() {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  // `node dist/index.js --migrate-only` applies the pending migrations and stops. The deploy script uses it to
  // migrate before the new code starts serving; the server also migrates on boot, so it is never required.
  //
  // `--migration-status` ASKS AND DOES NOT ACT. It used to fall through the same `migrate()` call as every other
  // start-up, so the command the deploy script uses to decide whether a release needs a maintenance window was
  // itself applying the schema — while the OLD release was still serving traffic. Migration 010 rewrites session
  // ids to digests, which old code cannot read: asking "are there pending migrations?" signed everybody out, and
  // a production box with no fresh backup receipt threw instead, which the deploy script's `2>/dev/null` turned
  // into an empty answer and therefore into "0 pending" and therefore into a migrating release deployed with no
  // maintenance page, no app stop and no pre-migration backup.
  //
  // So: the status branch runs FIRST, touches nothing, and writes exactly one line of JSON to stdout. The log is
  // silenced for that branch, because anything else on stdout would be parsed as the answer.
  const migrateOnly = process.argv.includes("--migrate-only");
  const migrationStatusOnly = process.argv.includes("--migration-status");
  // An operator escape hatch: start serving WITHOUT applying migrations. Used by a rollback that has to come up
  // against a schema it did not create, and by a deploy that has already migrated with --migrate-only.
  const noMigrate = process.argv.includes("--no-migrate");

  if (migrationStatusOnly) {
    initDb(config);
    let status: { applied: number; pending: string[]; database: "configured" | "absent"; readOnly: true };
    try {
      const read = isDbEnabled() ? await migrationStatus() : { applied: 0, pending: [] as string[] };
      status = { ...read, database: isDbEnabled() ? "configured" : "absent", readOnly: true };
    } finally {
      await closeDb().catch(() => {});
    }
    // One line, machine-readable, nothing else on this stream.
    process.stdout.write(`${JSON.stringify(status)}\n`);
    return;
  }

  log.info("phylax starting", {
    env: config.NODE_ENV,
    port: config.PORT,
    appUrl: config.APP_URL,
    database: config.DATABASE_URL ? "configured" : "absent",
    scheduler: config.SCHEDULER_ENABLED ? "enabled" : "disabled",
  });

  // 2. the database, and the schema
  initDb(config);
  if (isDbEnabled() && !noMigrate) {
    const result = await migrate();
    if (result.applied.length) log.info("migrations applied", { applied: result.applied });
  } else if (noMigrate) {
    log.warn("started with --no-migrate: pending migrations were NOT applied");
  }

  if (migrateOnly) {
    log.info("migrations complete; stopping as asked");
    await closeDb();
    return;
  }

  // 3. the app, and the scheduler
  //
  // The scheduler is made first, so it can be handed to the app: the health endpoint and the operations
  // endpoints report whether this instance is the one that is sending the reminders.
  scheduler = createScheduler(config);
  const app = createApp({ config, scheduler, startedAt });

  httpServer = createServer(app);
  // Keep-alive a little longer than the default, so a burst of requests reuses connections.
  httpServer.keepAliveTimeout = 5000;
  httpServer.requestTimeout = 30000;
  httpServer.timeout = 30000;
  httpServer.maxRequestsPerSocket = 1000;
  httpServer.headersTimeout = 10000;

  await new Promise<void>((resolve, reject) => {
    httpServer!.once("error", reject);
    httpServer!.listen(config.PORT, config.HOST, () => {
      httpServer!.off("error", reject);
      resolve();
    });
  });
  log.info("listening", { url: `http://${config.HOST}:${config.PORT}` });

  // 4. the scheduler, once the server is answering
  scheduler.start();

  // The systemd watchdog is the second layer behind the scheduler's own hang guard. It only pings while the
  // scheduler is healthy, so a process with a stuck tick goes quiet and gets restarted.
  const stopWatchdog = startSystemdWatchdog(() => scheduler?.health().healthy ?? true);
  if (stopWatchdog) log.info("systemd watchdog armed");

  // ---- the signals ------------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });

    const force = setTimeout(() => {
      log.error("shutdown took too long; exiting anyway");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    try {
      // Stop taking new work.
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        log.info("http server closed");
      }
      // Let the reminder that is being sent finish.
      if (scheduler) {
        await scheduler.stop();
        log.info("scheduler stopped");
      }
      stopWatchdog?.();
      // Only now is it safe to close the pool: the scheduler is done with it.
      await closeDb();
      log.info("database closed");
    } catch (err) {
      log.error("error during shutdown", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(force);
      log.info("stopped", { uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
      process.exit(signal === "uncaughtException" ? 1 : 0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection is a bug, but it is not a reason to drop every connection the process is serving.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err.stack ?? err.message });
    void shutdown("uncaughtException");
  });
}

/** A small helper so a failed start is reported the same way as everything else. */
export function start(): Promise<void> {
  return main().catch(async (err) => {
    log.error("failed to start", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    await closeDb().catch(() => {});
    process.exitCode = 1;
  });
}

// Only run when this file is the process entry point (not when it is imported by a test).
const invokedDirectly =
  typeof process.argv[1] !== "undefined" &&
  (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("server/index.ts"));
if (invokedDirectly) {
  void start();
}

export type { Config };
