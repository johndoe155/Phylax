import { dispatchSecurityNotices } from "./auth/securityEvents.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { conflictPairs, spanIn, type Shift, type Rules } from "@shared/shifts";
import { getLockPool, query, queryOne, execute, isDbEnabled, dispatchWorkerBudget } from "./db.js";
import { refundBudget, reserveBudget } from "./notifications/control.js";
import { log } from "./log.js";
import { sendMail } from "./notifications/mail.js";
import { sendSms } from "./notifications/sms.js";
import { pruneSessions } from "./auth/sessions.js";
import { pruneChallenges } from "./auth/webauthn.js";
import { prunePendingSignups } from "./auth/pending.js";
import { pruneMagicLinks } from "./auth/magicLinks.js";
import { reconcileDeliveryEvents, sweepReminderStatuses } from "./routes/webhooks.js";
import { LEGAL_VERSION } from "@shared/legal";
import type { Config } from "./config.js";

// At-least-once delivery: a crash after provider acceptance and before DB commit can duplicate a message.
// A unique queue key is NOT an exactly-once guarantee. No network call holds a row transaction open.
const LOCK_KEY = 0x7068796c;
export const MAX_ATTEMPTS = 48;
export const CLAIM_TIMEOUT_SECONDS = 900;
export type SchedulerStats = { ticked: boolean; conflicts: number; cancellations: number; sent: number; failed: number };
export type SchedulerHealth = { enabled: boolean; leader: boolean; lastStartedAt: number | null; lastCompletedAt: number | null; lastError: string | null; healthy: boolean };
export type Scheduler = { start(): void; stop(): Promise<void>; runOnce(): Promise<SchedulerStats>; isLeader(): boolean; health(): SchedulerHealth };
type A = { account_id: string; email: string | null; phone: string | null; email_enabled: boolean; sms_enabled: boolean; timezone: string; travel_minutes: number; cancel_hours: number; reminder_lead_minutes: number; consent_ok: boolean };
type R = { id: string; account_id: string; shift_id: string | null; kind: string; attempts: number; dedupe_key: string; claim_token: string; replay_generation:number; expires_at: Date };
type SR = { id: string; platform: string; facility: string; label: string; date: string; start_minute: number; end_minute: number };
const toShift = (s: SR): Shift => ({ ...s, start: s.start_minute, end: s.end_minute });

/**
 * The account query, shared by collect() and dispatch().
 *
 * `consent_ok` is whether the account has accepted the CURRENT legal version. A legal-version bump must stop
 * alerts for accounts that have not re-accepted, so both creation (collect) and dispatch check it.
 */
function accountSQL(versionParam: string): string {
  return `SELECT a.id AS account_id,a.email,a.phone,(s.email_enabled AND a.email_verified) AS email_enabled,
 (s.sms_enabled AND a.phone_verified AND (a.email IS NULL OR a.email_verified)) AS sms_enabled,
 s.timezone,s.travel_minutes,s.cancel_hours,s.reminder_lead_minutes,
 EXISTS(SELECT 1 FROM account_consents c WHERE c.account_id=a.id AND c.terms_version=${versionParam} AND c.privacy_version=${versionParam}) AS consent_ok
 FROM accounts a JOIN account_settings s ON s.account_id=a.id`;
}
const rulesOf = (a: A): Rules => ({ travelMin: a.travel_minutes, cancelHrs: a.cancel_hours });

/**
 * The SQL fragment that turns `s.timezone` into something PostgreSQL will actually accept.
 *
 * It used to be
 *
 *     CASE WHEN s.timezone ~ '^[A-Za-z][A-Za-z0-9/_+-]*$' THEN s.timezone ELSE 'UTC' END
 *
 * which looks like a guard and is not one: the regex only says the string is SHAPED like a zone name. `Foo/Bar`,
 * `Etc/Nonexistent` and — the one that matters, because it is reachable from the account page's own dropdown —
 * `Europe/Kiev` all match the regex and all make `AT TIME ZONE` throw `time zone "..." not recognized`. And that
 * throw happened inside the account-selection LATERAL join, which is OUTSIDE the per-account try/catch, so one
 * account's timezone aborted the entire tick: no digests, no dispatch, no security notices, no reconciliation,
 * for anybody, every tick, until the row was fixed by hand.
 *
 * The allow-list is `valid_timezones`, populated from `pg_timezone_names` and refreshed on every boot (see
 * db.ts `refreshValidTimezones`), so it agrees with the server's own tzdata rather than with a guess about what a
 * zone name looks like. A zone that is not on it degrades to UTC for PRIORITISATION only — the account is then
 * caught by `isValidZoneFor` inside the per-account loop and quarantined with a named error, so the tick
 * continues and the failure is visible instead of silently shifting somebody's cutoffs.
 */
const safeZoneSQL = (column = "s.timezone"): string =>
  `(CASE WHEN EXISTS (SELECT 1 FROM valid_timezones tz WHERE tz.name = ${column}) THEN ${column} ELSE 'UTC' END)`;

/**
 * Whether this PostgreSQL and this ICU agree that a zone exists.
 *
 * The two sets are NOT the same, in both directions, and only the intersection is usable:
 *
 *   ICU-valid, PG-invalid  `Europe/Kiev`, `Asia/Calcutta`, `America/Indianapolis`, `Pacific/Enderbury` and 14
 *                          more in this build. `Intl.DateTimeFormat` accepts them; `AT TIME ZONE` throws.
 *   PG-valid, ICU-invalid  `+05:00` and the other POSIX offset forms. Worse than throwing: PostgreSQL reads the
 *                          POSIX sign BACKWARDS, so `AT TIME ZONE '+05:00'` moves an instant five hours the wrong
 *                          way and every cutoff for that account is silently wrong by ten.
 *
 * Checking only one of the two is what let this through in the first place: account creation validated with
 * `Intl`, settings validated with `pg_timezone_names`, and each path let the other's failures in.
 */
