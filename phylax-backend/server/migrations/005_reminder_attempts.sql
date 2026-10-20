-- 005_reminder_attempts.sql
-- A reminder that could not be sent needs a retry budget, or a broken provider would have the scheduler trying the
-- same message forever.

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
