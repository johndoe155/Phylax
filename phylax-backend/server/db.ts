import pg from "pg";
import { readFileSync, statSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "./migrations/index.js";
import { log } from "./log.js";
import type { Config } from "./config.js";

/**
 * The PostgreSQL connection, and the migration runner.
 *
 * One pool for the whole process. The pool is deliberately small (DATABASE_POOL_MAX, default 10): the Always Free VM
 * has 2 OCPU and the workload is tiny, and a small pool keeps the database's own memory footprint modest.
 *
 * The server can run WITHOUT a database (DATABASE_URL unset, development only). In that mode `isDbEnabled` is
 * false and the routes that need storage answer 503; the browser then falls back to its local storage. Production
 * refuses to start in that mode — see config.ts.
 */

const { Pool, types } = pg;

/**
 * `date` columns come back as JS Date objects by default, which is a trap: a `date` column in Postgres is a
 * calendar day with no timezone, but a JS Date is an instant. Reading it as a Date and then formatting it in a
 * timezone shifts the day. The same applies to `int8` (bigint), which loses precision above 2^53.
 *
 * So: `date` comes back as the plain `YYYY-MM-DD` string, and `int8` as a number — unless it is too large for a
 * number to hold exactly, in which case it comes back as the full-precision string rather than a silently
 * rounded one. Everything this app stores in an int8 is a count or a small id, so the string case never fires
 * here; it exists so that a future big value cannot quietly lose precision.
 */
types.setTypeParser(types.builtins.DATE, (v: string) => v);
types.setTypeParser(types.builtins.INT8, (v: string) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

export type QueryParams = readonly unknown[];

let pool: pg.Pool | null = null;
let migrationPool: pg.Pool | null = null;
let lockPool: pg.Pool | null = null;
let dbEnabled = false;
let productionDatabase: string | null = null;

/**
 * How long a connection may sit idle inside a transaction.
 *
 * This is a server-side GUC, and it is one that exists in every supported version. `statement_timeout` (below)
 * is the driver-level equivalent for single statements.
 *
 * What is deliberately NOT here is `query_timeout`, the parameter that would bound a query which keeps making
 * progress without ever finishing. It is PostgreSQL 18 and later only — verified against 17.11, which answers
 * `unrecognized configuration parameter` and refuses the connection outright, so sending it unconditionally
 * takes the whole service down on the versions this deployment actually runs. The bound on a wedged connection
 * is the scheduler's own watchdog instead (see scheduler.ts), which is version-independent and restarts the
 * process rather than hoping a statement will give up.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60000;

/** The connection settings both pools share. */
function poolOptions(config: Config, max: number, connectTimeoutMs: number) {
  return {
    connectionString: config.DATABASE_URL!,
    max,
    // A private CA (a managed database with its own certificate authority) is supported: point
    // DATABASE_CA_CERT at the PEM file and it is trusted in addition to the public roots. The connection is
    // still verified — the option exists so a legitimate deployment does not have to turn TLS checking off.
    ssl: config.DATABASE_SSL
      ? { rejectUnauthorized: true, ...(config.DATABASE_CA_CERT ? { ca: readFileSync(config.DATABASE_CA_CERT) } : {}) }
      : undefined,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: 30000,
    // TCP keep-alive: a connection that died on the other side (VM pause, network drop) is detected instead of
    // being handed out and then failing mid-query.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: "phylax",
    // Server-side GUC. Bounded transactions: a connection that sits idle inside a transaction for a minute is
    // aborted, so a forgotten transaction cannot pin a table version or hold a lock for the rest of the day.
    options: `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  } satisfies pg.PoolConfig;
}

export function initDb(config: Config): pg.Pool | null {
  productionDatabase = config.isProd ? (config.DATABASE_URL ?? null) : null;
  if (!config.DATABASE_URL) {
    dbEnabled = false;
    log.warn("DATABASE_URL is not set: running without a database (development only)");
    return null;
  }
  pool = new Pool(poolOptions(config, config.DATABASE_POOL_MAX, 5000));
  // Production migrations use a distinct, short-lived role/DSN. The app pool remains on DATABASE_URL and is never
  // elevated. `DATABASE_MIGRATION_URL` is intentionally stored in root-only migrator.env, not the service env;
  // deploy scripts load it only for the explicit --migrate-only process. Development/tests without that file keep
  // using the single pool.
  if (config.DATABASE_MIGRATION_URL && config.DATABASE_MIGRATION_URL !== config.DATABASE_URL) {
    const migrationConfig = { ...config, DATABASE_URL: config.DATABASE_MIGRATION_URL };
    migrationPool = new Pool({ ...poolOptions(migrationConfig, 2, 5000), application_name: "phylax-migrator" });
    migrationPool.on("error", (err) => log.error("migration database client error", { error: err }));
  }
  // The lock pool is separate so a slow query can never starve the scheduler's leadership lock or the
  // per-account guards.
  //
  // It was hard-coded at 12, which was too small for what actually competes for it: the scheduler holds ONE
  // connection for its leadership lock for the whole time it is leader, up to four dispatch workers each hold one
  // for the duration of a send (an account-scoped advisory lock, which is session-scoped and therefore cannot be
  // moved to another connection), and every account-mutating HTTP request holds one for the full request. On a
  // busy box the HTTP side drained the pool, the scheduler's `pg_try_advisory_lock` acquisition returned no
  // client, and mutations answered an opaque 503 "storage is temporarily unavailable" that reads like a database
  // outage and is not one.
  //
  // The size is now configuration, with a default that leaves room for both sides, and the number of dispatch
  // workers is DERIVED from it (see scheduler.ts) rather than being an unrelated constant — so raising one without
  // the other cannot silently starve the pool again.
  const lockMax = config.DATABASE_LOCK_POOL_MAX;
  lockPool = new Pool({ ...poolOptions(config, lockMax, 2000), application_name: "phylax-locks" });
  lockPool.on("error", (err) => log.error("lock connection failed", { error: err }));
  pool.on("error", (err) => log.error("idle database client error", { error: err }));
  dbEnabled = true;
  return pool;
}

/**
 * How many scheduler dispatch workers the lock pool can actually support.
 *
 * One connection is reserved for the leadership lock and two for HTTP account-write guards, so a pool of the
 * default 16 supports four workers — the previous constant — without either side being able to lock the other
 * out. Derived, not hard-coded, so `DATABASE_LOCK_POOL_MAX=8` gives two workers instead of four workers fighting
 * over six connections.
 */
export function dispatchWorkerBudget(config: Config): number {
  return Math.max(1, Math.min(4, config.DATABASE_LOCK_POOL_MAX - 3));
}

export function getLockPool():pg.Pool {if(!lockPool)throw Error("Database unavailable");return lockPool;}

/** The outcome of one attempt to check a connection out of the lock pool. */
export type LockAcquire =
  | { ok: true; client: pg.PoolClient; waitedMs: number }
  | { ok: false; reason: "timeout" | "error"; waitedMs: number; error?: unknown };

/**
 * Cumulative counters for lock-pool acquisition, read by the ops health endpoint.
 *
 * B24 was invisible before this: the pool saturated, requests queued on `pg`'s internal wait list, and the only
 * signal was an occasional opaque 503. These counters make contention a number an operator can watch — how many
 * acquisitions timed out, how long they wait, and how deep pg's own queue is right now.
 */
const lockMetrics = { acquired: 0, timeouts: 0, errors: 0, waiting: 0, totalWaitMs: 0, maxWaitMs: 0 };

/** A snapshot of the lock-pool counters plus pg's live pool gauges. */
export function lockPoolMetrics() {
  const attempts = lockMetrics.acquired + lockMetrics.timeouts + lockMetrics.errors;
  return {
    ...lockMetrics,
    avgWaitMs: attempts > 0 ? Math.round(lockMetrics.totalWaitMs / attempts) : 0,
    poolTotal: lockPool?.totalCount ?? null,
    poolIdle: lockPool?.idleCount ?? null,
    poolWaiting: lockPool?.waitingCount ?? null,
  };
}

/**
 * Check a connection out of the lock pool, bounded by `timeoutMs`.
 *
 * `pg` queues `connect()` forever once the pool is full, so without a bound a burst of account writes would pile
 * up behind one another and present as a hang. This races the queued connect against a timer. THE LEAK THIS
 * AVOIDS: if the timer wins, the connect is still queued inside pg, and when a connection frees up pg will hand it
 * to that abandoned waiter — a checked-out connection nobody will ever release. So on timeout we attach a handler
 * that releases it the moment it arrives. The caller turns a timeout into a retryable 409, and a genuine
 * connection failure (the database is down) into a 503.
 */
export async function acquireLockConnection(timeoutMs: number): Promise<LockAcquire> {
  const pool = getLockPool();
  const started = Date.now();
  lockMetrics.waiting += 1;
  const connectPromise = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("lock_acquire_timeout")), timeoutMs);
  });
  const recordWait = () => {
    const waitedMs = Date.now() - started;
    lockMetrics.totalWaitMs += waitedMs;
    if (waitedMs > lockMetrics.maxWaitMs) lockMetrics.maxWaitMs = waitedMs;
    return waitedMs;
  };
  try {
    const client = await Promise.race([connectPromise, timeoutPromise]);
    const waitedMs = recordWait();
    lockMetrics.acquired += 1;
    return { ok: true, client, waitedMs };
  } catch (error) {
    const waitedMs = recordWait();
    if (error instanceof Error && error.message === "lock_acquire_timeout") {
      lockMetrics.timeouts += 1;
      // Release the connection pg will eventually hand to this now-abandoned waiter, so it cannot leak.
      connectPromise.then((c) => c.release()).catch(() => {});
      return { ok: false, reason: "timeout", waitedMs };
    }
    lockMetrics.errors += 1;
    return { ok: false, reason: "error", waitedMs, error };
  } finally {
    if (timer) clearTimeout(timer);
    lockMetrics.waiting -= 1;
  }
}

export const isDbEnabled = () => dbEnabled;

export function getPool(): pg.Pool {
  if (!pool) throw new Error("The database is not configured (DATABASE_URL is not set).");
  return pool;
}

/** Run a query and return its rows. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as unknown[]);
  return res.rows;
}

/** Run a query and return the first row, or null. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run a query and return the affected row count. */
export async function execute(text: string, params?: QueryParams): Promise<number> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rowCount ?? 0;
}

/** Run `fn` inside a transaction, rolling back if it throws. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is already broken; it will be discarded */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The hash the pre-migration backup receipt must carry.
 *
 * It is an HMAC keyed by DATABASE_HASH_KEY when that is set, so the file is not an unsalted digest of the
 * database URL (a world-readable mode-644 status file holding a plain sha256 of a low-entropy password is
 * brute-forceable). Set the SAME value in the app environment (/etc/phylax/phylax.env) and in the root-only
 * backup secrets (/etc/phylax/backup.env); the backup tool, this check and scripts/release-check.sh all derive
 * the same hash from it. Without the key it falls back to the plain digest, which keeps receipts written by an
 * earlier version valid.
 */
export function databaseReceiptHash(url: string): string {
  const key = process.env.DATABASE_HASH_KEY?.trim();
  const hash = createHash("sha256");
  if (key) hash.update(`phylax-db-hash-v1:${key}:`);
  hash.update(url);
  return hash.digest("hex");
}

/** The default location of the backup receipt. Overridable for tests and non-standard layouts. */
export const DEFAULT_BACKUP_STATUS_FILE = "/var/lib/phylax-backup/status.json";

/** How old a receipt may be and still gate a migration: fifteen minutes. */
const RECEIPT_MAX_AGE_MS = 900000;
/** How far in the future a receipt may be dated before it is treated as a clock fault: one minute. */
const RECEIPT_MAX_SKEW_MS = 60000;

export type ReceiptProblem =
  | { code: "missing"; detail: string }
  | { code: "unreadable"; detail: string }
  | { code: "malformed"; detail: string }
  | { code: "not_root_owned"; detail: string }
  | { code: "writable_by_others"; detail: string }
  | { code: "not_ok"; detail: string }
  | { code: "hash_mismatch"; detail: string }
  | { code: "stale"; detail: string }
  | { code: "future_dated"; detail: string };

export type ReceiptCheck =
  | { ok: true; ageMs: number; path: string }
  | { ok: false; path: string; problem: ReceiptProblem };

/**
 * Read and validate the pre-migration backup receipt, WITHOUT throwing.
 *
 * This used to be a chain of `&&` conditions wrapped around a bare `statSync`/`readFileSync`, so the two most
 * likely real-world failures arrived as raw syscalls:
 *
 *   ENOENT  no backup has ever been taken (a fresh box, or the receipt path moved)
 *   EACCES  the receipt is there but the SERVICE user cannot read it
 *
 * The second one was not a corner case, it was the normal case: `backup.sh` wrote the receipt mode 600 inside a
 * mode 700 root-owned directory, and the application runs as `phylax`. So the documented "restart the service
 * after a failed deploy" flow could never succeed under systemd — only a root-run `--migrate-only` could pass the
 * gate — and the operator was handed `EACCES: permission denied, open '/var/lib/phylax-backup/status.json'`
 * with no indication of what to do about it.
 *
 * The receipt is now written world-READABLE (never world-writable) by root, which is safe because its
 * `databaseHash` is an HMAC under `DATABASE_HASH_KEY` (required in production, see config.ts) rather than a bare
 * digest of the connection string. What this function returns is a discriminated result, so the caller can turn
 * each failure into the sentence that actually helps.
 */
export function checkBackupReceipt(databaseUrl: string, path = process.env.BACKUP_STATUS_FILE?.trim() || DEFAULT_BACKUP_STATUS_FILE): ReceiptCheck {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { ok: false, path, problem: { code: "missing", detail: `there is no receipt at ${path}` } };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        path,
        problem: {
          code: "unreadable",
          detail: `the service user cannot read ${path} (${code}). The receipt must be root-owned and world-READABLE: install -d -m 755 on its directory and chmod 0644 the file. It must never be writable by group or other.`,
        },
      };
    }
    return { ok: false, path, problem: { code: "unreadable", detail: `${path} could not be stat'd: ${code ?? String(err)}` } };
  }

  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        path,
        problem: {
          code: "unreadable",
          detail: `the service user cannot read ${path} (${code}). The receipt must be root-owned and world-READABLE: install -d -m 755 on its directory and chmod 0644 the file.`,
        },
      };
    }
    return { ok: false, path, problem: { code: "malformed", detail: `${path} is not valid JSON: ${code ?? String(err)}` } };
  }

  if (!receipt || typeof receipt !== "object") {
    return { ok: false, path, problem: { code: "malformed", detail: `${path} does not contain a receipt object` } };
  }
  const r = receipt as { ok?: unknown; timestamp?: unknown; databaseHash?: unknown };

  if (stat.uid !== 0) {
    return { ok: false, path, problem: { code: "not_root_owned", detail: `${path} is owned by uid ${stat.uid}, not root. A receipt the service user could write would be worthless as a gate.` } };
  }
  // Group-writable or other-writable means the service account could forge its own backup receipt.
  if ((stat.mode & 0o022) !== 0) {
    return { ok: false, path, problem: { code: "writable_by_others", detail: `${path} is writable by group or other (mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 0644 ${path}` } };
  }
  if (r.ok !== true) {
    return { ok: false, path, problem: { code: "not_ok", detail: `the last backup recorded in ${path} FAILED (ok:false). Fix the backup before migrating.` } };
  }

  const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  if (!Number.isFinite(at)) {
    return { ok: false, path, problem: { code: "malformed", detail: `${path} has no parsable ISO-8601 timestamp` } };
  }
  const ageMs = Date.now() - at;
  if (ageMs > RECEIPT_MAX_AGE_MS) {
    return { ok: false, path, problem: { code: "stale", detail: `the receipt is ${Math.round(ageMs / 60000)} minutes old; a migration requires one less than ${RECEIPT_MAX_AGE_MS / 60000} minutes old` } };
  }
  if (at - Date.now() > RECEIPT_MAX_SKEW_MS) {
    return { ok: false, path, problem: { code: "future_dated", detail: `the receipt is dated ${Math.round((at - Date.now()) / 60000)} minutes in the future; check the host clock` } };
  }
  if (typeof r.databaseHash !== "string" || r.databaseHash !== databaseReceiptHash(databaseUrl)) {
    return {
      ok: false,
      path,
      problem: {
        code: "hash_mismatch",
        detail:
          "the receipt was written for a DIFFERENT database, or DATABASE_HASH_KEY differs between the app environment and the backup environment. " +
          "Both must carry the same DATABASE_HASH_KEY (deploy/db-hash.mjs is the single derivation).",
      },
    };
  }
  return { ok: true, ageMs, path };
}