async function isValidZoneFor(zone: string): Promise<boolean> {
  const trimmed = zone?.trim();
  if (!trimmed) return false;
  try {
    // Throws RangeError for anything ICU does not know, including the offset forms.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    return false;
  }
  const row = await queryOne<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM valid_timezones WHERE name=$1) AS ok", [trimmed]);
  return !!row?.ok;
}

/**
 * A stable key for one conflict, independent of everything else on the schedule.
 *
 * The old key hashed the whole risky-shift set, so it changed whenever ANY conflict ended or the 14-day
 * window rolled — which re-notified the account about conflicts it had already been told about (audit finding
 * 4). A conflict is identified by the two shifts and the kind of clash, and nothing else.
 */
export const conflictNoticeKey = (x: Shift, y: Shift, kind: string) => {
  const sorted = [x, y].sort((a, b) => a.id.localeCompare(b.id));
  return `conflict:${sorted[0].id}:${sorted[1].id}:${kind}`;
};
/** A stable key for one shift's cancellation window. */
export const cancellationNoticeKey = (shift: Shift) => `cancel:${shift.id}`;
/** The one-row stand-in for a snapshot with more conflicts than per-conflict state is worth. */
const bulkNoticeKey = (accountId: string, kind: string) => `snapshot:${accountId}:${kind}`;

/** The digest's own key. It carries a generation so a NEW conflict produces a NEW digest, not a silent no-op. */
const digestKey = (accountId: string, kind: string, generation: number) => `digest:${accountId}:${kind}:${generation}`;

export const humanDuration = (minutes: number) => minutes <= 0 ? "now" : minutes < 60 ? `${Math.ceil(minutes)} minutes` : minutes < 2880 ? `${Math.floor(minutes/60)} hours ${Math.floor(minutes%60)} minutes` : `${Math.floor(minutes/1440)} days`;
export function upcomingPairs(shifts:Shift[],rules:Rules,zone:string,now:number){return conflictPairs(shifts,rules,zone,now).map(p=>({...p,kind:p.issue.kind}));}

type Notice = { key: string; kind: string; expires: number };
type Plan = { shift: Shift; kind: string; key: string; expires: number; count: number; items: Shift[]; notices: Notice[] };

/**
 * Above this many conflicts in one snapshot, the per-conflict state collapses to one row.
 *
 * A schedule with 500 shifts on one day has 124,750 overlapping pairs. Recording that many rows per tick — and
 * re-reading them on every scan — is a self-inflicted denial of service on the account's own database, and it
 * buys nothing: the digest already describes every conflict in one message. Past the threshold the snapshot is
 * recorded as a single "this snapshot has been reported" row, which still stops repeat alerts and still expires.
 */
const BULK_NOTICE_THRESHOLD = 500;

/**
 * The current snapshot of one account's schedule: every conflict, and the cancellation windows that matter.
 *
 * This is the CONTENT of a digest — what the message says. It is deliberately independent of what the account
 * has already been told: the message describes the schedule as it is now, so an ended conflict simply stops
 * being listed, and a new one joins the list.
 *
 * THE CANCELLATION BRANCH IS RESTRICTED TO CONFLICTING SHIFTS, and that restriction is the whole point of the
 * product. It used to select every shift whose assumed cutoff fell inside the lead window, whether or not it
 * clashed with anything — so a nurse with one perfectly ordinary shift a day got a message, three hours before
 * the assumed cutoff, telling her that "1 conflicting shift(s) have an assumed 24-hour cancellation cutoff".
 * Nothing was conflicting. The word was not a rounding error in the copy either: `docs/OPERATIONS.md` and
 * `docs/RELEASE-REMEDIATION.md` both state that only conflicting shifts enter a cancellation digest, so the
 * behaviour contradicted the specification and the message contradicted itself in the same sentence.
 *
 * A cutoff on its own is not actionable — the person knows when their shift starts, and Phylax's cutoff is an
 * assumption, not a platform policy. A cutoff on a shift that OVERLAPS another one is the decision that costs
 * money: which of the two do you give up, and can you still do it for free. That is the only case worth an
 * alert, and it is now the only case that produces one.
 */
function snapshot(shifts: Shift[], a: A, now: number): Plan[] {
  const pairs = upcomingPairs(shifts, rulesOf(a), a.timezone, now);
  const out: Plan[] = [];
  // The set of shifts involved in a conflict, keyed by id. Built once and used by both branches.
  const risky = new Map<string, Shift>();
  if (pairs.length) {
    const kind = pairs.some(p => p.kind === 'overlap') ? 'overlap' : 'tight';
    for (const p of pairs) { risky.set(p.a.id, p.a); risky.set(p.b.id, p.b); }
    const items = [...risky.values()].sort((x, y) => x.id.localeCompare(y.id));
    const expires = pairs.reduce((n, p) => Math.min(n, p.expires), Infinity);
    const notices: Notice[] = pairs.length > BULK_NOTICE_THRESHOLD
      ? [{ key: bulkNoticeKey(a.account_id, kind), kind, expires }]
      : pairs.map(p => ({ key: conflictNoticeKey(p.a, p.b, p.kind), kind: p.kind, expires: p.expires }));
    out.push({ shift: items[0], kind, key: digestKey(a.account_id, kind, 0), expires, count: pairs.length, items, notices });
  }
  if (!risky.size) return out;
  // Intersected with `risky`: a lone shift with a closing window is not an alert. See above.
  const due = [...risky.values()].filter(s => {
    const cutoff = spanIn(s, a.timezone)[0] - a.cancel_hours * 3600000;
    return cutoff > now && cutoff - a.reminder_lead_minutes * 60000 <= now;
  });
  if (due.length) {
    const sorted = [...due].sort((x, y) => x.id.localeCompare(y.id));
    const expires = Math.min(...due.map(s => spanIn(s, a.timezone)[0] - a.cancel_hours * 3600000));
    out.push({
      shift: sorted[0], kind: 'cancellation', key: digestKey(a.account_id, 'cancellation', 0), expires,
      count: due.length, items: sorted,
      notices: due.length > BULK_NOTICE_THRESHOLD
        ? [{ key: bulkNoticeKey(a.account_id, 'cancellation'), kind: 'cancellation', expires }]
        : due.map(s => ({ key: cancellationNoticeKey(s), kind: 'cancellation', expires: spanIn(s, a.timezone)[0] - a.cancel_hours * 3600000 })),
    });
  }
  return out;
}

