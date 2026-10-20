-- 016_replayable_digest_notices.sql
-- Making the notice release added in 015 reversible, so an operator replay cannot race the scanner.
--
-- 015 gave `conflict_notices` a `reminder_id`, so a digest that dies without ever being delivered can release
-- its conflicts and let them be reported again. That release has to be reversible, because the operator replay
-- endpoint (POST /api/ops/reminders/:id/replay) exists precisely to retry a dead digest — and once the notices
-- are gone, the next scan sees those conflicts as never-reported and creates a SECOND digest for them. The
-- operator's replay is then superseded by a duplicate, and the account can be told about the same conflict twice
-- by two different rows.
--
-- Storing the keys on the digest makes replay restorable, and it makes "which conflicts was this alert about?"
-- answerable from the row itself rather than only from a join that may already have been released.

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS notice_keys text[];

COMMENT ON COLUMN reminders.notice_keys IS
  'The conflict_notices.notice_key values this digest claimed. Used to restore them on an operator replay, so a replayed dead digest does not race the scanner into creating a duplicate.';
