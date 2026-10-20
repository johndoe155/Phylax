-- Hash existing bearer sessions once. This migration requires a maintenance deployment:
-- old releases cannot read hashed sessions. Roll back application code only with a fresh sign-in.
UPDATE sessions SET id=encode(digest(id,'sha256'),'hex');
ALTER TABLE sessions ADD COLUMN reauthenticated_at timestamptz;
-- Existing sessions must explicitly step up; new authenticated sessions set this column.
ALTER TABLE reminders ADD COLUMN status text NOT NULL DEFAULT 'queued'
  CHECK(status IN ('queued','accepted','delivered','failed','bounced','suppressed','expired','dead'));
ALTER TABLE reminders ADD COLUMN expires_at timestamptz;
ALTER TABLE reminders ADD COLUMN claim_token uuid;
UPDATE reminders SET status='accepted' WHERE sent_at IS NOT NULL;
UPDATE reminders SET expires_at=scheduled_for+interval '14 days' WHERE expires_at IS NULL;
ALTER TABLE reminders ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE reminders ALTER COLUMN expires_at SET DEFAULT now()+interval '14 days';
CREATE INDEX reminders_queue_idx ON reminders(scheduled_for) WHERE sent_at IS NULL AND status='queued';
CREATE TABLE notification_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL,
 account_id uuid REFERENCES accounts(id) ON DELETE CASCADE, provider text NOT NULL, provider_id text NOT NULL,
 channel text NOT NULL, recipient_hash text NOT NULL, status text NOT NULL DEFAULT 'accepted',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,provider_id)
);
CREATE TABLE delivery_events(event_id text PRIMARY KEY, provider text NOT NULL, provider_id text NOT NULL, status text NOT NULL, applied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE delivery_suppressions(recipient_hash text PRIMARY KEY, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE rate_buckets(key text NOT NULL, bucket bigint NOT NULL, hits integer NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(key,bucket));
CREATE INDEX rate_buckets_expiry_idx ON rate_buckets(expires_at);
CREATE TABLE scheduler_state(id boolean PRIMARY KEY DEFAULT true CHECK(id), heartbeat_at timestamptz, completed_at timestamptz, error_code text, scan_cursor uuid);
INSERT INTO scheduler_state(id) VALUES(true);
CREATE TABLE security_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
