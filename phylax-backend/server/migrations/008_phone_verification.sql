ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS phone_verifications (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  phone text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_verifications_expiry_idx ON phone_verifications(expires_at);
