-- 006_identity_management.sql
-- The tables behind the account-management features: verifying an email address, and resetting a password.
--
-- Both work the same way as the one-time sign-in link: the token is random, only its hash is stored, it expires
-- on its own, and it is consumed by the first use. A database leak cannot be replayed.

-- ---------------------------------------------------------------------------------------------
-- Verifying an email address
-- ---------------------------------------------------------------------------------------------

-- When somebody signs in with a password and types an address, they have proved they can type it, not that
-- they own it. This table holds the token that proves the rest.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_account_idx ON email_verification_tokens (account_id);
CREATE INDEX IF NOT EXISTS email_verification_tokens_expires_idx ON email_verification_tokens (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Resetting a password
-- ---------------------------------------------------------------------------------------------

-- The token here is longer-lived than the others, because a person who has lost their password may not see
-- the email for a while. It is still single-use, and it is still stored only as a hash.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_account_idx ON password_reset_tokens (account_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx ON password_reset_tokens (expires_at);

-- ---------------------------------------------------------------------------------------------
-- The reasons a person signed in
-- ---------------------------------------------------------------------------------------------

-- The accounts table records whether the address is verified, but not when it was verified or how. A consent
-- record and a verification record answer different questions, and both are worth keeping.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- A provider tells us whether it has verified the address it gave us. Apple and Google both do, and the
-- answer decides whether the account starts with a verified address.
ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------------------------
-- Claiming a reminder
-- ---------------------------------------------------------------------------------------------

-- A reminder is sent by a background process, and there must never be two of them sending the same one.
-- The dedupe key stops the same warning being CREATED twice, but not the same warning being SENT twice: two
-- processes would both pick up the rows that have not been sent yet.
--
-- So a process claims the rows it is about to send, by writing its claim into them. The write is a single
-- statement, so exactly one process can win each row. `claimed_at` is also how a claim that was never
-- finished (the process died mid-send) is noticed and taken back.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

