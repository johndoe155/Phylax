-- 015_production_readiness.sql
-- The schema changes behind the production-readiness remediation: a PostgreSQL-side timezone allow-list,
-- monotonic digest generations, notice-to-reminder lineage, optimistic concurrency on shifts, date bounds,
-- account suspension, link purposes and the removal of a column that stored a credential nobody could use.
--
-- Everything here is ADDITIVE or NOT VALID-then-VALIDATED, so it can be applied to a live database without a
-- maintenance window of its own. Nothing in here rewrites an existing column's type.

-- ---------------------------------------------------------------------------------------------
-- 1. A PostgreSQL-side allow-list of timezone names.
--
-- `account_settings.timezone` was validated two different ways depending on the write path. PUT /settings
-- checked it against pg_timezone_names; account CREATION checked it with `Intl.DateTimeFormat` alone. Those two
-- sets are not the same: this build's ICU accepts 18 zone names that this PostgreSQL rejects outright, and
-- `client/src/pages/Account.tsx` builds its dropdown from exactly the ICU list. So a person in Ukraine could
-- pick "Europe/Kiev" from the picker, save it through sign-up, and the scheduler's
--
--     ... AT TIME ZONE CASE WHEN s.timezone ~ '^[A-Za-z][A-Za-z0-9/_+-]*$' THEN s.timezone ELSE 'UTC' END
--
-- would throw `time zone "Europe/Kiev" not recognized` — because the regex MATCHES, so the CASE passes the bad
-- zone straight through. That throw happened in the account-selection LATERAL join, which is outside the
-- per-account try/catch, so it aborted the whole tick: no digests, no dispatch, no security notices and no
-- reconciliation for ANY account, every tick, until somebody's timezone was fixed by hand.
--
-- A regex cannot answer "does PostgreSQL know this zone". A table can. It is refreshed from the authoritative
-- source at migration time and on every boot (server/db.ts refreshValidTimezones), so it follows the server's
-- own tzdata through an OS upgrade.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS valid_timezones (
  name        text PRIMARY KEY,
  is_dst      boolean NOT NULL DEFAULT false,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO valid_timezones (name, is_dst)
SELECT name, is_dst FROM pg_timezone_names
ON CONFLICT (name) DO UPDATE SET is_dst = EXCLUDED.is_dst, refreshed_at = now();

-- ---------------------------------------------------------------------------------------------
-- 2. Monotonic digest generations.
--
-- The generation number in `digest:<account>:<kind>:<generation>` was computed as the COUNT of surviving
-- digest rows for that account and kind. Retention prunes sent reminders after 30 days, so the count goes DOWN:
-- an account that had received generations 0 and 1, whose rows were then pruned, counted 0 again and produced
-- `digest:...:overlap:0` a second time. That key already existed in the unique index (or collided with a row
-- that had not yet been pruned), the `ON CONFLICT DO NOTHING` swallowed the insert, and the new conflict digest
-- was silently dropped — the account was never told.
--
-- A stored, never-reused counter fixes it. The existing trailing component is backfilled so history keeps its
-- generations, and anything that does not parse gets 0.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;

-- Backfill from the trailing component of the existing key. The regex guard is what makes the cast safe:
-- a key whose fourth segment is not a number keeps the default 0 rather than failing the migration.
UPDATE reminders
   SET generation = (split_part(dedupe_key, ':', 4))::integer
 WHERE dedupe_key LIKE 'digest:%'
   AND split_part(dedupe_key, ':', 4) ~ '^[0-9]+$';

-- The next generation for one (account, kind) is a MAX over this index, not a COUNT over the table.
CREATE INDEX IF NOT EXISTS reminders_generation_idx ON reminders (account_id, kind, generation DESC);

-- ---------------------------------------------------------------------------------------------
-- 3. Notice-to-reminder lineage.
--
-- `conflict_notices` rows were written when a digest was ENQUEUED and never unwritten. A digest that was then
-- suppressed (no verified channel), expired, or dead-lettered after 48 attempts had already marked its
-- conflicts as "notified", so those conflicts could never be alerted again — the account would never hear about
-- a conflict the system knew about and failed to deliver.
--
-- Recording which reminder claimed a notice lets a terminal failure release it (see scheduler.ts). The column
-- is nullable and CASCADEs: notices written before this migration have no lineage and are treated as already
-- reported, which is the honest reading of history.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE conflict_notices ADD COLUMN IF NOT EXISTS reminder_id uuid REFERENCES reminders(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS conflict_notices_reminder_idx ON conflict_notices (reminder_id) WHERE reminder_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Optimistic concurrency on shifts.
--
-- Two tabs, or a tab and an import, could both PUT the same shift: last writer wins and the first person's edit
-- disappears with no indication. `version` lets a writer say which version it read, and a stale write becomes a
-- 409 the client can resolve by reloading. Default 1 means every existing row is immediately usable.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------------------------
-- 5. Date bounds.
--
-- `shifts.date` had no bound at all, so a typo or a hostile import could store the year 999999 — which then
-- landed in the scheduler's 14-day window arithmetic and in every capacity count. Added NOT VALID so existing
-- out-of-range rows cannot fail the migration, then validated: if this statement fails, the table has rows that
-- need looking at, and that is a finding rather than a migration failure to paper over.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_date_bounds;
ALTER TABLE shifts ADD CONSTRAINT shifts_date_bounds
  CHECK (date BETWEEN DATE '2000-01-01' AND (CURRENT_DATE + INTERVAL '10 years')::date) NOT VALID;
ALTER TABLE shifts VALIDATE CONSTRAINT shifts_date_bounds;

-- ---------------------------------------------------------------------------------------------
-- 6. Account suspension.
--
-- There was no way to stop an account without deleting it. An account that is being abused — SMS pumping,
-- harassing a facility, a compromised credential — had exactly two operator options: leave it running or
-- destroy the person's data, which is also destroying the evidence. Suspension stops sign-in and every
-- mutating API call, keeps the data intact, and is reversible.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspension_reason text;
CREATE INDEX IF NOT EXISTS accounts_suspended_idx ON accounts (suspended_at) WHERE suspended_at IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 7. Magic-link purposes.
--
-- A link could only ever mean "sign in". Step-up reauthentication — required before deleting an account,
-- changing a password or linking a provider — accepted a password or a passkey, so an account whose only
-- credential was an email link could never satisfy it and was permanently locked out of its own security
-- settings. A `reauth` link steps up the CURRENT session instead of creating a new one.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'signin'
  CHECK (purpose IN ('signin', 'reauth'));
-- A reauth link belongs to the account being stepped up, and must never be usable to sign in as somebody else.
ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS magic_links_purpose_idx ON magic_links (purpose, created_at) WHERE purpose = 'reauth';
CREATE INDEX IF NOT EXISTS magic_links_account_idx ON magic_links (account_id) WHERE account_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 8. Drop the stored password hash nobody could use.
--
-- `pending_signups.password_hash` was left over from the flow in which typing a password at sign-in created an
-- account. That flow was deliberately removed — password sign-in no longer creates accounts, and every signup
-- now begins with a proved email, a provider verification claim or a passkey ceremony — but the column stayed,
-- so a scrypt hash of a password a person had typed was sitting in a table with a 15-minute expiry and no code
-- path that could ever read it. A stored credential with no reader is only a disclosure risk.
--
-- The password route still stages a hash for a LEGACY provisional account (see integration.test.ts), so the
-- column is dropped only if nothing writes it: the code change and this migration land together.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE pending_signups DROP COLUMN IF EXISTS password_hash;

-- ---------------------------------------------------------------------------------------------
-- 9. Idle session expiry.
--
-- `sessions.last_seen_at` already existed and was already maintained (throttled to one write per minute per
-- session), but nothing read it for expiry: a session lived until its absolute TTL, up to 365 days. The check
-- is `last_seen_at < now() - idle`, which needs the index below to stay cheap inside the per-request session
-- lookup. Partial, because only live rows are ever candidates.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sessions_idle_idx ON sessions (last_seen_at);

-- ---------------------------------------------------------------------------------------------
-- 10. account_settings.phone is not a second place to put a number.
--
-- PUT /settings wrote whatever phone the client sent straight into `accounts.phone`, unverified, and mirrored
-- it here — so an unproved number could become the alert destination, and the same fact lived in two tables
-- that could disagree. The column stays (existing reads depend on it) but is now maintained only from the
-- verified value, inside the same transaction as `accounts.phone`. The assertion is documented here because
-- the invariant is enforced in code, where the transaction is: see server/routes/account.ts.
-- ---------------------------------------------------------------------------------------------
COMMENT ON COLUMN account_settings.phone IS
  'Mirror of accounts.phone, written only from a VERIFIED number inside the same transaction. Never client-supplied.';

