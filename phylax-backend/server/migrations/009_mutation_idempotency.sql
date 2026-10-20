-- Browser-generated keys make retried creates safe after an ambiguous network timeout.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS client_id text CHECK (length(client_id) <= 128);
ALTER TABLE patterns ADD COLUMN IF NOT EXISTS client_id text CHECK (length(client_id) <= 128);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_client_id_uniq ON shifts(account_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS patterns_client_id_uniq ON patterns(account_id, client_id) WHERE client_id IS NOT NULL;
