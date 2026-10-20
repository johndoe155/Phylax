import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.js";
import { deliveryAllowed, refundDelivery, trackDelivery, type BudgetReservation } from "./control.js";
import { unsubscribeHeaders, unsubscribeLink } from "./unsubscribe.js";
import type { Config } from "../config.js";

/**
 * Outbound email.
 *
 * The product's promise is "a warning at the moment you need it", and the landing page says alerts arrive by text
 * first, with email behind it. Either way the message has to come from a real provider, and the provider differs
 * per deployment, so the choice is configuration rather than code:
 *
 *   log      write the message to stdout and to a file. The default: it needs no credentials, and it is enough to
 *            develop and to prove the flow end to end.
 *   resend   the Resend HTTP API.
 *   postmark the Postmark HTTP API.
 *   smtp     any SMTP server, through nodemailer (loaded only if it is installed).
 *
 * The HTTP providers are called with `fetch`, so they need no SDK and no native code. That matters on a small VM
 * where every dependency is something else to keep patched.
 *
 * Budgets are reserved BEFORE the send and refunded when it fails (see control.ts), so a provider outage does not
 * spend a recipient's daily allowance on messages that were never delivered. `kind` keeps transactional traffic
 * (sign-in links, resets, security notices, verification codes) out of the alert budgets. Alert messages carry a
 * List-Unsubscribe header, which mailbox providers increasingly require and which gives people a visible way out.
 */

export type MailMessage = {
  to: string;
  reminderId?: string;
  idempotencyKey?:string;
  accountId?: string;
  subject: string;
  text: string;
  html?: string;
  /** Which budget pool this message counts against. Default: alert. */
  kind?: "alert" | "transactional";
};

export type SendResult = { ok: boolean; id?: string; error?: string };

/** Where the "log" provider writes the messages it would have sent. */
const LOG_DIR = process.env.MAIL_LOG_DIR ?? path.resolve(process.cwd(), "var", "mail");

/**
 * The unsubscribe headers for an alert message.
 *
 * Mailbox providers (Gmail and Yahoo Mail since 2024) treat bulk senders without a working List-Unsubscribe as
 * spam. This used to point at `${APP_URL}/account`, which is behind a sign-in: the provider's own "unsubscribe"
 * button therefore led to a login form, which is not a one-click unsubscribe and is exactly what pushes people to
 * the spam button instead — and a spam complaint then suppressed their transactional mail too (see control.ts).
 *
 * The real implementation is in `./unsubscribe.ts`: a signed, expiring token, an RFC 8058
 * `List-Unsubscribe-Post` header, and a route that needs no session. Transactional messages still deliberately
 * carry nothing: a security notice is not something a person should be able to unsubscribe from.
 */
function alertUnsubscribeHeaders(config: Config, message: MailMessage): Record<string, string> {
  if (message.kind === "transactional") return {};
  return unsubscribeHeaders(config, "email", message.to);
}

/**
 * The unsubscribe link to put in the BODY of an alert message.
 *
 * Not every client surfaces the header, and a person reading a plain-text reminder on a phone has no other way to
 * act on "stop emailing me" without signing in. Returns "" for transactional mail.
 */
export function alertUnsubscribeFooter(config: Config, message: MailMessage): string {
  if (message.kind === "transactional") return "";
  const link = unsubscribeLink(config, "email", message.to);
  if (!link) return "";
  return `\n\nStop these alerts: ${link}\n(This does not stop sign-in links or security notices.)`;
}

