ALTER TABLE security_events ADD COLUMN notice_accepted_at timestamptz;
CREATE TABLE security_notices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES security_events(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, target_email text NOT NULL, kind text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, last_attempt_at timestamptz, claimed_at timestamptz, claim_token uuid,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
 UNIQUE(event_id,target_email)
);
CREATE INDEX security_notices_due_idx ON security_notices(created_at);
