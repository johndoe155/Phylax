import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../http.js";
import { applyResubscribe, applyUnsubscribe, inspectUnsubscribeToken } from "../notifications/unsubscribe.js";
import { log } from "../log.js";
import type { Config } from "../config.js";

/**
 * The one-click unsubscribe route (RFC 8058).
 *
 * Mounted OUTSIDE the session, CSRF and same-origin middleware, and deliberately so:
 *
 *   - a mailbox provider's "unsubscribe" button is a cross-origin POST from Google's or Yahoo's infrastructure.
 *     Requiring the double-submit CSRF cookie would reject every one of them, which is the failure mode this
 *     route exists to remove;
 *   - the person clicking it may not be signed in, and must not be asked to be. Making opt-out conditional on
 *     authentication is the same class of compliance problem as making account deletion conditional on accepting
 *     new terms.
 *
 * What replaces those defences is the signed token in the path: it is an HMAC under a key that never leaves the
 * server, it names the recipient hash and the channel, and it expires. There is nothing to forge and nothing to
 * enumerate — the token is the authority.
 *
 * `GET` renders a self-contained confirmation page (no external assets, so it works inside a sandboxed mail
 * preview and after the site's own bundle has been redeployed). `POST` performs the unsubscribe and answers both
 * the RFC 8058 empty-body case and a browser that submitted the confirmation form.
 */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A page with no external dependencies: the mail client may be sandboxed and the bundle may have been redeployed. */
function page(title: string, heading: string, body: string, token: string, done: boolean): string {
  const channelLabel = title.includes("text") ? "text messages" : "email alerts";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e6edf7;margin:0;display:grid;place-items:center;min-height:100vh}
main{max-width:34rem;padding:2rem;text-align:center}
h1{font-size:1.4rem;margin:0 0 .75rem}
p{color:#9fb0c7;line-height:1.65;margin:.5rem 0}
form{margin-top:1.25rem}
button{font:inherit;background:#1f6feb;color:#fff;border:0;border-radius:.5rem;padding:.6rem 1.1rem;cursor:pointer}
button:hover{background:#2b7fff}
a{color:#79b8ff}
small{display:block;margin-top:1.5rem;color:#6b7f99}
</style></head>
<body><main>
<h1>${escapeHtml(heading)}</h1>
<p>${body}</p>
${done ? "" : `<form method="post" action="/api/unsubscribe/${encodeURIComponent(token)}"><button type="submit">Unsubscribe from ${channelLabel}</button></form>`}
<p><a href="/">Back to Phylax</a></p>
<small>Sign-in links, password resets and security notices are not affected — those are not ${channelLabel}.</small>
</main></body></html>`;
}

export function unsubscribeRoutes(config: Config): Router {
  const router = Router();

  router.get(
    "/:token",
    asyncHandler(async (req: Request, res: Response) => {
      const token = req.params.token;
      const inspected = inspectUnsubscribeToken(config, token);
      res.setHeader("Cache-Control", "no-store");
      if (!inspected) {
        res.status(400).send(
          page(
            "That unsubscribe link is not valid",
            "That unsubscribe link is not valid",
            "It has expired, or it was not issued by this service. Sign in and turn alerts off from Account &amp; alerts, or reply STOP to any text.",
            token,
            true,
          ),
        );
        return;
      }
      const label = inspected.channel === "sms" ? "text message alerts" : "email alerts";
      res.status(200).send(
        page(
          `Stop Phylax ${label}`,
          `Stop Phylax ${label}?`,
          `Confirming this stops your ${label}. Nothing is deleted and your account is untouched — you can turn them back on at any time from Account &amp; alerts.`,
          token,
          false,
        ),
      );
    }),
  );

  // RFC 8058: the provider POSTs with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and no meaningful body.
  // A browser submitting the confirmation form arrives here too. Both are the same action.
  router.post(
    "/:token",
    asyncHandler(async (req: Request, res: Response) => {
      const token = req.params.token;
      const oneClick = String(req.headers["list-unsubscribe-post"] ?? "").includes("List-Unsubscribe=One-Click");
      const result = await applyUnsubscribe(config, token);
      res.setHeader("Cache-Control", "no-store");

      if (!result.ok) {
        // A provider one-click gets a 4xx with no body: there is nobody reading it, and a 200 would tell the
        // provider the opt-out succeeded when it did not.
        if (oneClick) {
          log.warn("one-click unsubscribe rejected", { code: result.code });
          res.status(result.code === "invalid_token" ? 400 : 503).send("");
          return;
        }
        res.status(result.code === "invalid_token" ? 400 : 503).send(
          page(
            "That unsubscribe link is not valid",
            result.code === "invalid_token" ? "That unsubscribe link is not valid" : "That did not work",
            result.code === "invalid_token"
              ? "It has expired, or it was not issued by this service. Sign in and turn alerts off from Account &amp; alerts, or reply STOP to any text."
              : "Storage is temporarily unavailable. Try again in a minute — nothing has been changed.",
            token,
            true,
          ),
        );
        return;
      }

      const label = result.channel === "sms" ? "text message alerts" : "email alerts";
      if (oneClick) {
        // The provider expects a 2xx and reads nothing else.
        res.status(200).json({ status: "unsubscribed", channel: result.channel });
        return;
      }
      res.status(200).send(
        page(
          `You will not receive further Phylax ${label}`,
          `${label[0].toUpperCase()}${label.slice(1)} are off`,
          result.alreadySuppressed
            ? `That address was already unsubscribed, so nothing changed. You will not receive further ${label}.`
            : `You will not receive further ${label}. <form method="post" action="/api/unsubscribe/${encodeURIComponent(token)}/resubscribe" style="display:inline"><button type="button" onclick="this.form.submit()">Undo — turn them back on</button></form>`,
          token,
          true,
        ),
      );
    }),
  );

  // The "that wasn't me / I changed my mind" action. Same token, same authority, and it only ever clears a `stop`
  // suppression — a hard bounce stays until an operator clears it.
  router.post(
    "/:token/resubscribe",
    asyncHandler(async (req: Request, res: Response) => {
      const token = req.params.token;
      const result = await applyResubscribe(config, token);
      res.setHeader("Cache-Control", "no-store");
      if (!result.ok) {
        res.status(result.code === "invalid_token" ? 400 : 503).send(
          page("That link is not valid", "That link is not valid", "It has expired, or it was not issued by this service.", token, true),
        );
        return;
      }
      const label = result.channel === "sms" ? "text message alerts" : "email alerts";
      res.status(200).send(
        page(
          `Phylax ${label} are on again`,
          `${label[0].toUpperCase()}${label.slice(1)} are on again`,
          result.alreadySuppressed
            ? `There was no unsubscribe to undo for that address. If alerts are still not arriving, sign in and check Account &amp; alerts.`
            : `You will receive ${label} again. You can turn them off at any time from any message, or from Account &amp; alerts.`,
          token,
          true,
        ),
      );
    }),
  );

  return router;
}
