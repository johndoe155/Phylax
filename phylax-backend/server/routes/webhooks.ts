import { createHmac, timingSafeEqual } from "node:crypto";
import { identifierHash, hashIdentifierAll, identifierKeys } from "../auth/tokens.js";
import { Router, json, urlencoded, type Request } from "express";
import type { Config } from "../config.js";
import { execute, query, withTransaction } from "../db.js";
import { asyncHandler, HttpError, rateLimiter } from "../http.js";

const equal = (a: string, b: string) => !!a && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function validSvix(secret: string, id: string, timestamp: string, signatures: string, raw: Buffer, now = Date.now()) {
  if (!id || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest("base64");
  return signatures.split(" ").some(s => equal(s, `v1,${signature}`));
}
export function validTwilio(token: string, url: string, params: Record<string, unknown>, signature: string) {
  if (!token || Object.values(params).some(v => typeof v !== "string")) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  return equal(createHmac("sha1", token).update(data).digest("base64"), signature);
}

/**
 * Apply provider callbacks to the deliveries they belong to.
 *
 * Persist only normalized metadata, not webhook bodies or recipient addresses.
 *
 * `only` narrows the sweep to one provider id. The webhook route uses it: a callback about one message should
 * touch that message, not run the whole backlog inside the request that is waiting on it. The scheduler runs the
 * full sweep on its own clock, which is what catches callbacks that arrived out of order or after a restart.
 */
export async function reconcileDeliveryEvents(only?: { provider: string; providerId: string }) {
  const events = await query<{ event_id: string; provider: string; provider_id: string; status: string }>(
    `SELECT e.* FROM delivery_events e JOIN notification_deliveries d ON d.provider=e.provider AND d.provider_id=e.provider_id
     WHERE e.applied_at IS NULL ${only ? "AND e.provider=$1 AND e.provider_id=$2" : ""} ORDER BY e.created_at LIMIT 500`,
    only ? [only.provider, only.providerId] : []);
  for (const event of events) await withTransaction(async client => {
    const delivery = await client.query<{ id: string; reminder_id: string | null; recipient_hash: string; status: string }>(
      "SELECT * FROM notification_deliveries WHERE provider=$1 AND provider_id=$2 FOR UPDATE", [event.provider, event.provider_id]);
    const d = delivery.rows[0]; if (!d) return;
    const rank: Record<string, number> = { accepted: 0, delayed: 1, delivered: 2, failed: 3, bounced: 4, complained: 5 };
    if ((rank[event.status] ?? -1) >= (rank[d.status] ?? 0)) {
      await client.query("UPDATE notification_deliveries SET status=$2,updated_at=now() WHERE id=$1", [d.id, event.status]);
      if (d.reminder_id) await client.query("UPDATE reminders SET status=$2 WHERE id=$1 AND sent_at IS NOT NULL", [d.reminder_id, event.status === "complained" ? "bounced" : event.status === "delayed" ? "accepted" : event.status]);
      if (["bounced", "complained"].includes(event.status)) await client.query("INSERT INTO delivery_suppressions(recipient_hash,reason) VALUES($1,$2) ON CONFLICT DO NOTHING", [d.recipient_hash, event.status]);
    }
    await client.query("UPDATE delivery_events SET applied_at=now() WHERE event_id=$1", [event.event_id]);
  });
}

/**
 * Refresh every reminder's status from its deliveries.
 *
 * This is a full sweep, so it belongs to the scheduler's housekeeping, not to a webhook request: it used to run
 * on every callback, which meant one provider event scanned every delivery row that ever had a reminder.
 */
export async function sweepReminderStatuses() {
  await execute(`UPDATE reminders r SET status=CASE WHEN d.status='complained' THEN 'bounced' WHEN d.status='delayed' THEN 'accepted' ELSE d.status END
   FROM (SELECT DISTINCT ON(reminder_id) reminder_id,status FROM notification_deliveries WHERE reminder_id IS NOT NULL ORDER BY reminder_id,created_at DESC,id DESC) d
   WHERE d.reminder_id=r.id AND r.sent_at IS NOT NULL AND r.status IN ('accepted','delivered','failed','bounced')`);
}
export function webhookRoutes(config: Config) {
  const router = Router();
  router.use(rateLimiter({ windowMs: 60000, max: 300 }));
  router.use(json({ limit: "64kb", verify(req, _res, buf) { (req as Request & { rawBody: Buffer }).rawBody = Buffer.from(buf); } }));
  router.use(urlencoded({ extended: false, limit: "16kb" }));
  router.post("/:provider", asyncHandler(async (req, res) => {
    const provider = req.params.provider;
    let eventId = "", providerId = "", status = "";
    if (provider === "resend") {
      const id = req.get("svix-id") ?? "";
      if (!config.RESEND_WEBHOOK_SECRET || !validSvix(config.RESEND_WEBHOOK_SECRET, id, req.get("svix-timestamp") ?? "", req.get("svix-signature") ?? "", (req as Request & { rawBody: Buffer }).rawBody ?? Buffer.alloc(0))) throw new HttpError(401,"invalid_signature","Invalid callback signature.");
      const statuses: Record<string,string> = { "email.delivered":"delivered", "email.bounced":"bounced", "email.complained":"complained", "email.delivery_delayed":"delayed", "email.failed":"failed" };
      eventId = `resend:${id}`; providerId = req.body.data?.email_id; status = statuses[req.body.type];
    } else if (provider === "twilio") {
      if (!validTwilio(config.TWILIO_AUTH_TOKEN ?? "", `${config.APP_URL}/api/webhooks/twilio`, req.body, req.get("x-twilio-signature") ?? "")) throw new HttpError(401,"invalid_signature","Invalid callback signature.");
      if (req.body.AccountSid !== config.TWILIO_ACCOUNT_SID) throw new HttpError(401,"invalid_account","Invalid callback account.");
      providerId = req.body.MessageSid;
      const statuses: Record<string,string> = { delivered:"delivered", failed:"failed", undelivered:"failed" };
      status = statuses[req.body.MessageStatus]; eventId = `twilio:${providerId}:${status}`;
    } else if (["postmark","smtp","webhook"].includes(provider)) {
      const token = provider === "postmark" ? config.POSTMARK_WEBHOOK_TOKEN : provider === "smtp" ? config.SMTP_WEBHOOK_TOKEN : config.SMS_WEBHOOK_TOKEN;
      const expected = provider === "postmark" ? `Basic ${Buffer.from(`phylax:${token}`).toString("base64")}` : `Bearer ${token}`;
      if (!token || !equal(req.get("authorization") ?? "", expected)) throw new HttpError(401,"invalid_signature","Invalid callback authorization.");
      if (provider === "postmark") {
        providerId = req.body.MessageID;
        status = req.body.RecordType === "Delivery" ? "delivered" : req.body.RecordType === "SpamComplaint" ? "complained" : req.body.RecordType === "Bounce" ? (req.body.Inactive ? "bounced" : "delayed") : "";
        eventId = `postmark:${req.body.ID ?? providerId}:${status}`;
      } else {
        providerId = req.body.id; status = req.body.status;
        eventId = `${provider}:${req.body.eventId ?? providerId}:${status}`;
      }
    } else throw new HttpError(404,"not_found","Unknown callback.");
    // ---- an inbound text: STOP and START ------------------------------------------------------------------
    //
    // "Reply STOP to opt out" is not a courtesy, it is the rule (TCPA and the carrier rules that come with it),
    // and a deployment that cannot honour it cannot legally send texts at all. Twilio forwards inbound messages
    // to this same endpoint, so the reply is handled here: a suppression is written (or cleared) and the sender
    // gets a confirmation. The suppression is what stops the next alert, and it is never cleared by age.
    if (provider === "twilio" && typeof req.body.Body === "string" && typeof req.body.From === "string" && req.body.From) {
      const command = req.body.Body.trim().toUpperCase();
      const optOut = /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(command);
      const optIn = /^(START|UNSTOP|YES|SUBSCRIBE)$/.test(command);
      if (optOut || optIn) {
        const canonical = `sms:${req.body.From.trim().toLowerCase()}`;
        if (optOut) {
          // A new STOP is written under the current key only: it is the value every future lookup tries first.
          const recipient = identifierHash(config, canonical);
          await execute("INSERT INTO delivery_suppressions(recipient_hash,reason) VALUES($1,'stop') ON CONFLICT DO NOTHING", [recipient]);
        } else {
          // Clearing a STOP must match the row under whichever key it was written, or a rotated key would leave a
          // stale suppression in place and the person who texted START would still be blocked from the next alert.
          const hashes = hashIdentifierAll(canonical, identifierKeys(config));
          await execute("DELETE FROM delivery_suppressions WHERE recipient_hash = ANY($1::text[]) AND reason='stop'", [hashes]);
        }
        const reply = optOut
          ? "You are unsubscribed from Phylax text alerts. You will not receive more texts from us. Reply START to resume."
          : "You are subscribed again to Phylax text alerts. Reply STOP at any time to opt out.";
        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
        return;
      }
    }
    if (!status) { res.sendStatus(204); return; }
    if (!["delivered","bounced","complained","failed","delayed"].includes(status) || typeof providerId !== "string" || !providerId || providerId.length > 200 || eventId.length > 300) throw new HttpError(400,"invalid_event","Invalid callback metadata.");
    await execute("INSERT INTO delivery_events(event_id,provider,provider_id,status) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [eventId,provider,providerId,status]);
    // Only this provider id. The full sweep is housekeeping's job.
    await reconcileDeliveryEvents({ provider, providerId });
    res.sendStatus(204);
  }));
  return router;
}
