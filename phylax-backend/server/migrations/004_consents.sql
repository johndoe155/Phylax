-- 004_consents.sql
-- The record of what each person agreed to, and when.

-- A consent is kept, not just a boolean: the versions of the terms and the privacy policy that were on screen at
-- the moment the person agreed. If the documents are re-issued, the old agreements still say which text they saw.
CREATE TABLE IF NOT EXISTS account_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  terms_version   text NOT NULL,
  privacy_version text NOT NULL,
  accepted_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_consents_account_idx ON account_consents (account_id, accepted_at DESC);
