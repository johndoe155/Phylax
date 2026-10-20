/**
 * Contact adapter for the two pricing dialogs (components/pricing/ContactDialog.tsx): "Join the waitlist" and
 * "Ask a question". The dialogs only depend on what is exported here.
 *
 * PLACEHOLDER SEND. Phylax has no backend for this yet (server/index.ts only serves the built site). So:
 *   - set VITE_CONTACT_ENDPOINT to a URL that accepts a JSON POST (a form service, a serverless function...) and every
 *     submission is sent there, as `ContactRequest` plus `source` and `sentAt`. A non-2xx answer shows the dialog's
 *     "Couldn't send" message;
 *   - leave it unset and the send is simulated: a short wait, then success. Nothing is stored or sent, so set the
 *     variable before launch (a production build warns in the console as a reminder).
 *
 * DEMO. In the simulated mode an email that starts with "error@" fails, so the failure state can be seen.
 * The server should validate again, rate-limit, and never trust the client's `sentAt`.
 */

export type ContactKind = "waitlist" | "question";

export interface ContactValues { name: string; email: string; message: string }
export type ContactErrors = Partial<Record<keyof ContactValues, string>>;

export type ContactRequest =
  | { kind: "waitlist"; email: string; name?: string }
  | { kind: "question"; name: string; email: string; message: string };

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/; // the same test the sign-in page uses
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const MESSAGE_MAX = 1000;

/** What is wrong with each field, in the words shown under it. Empty when everything is fine. */
export function validateContact(kind: ContactKind, values: ContactValues): ContactErrors {
  const found: ContactErrors = {};
  const email = values.email.trim();
  if (kind === "question" && !values.name.trim()) found.name = "Enter your name.";
  if (!email) found.email = "Enter your email address.";
  else if (!EMAIL_RE.test(email)) found.email = "Enter a valid email, like name@work.com.";
  if (kind === "question" && !values.message.trim()) found.message = "Write your question.";
  return found;
}

export function toRequest(kind: ContactKind, values: ContactValues): ContactRequest {
  const name = values.name.trim();
  const email = values.email.trim();
  if (kind === "waitlist") return name ? { kind, email, name } : { kind, email };
  return { kind, name, email, message: values.message.trim() };
}

export class ContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactError";
  }
}

const ENDPOINT = (import.meta.env.VITE_CONTACT_ENDPOINT as string | undefined)?.trim();
let warned = false;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves when the message has been accepted.
 * Rejects with an AbortError when the person cancelled (swallow it) and with anything else when it could not be sent.
 */
export async function sendContact(request: ContactRequest, signal?: AbortSignal): Promise<void> {
  if (ENDPOINT) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...request, source: "pricing", sentAt: new Date().toISOString() }),
      signal,
    });
    if (!response.ok) throw new ContactError(`The contact endpoint answered ${response.status}.`);
    return;
  }

  if (import.meta.env.PROD && !warned) {
    warned = true;
    console.warn("VITE_CONTACT_ENDPOINT is not set: waitlist and question submissions are simulated and go nowhere.");
  }
  await wait(1100, signal);
  if (request.email.toLowerCase().startsWith("error@")) throw new ContactError("Simulated failure.");
  if (import.meta.env.DEV) console.info("[contact placeholder] accepted", request);
}
