-- A reset token proves control of the address it was delivered to, not a later replacement address.
ALTER TABLE password_reset_tokens ADD COLUMN email text;
UPDATE password_reset_tokens t SET email=a.email FROM accounts a WHERE a.id=t.account_id;
DELETE FROM password_reset_tokens WHERE email IS NULL;
ALTER TABLE password_reset_tokens ALTER COLUMN email SET NOT NULL;
