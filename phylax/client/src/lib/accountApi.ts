/**
 * The one seam between the account components and the backend. They import every call from here, never from a concrete
 * implementation, so swapping the implementation is a one-line change and nothing else.
 *
 * It now points at accountApi.real.ts, which talks to the Phylax API (same-origin cookies, CSRF header, the account,
 * passkey, session and reminder endpoints). Types and pure helpers stay in account.ts.
 *
 * The placeholder it used to point at (accountDemo.ts, a localStorage simulation of the same calls) has been removed: it
 * modelled a password sign-up the backend deliberately does not have, and keeping two implementations of the same
 * contract invites the pages to drift back to the one that is not real. Its contract survives in the header of
 * accountApi.real.ts and in the comments on each function.
 */
export * from "./accountApi.real";
