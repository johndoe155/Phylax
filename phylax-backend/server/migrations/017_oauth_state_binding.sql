-- 017_oauth_state_binding.sql
-- Make the OAuth callback findable without a cookie, which is what "Sign in with Apple" requires.
--
-- `oauth_states` was keyed by the hash of the `phylax_oauth` COOKIE value. Apple uses
-- `response_mode=form_post`: it renders a page on appleid.apple.com that auto-submits a form to our callback.
-- That is a CROSS-SITE POST, and browsers do not attach cookies to cross-site POSTs unless the cookie is
-- SameSite=None AND the browser is willing — which for a third-party-initiated form post it frequently is not.
--
-- So for Apple the cookie did not arrive, and because the cookie value WAS the lookup key, the row holding the
-- PKCE code verifier was unreachable too. The callback failed before it ever reached the linking logic: every
-- attempt to link an Apple identity to an existing account ended at /login?error=oauth, and
-- /login?error=linking for the ones that got further. Linking an Apple provider could not succeed at all.
--
-- The state itself is the carrier that is GUARANTEED to round-trip: Apple puts it in the form body, Google puts
-- it in the query string, and it is HMAC-signed and single-use. Keying the row on an id inside that signed state
-- makes the verifier reachable on a cookieless callback, and consuming the row (DELETE ... RETURNING) is a
-- stronger binding than the cookie ever was — a state can be redeemed exactly once, by whoever holds it, and it
-- only ever existed in the browser that was redirected to the provider.
--
-- `nonce_hash` stays: it is the existing primary key, it is what the browser-bound same-site flows still check,
-- and removing it would invalidate in-flight authorisations at deploy time.

ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS state_id text;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_state_id_key ON oauth_states (state_id) WHERE state_id IS NOT NULL;
