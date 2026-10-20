import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config } from "./config.js";
import { initDb, migrate, closeDb, query, execute } from "./db.js";

/**
 * Test helpers for the parts of the server that need a database.
 *
 * The tests run against a real PostgreSQL, not a fake: the scheduler's whole job is a set of SQL statements with
 * unique constraints, and a fake would not prove any of it. Set `TEST_DATABASE_URL` to point at a database that
 * may be emptied.
 *
 * When no database is configured, the integration tests skip rather than fail, so `npm test` still works on a
 * machine with no PostgreSQL.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";

let ready = false;
let config: Config | null = null;

/** Prepare the test database: connect, migrate, and make sure it is empty. Returns null when there is none. */
export async function setupDatabase(): Promise<Config | null> {
  if (ready) return config;
  if (!TEST_DATABASE_URL) return null;

  const env = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: "test-secret-that-is-at-least-32-characters-long",
    NODE_ENV: "test",
    SCHEDULER_ENABLED: "false",
  };
  config = loadConfig(env);
  initDb(config);
  await migrate();
  await truncateAll();
  ready = true;
  return config;
}

/**
 * Empty every table, so each test starts from nothing.
 *
 * Two tables here are not per-account data and are the reason this list has to be explicit:
 *
 *   rate_buckets      the durable delivery and abuse budgets. Nothing references `accounts`, so no CASCADE ever
 *                     cleared it, and budgets accumulated ACROSS tests — a test that ran after several others
 *                     could find an account's hourly reminder budget already spent by somebody else's fixture.
 *   scheduler_state   a single row holding the scan cursor, the heartbeat and the last error code. The cursor in
 *                     particular decides which accounts the rotating pass will even look at, so a stale one from
 *                     a previous test silently changes what the next test scans.
 *
 * `schema_migrations` and `valid_timezones` are deliberately NOT truncated: they are reference data, and emptying
 * either would make every later test in the file re-migrate or lose the timezone allow-list.
 */
export async function truncateAll(): Promise<void> {
  await execute(`
    TRUNCATE reminders, conflict_notices, webauthn_challenges, passkeys, account_consents, account_settings,
             patterns, shifts, magic_links, pending_signups, sessions, auth_identities, accounts,
             email_verification_tokens, password_reset_tokens, phone_verifications, oauth_states,
             security_events, security_notices, notification_deliveries, delivery_events, delivery_suppressions,
             rate_buckets
    RESTART IDENTITY CASCADE
  `);
  // A single-row table with no foreign keys: reset it explicitly rather than by cascade.
  await execute("UPDATE scheduler_state SET scan_cursor=NULL, heartbeat_at=NULL, completed_at=NULL, error_code=NULL WHERE id=true");
}

/** Close the pool at the end of the test run. */
export async function teardownDatabase(): Promise<void> {
  if (ready) await closeDb();
  ready = false;
}

/** A signed-in account with alerts switched on. */
export async function makeAccount(opts: {
  email?: string;
  phone?: string | null;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  travelMinutes?: number;
  cancelHours?: number;
  reminderLeadMinutes?: number;
}) {
  const email = opts.email ?? `test-${randomUUID()}@example.com`;
  const rows = await query<{ id: string }>(
    `INSERT INTO accounts (display_name, email, email_verified, phone)
     VALUES ('Test Person', $1, true, $2) RETURNING id`,
    [email, opts.phone ?? null],
  );
  const id = rows[0]!.id;
  await execute(
    `INSERT INTO account_settings
       (account_id, travel_minutes, cancel_hours, email_enabled, sms_enabled, phone, reminder_lead_minutes, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'UTC')`,
    [
      id,
      opts.travelMinutes ?? 60,
      opts.cancelHours ?? 24,
      opts.emailEnabled ?? true,
      opts.smsEnabled ?? false,
      opts.phone ?? null,
      opts.reminderLeadMinutes ?? 180,
    ],
  );
  await execute("INSERT INTO account_consents(account_id,terms_version,privacy_version,accepted_at) VALUES($1,'2026-10-17.2','2026-10-17.2',now())",[id]);
  return { id, email };
}

/** A shift for an account. */
export async function makeShift(
  accountId: string,
  shift: { platform?: string; facility?: string; label?: string; start: number; end: number; date: string },
) {
  const rows = await query<{ id: string }>(
    `INSERT INTO shifts (account_id, platform, facility, label, start_minute, end_minute, date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      accountId,
      shift.platform ?? "ShiftKey",
      shift.facility ?? "Riverside Manor",
      shift.label ?? "Night",
      shift.start,
      shift.end,
      shift.date,
    ],
  );
  return rows[0]!.id;
}

/** The date `n` days from now, as `YYYY-MM-DD`. */
export const dayFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * A shift that starts `hours` from now and runs for `durationHours`.
 *
 * The date and the minutes after midnight are worked out together, so a shift that starts late in the evening
 * lands on the right day and runs over midnight the way the domain says it does.
 */
export const shiftStartingIn = (hours: number, durationHours = 8) => {
  const start = new Date(Date.now() + hours * 3600000);
  const end = new Date(start.getTime() + durationHours * 3600000);
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    date: ymd(start),
    start: start.getHours() * 60 + start.getMinutes(),
    end: end.getHours() * 60 + end.getMinutes(),
  };
};

/** A throwaway copy of the repository's `psql`, for the shell tests. Not used by the unit tests. */
export const psqlAvailable = () => {
  try {
    execSync("command -v psql", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