/** Send one email. Never throws: a failure is reported in the result. */
export async function sendMail(config: Config, message: MailMessage): Promise<SendResult> {
  if (config.MAIL_PROVIDER === "disabled" || (config.isProd && config.MAIL_PROVIDER === "log")) return { ok: false, error: "delivery_disabled" };
  const kind = message.kind ?? "alert";
  try {
    let reservations: BudgetReservation[] = [];
    if (config.MAIL_PROVIDER !== "log") {
      const decision = await deliveryAllowed(config, "email", message.to, 1, kind);
      if (!decision.ok) return { ok: false, error: decision.reason };
      reservations = decision.reservations;
    }
    const result = await (async (): Promise<SendResult> => {
    switch (config.MAIL_PROVIDER) {
      case "resend":
        return await sendViaResend(config, message);
      case "postmark":
        return await sendViaPostmark(config, message);
      case "smtp":
        return await sendViaSmtp(config, message);
      case "log":
      default:
        return await sendViaLog(message);
    }
    })();
    if (result.ok) await trackDelivery(config.MAIL_PROVIDER, result.id, "email", message.to, config, message);
    else await refundDelivery(reservations); // a failed send must not consume the budget
    return result;
  } catch (err) {
    log.error("email send failed", { provider: config.MAIL_PROVIDER, error: err });
    return { ok: false, error: "provider_unavailable" };
  }
}

async function sendViaLog(message: MailMessage): Promise<SendResult> {
  const id = `log_${Date.now().toString(36)}`;
  const body = [
    `--- email (provider: log) ---`,
    `to:      ${message.to}`,
    `subject: ${message.subject}`,
    ``,
    message.text,
    ``,
  ].join("\n");
  // stdout for `journalctl`, and a file so the message can be read back after the fact.
  process.stdout.write(body + "\n");
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), body + "\n");
  } catch {
    /* the file copy is a convenience, not a requirement */
  }
  return { ok: true, id };
}

async function sendViaResend(config: Config, message: MailMessage): Promise<SendResult> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json", ...((message.idempotencyKey || message.reminderId) ? { "Idempotency-Key": message.idempotencyKey ?? `phylax-${message.reminderId}` } : {}) },
    body: JSON.stringify({
      from: config.MAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text + alertUnsubscribeFooter(config, message),
      ...(message.html ? { html: message.html } : {}),
      ...(config.MAIL_REPLY_TO ? { reply_to: config.MAIL_REPLY_TO } : {}),
      ...{ headers: alertUnsubscribeHeaders(config, message) },
    }),
  });
  if (!res.ok) return { ok: false, error: `provider_http_${res.status}` };
  const json = (await res.json()) as { id?: string };
  return { ok: true, id: json.id };
}

async function sendViaPostmark(config: Config, message: MailMessage): Promise<SendResult> {
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "X-Postmark-Server-Token": config.POSTMARK_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({
      From: config.MAIL_FROM,
      To: message.to,
      Subject: message.subject,
      TextBody: message.text + alertUnsubscribeFooter(config, message),
      ...(config.MAIL_REPLY_TO ? { ReplyTo: config.MAIL_REPLY_TO } : {}),
      ...(message.html ? { HtmlBody: message.html } : {}),
      ...(config.POSTMARK_MESSAGE_STREAM ? { MessageStream: config.POSTMARK_MESSAGE_STREAM } : {}),
      ...{ Headers: Object.entries(alertUnsubscribeHeaders(config, message)).map(([Name, Value]) => ({ Name, Value })) },
    }),
  });
  if (!res.ok) return { ok: false, error: `provider_http_${res.status}` };
  const json = (await res.json()) as { MessageID?: string };
  return { ok: true, id: json.MessageID };
}

