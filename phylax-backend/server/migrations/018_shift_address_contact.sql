-- 018_shift_address_contact.sql
-- Store the two fields the app has always collected on a shift but the schema never had: the site's address and the
-- contact for the shift.
--
-- WHY A MIGRATION RATHER THAN DELETING THE FIELDS FROM THE APP.
--
-- The browser's shift model (client/src/lib/shifts.ts) carries `address` on a saved tile and on a shift, and `contact`
-- on a shift (filled from the detail sheet). The dashboard shows both, the edit panel edits them, and the CSV export has
-- a column for the address. The database had no column for either, and the import validator silently stripped them
-- (`z.object` drops unknown keys), so those two values had exactly two possible homes:
--
--   1. keep them in localStorage only — which splits one shift across two stores, so the same row would have an address
--      on this device and none on another, and the export would differ from what the account holds; or
--   2. give them a column.
--
-- Option 2 is what this does. Nothing is renamed, nothing moves, and every existing row is valid without a backfill:
-- both columns are nullable, so an account that never used them is unaffected and the API keeps answering exactly as it
-- did for those rows.
--
-- `patterns.address` follows for the same reason: a tile is what a shift is logged from, and the address shown on the
-- tile has to come from somewhere the server holds, or the dashboard would invent it again on every device.
--
-- LENGTHS match the browser's own limits (client/src/lib/manageShifts.ts FIELD_MAX): address 200 characters. `contact`
-- is a person's name or a phone number, so it gets the same generous ceiling as a facility name. They are CHECKed here as
-- well as clamped in the route, so a client that bypasses the route cannot store a 10 MB contact.
--
-- This migration is additive and idempotent (IF NOT EXISTS), which is the same style as every other one in this
-- directory: applying it twice is a no-op.

ALTER TABLE shifts   ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE shifts   ADD COLUMN IF NOT EXISTS contact text;
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS address text;

-- The limits are added separately so re-running this file after a partial failure cannot fail on a duplicate constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shifts_address_len') THEN
    ALTER TABLE shifts ADD CONSTRAINT shifts_address_len CHECK (address IS NULL OR char_length(address) <= 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shifts_contact_len') THEN
    ALTER TABLE shifts ADD CONSTRAINT shifts_contact_len CHECK (contact IS NULL OR char_length(contact) <= 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patterns_address_len') THEN
    ALTER TABLE patterns ADD CONSTRAINT patterns_address_len CHECK (address IS NULL OR char_length(address) <= 200);
  END IF;
END
$$;
