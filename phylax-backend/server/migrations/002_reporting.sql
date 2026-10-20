-- 002_reporting.sql
-- Supporting queries for the scheduler and the operations dashboards.

-- The scheduler's hot path: the shifts of every account that has reminders switched on, soon enough to matter.
-- (A partial index cannot use CURRENT_DATE in its predicate — that is not immutable — so this is a plain index; the
-- scheduler filters on the account first, which the index on (account_id, date) already covers.)
CREATE INDEX IF NOT EXISTS shifts_account_date_idx_v2 ON shifts (account_id, date);

-- A quick "who is signed in" view, used by the ops endpoint.
-- (Postgres has no CREATE VIEW IF NOT EXISTS, so the view is dropped and recreated: it is a read-only projection
-- with no dependents, so this is safe to do on every run.)
DROP VIEW IF EXISTS account_overview;
CREATE VIEW account_overview AS
SELECT
  a.id                AS account_id,
  a.display_name,
  a.email,
  a.phone,
  s.email_enabled,
  s.sms_enabled,
  s.travel_minutes,
  s.cancel_hours,
  s.timezone,
  (SELECT count(*) FROM shifts sh WHERE sh.account_id = a.id) AS shift_count
FROM accounts a
LEFT JOIN account_settings s ON s.account_id = a.id;
