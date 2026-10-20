-- OAuth state is single-use and the PKCE verifier stays server-side.
CREATE TABLE IF NOT EXISTS oauth_states (
  nonce_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states(expires_at);
