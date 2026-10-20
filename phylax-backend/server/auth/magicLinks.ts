import { execute } from "../db.js";

/**
 * The one-time sign-in links.
 *
 * A link is a row in `magic_links`: the address it was sent to, a hash of the token, and when it stops
 * working. The token itself is never stored — only its hash — so a leaked database cannot be used to sign
 * anybody in.
 *
 * The rows are useless once the link has expired or been used, so the scheduler prunes them. Without that the
 * table grows for as long as the app is running, and it is the one table that grows fastest: every sign-in
 * attempt by email writes a row.
 */

/** Remove the links that have expired, and the used ones that are older than a week. */
export async function pruneMagicLinks(): Promise<number> {
  await execute("DELETE FROM phone_verifications WHERE expires_at < now()");
  await execute("DELETE FROM oauth_states WHERE expires_at < now()");
  await execute("DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'");
  await execute("DELETE FROM email_verification_tokens WHERE expires_at < now() - interval '1 day'");
  return execute(
    `DELETE FROM magic_links
      WHERE expires_at < now() - interval '1 day'
         OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')`,
  );
}
