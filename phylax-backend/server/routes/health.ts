import { timingSafeEqual } from "node:crypto";
import { sendMail } from "../notifications/mail.js";
import { sendSms } from "../notifications/sms.js";
import { execute, migrationStatus } from "../db.js";
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../http.js";
import { query, queryOne, isDbEnabled, withTransaction, lockPoolMetrics } from "../db.js";
import { log } from "../log.js";
import { LEGAL_VERSION } from "@shared/legal";
import type { Scheduler } from "../scheduler.js";

/** Account ids are UUIDs; validated here so a malformed id is a 400, not a Postgres cast failure surfaced as 500. */
const ACCOUNT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Health and operations.
 *
 * `/api/health` is what the load balancer, the systemd unit and the deploy script all use to decide whether the
 * service is up. It must be cheap, and it must never need a session.
 *
 * `/api/ops/*` is the operator's door: it is behind a shared token and it is where a backup can be triggered and
 * the scheduler can be nudged by hand. It is not for the app itself.
 *
 * The public health answer is deliberately two facts: is the service up, and for how long. It used to include
 * the scheduler's internals — leader, last error, tick times — which is operational detail that anybody on the
 * internet had no business reading, and which told an attacker exactly when to look away from a failing job.
 * That detail is at `/api/ops/status`, behind the token.
 */