async function sendViaSmtp(config: Config, message: MailMessage): Promise<SendResult> {
  // nodemailer is optional: it is only needed by the SMTP provider, so it is loaded on demand and through a
  // variable specifier, which keeps it out of the dependency graph (and out of the type check) entirely.
  const specifier = "nodemailer";
  type Nodemailer = { createTransport: (opts: unknown) => { sendMail: (opts: unknown) => Promise<unknown> } };
  let nodemailer: Nodemailer;
  try {
    nodemailer = (await import(/* @vite-ignore */ specifier)) as unknown as Nodemailer;
  } catch {
    return { ok: false, error: "MAIL_PROVIDER=smtp needs the optional 'nodemailer' package installed" };
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    // Without this, port 587 uses OPPORTUNISTIC STARTTLS: a relay that does not advertise it receives the message
    // — including sign-in links and verification codes — in clear text, and nothing reports that it happened.
    // requireTLS makes a missing upgrade a hard failure instead of a silent downgrade. config.ts additionally
    // refuses to boot in production with both SMTP_SECURE and SMTP_REQUIRE_TLS off.
    requireTLS: !config.SMTP_SECURE && config.SMTP_REQUIRE_TLS,
    tls: config.SMTP_REQUIRE_TLS ? { rejectUnauthorized: true } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  });
  const info = (await transport.sendMail({
    from: config.MAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text + alertUnsubscribeFooter(config, message),
    html: message.html,
    replyTo: config.MAIL_REPLY_TO,
    headers: alertUnsubscribeHeaders(config, message),
  })) as { messageId?: string };
  return { ok: true, id: info.messageId };
}

/** The sign-in link email. */
export function magicLinkEmail(appUrl: string, link: string): { subject: string; text: string } {
  return {
    subject: "Your Phylax sign-in link",
    text: [
      "Here is your sign-in link:",
      "",
      link,
      "",
      "It works once, and it expires in 15 minutes.",
      "",
      "If you did not ask to sign in, you can ignore this message.",
      `Phylax — ${appUrl}`,
    ].join("\n"),
  };
}

/**
 * The step-up email: proof of presence before a sensitive change, for an account whose way in is an email link.
 *
 * Distinct from the sign-in link on purpose. This one does NOT create a session — it confirms the session the
 * person already has, so it says "confirm it's you" and tells them to open it in the same browser (the redeem
 * needs the session cookie that is only in the browser that asked). See POST /api/auth/reauthenticate/link.
 */
export function reauthLinkEmail(appUrl: string, link: string): { subject: string; text: string } {
  return {
    subject: "Confirm it's you — Phylax",
    text: [
      "You asked to make a sensitive change to your Phylax account, so we need to confirm it's really you.",
      "",
      "Open this link in the SAME browser you're signed in on:",
      "",
      link,
      "",
      "It works once, and it expires in 15 minutes. It confirms your current session; it does not sign you in anywhere new.",
      "",
      "If you did not ask for this, you can ignore it — nothing changes until the link is used.",
      `Phylax — ${appUrl}`,
    ].join("\n"),
  };
}

/** The "your account is ready" email. */
export function welcomeEmail(appUrl: string, displayName: string): { subject: string; text: string } {
  return {
    subject: "Welcome to Phylax",
    text: [
      `Welcome, ${displayName}.`,
      "",
      "Your account is ready. Log a shift and Phylax will check it against everything else you have logged.",
      "",
      `${appUrl}/dashboard`,
      "",
      "Phylax warns and explains. It never deletes a shift for you.",
    ].join("\n"),
  };
}

/** The email that lets somebody set a new password after they have forgotten the old one. */
export function passwordResetEmail(appUrl: string, link: string): { subject: string; text: string } {
  return {
    subject: "Reset your Phylax password",
    text: [
      "Somebody asked to reset the password for this Phylax account.",
      "",
      "If that was you, use this link to set a new one:",
      "",
      link,
      "",
      "The link works once, and it stops working in an hour.",
      "",
      "If it wasn't you, nothing has changed and you can ignore this message.",
    ].join("\n"),
  };
}

/** The email that confirms somebody owns the address they have just put on their account. */
export function emailVerificationEmail(appUrl: string, link: string): { subject: string; text: string } {
  return {
    subject: "Confirm your Phylax email address",
    text: [
      "Please confirm this email address for your Phylax account.",
      "",
      link,
      "",
      "The link works once, and it stops working in a day.",
      "",
      "If you did not ask for this, nothing has changed and you can ignore this message.",
    ].join("\n"),
  };
}