/** The operator-facing sentence for a refused migration. Names the one command that fixes it. */
export function receiptRefusalMessage(check: ReceiptCheck & { ok: false }): string {
  return (
    `A fresh, root-owned, verified, encrypted, off-machine pre-migration backup receipt is required, and ${check.problem.detail}. ` +
    `Run, as root: /usr/local/lib/phylax-backup/backup.sh (it writes ${check.path}), then start the application again.`
  );
}

/**
 * Apply any migration that has not run yet.
 *
 * Each migration runs in its own transaction and is recorded in `schema_migrations`. A migration that fails leaves the
 * database untouched and stops the run, so a half-applied schema is not a thing that can happen.
 *
 * This is safe to call on every boot: applied migrations are skipped.
 */
export async function migrate(): Promise<{ applied: string[]; skipped: number }> {
  if (productionDatabase && !migrationPool) {
    throw new Error("Production migrations require a distinct DATABASE_MIGRATION_URL. Load /etc/phylax/migrator.env for the explicit migration command; the running application role is DML-only.");
  }
  const client = await (migrationPool ?? getPool()).connect();
  const applied: string[] = [];
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_lock(1885895021)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const rows = await client.query<{ version: string; checksum: string | null }>("SELECT version,checksum FROM schema_migrations");
    const done = new Set(rows.rows.map(r => r.version));

    // The production gate, evaluated ONCE for the whole run and only when something is actually pending.
    //
    // It used to be re-evaluated inside the loop, on every migration, which meant a run that took longer than the
    // receipt's fifteen-minute freshness window failed halfway through and left the schema part-migrated. It also
    // read the receipt with a bare statSync, so a fresh box (ENOENT) or an unreadable receipt (EACCES — the normal
    // case, when backup.sh wrote it mode 600 inside a mode 700 root directory and the app runs as `phylax`)
    // surfaced as a raw syscall error instead of the instruction that fixes it.
    const pending = MIGRATIONS.filter(m => !done.has(m.version));
    if (productionDatabase && pending.length) {
      const check = checkBackupReceipt(productionDatabase);
      if (!check.ok) {
        const message = receiptRefusalMessage(check);
        log.error("refusing to migrate without a valid backup receipt", { code: `receipt_${check.problem.code}`, path: check.path, pending: pending.map(m => m.version) });
        throw new Error(message);
      }
      log.info("pre-migration backup receipt accepted", { path: check.path, ageSeconds: Math.round(check.ageMs / 1000), pending: pending.map(m => m.version) });
    }

    for (const m of MIGRATIONS) {
      const checksum = createHash("sha256").update(m.sql).digest("hex");
      const existing = rows.rows.find(row => row.version === m.version);
      if (existing?.checksum && existing.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${m.version}`);
      // One-time checksum baseline for legacy installations; preserve a verified pre-upgrade backup.
      if (done.has(m.version)) { if (!existing?.checksum) await client.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1",[m.version,checksum]); continue; }
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL statement_timeout = '60s'");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)", [m.version,checksum]);
        await client.query("COMMIT");
      } catch (err) { await client.query("ROLLBACK"); throw err; }
      applied.push(m.version);
    }
    return { applied, skipped: MIGRATIONS.length - applied.length };
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(1885895021)"); } finally {
      // `SET lock_timeout` is session state: release it with the connection, or the next user of this pooled
      // client inherits a 10s lock timeout it never asked for.
      try { await client.query("RESET lock_timeout"); } catch { /* the connection is going away anyway */ }
      client.release();
    }
  }
}

/**
 * Which migrations have not been applied yet.
 *
 * The deploy script asks this before it does anything destructive. Every deploy used to stop the service and
 * take a full backup first, even when the release contained no schema change at all; now it can tell the
 * difference and skip the window entirely.
 *
 * THIS FUNCTION MUST NEVER WRITE. It is the read-only half of the migration contract, and `--migration-status`
 * is allowed to run while an older release is still serving traffic. A database that has never been migrated has
 * no `schema_migrations` table at all, so the table is probed with `to_regclass` rather than queried blind: on a
 * fresh box the honest answer is "everything is pending", not a `42P01` that the deploy script would read as an
 * empty answer and treat as "nothing is pending".
 */
export async function migrationStatus(): Promise<{ applied: number; pending: string[] }> {
  if (!isDbEnabled()) return { applied: 0, pending: MIGRATIONS.map(m => m.version) };
  const exists = await query<{ name: string | null }>("SELECT to_regclass('schema_migrations')::text AS name");
  const rows = exists[0]?.name
    ? await query<{ version: string }>("SELECT version FROM schema_migrations")
    : [];
  const done = new Set(rows.map(r => r.version));
  return {
    applied: MIGRATIONS.filter(m => done.has(m.version)).length,
    pending: MIGRATIONS.filter(m => !done.has(m.version)).map(m => m.version),
  };
}

/** Close the pool. Called on shutdown, after the scheduler has stopped. */
export async function closeDb(): Promise<void> {
  const p = pool;
  const m = migrationPool;
  const l = lockPool;
  pool = null;
  migrationPool = null;
  lockPool = null;
  dbEnabled = false;
  await Promise.all([p?.end(), m?.end(), l?.end()]);
}
