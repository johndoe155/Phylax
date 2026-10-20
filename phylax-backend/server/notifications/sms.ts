import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../log.js";
import { deliveryAllowed, refundDelivery, trackDelivery, type BudgetReservation } from "./control.js";
import type { Config } from "../config.js";

/**
 * Outbound text messages.
 *
 * The landing page promises "alerts by text, so they work on any phone", and the scheduler is what keeps that
 * promise. The provider is configuration, as with email:
 *
 *   log      write the message to stdout and to a file. The default: no credentials needed.
 *   twilio   the Twilio REST API, called directly with `fetch` (no SDK, no native code).
 *   webhook  POST the message as JSON to a URL of your choosing, for a provider this file has not heard of.
 *
 * A message is plain text and short: it has to fit on a lock screen and still say what the person needs to know.
 */

export type SmsMessage = {
  to: string;
  reminderId?: string;
  accountId?: string;
  body: string;
  /** Which budget pool this message counts against. Default: alert. */
  kind?: "alert" | "transactional";
};

export type SendResult = { ok: boolean; id?: string; error?: string };

const LOG_DIR = process.env.SMS_LOG_DIR ?? path.resolve(process.cwd(), "var", "sms");

/** Send one text. Never throws: a failure is reported in the result. */
export async function sendSms(config: Config, message: SmsMessage): Promise<SendResult> {
  if (config.SMS_PROVIDER === "disabled" || (config.isProd && config.SMS_PROVIDER === "log")) return { ok: false, error: "delivery_disabled" };
  const kind = message.kind ?? "alert";
  try {
    let reservations: BudgetReservation[] = [];
    if (config.SMS_PROVIDER !== "log") {
      const unicode=/[^\x20-\x7E\r\n]/.test(message.body);
      // The GSM-03.38 extension table, and nothing else: ^ { } \ [ ~ ] |. Each of these is TWO septets, not one, so a
      // message made of them does not fit in 160 characters. The class has to be exactly these eight — the previous
      // version had a stray `^` straight after `[`, which turns a character class into its NEGATION: it counted every
      // ordinary character as an extension and billed every message at roughly twice its length, so long messages
      // were refused as multi-part they would never have needed to be.
      const size=unicode?message.body.length:message.body.length+(message.body.match(/[\^{}[~\]|\\]/g)?.length??0);
      const units=size<=(unicode?70:160)?1:Math.ceil(size/(unicode?67:153));
      const decision = await deliveryAllowed(config, "sms", message.to, units, kind);
      if (!decision.ok) return { ok: false, error: decision.reason };
      reservations = decision.reservations;
    }
    const result = await (async (): Promise<SendResult> => {
    switch (config.SMS_PROVIDER) {
      case "twilio":
        return await sendViaTwilio(config, message);
      case "webhook":
        return await sendViaWebhook(config, message);
      case "log":
      default:
        return await sendViaLog(message);
    }
    })();
    if (result.ok) await trackDelivery(config.SMS_PROVIDER, result.id, "sms", message.to, config, message);
    else await refundDelivery(reservations); // a failed send must not consume the budget
    return result;
  } catch (err) {
    log.error("sms send failed", { provider: config.SMS_PROVIDER, error: err });
    return { ok: false, error: "provider_unavailable" };
  }
}

async function sendViaLog(message: SmsMessage): Promise<SendResult> {
  const id = `log_${Date.now().toString(36)}`;
  const body = `--- sms (provider: log) ---\nto: ${message.to}\n\n${message.body}\n`;
  process.stdout.write(body + "\n");
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`), body + "\n");
  } catch {
    /* the file copy is a convenience, not a requirement */
  }
  return { ok: true, id };
}

async function sendViaTwilio(config: Config, message: SmsMessage): Promise<SendResult> {
  const sid = config.TWILIO_ACCOUNT_SID!;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({
    To: message.to,
    From: config.SMS_FROM ?? "",
    Body: message.body,
    StatusCallback: `${config.APP_URL}/api/webhooks/twilio`,
  });
  const auth = Buffer.from(`${sid}:${config.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) return { ok: false, error: `provider_http_${res.status}` };
  const json = (await res.json()) as { sid?: string };
  return { ok: true, id: json.sid };
}

async function sendViaWebhook(config: Config, message: SmsMessage): Promise<SendResult> {
  const res = await fetch(config.SMS_WEBHOOK_URL!, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.SMS_WEBHOOK_TOKEN}` },
    body: JSON.stringify({ to: message.to, body: message.body, from: config.SMS_FROM ?? null }),
  });
  if (!res.ok) return { ok: false, error: `provider_http_${res.status}` };
  const data = await res.json() as { id?: string };
  return typeof data.id === "string" && data.id.length <= 200 ? { ok: true, id: data.id } : { ok: false, error: "invalid_provider_response" };
}

/** Hide all but the last two digits of a phone number, for logs. */
export const maskPhone = (phone: string) => {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
};
