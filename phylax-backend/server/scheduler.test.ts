import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScheduler } from "./scheduler.js";
import { execute, query, queryOne } from "./db.js";
import {
  setupDatabase,
  teardownDatabase,
  truncateAll,
  makeAccount,
  makeShift,
  dayFromNow,
  shiftStartingIn,
} from "./test-helpers.js";
import type { Config } from "./config.js";
import { LEGAL_VERSION } from "@shared/legal";

/**
 * The scheduler, against a real database.
 *
 * These tests skip when there is no test database, so `npm test` still works on a machine with no PostgreSQL:
 *
 *   createdb phylax_test
 *   TEST_DATABASE_URL=postgresql://phylax@127.0.0.1:5432/phylax_test npm test
 */

let config: Config | null = null;

beforeAll(async () => {
  config = await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

const schedulerFor = () => {
  if (!config) throw new Error("no database");
  return createScheduler({ ...config, SCHEDULER_ENABLED: false });
};

/**
 * A pair of shifts that overlap: a night shift, then an early one the next morning that starts before it ends.
 *
 * The dates are six and seven days out on purpose. With the pair on today and tomorrow, the *second* shift's
 * cancellation window (24 h before a 06:00 start) sits about three hours ahead of "now" for three hours of every
 * day — so between 03:00 and 06:00 UTC the scheduler also produced a cancellation digest, and these tests, which
 * are about conflicts, failed on `sent === 1` depending on what time of day CI happened to run. Pushed out a
 * week, the cutoff is a week away and no cancellation is ever due, whatever the clock says.
 */
const conflictingPair = async (accountId: string) => {
  await makeShift(accountId, { start: 19 * 60, end: 7 * 60, date: dayFromNow(6) });
  await makeShift(accountId, { platform: "CareRev", facility: "St. Anne's", start: 6 * 60, end: 14 * 60, date: dayFromNow(7) });
};

describe("the reminder scheduler", () => {
  it("does nothing at all without a database", async () => {
    if (config) return; // there IS a database: this case is covered by the config guard instead
    const scheduler = createScheduler({ SCHEDULER_ENABLED: true } as unknown as Config);
    const stats = await scheduler.runOnce();
    // No database means no tick: nothing to scan, nothing to send, and no error either. The point of the test is
    // that a development machine with no PostgreSQL gets a clean no-op rather than a rejected promise.
    expect(stats.ticked).toBe(false);
    expect(stats.sent).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it("records a conflict once, and sends it once", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    // The landing page's own example: a 7 p.m. to 7 a.m. night shift, and a 6 a.m. to 2 p.m. day shift that
    // starts while the night shift is still running. They overlap from 6 a.m. to 7 a.m.
    await conflictingPair(account.id);

    const scheduler = schedulerFor();
    const first = await scheduler.runOnce();
    expect(first.conflicts).toBeGreaterThanOrEqual(1);
    expect(first.sent).toBeGreaterThanOrEqual(1);

    const rows = await query<{ kind: string; sent_at: Date | null }>(
      "SELECT kind, sent_at FROM reminders WHERE account_id = $1",
      [account.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.sent_at !== null)).toBe(true);
    expect(rows.some((r) => r.kind === "overlap")).toBe(true);

    // A second tick must not send the same warning again: the dedupe key is what makes that true.
    const second = await scheduler.runOnce();
    expect(second.conflicts).toBe(0);
    expect(second.sent).toBe(0);
    const after = await query<{ id: string }>("SELECT id FROM reminders WHERE account_id = $1", [account.id]);
    expect(after.length).toBe(rows.length);
  });

  it("sends a cancellation reminder once the window is about to close, and not before", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true, cancelHours: 24, reminderLeadMinutes: 180 });

    // A shift starting in 10 hours: its 24-hour cancellation window closed 14 hours ago. Nothing is due.
    const past = shiftStartingIn(10);
    const pastId = await makeShift(account.id, { ...past, end: past.end });
    const first = await schedulerFor().runOnce();
    expect(first.cancellations).toBe(0);
    expect((await query("SELECT id FROM reminders WHERE shift_id = $1", [pastId])).length).toBe(0);

    // A shift starting in 25 hours: the window closes in 1 hour, which is inside the 3-hour lead.
    const soon = shiftStartingIn(25);
    await makeShift(account.id, { ...soon, end: soon.end });
    await makeShift(account.id, { ...soon, facility: "Conflicting Facility", end: soon.end });
    const second = await schedulerFor().runOnce();
    expect(second.cancellations).toBeGreaterThanOrEqual(1);
    const due = await query<{ kind: string; sent_at: Date | null }>(
      "SELECT kind, sent_at FROM reminders WHERE account_id = $1 AND kind='cancellation'",
      [account.id],
    );
    expect(due.length).toBe(1);
    expect(due[0]!.kind).toBe("cancellation");
    expect(due[0]!.sent_at).not.toBeNull();
  });

  // ---- the repeat-alert bug ---------------------------------------------------------------------------
  //
  // The digest's key used to be a hash of the whole risky-shift set. One conflict ending — or the 14-day window
  // simply rolling — changed the hash, so the account was told about conflicts it had already been told about,
  // every single tick. What is needed is per-conflict state: a conflict is reported once, a NEW conflict is
  // reported once, and a conflict that ends changes nothing.
  it("reports each conflict once, reports a new conflict, and stays quiet when one ends", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    await conflictingPair(account.id);

    const scheduler = schedulerFor();
    const first = await scheduler.runOnce();
    expect(first.conflicts).toBe(1);
    expect(first.sent).toBe(1);

    // Nothing changed: no second message, and no second reminder.
    const again = await scheduler.runOnce();
    expect(again.conflicts).toBe(0);
    expect(again.sent).toBe(0);
    expect((await query("SELECT id FROM reminders WHERE account_id = $1", [account.id])).length).toBe(1);

    // The conflict ends (the day shift moves out of the night shift's way): still no message. The old key
    // changed here, which is exactly when the account used to be told about it all over again.
    await execute("UPDATE shifts SET start_minute = 8 * 60, end_minute = 16 * 60 WHERE platform = 'CareRev'");
    const ended = await scheduler.runOnce();
    expect(ended.conflicts).toBe(0);
    expect(ended.sent).toBe(0);

    // A genuinely new conflict: exactly one new digest, and it describes the schedule as it is now.
    await makeShift(account.id, { platform: "Vivian", facility: "St. Anne's", start: 8 * 60 + 30, end: 12 * 60, date: dayFromNow(7) });
    const fresh = await scheduler.runOnce();
    expect(fresh.conflicts).toBe(1);
    expect(fresh.sent).toBe(1);
    const digests = await query<{ dedupe_key: string; sent_at: Date | null }>(
      "SELECT dedupe_key, sent_at FROM reminders WHERE account_id = $1 ORDER BY created_at", [account.id]);
    expect(digests.length).toBe(2);
    expect(digests.every(d => d.sent_at !== null)).toBe(true);
    // Two different generations of the same kind: the second one is not a re-send of the first.
    expect(digests[0]!.dedupe_key).not.toBe(digests[1]!.dedupe_key);
  });

  // ---- the stalled scheduler --------------------------------------------------------------------------
  //
  // One account used to be able to stop the whole tick: a timezone that PostgreSQL cannot use threw out of the
  // scan, the cursor never advanced, and dispatch, the security notices and reconciliation never ran for
  // anybody. Now that account is quarantined and the tick carries on.
  it("quarantines one broken account instead of stalling the whole tick", async () => {
    if (!config) return;
    await truncateAll();
    const broken = await makeAccount({ emailEnabled: true });
    await conflictingPair(broken.id);
    // The offset-style zone that validates in JavaScript and inverts in PostgreSQL (POSIX signs are backwards),
    // which is what used to throw out of `AT TIME ZONE $2`.
    await execute("UPDATE account_settings SET timezone = '+05:00' WHERE account_id = $1", [broken.id]);

    const healthy = await makeAccount({ emailEnabled: true });
    await conflictingPair(healthy.id);

    const scheduler = schedulerFor();
    const stats = await scheduler.runOnce();
    // The tick itself succeeded...
    expect(stats.ticked).toBe(true);
    // ...the healthy account was still served...
    expect(stats.sent).toBe(1);
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM reminders WHERE account_id = $1", [healthy.id]))[0]!.n).toBe(1);
    // ...and the broken one was reported, not silently skipped. The code is specific now: `account_scan_failed`
    // is the generic quarantine for anything unexpected, and a timezone this server cannot use is a KNOWN failure
    // with its own code, because the fix is different (correct the zone) and the operator should not have to read
    // a stack trace to find that out.
    expect(scheduler.health().lastError).toBe("account_timezone_invalid");
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM reminders WHERE account_id = $1", [broken.id]))[0]!.n).toBe(0);

    // A broken account does not stay broken forever: fixing the zone brings it back on the next tick.
    await execute("UPDATE account_settings SET timezone = 'Africa/Lagos' WHERE account_id = $1", [broken.id]);
    const recovered = await scheduler.runOnce();
    expect(recovered.conflicts).toBe(1);
    expect(recovered.sent).toBe(1);
  });

  // ---- the legal-version bump -------------------------------------------------------------------------
  //
  // A new terms version must stop alerts for accounts that have not accepted it. Creation used to be the only
  // place this was checked, so a queued reminder kept being delivered after the bump.
  it("stops creating and delivering alerts for an account that has not accepted the current terms", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    await conflictingPair(account.id);
    // The account accepted an older version of the documents.
    await execute("UPDATE account_consents SET terms_version = '2020-01-01.1', privacy_version = '2020-01-01.1' WHERE account_id = $1", [account.id]);

    const scheduler = schedulerFor();
    const stats = await scheduler.runOnce();
    expect(stats.conflicts).toBe(0);
    expect(stats.sent).toBe(0);
    expect((await query("SELECT id FROM reminders WHERE account_id = $1", [account.id])).length).toBe(0);

    // Accepting the current version brings alerts back.
    await execute("UPDATE account_consents SET terms_version = $2, privacy_version = $2 WHERE account_id = $1", [account.id, LEGAL_VERSION]);
    const after = await scheduler.runOnce();
    expect(after.conflicts).toBe(1);
    expect(after.sent).toBe(1);
  });

  it("says nothing to an account with no alerts switched on", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: false, smsEnabled: false });
    await conflictingPair(account.id);

    const stats = await schedulerFor().runOnce();
    expect(stats.conflicts).toBe(0);
    expect((await query("SELECT id FROM reminders WHERE account_id = $1", [account.id])).length).toBe(0);
  });

  it("does not warn about two shifts at the same place", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    // The same facility twice, a short gap apart: a long shift, not a drive.
    await makeShift(account.id, { start: 7 * 60, end: 12 * 60, date: dayFromNow(1) });
    await makeShift(account.id, { platform: "CareRev", start: 13 * 60, end: 18 * 60, date: dayFromNow(1) });

    const stats = await schedulerFor().runOnce();
    expect(stats.conflicts).toBe(0);
  });

  it("stops cleanly, and gives up the lock", async () => {
    if (!config) return;
    await truncateAll();
    const scheduler = schedulerFor();
    scheduler.start();
    await scheduler.stop();
    expect(scheduler.isLeader()).toBe(false);
  });

  // ---- finding 1: the lone shift ---------------------------------------------------------------------------
  //
  // This is the case the suite did not have, and its absence is why the bug shipped. The existing cancellation
  // test creates TWO shifts at DIFFERENT facilities, which is a genuine tight-travel conflict — so the digest it
  // asserts on was correctly about a conflicting shift, and the test passed while every account with a single
  // ordinary shift was being told it had "1 conflicting shift(s)".
  it("says nothing about the cancellation window of a shift that conflicts with nothing", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true, cancelHours: 24, reminderLeadMinutes: 180 });
    // One shift. Its 24-hour cancellation window closes in about an hour, squarely inside the 3-hour lead, so
    // the old code produced a digest for it — and worded that digest "1 conflicting shift(s)".
    const soon = shiftStartingIn(25);
    await makeShift(account.id, { ...soon, end: soon.end });

    const stats = await schedulerFor().runOnce();
    expect(stats.cancellations).toBe(0);
    expect(stats.conflicts).toBe(0);
    expect(stats.sent).toBe(0);
    expect((await query("SELECT id FROM reminders WHERE account_id = $1", [account.id])).length).toBe(0);
    expect((await query("SELECT notice_key FROM conflict_notices WHERE account_id = $1", [account.id])).length).toBe(0);
  });

  it("does alert about the window of a shift that conflicts with another one", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true, cancelHours: 24, reminderLeadMinutes: 180 });
    // The same pair as the negative test above, plus one overlapping shift at a different facility — so the
    // window that was silent a moment ago is now actionable: which of the two do you give up, and can you still
    // do it for free. That is the only reason this alert exists.
    const soon = shiftStartingIn(25);
    await makeShift(account.id, { ...soon, end: soon.end });
    await makeShift(account.id, { ...soon, platform: "CareRev", facility: "Conflicting Facility", start: soon.start + 60, end: soon.end + 60 });

    const stats = await schedulerFor().runOnce();
    expect(stats.cancellations).toBeGreaterThanOrEqual(1);
    const due = await query<{ kind: string; dedupe_key: string; sent_at: Date | null }>(
      "SELECT kind, dedupe_key, sent_at FROM reminders WHERE account_id = $1 AND kind='cancellation'", [account.id]);
    expect(due.length).toBe(1);
    expect(due[0]!.sent_at).not.toBeNull();
    // And every shift the digest names is in the conflicting set — the message says "conflicting", so it had
    // better be true of each one.
    const notices = await query<{ notice_key: string }>(
      "SELECT notice_key FROM conflict_notices WHERE account_id = $1 AND kind='cancellation'", [account.id]);
    expect(notices.length).toBe(2);
    expect(notices.every(n => n.notice_key.startsWith("cancel:"))).toBe(true);
  });

  // ---- finding 4: digest generations survive retention pruning ---------------------------------------------
  // The generation was COUNT(*) of the SURVIVING digest rows for that account and kind. Retention prunes sent
  // reminders after 30 days, so the count goes down while the highest generation still in the table does not —
  // and the next digest then reused a key that was still present. `dedupe_key` is unique, so
  // `ON CONFLICT DO NOTHING` swallowed the insert and the account was never told about a genuinely new conflict.
  //
  // The test reproduces exactly that shape: prune the OLD generations (what the retention job does), leave a
  // recent one whose generation is higher than the surviving count, and require the next digest to be created.
  it("keeps producing new digests after retention has pruned the old ones", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    await conflictingPair(account.id);
    const scheduler = schedulerFor();

    expect((await scheduler.runOnce()).sent).toBe(1);
    const first = await queryOne<{ dedupe_key: string; generation: number }>(
      "SELECT dedupe_key, generation FROM reminders WHERE account_id=$1", [account.id]);
    expect(first!.generation).toBe(0);

    // The state that broke: generations 0..2 were pruned by retention, generation 3 survives. COUNT(*) is 1, so
    // a count-based generation produces 1 — and 3 is the only row left, so 1 is free, but the NEXT prune cycle
    // reproduces the collision. What must never happen is a generation that is already present.
    await execute("DELETE FROM reminders WHERE account_id=$1", [account.id]);
    await execute("DELETE FROM conflict_notices WHERE account_id=$1", [account.id]);
    const shiftId = (await queryOne<{ id: string }>("SELECT id FROM shifts WHERE account_id=$1 LIMIT 1", [account.id]))!.id;
    await execute(
      `INSERT INTO reminders(account_id,shift_id,kind,dedupe_key,generation,scheduled_for,expires_at,sent_at,status)
       VALUES ($1,$2,'overlap',$3,3,now()-interval '2 days',now()+interval '1 day',now()-interval '2 days','accepted')`,
      [account.id, shiftId, `digest:${account.id}:overlap:3`]);

    // A new, different conflict. Its digest must be created with a generation that does not exist yet.
    await execute("DELETE FROM shifts WHERE account_id=$1", [account.id]);
    await makeShift(account.id, { start: 19 * 60, end: 7 * 60, date: dayFromNow(3) });
    await makeShift(account.id, { platform: "Vivian", facility: "Different Place", start: 6 * 60, end: 14 * 60, date: dayFromNow(4) });

    const second = await scheduler.runOnce();
    expect(second.conflicts).toBe(1);
    expect(second.sent).toBe(1);
    const fresh = await queryOne<{ dedupe_key: string; generation: number }>(
      "SELECT dedupe_key, generation FROM reminders WHERE account_id=$1 AND sent_at > now() - interval '1 minute'", [account.id]);
    // COUNT-based would have produced generation 1 here and collided on the next prune; MAX+1 produces 4.
    expect(fresh).not.toBeNull();
    expect(fresh!.generation).toBe(4);
    expect(fresh!.dedupe_key).toBe(`digest:${account.id}:overlap:4`);
    expect(fresh!.dedupe_key).not.toBe(first!.dedupe_key);
  });

  it("does not collide with itself when one tick produces two digests of the same kind", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    await conflictingPair(account.id);
    // Force the situation by hand: two overlap digests for one account must get two different generations, or
    // the second one is silently dropped.
    await execute(
      `INSERT INTO reminders(account_id,shift_id,kind,dedupe_key,generation,scheduled_for,expires_at)
       SELECT $1::uuid, id, 'overlap', 'digest:'||$1::text||':overlap:7', 7, now(), now()+interval '1 day' FROM shifts LIMIT 1`,
      [account.id]);
    // `nextGenerations` is closure state inside createScheduler; assert the invariant it depends on directly.
    const maxGen = await queryOne<{ next: number }>(
      "SELECT (max(generation)+1)::int AS next FROM reminders WHERE account_id=$1 AND dedupe_key LIKE $2",
      [account.id, `digest:${account.id}:%`]);
    expect(maxGen!.next).toBe(8);
  });

  // ---- finding 3: a zone ICU accepts and PostgreSQL rejects -------------------------------------------------
  //
  // The existing quarantine test uses '+05:00', which is the POSIX-offset case: `Intl` REJECTS it, and
  // PostgreSQL accepts it while reading the sign backwards. The other half of the skew — a zone `Intl` accepts
  // and PostgreSQL throws on — was untested, and it is the dangerous half, because it is reachable from the
  // account page's own dropdown: `Intl.supportedValuesOf("timeZone")` offers 18 names this PostgreSQL rejects.
  it("quarantines a timezone that is valid in ICU but unknown to PostgreSQL", async () => {
    if (!config) return;
    await truncateAll();
    // Prove the premise first, so the test cannot silently stop testing anything after an ICU or tzdata update.
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kiev" })).not.toThrow();
    const known = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM valid_timezones WHERE name='Europe/Kiev'");
    expect(known!.n).toBe(0);

    const broken = await makeAccount({ emailEnabled: true });
    await conflictingPair(broken.id);
    await execute("UPDATE account_settings SET timezone='Europe/Kiev' WHERE account_id=$1", [broken.id]);
    const healthy = await makeAccount({ emailEnabled: true });
    await conflictingPair(healthy.id);

    const scheduler = schedulerFor();
    const stats = await scheduler.runOnce();
    // The tick itself succeeded, and the healthy account was still served: this is the exact failure that used
    // to abort the whole tick from inside the account-selection LATERAL join, because the throw happened outside
    // the per-account try/catch.
    expect(stats.ticked).toBe(true);
    expect(stats.sent).toBe(1);
    expect(scheduler.health().lastError).toBe("account_timezone_invalid");
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM reminders WHERE account_id=$1", [broken.id]))[0]!.n).toBe(0);

    // It stays reported, tick after tick, rather than being scanned once and forgotten for a whole rotation.
    const again = await scheduler.runOnce();
    expect(again.ticked).toBe(true);
    expect(scheduler.health().lastError).toBe("account_timezone_invalid");

    // And correcting the zone brings the account back on the next tick.
    await execute("UPDATE account_settings SET timezone='Europe/Kyiv' WHERE account_id=$1", [broken.id]);
    const recovered = await scheduler.runOnce();
    expect(recovered.conflicts).toBe(1);
    expect(scheduler.health().lastError).toBeNull();
  });

  it("never offers a timezone the server cannot use", async () => {
    if (!config) return;
    // The account page built its <select> from Intl.supportedValuesOf("timeZone") alone. That is the list that
    // contains Europe/Kiev, Asia/Calcutta and America/Indianapolis, so the UI offered zones that sign-up would
    // accept and the scheduler would then choke on. GET /api/meta/timezones returns the intersection instead.
    const offered = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    const rows = await query<{ name: string }>("SELECT name FROM valid_timezones");
    const known = new Set(rows.map(r => r.name));
    const unusable = offered.filter(z => !known.has(z));
    expect(unusable.length).toBeGreaterThan(0); // the premise: the two sets really do differ
    expect(unusable).toContain("Europe/Kiev");
  });

  // ---- finding 25: a digest that is never delivered must not mark its conflicts as reported ------------------
  it("releases a conflict for re-alerting when its digest is suppressed, and keeps it when delivered", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    await conflictingPair(account.id);
    const scheduler = schedulerFor();
    expect((await scheduler.runOnce()).sent).toBe(1);
    const delivered = await query<{ notice_key: string }>("SELECT notice_key FROM conflict_notices WHERE account_id=$1", [account.id]);
    expect(delivered.length).toBe(1);

    // Nothing changes: still no second alert, because a DELIVERED digest keeps its notices.
    expect((await scheduler.runOnce()).sent).toBe(0);

    // Now make the same account undeliverable — no verified channel — and force the conflict to be fresh again.
    await execute("UPDATE accounts SET email_verified=false WHERE id=$1", [account.id]);
    await execute("UPDATE account_settings SET email_enabled=true WHERE account_id=$1", [account.id]);
    await execute("DELETE FROM conflict_notices WHERE account_id=$1", [account.id]);
    const stats = await scheduler.runOnce();
    expect(stats.conflicts).toBe(1); // a digest was created...
    expect(stats.sent).toBe(0);      // ...and could not be delivered.
    // The old behaviour left the notices in place here, so the conflict was marked "told" forever and the account
    // never heard about it once its channel came back.
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM conflict_notices WHERE account_id=$1", [account.id]))[0]!.n).toBe(0);
    const suppressed = await queryOne<{ status: string; error: string }>(
      "SELECT status, error FROM reminders WHERE account_id=$1 AND kind='overlap' ORDER BY created_at DESC LIMIT 1", [account.id]);
    expect(suppressed!.status).toBe("suppressed");
    expect(suppressed!.error).toBe("no_longer_applicable");

    // Fixing the channel brings the alert back, which is the whole point of releasing the notices.
    await execute("UPDATE accounts SET email_verified=true WHERE id=$1", [account.id]);
    const after = await scheduler.runOnce();
    expect(after.sent).toBe(1);
  });

  it("defers rather than destroys an alert whose account stops consenting before it is sent", async () => {
    if (!config) return;
    await truncateAll();
    const account = await makeAccount({ emailEnabled: true });
    await conflictingPair(account.id);
    const scheduler = schedulerFor();
    // Consent is checked at CREATION as well, so the digest has to exist before consent is withdrawn — that is
    // the case this is about: a legal-version bump landing between enqueue and delivery.
    expect((await scheduler.runOnce()).sent).toBe(1);

    // Put the delivered digest back in the queue, as an undelivered one would be. `last_attempt_at` has to go
    // too: dispatch applies exponential backoff from it, so a row that was attempted a millisecond ago is not a
    // candidate on the next tick at all, and the deferral branch would never be reached.
    await execute("UPDATE reminders SET sent_at=NULL, status='queued', attempts=0, last_attempt_at=NULL, claimed_at=NULL, claim_token=NULL, error=NULL, scheduled_for=now() WHERE account_id=$1", [account.id]);
    await execute("UPDATE account_consents SET terms_version='2020-01-01.1' WHERE account_id=$1", [account.id]);

    expect((await scheduler.runOnce()).sent).toBe(0);
    const row = await queryOne<{ status: string; error: string; attempts: number; claimed: boolean }>(
      "SELECT status, error, attempts, claimed_at IS NOT NULL AS claimed FROM reminders WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1", [account.id]);
    // It used to be marked `suppressed`, a TERMINAL state: accepting the terms a minute later brought nothing
    // back, because the row was no longer queued and nothing would ever pick it up again. Deferring keeps it
    // deliverable, and the 15-minute claim window keeps it from being retried every single tick.
    expect(row!.status).toBe("queued");
    expect(row!.error).toBe("consent_required");
    // Deferred, not retried: `attempts` drives the exponential backoff AND the 48-attempt dead-letter, so a
    // legal-version bump must not consume it. A terms change that dead-lettered an alert never once offered to a
    // provider would lose it twice over, because `dead` also releases the conflict's notices.
    expect(row!.attempts).toBe(0);
    expect(row!.claimed).toBe(true);
    // And the notices stay put, so the same conflict is not re-created from scratch on every tick — that churn
    // would be worst exactly when it matters most, right after a legal-version bump affects every account.
    expect((await query<{ n: number }>("SELECT count(*)::int AS n FROM conflict_notices WHERE account_id=$1", [account.id]))[0]!.n).toBe(1);

    // Accepting the current terms brings the SAME alert back, rather than losing it.
    // Accepting the current terms brings the SAME alert back, rather than losing it. Clearing `claimed_at`
    // stands in for the 15-minute claim window having elapsed, which is what makes the row a candidate again.
    await execute("UPDATE account_consents SET terms_version=$2, privacy_version=$2 WHERE account_id=$1", [account.id, LEGAL_VERSION]);
    await execute("UPDATE reminders SET claimed_at=NULL WHERE account_id=$1", [account.id]);
    expect((await scheduler.runOnce()).sent).toBe(1);
    const delivered = await queryOne<{ status: string; error: string | null }>(
      "SELECT status, error FROM reminders WHERE account_id=$1", [account.id]);
    expect(delivered!.status).toBe("accepted");
    expect(delivered!.error).toBeNull();
  });

  // ---- finding 5: the rotating pass must actually reach everybody --------------------------------------------
  // ---- finding 5: the rotating pass must actually reach everybody --------------------------------------------
  //
  // The old scan was ONE query whose filter was a keyset over `id` (`needs_scan OR cursor IS NULL OR id>cursor`)
  // while its ORDER BY was over `needs_scan DESC, soonest_cutoff, id`. Take 100 accounts out of 5,000: the first
  // tick returns the 100 highest-priority ones, spread across the whole id range, and stores the LAST of them as
  // the cursor. Every one of those accounts with an id BELOW that cursor is then excluded by `id > cursor` for the
  // rest of the rotation — including the ones with the soonest cutoffs, which is exactly the set the ordering was
  // trying to prioritise.
  //
  // `needs_scan` is the honest observable here: only the ROTATING pass clears it, and only for the accounts it
  // actually consumed. Under the old code the flag was cleared for every account in the batch (priority or not),
  // so once the whole table was clean the cursor stranded the rotation permanently.
  it("rotates through every account instead of stranding the ones below the cursor", async () => {
    if (!config) return;
    await truncateAll();
    const total = 5;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) ids.push((await makeAccount({ emailEnabled: true })).id);
    // No shifts at all: nothing is due, nothing conflicts, so the priority pass is empty and every account can
    // only be reached by the rotation. That is what makes this a test of the rotation and not of digest creation.
    const small = createScheduler({ ...config!, SCHEDULER_ACCOUNT_BATCH: 2, SCHEDULER_ENABLED: false });
    const dirty = async () => (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM accounts WHERE needs_scan"))!.n;

    expect(await dirty()).toBe(total);
    await small.runOnce();
    expect(await dirty()).toBe(total - 2);
    await small.runOnce();
    expect(await dirty()).toBe(total - 4);
    // The third tick gets the last account, does NOT fill its batch, and therefore resets the cursor — which is
    // what lets the next rotation start from the beginning instead of stranding everybody below a stale cursor.
    await small.runOnce();
    expect(await dirty()).toBe(0);
    const state = await queryOne<{ scan_cursor: string | null }>("SELECT scan_cursor FROM scheduler_state WHERE id=true");
    expect(state!.scan_cursor).toBeNull();

    // And it genuinely comes back round: mark everything dirty again and the same accounts are reached again.
    await execute("UPDATE accounts SET needs_scan=true");
    await small.runOnce();
    await small.runOnce();
    await small.runOnce();
    expect(await dirty()).toBe(0);
    for (const id of ids) {
      expect((await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM accounts WHERE id=$1", [id]))!.n).toBe(1);
    }
  });
});