/**
 * Whether the account should be told something it has not been told yet.
 *
 * This is the DECISION, and it is separate from the content on purpose. A digest is created when at least one
 * conflict in the snapshot is not yet in `notified` (the per-conflict state); an ended conflict changes nothing
 * here, which is what stops the repeat-alert bug. Rendering the digest uses `snapshot`, not this: by the time the
 * reminder is dispatched, its own notices have already been recorded, so filtering on `notified` at render time
 * would find nothing left to say and suppress every digest.
 */
function freshPlans(shifts: Shift[], a: A, now: number, notified: ReadonlySet<string>): Plan[] {
  return snapshot(shifts, a, now).filter(plan => plan.notices.some(n => !notified.has(n.key)));
}

/**
 * The digest keys a snapshot would produce RIGHT NOW, one per plan, in the same order.
 *
 * `snapshot()` cannot know the generation — it is a pure function of the schedule, and the generation lives in
 * the database — so it fills each key with generation 0 as a placeholder. Creation and rendering both need the
 * real keys and they MUST agree, or `render()` cannot find the plan its reminder was created for and silently
 * falls back to "whatever the last plan of this kind is".
 *
 * Two plans of the same kind in one snapshot get consecutive generations, so neither can collide with the other.
 */
export function planKeys(accountId: string, plans: Plan[], generations: ReadonlyMap<string, number>): string[] {
  const used = new Map<string, number>();
  return plans.map(plan => {
    const base = generations.get(plan.kind) ?? 0;
    const offset = used.get(plan.kind) ?? 0;
    used.set(plan.kind, offset + 1);
    return digestKey(accountId, plan.kind, base + offset);
  });
}

/**
 * The plan a reminder should be rendered from.
 *
 * An exact key match is the reminder's own snapshot. When there is none — the schedule changed between creation
 * and dispatch, which is normal and expected — the current plan of the same kind is rendered instead, because the
 * message must always describe the schedule as it is NOW rather than as it was when the row was written.
 */
export function planForReminder(reminderKey: string, reminderKind: string, plans: Plan[], keys: string[]): Plan | null {
  const exact = keys.indexOf(reminderKey);
  if (exact >= 0) return plans[exact] ?? null;
  const sameKind = plans.map((p, i) => ({ p, i })).filter(x => x.p.kind === reminderKind).at(-1);
  return sameKind ? plans[sameKind.i] ?? null : null;
}

