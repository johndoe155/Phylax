import { useEffect, useRef, useState } from "react";
import { AcButton } from "./controls";

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId?: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => (window.turnstile ? resolve() : reject(new Error("Turnstile did not start")));
      script.onerror = () => { scriptPromise = null; script.remove(); reject(new Error("Turnstile did not load")); };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

/**
 * Cloudflare Turnstile. The page mounts it only when the server publishes a site key; the phone-code button waits for its
 * token. The box keeps its height from the first frame (see .ac-turnstile) so the widget arriving moves nothing.
 * `onToken(null)` means there is no usable token (not solved yet, expired, or the challenge errored).
 */
export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const tokenRef = useRef(onToken);
  tokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    setStatus("loading");
    tokenRef.current(null);
    loadScript()
      .then(() => {
        const el = box.current;
        if (cancelled || !el || !window.turnstile) return;
        widgetId = window.turnstile.render(el, {
          sitekey: siteKey,
          theme: "dark",
          size: "flexible",
          callback: (token: string) => tokenRef.current(token),
          "expired-callback": () => tokenRef.current(null),
          "timeout-callback": () => tokenRef.current(null),
          "error-callback": () => { tokenRef.current(null); setStatus("failed"); return true; },
        });
        setStatus("ready");
      })
      .catch(() => { if (!cancelled) setStatus("failed"); });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) { try { window.turnstile.remove(widgetId); } catch { /* already gone */ } }
    };
  }, [siteKey, attempt]);

  return (
    <div className="ac-turnstile" data-status={status}>
      <div ref={box} className="ac-turnstile-box" />
      {status === "loading" ? <span className="ac-turnstile-note"><span className="signal-dot" />Loading the security check</span> : null}
      {status === "failed" ? (
        <div className="ac-turnstile-fail" role="alert">
          <span>The security check couldn't load.</span>
          <AcButton variant="quiet" size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</AcButton>
        </div>
      ) : null}
    </div>
  );
}