export function healthRoutes(opts: { scheduler?: Scheduler; startedAt: number }): Router {
  const router = Router();

  router.get(
    "/health",
    asyncHandler(async (req: Request, res: Response) => {
      let database: "ok" | "down" | "absent" = "absent";
      if (isDbEnabled()) {
        try {
          await queryOne("SELECT 1 AS ok");
          database = "ok";
        } catch {
          database = "down";
        }
      }
      // The dead-man's switch. The scheduler writes `completed_at` at the end of every tick; if the newest one
      // is older than the tick budget, something is stuck and the service says so. This is the check an external
      // monitor watches, and it is why the process also carries its own watchdog (see scheduler.ts).
      let schedulerHealthy = true;
      if (isDbEnabled() && req.ctx.config.SCHEDULER_ENABLED) {
        const heartbeat = await queryOne<{completed_at:Date|null}>("SELECT completed_at FROM scheduler_state WHERE id=true").catch(() => null);
        const budget = Math.max(180000, req.ctx.config.SCHEDULER_INTERVAL_MS * 3);
        const lastTick = heartbeat?.completed_at?.getTime() ?? null;
        // A fresh boot gets a grace period: the first tick can legitimately take a while (it is the one that
        // finds and applies a pending migration), and a deploy that fails its own health check rolls back a
        // release that was never given the chance to start.
        schedulerHealthy = Date.now() - opts.startedAt < 90000 || (lastTick !== null && Date.now() - lastTick < budget);
      }
      const healthy = database !== "down" && schedulerHealthy;
      res.status(healthy ? 200 : 503).json({
        ok: healthy,
        uptimeSeconds: Math.round((Date.now() - opts.startedAt) / 1000),
      });
    }),
  );

  // ---- operations: behind a token --------------------------------------------------------------
  const requireOpsToken = (req: Request, res: Response, next: (err?: unknown) => void) => {
    const expected = req.ctx.config.OPS_TOKEN;
    if (!expected) {
      res.status(404).json({ error: { code: "not_found", message: "Not found." } });
      return;
    }
    const given = req.headers["x-ops-token"];
    const token = Array.isArray(given) ? given[0] : given;
    if (!token || Buffer.byteLength(token)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token),Buffer.from(expected))) {
      res.status(401).json({ error: { code: "unauthorized", message: "Not allowed." } });
      return;
    }
    next();
  };

  router.post(
    "/ops/scheduler/run",
    requireOpsToken,
    asyncHandler(async (req: Request, res: Response) => {
      if (!opts.scheduler) {
        res.status(501).json({ error: { code: "not_available", message: "The scheduler is not running." } });
        return;
      }
      const stats = await opts.scheduler.runOnce();
      res.json(stats);
    }),
  );

  router.get(
    "/ops/status",
    requireOpsToken,
    asyncHandler(async (req: Request, res: Response) => {
      const counts = isDbEnabled()
        ? await queryOne<{ accounts: string; shifts: string; reminders: string }>(
            `SELECT (SELECT count(*) FROM accounts) AS accounts,
                    (SELECT count(*) FROM shifts) AS shifts,
                    (SELECT count(*) FROM reminders) AS reminders`,
          )
        : null;
      res.json({
        uptimeSeconds: Math.round((Date.now() - opts.startedAt) / 1000),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        scheduler: opts.scheduler?.health() ?? null,
        delivery: isDbEnabled() ? await queryOne(`SELECT count(*) FILTER(WHERE channel='email' AND provider=$1)::int AS email_delivered,count(*) FILTER(WHERE channel='sms' AND provider=$2)::int AS sms_delivered FROM notification_deliveries WHERE status='delivered' AND updated_at>now()-interval '24 hours'`,[req.ctx.config.MAIL_PROVIDER,req.ctx.config.SMS_PROVIDER]) : null,
        securityNotices:isDbEnabled()?await queryOne("SELECT count(*)::int AS pending,COALESCE(extract(epoch FROM now()-min(created_at)),0)::int AS oldest_seconds FROM security_notices WHERE expires_at>now()") :null,
        providers:{email:req.ctx.config.MAIL_PROVIDER,sms:req.ctx.config.SMS_PROVIDER},
        counts,
        // PostgreSQL saturation is invisible to an HTTP health check: surface current connections and the server
        // limit so monitor.sh can alert before new requests start timing out at max_connections.
        databaseConnections: isDbEnabled() ? await queryOne(`SELECT
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS used,
          current_setting('max_connections')::int AS max` ) : null,
        queue: isDbEnabled() ? await queryOne(`SELECT count(*) FILTER(WHERE status='dead')::int AS dead,
          count(*) FILTER(WHERE status IN ('failed','bounced'))::int AS delivery_failed,
          count(*) FILTER(WHERE status='queued' AND scheduled_for<now() AND expires_at>now())::int AS due,
          COALESCE(extract(epoch FROM now()-min(scheduled_for) FILTER(WHERE status='queued' AND scheduled_for<now() AND expires_at>now())),0)::int AS oldest_due_seconds FROM reminders`) : null,
        heartbeat: isDbEnabled() ? await queryOne("SELECT heartbeat_at,completed_at,error_code,scan_cursor FROM scheduler_state WHERE id=true") : null,
        // Lock-pool contention (B24): how often account writes waited for a connection, how long, and how deep the
        // queue is now. `timeouts` rising is the early signal that DATABASE_LOCK_POOL_MAX is undersized for the load.
        lockPool: isDbEnabled() ? lockPoolMetrics() : null,
        // What the deploy script asks before it takes the service down: is there anything to migrate at all?
        migrations: isDbEnabled() ? await migrationStatus() : null,
        // The legal posture, so a release check can confirm the deployment is the one the documents describe.
        legal: {
          operator: req.ctx.config.SERVICE_OPERATOR ?? null,
          contactEmail: req.ctx.config.SERVICE_CONTACT_EMAIL ?? null,
          jurisdiction: req.ctx.config.SERVICE_JURISDICTION ?? null,
          approvedVersion: req.ctx.config.LEGAL_APPROVED_VERSION ?? null,
          currentVersion: LEGAL_VERSION,
        },
        // Suppressions, so "why did my alerts stop?" is answerable without touching the database.
        suppressions: isDbEnabled() ? await query<{ recipient_hash: string; reason: string; created_at: Date }>(
          "SELECT recipient_hash,reason,created_at FROM delivery_suppressions ORDER BY created_at DESC LIMIT 200") : null,
      });
    }),
  );

  router.post("/ops/probe",requireOpsToken,asyncHandler(async(req,res)=>{
    const email=req.body.email,phone=req.body.phone;
    if(!email && !phone) return res.status(400).json({error:{code:"destination_required",message:"Provide an operator-owned probe destination."}});
    const results:Record<string,unknown>={};
    if(email)results.email=await sendMail(req.ctx.config,{to:email,subject:"Phylax delivery acceptance probe",text:"Operator-requested delivery probe. Confirm receipt and the authenticated delivery callback before release."});
    if(phone)results.sms=await sendSms(req.ctx.config,{to:phone,body:"Phylax operator delivery acceptance probe. Confirm receipt and delivery callback before release."});
    res.json(results);
  }));
  /**
   * The reminders that need an operator, listed.
   *
   * Replay and acknowledge both take an id, and until now the only way to GET one was `SELECT id FROM reminders
   * WHERE status='dead'` against the production database as a superuser — which is exactly the access the rest of
   * this design works to avoid. The monitor alerts on `queue.dead > 0` and `delivery_failed > 0` but reports
   * counts, so an operator knew something was stuck and had no supported way to find out what.
   *
   * Read-only, paginated, and restricted to the statuses that are actionable. No recipient addresses: a reminder
   * row is about a delivery attempt, and the destination lives in `accounts`, behind a different question.
   */
  router.get("/ops/reminders", requireOpsToken, asyncHandler(async (req, res) => {
    if (!isDbEnabled()) return res.status(503).json({ error: { code: "unavailable", message: "Database is not configured." } });
    const allowed = ["dead", "failed", "bounced", "suppressed", "expired", "queued", "accepted"] as const;
    const requested = String(req.query.status ?? "dead,failed").split(",").map(s => s.trim()).filter(Boolean);
    const statuses = requested.filter(s => (allowed as readonly string[]).includes(s));
    if (requested.length && !statuses.length) {
      return res.status(400).json({ error: { code: "invalid_status", message: `status must be one or more of: ${allowed.join(", ")}.` } });
    }
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
    // Keyset pagination on (created_at, id): stable under inserts, and it does not skip rows the way OFFSET does
    // when the set changes between pages.
    const before = typeof req.query.before === "string" && req.query.before.length > 0 ? req.query.before : null;
    const rows = await query<{
      id: string; account_id: string; kind: string; status: string; error: string | null; attempts: number;
      generation: number; replay_generation: number; created_at: Date; scheduled_for: Date; expires_at: Date;
      sent_at: Date | null; channel: string | null; notice_keys: string[] | null;
    }>(
      `SELECT id, account_id, kind, status, error, attempts, generation, replay_generation,
              created_at, scheduled_for, expires_at, sent_at, channel, notice_keys
         FROM reminders
        WHERE status = ANY($1::text[])
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [statuses.length ? statuses : ["dead", "failed"], before, before ? (req.query.beforeId ?? null) : null, limit],
    );
    // `replayable` is what the two mutating endpoints actually require, computed here so an operator does not
    // have to reconstruct the rule (dead/failed, unexpired, unclaimed) to know whether a replay will 409.
    const now = Date.now();
    res.json({
      statuses,
      reminders: rows.map(r => ({
        id: r.id,
        accountId: r.account_id,
        kind: r.kind,
        status: r.status,
        error: r.error,
        attempts: r.attempts,
        generation: r.generation,
        replayGeneration: r.replay_generation,
        createdAt: r.created_at,
        scheduledFor: r.scheduled_for,
        expiresAt: r.expires_at,
        sentAt: r.sent_at,
        channel: r.channel,
        conflicts: r.notice_keys?.length ?? 0,
        replayable: ["dead", "failed"].includes(r.status) && r.expires_at.getTime() > now,
        acknowledgable: ["dead", "failed", "bounced"].includes(r.status),
      })),
      nextBefore: rows.length === limit ? rows.at(-1)!.created_at : null,
      nextBeforeId: rows.length === limit ? rows.at(-1)!.id : null,
    });
  }));

  router.post("/ops/reminders/:id/acknowledge",requireOpsToken,asyncHandler(async(req,res)=>{
    if(!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(400);
    const changed=await execute("UPDATE reminders SET status='suppressed',error='operator_acknowledged' WHERE id=$1 AND status IN ('dead','failed','bounced') AND claimed_at IS NULL",[req.params.id]);
    log.info("operator acknowledged reminder",{reminderId:req.params.id});res.json({acknowledged:!!changed});
  }));
  router.post("/ops/reminders/:id/replay", requireOpsToken, asyncHandler(async (req,res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.status(400).json({error:{code:"invalid_id",message:"Invalid reminder id."}});
    // One transaction, because the two halves have to happen together.
    //
    // When this digest went `dead`, the scheduler released its `conflict_notices` rows so the conflicts could be
    // reported again (a dead digest is an alert that was never delivered, and marking it "told" forever was the
    // bug). If the replay re-queued the reminder WITHOUT restoring those notices, the next scan would see the
    // conflicts as never-reported and create a second digest — which then supersedes the one the operator just
    // replayed. The operator's deliberate retry would be quietly thrown away and the account could be told twice.
    //
    // `notice_keys` is the record of what the digest owned, kept on the row for exactly this.
    const replayed = await withTransaction(async (tx) => {
      const updated = await tx.query<{ id: string; account_id: string; kind: string; notice_keys: string[] | null; expires_at: Date }>(
        "UPDATE reminders SET status='queued',attempts=0,replay_generation=replay_generation+1,last_attempt_at=NULL,error=NULL,sent_at=NULL,claimed_at=NULL WHERE id=$1 AND status IN ('dead','failed') AND expires_at>now() AND claimed_at IS NULL RETURNING id,account_id,kind,notice_keys,expires_at",
        [req.params.id],
      );
      const row = updated.rows[0];
      if (!row) return null;
      const keys: string[] = row.notice_keys ?? [];
      if (keys.length) {
        await tx.query(
          `INSERT INTO conflict_notices(account_id,notice_key,kind,expires_at,reminder_id)
           SELECT $1, k, $2, $3, $4 FROM unnest($5::text[]) AS k
           ON CONFLICT (account_id,notice_key) DO UPDATE SET reminder_id=EXCLUDED.reminder_id, expires_at=EXCLUDED.expires_at`,
          [row.account_id, row.kind, row.expires_at, row.id, keys],
        );
      }
      return { id: row.id, restored: keys.length };
    });
    if (!replayed) { res.status(409).json({replayed:false}); return; }
    log.info("operator replayed reminder",{reminderId:replayed.id,noticesRestored:replayed.restored});
    res.status(200).json({replayed:true,noticesRestored:replayed.restored});
  }));
  router.delete("/ops/suppressions/:hash", requireOpsToken, asyncHandler(async(req,res)=>{
    if(!/^[a-f0-9]{64}$/.test(req.params.hash)) return res.sendStatus(400);
    await execute("DELETE FROM delivery_suppressions WHERE recipient_hash=$1",[req.params.hash]);res.sendStatus(204);
  }));

  // ---- suspension: an operator kill-switch for one account ------------------------------------
  //
  // Suspending sets a flag that every sign-in path (createSession) and every authenticated request (requireAuth)
  // checks, and ends the account's live sessions so the effect is immediate rather than waiting for the next
  // expiry. It is reversible and it deletes nothing: reinstating clears the flag and the person can sign in again.
  // Erasure is a different operation (DELETE /api/account) and belongs to the account holder, not the operator.
  router.post("/ops/accounts/:id/suspend", requireOpsToken, asyncHandler(async (req: Request, res: Response) => {
    if (!ACCOUNT_UUID_RE.test(req.params.id)) return res.status(400).json({ error: { code: "invalid_id", message: "That account identifier is not valid." } });
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
    const suspended = await withTransaction(async client => {
      const result = await client.query(
        "UPDATE accounts SET suspended_at = now(), suspension_reason = $2, updated_at = now() WHERE id = $1 RETURNING id",
        [req.params.id, reason],
      );
      if (!result.rowCount) return false;
      // Keep the session rows during suspension so protected routes can answer the specified 403
      // `account_suspended` rather than an indistinguishable 401. On reinstatement, all of these sessions are
      // revoked, so the person must sign in again and cannot resume a possibly-stolen cookie.
      return true;
    });
    if (!suspended) return res.status(404).json({ error: { code: "not_found", message: "That account does not exist." } });
    log.info("operator suspended account", { accountId: req.params.id, reason });
    res.json({ suspended: true, id: req.params.id, reason });
  }));

  router.post("/ops/accounts/:id/reinstate", requireOpsToken, asyncHandler(async (req: Request, res: Response) => {
    if (!ACCOUNT_UUID_RE.test(req.params.id)) return res.status(400).json({ error: { code: "invalid_id", message: "That account identifier is not valid." } });
    const updated = await withTransaction(async client => {
      const result = await client.query(
        "UPDATE accounts SET suspended_at = NULL, suspension_reason = NULL, updated_at = now() WHERE id = $1 AND suspended_at IS NOT NULL RETURNING id",
        [req.params.id],
      );
      if (!result.rowCount) return false;
      // A reinstated account must sign in again: the sessions kept solely so the middleware could return an
      // explicit 403 during suspension are now invalidated atomically with the reinstatement.
      await client.query("DELETE FROM sessions WHERE account_id=$1", [req.params.id]);
      return true;
    });
    if (!updated) {
      // Distinguish "no such account" from "not suspended" so the operator is not left guessing.
      const exists = await queryOne<{ id: string }>("SELECT id FROM accounts WHERE id = $1", [req.params.id]);
      if (!exists) return res.status(404).json({ error: { code: "not_found", message: "That account does not exist." } });
      return res.json({ suspended: false, id: req.params.id, alreadyActive: true });
    }
    log.info("operator reinstated account", { accountId: req.params.id });
    res.json({ suspended: false, id: req.params.id });
  }));
  // A last-resort way to see what the process is doing when something has gone quiet.
  router.post(
    "/ops/log",
    requireOpsToken,
    asyncHandler(async (req: Request, res: Response) => {
      log.info("operator note", { note: (req.body ?? {}).note });
      res.json({ ok: true });
    }),
  );

  return router;
}
