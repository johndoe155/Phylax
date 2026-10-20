-- 014_release_hardening.sql
-- Corrective hardening: per-conflict notification state, missing indexes, safe shift history,
-- browser-bound sign-in links, dirty-account scanning.

-- ---------------------------------------------------------------------------------------------
-- 1. Per-conflict notification state.
--
-- The old digest key hashed the whole risky-shift set, so the fingerprint changed the moment ONE conflict
-- ended (or the 14-day window rolled) and the account was told about conflicts it had already been told
-- about. What is needed is per-conflict state: a row per (account, conflict) that records "this has been
-- notified", expiring when the conflict itself stops being relevant.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conflict_notices (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  notice_key  text NOT NULL,                -- 'conflict:<shift a>:<shift b>:<kind>' or 'cancel:<shift id>'
  kind        text NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,                  -- when the underlying conflict stops being upcoming
  PRIMARY KEY (account_id, notice_key)
);
CREATE INDEX IF NOT EXISTS conflict_notices_expiry_idx ON conflict_notices (expires_at);
CREATE INDEX IF NOT EXISTS conflict_notices_account_idx ON conflict_notices (account_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Dirty-account scanning.
--
-- The scheduler scans 100 accounts per 60s tick: at 5,000 alert-enabled accounts a full cycle takes 50
-- minutes, and a short cancellation window can open and close between scans. Accounts are now marked dirty
-- when their shifts change, and the scan processes dirty accounts first, soonest-cutoff first.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS needs_scan boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS accounts_needs_scan_idx ON accounts (needs_scan) WHERE needs_scan;

-- Existing accounts start dirty once; the first scan after this migration clears them.
UPDATE accounts SET needs_scan = true WHERE needs_scan = false;

-- ---------------------------------------------------------------------------------------------
-- 3. Missing indexes.
--
-- Housekeeping, reconciliation and the security-event history all filtered on created_at/expires_at with no
-- index, so every tick did a sequential scan over up to 30 days of rows.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS reminders_expires_idx ON reminders (expires_at);
CREATE INDEX IF NOT EXISTS delivery_events_created_idx ON delivery_events (created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_created_idx ON notification_deliveries (created_at);
CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at);
CREATE INDEX IF NOT EXISTS delivery_suppressions_created_idx ON delivery_suppressions (created_at);

-- ---------------------------------------------------------------------------------------------
-- 4. Missing foreign-key indexes.
--
-- Every one of these is on the child side of an ON DELETE CASCADE or a join path: without them, deleting a
-- shift, a reminder or an account scans the child table.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS reminders_shift_idx ON reminders (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_deliveries_reminder_idx ON notification_deliveries (reminder_id) WHERE reminder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_deliveries_account_idx ON notification_deliveries (account_id);
CREATE INDEX IF NOT EXISTS security_events_account_idx ON security_events (account_id);
CREATE INDEX IF NOT EXISTS security_notices_account_idx ON security_notices (account_id);
CREATE INDEX IF NOT EXISTS webauthn_challenges_account_idx ON webauthn_challenges (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS webauthn_challenges_pending_idx ON webauthn_challenges (pending_signup_id) WHERE pending_signup_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 5. Alert history survives a deleted shift.
--
-- reminders.shift_id was ON DELETE CASCADE, so deleting a shift deleted its alert history and its dead-letter
-- rows: an operator investigating "why did I never hear about this shift?" found nothing. The reminder now
-- keeps its history with a null shift; a still-pending reminder whose shift is gone renders as
-- no_longer_applicable and is suppressed by the scheduler.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_shift_id_fkey;
ALTER TABLE reminders ADD CONSTRAINT reminders_shift_id_fkey
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------------
-- 6. Browser-bound sign-in links.
--
-- A magic link was not bound to the browser that requested it, so an attacker could request a link for their
-- OWN address and feed it to a victim's browser, signing the victim into the attacker's account (login CSRF).
-- The link now carries a hash of the browser nonce it was issued to.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE magic_links ADD COLUMN IF NOT EXISTS browser_hash text;

-- ---------------------------------------------------------------------------------------------
-- 7. Passkey device names.
--
-- A passkey was listed by the first twelve characters of its credential id, which tells a person nothing when
-- they are trying to work out which of their devices is which — and the whole point of the list is "is there a
-- device here I don't recognise?". The name is chosen by the person when the passkey is added, and can be changed
-- afterwards. It is a label, never an identifier: nothing authenticates on it.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS name text;