export function createScheduler(config: Config): Scheduler {
  let timer: NodeJS.Timeout | null=null, inFlight: Promise<SchedulerStats> | null=null, leader=false, stopping=false;
  let client: pg.PoolClient | null=null;
  let lockFailure:(() =>void)|null=null;
  let lastStartedAt: number|null=null,lastCompletedAt: number|null=null,lastError:string|null=null;
  let watchdog: NodeJS.Timeout | null=null;
  let tickStartedAt = 0;
  const initialized=Date.now();

  /**
   * The hang guard.
   *
   * A wedged tick (a database connection that never answers) used to leave `inFlight` pending forever: health
   * went 503 and nothing ever recovered, because nothing restarted the process. The pools now bound query time
   * (see db.ts), so a hang becomes an error and the next tick recovers on its own. This is the backstop for
   * everything that bounds cannot catch: if a tick runs far past its budget, the process exits and systemd
   * restarts it. A restart loses an in-flight send at worst, and delivery is at-least-once by design.
   */
  const hangThresholdMs = () => Math.max(180000, config.SCHEDULER_INTERVAL_MS * 3);
  function armWatchdog() {
    if (watchdog || !config.SCHEDULER_ENABLED || !isDbEnabled()) return;
    watchdog = setInterval(() => {
      if (stopping || !inFlight) return;
      const running = Date.now() - (tickStartedAt || initialized);
      if (running > hangThresholdMs()) {
        log.error("scheduler tick has hung; exiting so the service manager restarts the process", {
          code: "scheduler_hung", runningMs: running, thresholdMs: hangThresholdMs(),
        });
        process.exit(1);
      }
    }, 30000);
    watchdog.unref();
  }

  async function lock() {
    if (leader || stopping || !isDbEnabled()) return;
    const c=await getLockPool().connect();
    try {
     if(!(await c.query<{ok:boolean}>("SELECT pg_try_advisory_lock($1) AS ok",[LOCK_KEY])).rows[0]?.ok || stopping) { c.release(); return; }
     client=c;leader=true;
     lockFailure=()=>{leader=false;client=null;lockFailure=null;c.release(true);};c.once("error",lockFailure);
    } catch(e) { c.release(true);throw e; }
   }
  async function unlock() { const c=client;client=null;leader=false;if(c){if(lockFailure)c.removeListener("error",lockFailure);lockFailure=null;try{await c.query("SELECT pg_advisory_unlock($1)",[LOCK_KEY]);c.release();}catch{c.release(true);}} }

  /**
   * Give up leadership after a broken lock connection.
   *
   * A leader whose dedicated connection has died used to stay `leader` forever, failing at `SELECT 1` on every
   * tick. Now the failure drops leadership and destroys the client, so the very next tick re-acquires the lock
   * on a fresh connection.
   */
  function dropLeadership(reason: string, err: unknown) {
    log.error("scheduler lost its lock connection; will re-acquire on the next tick", { code: reason, error: err });
    const c = client;
    client = null; leader = false;
    if (lockFailure && c) { c.removeListener("error", lockFailure); lockFailure = null; }
    if (c) c.release(true);
  }

  /**
   * Housekeeping, one query at a time.
   *
   * It used to fire ten queries concurrently, which on a 10-connection pool starved real requests. These are
   * cheap deletes; sequential is fast enough and cannot flood the pool.
   *
   * delivery_suppressions is deliberately NOT pruned by age: a suppression means "this address bounced or
   * complained", and deleting it after 90 days resumes sending to an address that is still bad. Suppressions
   * are cleared by an operator through the ops endpoint once the address is fixed.
   */
  async function housekeeping() {
    const jobs: [string, () => Promise<unknown>][] = [
      ["prune_sessions", () => pruneSessions({ idleTimeoutMinutes: config.SESSION_IDLE_TIMEOUT_MINUTES })],
      ["prune_challenges", pruneChallenges],
      ["prune_pending_signups", prunePendingSignups],
      ["prune_magic_links", pruneMagicLinks],
      ["prune_reminders", () => execute("DELETE FROM reminders WHERE expires_at<now()-interval '30 days' AND (claimed_at IS NULL OR claimed_at<now()-interval '15 minutes')")],
      ["prune_rate_buckets", () => execute("DELETE FROM rate_buckets WHERE expires_at<now()")],
      ["prune_delivery_events", () => execute("DELETE FROM delivery_events WHERE created_at<now()-interval '30 days'")],
      ["prune_notification_deliveries", () => execute("DELETE FROM notification_deliveries WHERE created_at<now()-interval '30 days'")],
      ["prune_security_events", () => execute("DELETE FROM security_events WHERE created_at<now()-interval '90 days'")],
      ["prune_conflict_notices", () => execute("DELETE FROM conflict_notices WHERE expires_at IS NOT NULL AND expires_at<now()-interval '7 days'")],
      ["sweep_reminder_statuses", sweepReminderStatuses],
    ];
    for (const [name, job] of jobs) {
      try { await job(); }
      catch (err) { log.error("housekeeping job failed", { code: "housekeeping_failed", job: name, error: err }); }
    }
  }

  async function insert(a: A,s: Shift,kind:string,key:string,at:number,expires:number,generation:number,noticeKeys:string[]) {
    const row = await queryOne<{ id: string }>(`INSERT INTO reminders(account_id,shift_id,kind,dedupe_key,generation,notice_keys,scheduled_for,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($8/1000.0)) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
     [a.account_id,s.id,kind,key,generation,noticeKeys,at,expires]);
    return row?.id ?? null;
  }

  /** The per-conflict notification state for one account. */
  async function notifiedSet(accountId: string): Promise<Set<string>> {
    const rows = await query<{ notice_key: string }>("SELECT notice_key FROM conflict_notices WHERE account_id=$1 AND (expires_at IS NULL OR expires_at>now())", [accountId]);
    return new Set(rows.map(r => r.notice_key));
  }

  /**
   * The next digest generation for one account, per kind.
   *
   * It used to be `COUNT(*)` of the surviving `digest:%` rows for that account. Retention prunes sent reminders
   * after 30 days, so the count goes DOWN — and an account that had already been given generations 0 and 1,
   * whose rows were then pruned, counted 0 again and produced `digest:<account>:overlap:0` a second time. That
   * key is unique, so `ON CONFLICT DO NOTHING` swallowed the insert and the new digest was dropped without a
   * trace: a genuinely new conflict, silently never reported.
   *
   * `MAX(generation)+1` over the stored column is monotonic whether or not rows have been pruned, because the
   * column is carried by the row that survives longest and the index below makes the lookup a single seek.
   */
  async function nextGenerations(accountId: string): Promise<Map<string, number>> {
    const rows = await query<{ kind: string; max_gen: string }>(
      `SELECT kind, max(generation)::text AS max_gen FROM reminders WHERE account_id=$1 AND dedupe_key LIKE $2 GROUP BY kind`,
      [accountId, `digest:${accountId}:%`],
    );
    return new Map(rows.map(r => [r.kind, Number(r.max_gen) + 1]));
  }

  /**
   * The scan.
   *
   * TWO PASSES, because the old one mixed two different orderings and lost work in the seam.
   *
   * It was a single query:
   *
   *     WHERE (needs_scan OR cursor IS NULL OR id > cursor)
   *     ORDER BY needs_scan DESC, soonest_cutoff NULLS LAST, id
   *     LIMIT batch
   *
   * The filter is a keyset over `id`, but the sort is over three other things. Take a batch of 100 out of 5,000
   * accounts: the first tick returns the 100 highest-priority accounts, which are spread across the whole id
   * range, and stores the LAST of them as the cursor. Every one of those accounts with an id BELOW that cursor is
   * then excluded by `id > cursor` for the rest of the rotation — including the ones with the soonest cutoffs,
   * which is precisely the set the ordering was trying to prioritise. A cancellation window that opens and closes
   * inside one 50-minute rotation was missed by the accounts the query had just decided were the most urgent.
   *
   * So:
   *
   *   PRIORITY PASS  no cursor at all. Everything dirty (`needs_scan`), everything with a cutoff closing inside
   *                  the lead window, and everything whose timezone this PostgreSQL cannot use (so a bad zone is
   *                  surfaced as a quarantine rather than silently deprioritised by the UTC fallback). Run every
   *                  tick, and never starved by the rotation.
   *
   *   ROTATING PASS  a correct keyset over `id` alone: `WHERE id > cursor ORDER BY id LIMIT batch`. Fair, because
   *                  the cursor and the ordering are now the same key, so every alert-enabled account is
   *                  guaranteed to be visited within ceil(accounts / batch) ticks. It carries no LATERAL join at
   *                  all, which also makes the common tick considerably cheaper.
   *
   * Accounts found by both passes are scanned once: `seen` is checked before the per-account work.
   *
   * Per-account work is wrapped, so one account with a bad timezone, a capacity overflow or a broken row is
   * quarantined and reported instead of throwing out of the loop, stalling the cursor and skipping dispatch, the
   * security notices and delivery reconciliation for everybody.
   */
  async function collect(now: number) {
    const state = await queryOne<{ scan_cursor: string | null }>("SELECT scan_cursor FROM scheduler_state WHERE id=true");
    const cursor = state?.scan_cursor ?? null;
    const batch = config.SCHEDULER_ACCOUNT_BATCH;
    const lead = config.REMINDER_LEAD_MINUTES;

    // ---- the priority pass -------------------------------------------------------------------------
    //
    // `soonest_cutoff` is computed with the allow-listed zone. The old LATERAL used a regex-shaped CASE, which
    // passed unknown zones straight to `AT TIME ZONE` and threw out of the account-selection query itself — one
    // account, whole tick, every tick.
    const priority = await query<A>(`${accountSQL("$3")}
     LEFT JOIN LATERAL (
       SELECT min((sh.date + (sh.start_minute - s.cancel_hours * 60) * interval '1 minute') AT TIME ZONE ${safeZoneSQL()}) AS soonest_cutoff
         FROM shifts sh
        WHERE sh.account_id = a.id
          AND sh.date BETWEEN (now() AT TIME ZONE ${safeZoneSQL()})::date - 1
                          AND (now() AT TIME ZONE ${safeZoneSQL()})::date + 14
     ) sc ON TRUE
     WHERE (s.email_enabled OR s.sms_enabled)
       AND (
            a.needs_scan
         OR NOT EXISTS (SELECT 1 FROM valid_timezones tz WHERE tz.name = s.timezone)
         OR (sc.soonest_cutoff IS NOT NULL
             AND sc.soonest_cutoff - (s.cancel_hours * interval '1 hour') <= now() + make_interval(mins => $1))
       )
     ORDER BY (NOT EXISTS (SELECT 1 FROM valid_timezones tz WHERE tz.name = s.timezone)) DESC,
              a.needs_scan DESC,
              sc.soonest_cutoff NULLS LAST,
              a.id
     LIMIT $2`, [lead, batch, LEGAL_VERSION]);

    // ---- the rotating pass ----------------------------------------------------------------------------
    //
    // Keyset over `id` alone, ordered by `id` alone. The cursor and the ordering are the same key, which is what
    // makes the rotation fair.
    const rotating = await query<A>(`${accountSQL("$2")}
     WHERE (s.email_enabled OR s.sms_enabled) AND ($1::uuid IS NULL OR a.id > $1::uuid)
     ORDER BY a.id LIMIT $3`, [cursor, LEGAL_VERSION, batch]);

    const accounts: A[] = [];
    const seen = new Set<string>();
    for (const a of [...priority, ...rotating]) {
      if (seen.has(a.account_id)) continue;
      seen.add(a.account_id);
      accounts.push(a);
    }

    let conflicts = 0, cancellations = 0;
    for (const a of accounts) {
      try {
        // Accounts that have not accepted the current legal version get no NEW alerts.
        if (!a.consent_ok) { await execute("UPDATE accounts SET needs_scan=false WHERE id=$1", [a.account_id]); continue; }
        // The zone is checked against BOTH authorities before any span arithmetic. `spanIn` throws a RangeError
        // for a zone ICU does not know (the POSIX offset forms), and PostgreSQL throws for a zone it does not
        // know (the 18 ICU aliases this build accepts and it rejects, `Europe/Kiev` among them). Either one used
        // to escape into the tick; both are now a named quarantine.
        if (!(await isValidZoneFor(a.timezone))) {
          lastError = "account_timezone_invalid";
          log.error("scheduler account has a timezone this server cannot use; quarantined for this tick", {
            accountId: a.account_id, code: "account_timezone_invalid",
            detail: "The zone must be in pg_timezone_names AND known to ICU. The account page's picker is served from GET /api/meta/timezones, which returns exactly that intersection.",
          });
          // Left dirty on purpose: it stays in the priority pass, so the failure keeps being reported every tick
          // until somebody fixes it, instead of being scanned once and then forgotten for a whole rotation.
          continue;
        }
        // Strict per-account capacity is also enforced by HTTP writes; direct SQL/imports must obey it.
        const rows = await query<SR>(`SELECT * FROM shifts WHERE account_id=$1 AND date BETWEEN (now() AT TIME ZONE $2)::date-1 AND (now() AT TIME ZONE $2)::date+14 ORDER BY date,start_minute LIMIT 501`, [a.account_id, a.timezone]);
        if (rows.length > 500) {
          lastError = "account_capacity_exceeded";
          log.error("scheduler account exceeds active window capacity", { accountId: a.account_id });
          continue;
        }
        const shifts = rows.map(toShift);
        const notified = await notifiedSet(a.account_id);
        const plans = freshPlans(shifts, a, now, notified);
        if (!plans.length) continue;
        // One lookup for the whole account, not one per plan.
        const generations = await nextGenerations(a.account_id);
        const keys = planKeys(a.account_id, plans, generations);
        for (let i = 0; i < plans.length; i++) {
          const plan = plans[i];
          const key = keys[i];
          const generation = Number(key.split(":").at(-1));
          // A newer digest supersedes an unsent older one for the same kind, so the account never gets two.
          await execute(`UPDATE reminders SET status='suppressed',error='superseded',claimed_at=NULL,claim_token=NULL
            WHERE account_id=$1 AND kind=$2 AND status='queued' AND sent_at IS NULL AND dedupe_key<>$3`, [a.account_id, plan.kind, key]);
          const noticeKeys = plan.notices.map(n => n.key);
          const reminderId = await insert(a, plan.shift, plan.kind, key, now, plan.expires, generation, noticeKeys);
          if (!reminderId) continue;
          if (plan.kind === 'cancellation') cancellations++; else conflicts++;
          // One statement for the whole snapshot. The old code issued one INSERT per conflict, so a dense
          // schedule turned a single tick into a hundred thousand round trips.
          //
          // `reminder_id` is the lineage that makes a terminal failure recoverable: when this digest dies or
          // expires without ever being delivered, its notices are released so the conflicts can be alerted again
          // (see `releaseNotices`). Without it, a suppressed digest marked its conflicts "notified" forever and
          // the account never heard about a conflict the system knew about.
          await execute(`INSERT INTO conflict_notices(account_id,notice_key,kind,expires_at,reminder_id)
            SELECT $1, n.key, n.kind, to_timestamp(n.expires/1000.0), $5 FROM unnest($2::text[],$3::text[],$4::float8[]) AS n(key,kind,expires)
            ON CONFLICT(account_id,notice_key) DO UPDATE SET expires_at=EXCLUDED.expires_at, reminder_id=EXCLUDED.reminder_id`,
            [a.account_id, plan.notices.map(n => n.key), plan.notices.map(n => n.kind), plan.notices.map(n => n.expires), reminderId]);
        }
      } catch (err) {
        // Quarantine, don't stall: this account is skipped this tick, the cursor still advances, and the rest of
        // the tick (dispatch, notices, reconciliation) still runs.
        lastError = "account_scan_failed";
        log.error("scheduler account scan failed; quarantined for this tick", { accountId: a.account_id, error: err });
      }
    }
    // The cursor belongs to the ROTATING pass only. It advances when that pass filled its batch, and resets when
    // the pass reached the end of the id range, which is what makes the rotation actually rotate. The priority
    // pass never touches it.
    const rotatingLast = rotating.length === batch ? rotating.at(-1)!.account_id : null;
    await execute("UPDATE scheduler_state SET scan_cursor=$1 WHERE id=true", [rotatingLast]);
    // Only accounts the rotating pass consumed are cleared: a priority-pass account stays dirty until the
    // rotation reaches it, so a shift change is never dropped by a pass that does not own the cursor.
    if (rotating.length) await execute("UPDATE accounts SET needs_scan=false WHERE id = ANY($1::uuid[])", [rotating.map(x => x.account_id)]);
    return { conflicts, cancellations };
  }

  /**
   * Release the notification state a digest claimed, because that digest is never going to be delivered.
   *
   * `conflict_notices` is what stops a conflict being reported twice. Recording it at ENQUEUE time means a
   * digest that then dies — 48 attempts exhausted, expiry reached, suppressed because no channel was verified —
   * has already marked its conflicts as told, and the account never hears about them. That is the worst failure
   * mode available: the system detected the conflict, tried to say so, failed, and then recorded that it had
   * succeeded.
   *
   * Deleting the notices makes those conflicts eligible again on the next tick. `ON DELETE CASCADE` from
   * `reminders` already handles a pruned reminder; this handles the ones that stay in the table as a record.
   */
  async function releaseNotices(reminderId: string, reason: string) {
    try {
      await execute("DELETE FROM conflict_notices WHERE reminder_id=$1", [reminderId]);
      // `notice_keys` is deliberately KEPT on the row: it is what POST /api/ops/reminders/:id/replay uses to put
      // the notices back, so a replayed dead digest owns its conflicts again instead of racing the scanner into
      // creating a duplicate. The reminder is the record of what happened; the keys are how to undo the release.
      log.warn("digest terminally undelivered; its conflicts are eligible to be reported again", { reminderId, code: `notices_released_${reason}` });
    } catch (err) {
      // Failing to release is not worth losing the rest of the tick over, but it must not be silent either:
      // an account that never gets re-alerted is exactly the bug this exists to prevent.
      log.error("could not release conflict notices for a dead digest", { reminderId, reason, error: err });
    }
  }
  async function render(r:R,a:A){
    const rows=await query<SR>(`SELECT * FROM shifts WHERE account_id=$1 AND date BETWEEN (now() AT TIME ZONE $2)::date-1 AND (now() AT TIME ZONE $2)::date+14 LIMIT 501`,[a.account_id,a.timezone]);
    if(rows.length>500)return null;
    const shifts=rows.map(toShift);
    // The snapshot, not the freshness check: see `snapshot` for why that distinction matters.
    const candidates=snapshot(shifts,a,Date.now());
    // The keys are rebuilt the same way collect() built them, so an exact match means "this is the snapshot the
    // reminder was created for". If the schedule has moved on, the current plan of the same kind is rendered
    // instead — the message always describes the schedule as it is now, and only one live digest per kind exists.
    const generations=await nextGenerations(a.account_id);
    const plan=planForReminder(r.dedupe_key,r.kind,candidates,planKeys(a.account_id,candidates,generations));
    if(!plan || r.expires_at.getTime()<=Date.now())return null;
    const link=`${config.APP_URL}/dashboard`;
    if(plan.kind==='cancellation'){
      const summary=plan.items.slice(0,3).map(s=>`${s.date} ${s.facility}: assumed cutoff in ${humanDuration((spanIn(s,a.timezone)[0]-a.cancel_hours*3600000-Date.now())/60000)}`).join('; ');
      // The wording says "conflicting" because after the snapshot() fix it is now TRUE: every shift in this
      // digest is in the conflicting set. Before that fix the same sentence was sent about lone shifts with
      // nothing to conflict with, which made the message self-contradicting in its first clause.
      return {subject:`Review ${plan.count} conflicting shift cutoff(s)`,body:`Phylax: ${plan.count} conflicting shift(s) have an assumed ${a.cancel_hours}-hour cancellation cutoff within your ${a.reminder_lead_minutes}-minute lead window. ${summary}. These are your configured assumptions, not verified platform policies. Review all conflicts and actual policies before cancelling. ${link}`,smsBody:`Phylax: ${plan.count} conflicting shift cutoff(s) approaching. Your assumed policy, not platform-verified. Review before cancelling: ${link}`};
    }
    const summary=plan.items.slice(0,5).map(s=>`${s.date} ${s.platform} at ${s.facility}`).join('; ');
    return {subject:`${plan.count} schedule conflict(s) to review`,body:`Phylax found ${plan.count} overlap/tight-travel conflict(s) involving ${plan.items.length} upcoming shifts in ${a.timezone}. ${summary}. Your travel buffer is ${a.travel_minutes} minutes. Review the complete stack and actual cancellation policies: ${link}`,smsBody:`Phylax: ${plan.count} schedule conflict(s) involving ${plan.items.length} shifts. Review your stack: ${link}`};
   }
  async function dispatch() {
    // ---- terminal transitions, with their notification state released ----------------------------------
    //
    // Both of these used to be a bare UPDATE. The digest's conflicts stayed marked "notified" in
    // `conflict_notices`, so a reminder that exhausted its 48 attempts, or whose window closed before it could be
    // sent, took the account's only chance of hearing about those conflicts with it. Returning the ids lets the
    // notices be released (see `releaseNotices`) and the conflicts become eligible again.
    const expiring = await query<{ id: string }>(
      `UPDATE reminders SET status='expired',claimed_at=NULL,claim_token=NULL
        WHERE status='queued' AND expires_at<=now() AND (claimed_at IS NULL OR claimed_at<now()-interval '15 minutes')
        RETURNING id`);
    for (const row of expiring) await releaseNotices(row.id, "expired");
    const dying = await query<{ id: string }>(
      `UPDATE reminders SET status='dead' WHERE status='queued' AND attempts>=$1 AND claimed_at IS NULL RETURNING id`,
      [MAX_ATTEMPTS]);
    for (const row of dying) await releaseNotices(row.id, "dead");
    const token=randomUUID();
    const due=await query<R>(`WITH candidates AS (SELECT id FROM reminders WHERE status='queued' AND sent_at IS NULL AND expires_at>now() AND scheduled_for<=now() AND attempts<$1
     AND (last_attempt_at IS NULL OR last_attempt_at<now()-least(3600,power(2,least(attempts,12))*30)*interval '1 second')
     AND (claimed_at IS NULL OR claimed_at<now()-interval '15 minutes') ORDER BY scheduled_for LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE reminders r SET claimed_at=now(),claim_token=$3 FROM candidates c WHERE c.id=r.id RETURNING r.*`,[MAX_ATTEMPTS,config.SCHEDULER_BATCH_SIZE,token]);
    let sent=0,failed=0,index=0;const started=Date.now();
    const grouped=new Map<string,R[]>();for(const r of due)grouped.set(r.account_id,[...(grouped.get(r.account_id)??[]),r]);
    const groups=[...grouped.values()];
    async function worker() {
     while(!stopping && index<groups.length && Date.now()-started<30000) {
      const group=groups[index++];
      for(const r of group) {
      if(stopping || Date.now()-started>=30000)break;
      let guard:pg.PoolClient|null=null;
      try {
       // Account-scoped advisory guard coordinates outbound sends with shift mutations. Mutations fail 409
       // rather than deleting a row currently being rendered/sent. Lock is automatically released on process death.
       guard=await getLockPool().connect();
       const locked=await guard.query<{ok:boolean}>("SELECT pg_try_advisory_lock(hashtextextended($1,123)) AS ok",[r.account_id]);
       if(!locked.rows[0]?.ok)continue;
       if(!await queryOne("SELECT id FROM reminders WHERE id=$1 AND claim_token=$2 AND status='queued'",[r.id,token]))continue;
       const a=await queryOne<A>(`${accountSQL("$2")} WHERE a.id=$1`,[r.account_id,LEGAL_VERSION]);
       // A legal-version bump stops delivery too, not just creation.
       //
       // It used to mark the reminder `suppressed` — a TERMINAL state — which meant an account that had not yet
       // re-accepted the new terms lost that alert permanently: accepting the terms a minute later brought
       // nothing back, because the row was no longer queued. It is now a DEFERRAL. Setting `claimed_at=now()`
       // with a NULL claim token puts the row outside the dispatch candidate set for the normal 15-minute claim
       // window, so it is retried on its own schedule rather than every tick, and it is delivered as soon as
       // consent exists. Nothing is lost and no notices are released, because this reminder has not failed.
       if(a && !a.consent_ok){
        // Deferred, NOT failed: `attempts` and `last_attempt_at` are deliberately left alone. They measure
        // DELIVERY failures and drive both the exponential backoff and the 48-attempt dead-letter, and a
        // legal-version bump is neither. Counting it would let a terms change burn a reminder's whole retry
        // budget and dead-letter an alert that was never once offered to a provider — and `dead` releases the
        // conflict's notices, so the account could lose the alert twice over.
        //
        // Setting claimed_at with a NULL claim token is what defers it: the dispatch candidate query requires
        // `claimed_at IS NULL OR claimed_at < now() - 15 minutes`, so the row waits out the normal claim window
        // and is retried on its own schedule rather than every tick. It is delivered as soon as consent exists.
        await execute("UPDATE reminders SET error='consent_required',claimed_at=now(),claim_token=NULL WHERE id=$1 AND claim_token=$2",[r.id,token]);
        continue;
       }
       const text=a?await render(r,a):null;
       if(!text || !a || (!a.email_enabled && !a.sms_enabled)) {
        // Genuinely terminal: the schedule changed so the digest no longer describes anything, or the account has
        // no verified channel left. The notices are released, because the alternative is the failure this whole
        // mechanism exists to prevent — a conflict the system detected, tried to report, could not deliver, and
        // then recorded as reported. When a channel comes back (or the conflict re-forms) it can be told.
        await execute("UPDATE reminders SET status='suppressed',error='no_longer_applicable',claimed_at=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$2",[r.id,token]);
        await releaseNotices(r.id,"no_longer_applicable");
        continue;
       }
       // Reserve the account's hourly reminder budget; refund it if the send fails, so an outage does not
       // spend the budget on messages that never went out.
       const reserve=await reserveBudget(`reminder-account:${r.account_id}`,6,3600);
       if(!reserve.allowed)continue;
       let channel="sms",result:{ok:boolean;error?:string}={ok:false,error:"no_channel"};
       const context={accountId:r.account_id,reminderId:r.id,idempotencyKey:`phylax-${r.id}-${r.replay_generation}`};
       if(a.sms_enabled && a.phone)result=await sendSms(config,{to:a.phone,body:text.smsBody,...context});
       if(!result.ok && a.email_enabled && a.email){channel="email";result=await sendMail(config,{to:a.email,subject:text.subject,text:text.body,...context});}
       if(result.ok){sent++;await execute("UPDATE reminders SET sent_at=now(),status='accepted',channel=$3,attempts=attempts+1,last_attempt_at=now(),claimed_at=NULL,claim_token=NULL,error=NULL WHERE id=$1 AND claim_token=$2",[r.id,token,channel]);}
       else {
        failed++;
        // The provider accepted the message but our bookkeeping failed: that is a retryable failure, and the
        // other channel is a legitimate second attempt rather than a duplicate (see control.ts for the
        // at-least-once semantics). Everything else refunds the budget it reserved.
        await refundBudget(`reminder-account:${r.account_id}`,reserve.bucket);
        await execute("UPDATE reminders SET attempts=attempts+1,last_attempt_at=now(),claimed_at=NULL,claim_token=NULL,error=$3 WHERE id=$1 AND claim_token=$2",[r.id,token,result.error??"provider_unavailable"]);
       }
      } catch (err) {
       failed++;
       log.error("reminder failed",{reminderId:r.id,error:err});
       await execute("UPDATE reminders SET attempts=attempts+1,last_attempt_at=now(),error='processing_failed',claimed_at=NULL,claim_token=NULL WHERE id=$1 AND claim_token=$2",[r.id,token]).catch(()=>{});
      }
      finally {if(guard){try{await guard.query("SELECT pg_advisory_unlock(hashtextextended($1,123))",[r.account_id]);}catch{guard.release(true);guard=null;}finally{guard?.release();}}}
     }
     }
    }
    // The worker count is DERIVED from the lock pool, not from an unrelated constant.
    //
    // It was `min(4, DATABASE_POOL_MAX - 2)`, which used the QUERY pool's size to decide how many connections to
    // take from the LOCK pool — the two are separate pools with separate limits. Each worker holds a lock-pool
    // connection for the whole send (an advisory lock is session-scoped, so it cannot be handed over), and the
    // leadership lock holds one for as long as this process is leader, so the real budget is
    // DATABASE_LOCK_POOL_MAX minus the leader minus what HTTP account-write guards need. Deriving it means
    // raising one number without the other cannot silently starve the pool.
    const workers = dispatchWorkerBudget(config);
    try {await Promise.all(Array.from({length:workers},worker));}
    finally {await execute("UPDATE reminders SET claimed_at=NULL,claim_token=NULL WHERE claim_token=$1",[token]);}
    return {sent,failed};
   }
  async function tick():Promise<SchedulerStats> {
    const stats:SchedulerStats={ticked:false,conflicts:0,cancellations:0,sent:0,failed:0};
    if(!isDbEnabled() || stopping)return stats;
    lastStartedAt=Date.now();tickStartedAt=lastStartedAt;
    try {
     await lock();if(!leader)return stats;
     // Confirm dedicated connection is still alive; reconnect on the next tick after a lost lock.
     await client!.query("SELECT 1");
     stats.ticked=true;lastError=null;
     await execute("UPDATE scheduler_state SET heartbeat_at=now(),error_code=NULL WHERE id=true");
     await housekeeping();Object.assign(stats,await collect(Date.now()),await dispatch());
     await dispatchSecurityNotices(config,()=>stopping);
     await reconcileDeliveryEvents();lastCompletedAt=Date.now();
     await execute("UPDATE scheduler_state SET completed_at=now(),error_code=$1 WHERE id=true",[lastError]);
    } catch (err) {
     // A dead lock connection is not a tick failure: drop leadership so the next tick starts clean.
     const code=typeof err==="object"&&err?String((err as {code?:unknown}).code??""):"";
     if(leader && (code.startsWith("08") || code==="57P01" || code==="57P03")) { dropLeadership("lock_connection_lost",err); return stats; }
     lastError="tick_failed";log.error("scheduler tick failed",{code:lastError,error:err});
     await execute("UPDATE scheduler_state SET error_code=$1 WHERE id=true",[lastError]).catch(()=>{});
    }
    return stats;
   }
  function runOnce(){
    if(inFlight)return inFlight;
    const temporary=!timer;
    inFlight=tick().finally(async()=>{if(temporary)await unlock();inFlight=null;});return inFlight;
   }
  return {
    start(){if(timer||stopping||!config.SCHEDULER_ENABLED||!isDbEnabled())return;timer=setInterval(()=>{void runOnce();},config.SCHEDULER_INTERVAL_MS);timer.unref();armWatchdog();void runOnce();},
    async stop(){stopping=true;if(timer)clearInterval(timer);timer=null;if(watchdog){clearInterval(watchdog);watchdog=null;}if(inFlight)await inFlight;await unlock();},
    runOnce,isLeader:()=>leader,
    health(){const threshold=hangThresholdMs();return {enabled:config.SCHEDULER_ENABLED,leader,lastStartedAt,lastCompletedAt,lastError,healthy:!config.SCHEDULER_ENABLED || Date.now()-(lastCompletedAt??initialized)<threshold};}
   };
}
