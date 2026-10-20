/**
 * The legal documents a person agrees to when they create an account, and the version of each that this build shows.
 *
 * Both documents are served by pages/Legal.tsx (text in lib/legalDocs.ts), which shows these versions. Bump a version
 * whenever its text changes: the account flow sends them with the person's acceptance, so the record says exactly which
 * text they agreed to. TODO(legal): the text is a pre-launch draft until counsel has reviewed it and /api/legal reports it approved.
 */
export const TERMS_URL = "/terms";
export const PRIVACY_URL = "/privacy";
export const TERMS_VERSION = "2026-10-17";
export const PRIVACY_VERSION = "2026-10-17";
/**
 * The single version string the account page shows next to "Terms & privacy" and sends with "Save policy consent".
 * It moves whenever either document changes (the part after the dot counts revisions within a day). The server is the
 * authority and publishes its own in the account meta (lib/account.ts); this is what the page shows until that arrives.
 */
export const POLICY_VERSION = "2026-10-17.2";
