-- 003_passkeys.sql
-- WebAuthn (passkey) support: the stored credentials and the one-time challenges.

-- The credentials a person's devices hold. A passkey is a key pair created by the authenticator (a phone, a laptop,
-- a platform authenticator); the private key never leaves it, so the row below holds only the public key.
CREATE TABLE IF NOT EXISTS passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- base64url, as the authenticator reports it
  credential_id text NOT NULL UNIQUE,
  -- base64url COSE public key
  public_key    text NOT NULL,
  -- the authenticator's signature counter, used to spot a cloned key
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[],
  device_type   text,
  backed_up     boolean NOT NULL DEFAULT false,
  aaguid        text,
  -- the stable "user handle" the authenticator stores for this account
  user_handle   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS passkeys_account_idx ON passkeys (account_id);

-- The one-time challenge for a registration or an authentication. It is stored (rather than kept in a signed cookie)
-- so it can be consumed exactly once: a replayed assertion finds no challenge and fails.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge        text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('registration', 'authentication')),
  account_id       uuid REFERENCES accounts(id) ON DELETE CASCADE,
  pending_signup_id uuid REFERENCES pending_signups(id) ON DELETE CASCADE,
  -- the user handle handed to the authenticator, so a registration can be tied to an account that does not exist yet
  user_handle      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_expires_idx ON webauthn_challenges (expires_at);
