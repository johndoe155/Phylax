import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { MotionConfig, motion } from "framer-motion";
import "../login.css";
import "../onboarding.css";
import "../recovery.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { BarField } from "@/components/login/BarField";
import { EyeToggle, Field } from "@/components/login/Field";
import { AnimatedCheck, EASE_IN, EASE_OUT, IconChevronLeft, IconLock, IconMail } from "@/components/login/icons";
import { IconAlert } from "@/components/recovery/icons";
import { AuthError, TokenError, confirmEmail, redeemSignInLink, requestPasswordReset, resetPassword } from "@/lib/auth";
import { isPlausibleToken, parseToken, tokenFromLocation } from "@/lib/recoveryToken";

/**
 * Account recovery: one component, four routes (see App.tsx).
 *
 *   /forgot-password  email -> "Send reset link"            (never reveals whether the address has an account)
 *   /reset-password   ?token=...  new password -> "Reset password"
 *   /confirm-email    ?token=...  one button -> "Confirm email"
 *   /redeem-link      paste a link or token -> "Continue sign-in", then the dashboard
 *
 * It is the login page's own layout (ink canvas and heading on top, cream sheet in the thumb zone, a brand column and a
 * form panel on desktop), so it uses login.css and onboarding.css and adds only recovery.css. The API calls live in
 * lib/auth.ts; the token parsing in lib/recoveryToken.ts. All async state (busy / error / success) is local to this file.
 */

type View = "forgot-password" | "reset-password" | "confirm-email" | "redeem-link";
type Phase = "idle" | "busy" | "done" | "error";
type Errors = { email?: string; password?: string; token?: string; form?: string };
type Result = { tone: "ok" | "notice" | "problem"; icon: "mail" | "check" | "alert"; message: string; cta?: { label: string; href: string } };

const LOGIN_URL = "/login";
const FORGOT_URL = "/forgot-password";
const DASHBOARD_URL = "/dashboard";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PASSWORD_MIN = 8;
const RESEND_SECONDS = 30;
const SETTLE_MS = 650; //       how long the button's drawn check shows before the result takes over
const LEAVE_DELAY_MS = 900; //  how long a finished sign-in shows before the sheet drops away
const LEAVE_MS = 580; //        a touch longer than the .55s sheet exit in login.css, so it is fully gone before we navigate
const NETWORK_ERROR = "Couldn't reach Phylax. Check your connection and try again.";

const MSG_RESET_SENT = "If that address has a password account, a reset link is on its way.";
const MSG_RESET_DONE = "Password reset. You can sign in now.";
const MSG_CONFIRMED = "Email confirmed. Sign in again to continue.";
const MSG_PROVISIONAL = "Your provisional credentials have expired or been wiped. Please sign in via your email link and set a new password.";

interface Copy {
  heading: string; lines: [string, string]; sub: string; title: string; lead: string; cta: string;
  waiting: string; ready: string; busy: string; ok: string; msgLines: number;
}

const COPY: Record<View, Copy> = {
  "forgot-password": { heading: "Forgot your password?", lines: ["Forgot your", "password?"], sub: "We'll email you a link to set a new one.", title: "Forgot password", lead: "Enter the email on your account and we'll send you a link.", cta: "Send reset link", waiting: "Waiting for email", ready: "Ready to send", busy: "Sending link", ok: "Link sent", msgLines: 3 },
  "reset-password": { heading: "Set a new password", lines: ["Set a new", "password"], sub: "Make it at least 8 characters.", title: "Reset password", lead: "Choose the password you'll use to sign in from now on.", cta: "Reset password", waiting: "Waiting for password", ready: "Ready to reset", busy: "Resetting password", ok: "Password reset", msgLines: 2 },
  "confirm-email": { heading: "Confirm your email", lines: ["Confirm", "your email"], sub: "One tap and your address is verified.", title: "Confirm email", lead: "Confirm that this address is yours to finish setting up your account.", cta: "Confirm email", waiting: "Waiting for confirmation", ready: "Ready to confirm", busy: "Confirming", ok: "Email confirmed", msgLines: 4 },
  "redeem-link": { heading: "Sign in with your link", lines: ["Sign in with", "your link"], sub: "Paste it below and you're in.", title: "Sign in with link", lead: "Paste the sign-in link from your email to continue.", cta: "Continue sign-in", waiting: "Waiting for link", ready: "Ready to sign in", busy: "Checking link", ok: "Signed in", msgLines: 2 },
};

function viewFor(path: string): View {
  const clean = path.toLowerCase().replace(/\/+$/, "").replace(/^\//, "");
  return clean in COPY ? (clean as View) : "forgot-password";
}

/** A short tick on devices that can vibrate (Android browsers). iOS Safari has no API for it; the on-screen motion covers that. */
function buzz(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* not available */ }
}

const readUrlToken = () => (typeof window === "undefined" ? "" : tokenFromLocation(window.location.search, window.location.hash));

export default function Recovery() {
  const [location, navigate] = useLocation();
  const view = viewFor(location);
  const copy = COPY[view];
  const urlToken = useMemo(readUrlToken, [view]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [raw, setRaw] = useState(() => (view === "redeem-link" ? readUrlToken() : "")); // redeem: the pasted link or token
  const [found, setFound] = useState(() => view === "redeem-link" && readUrlToken() !== ""); // ...and whether it came out of a link
  const [differentDevice, setDifferentDevice] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<number[]>([]);
  const previousView = useRef<View>(view);

  const busy = phase === "busy";
  const done = phase === "done";
  const locked = busy || done;
  const emailOk = EMAIL_RE.test(email.trim());
  const parsed = useMemo(() => parseToken(raw), [raw]);
  const tokenOk = isPlausibleToken(parsed.token);

  // A reset or confirmation link without its token can't work: say so, and offer the way out.
  const blocked = useMemo<Result | null>(() => {
    if (urlToken || (view !== "reset-password" && view !== "confirm-email")) return null;
    return view === "reset-password"
      ? { tone: "problem", icon: "alert", message: "This reset link is incomplete. Open it again from your email, or request a new one.", cta: { label: "Request a new link", href: FORGOT_URL } }
      : { tone: "problem", icon: "alert", message: "This confirmation link is incomplete. Open it again from your email.", cta: { label: "Sign in", href: LOGIN_URL } };
  }, [view, urlToken]);
  const shown = blocked ?? result;
  const stage = shown ? "result" : "form";

  // ---- Page chrome: reach the screen edges on notched phones, set the tab title, and keep tokens out of Referer headers. ----
  useEffect(() => {
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousContent = viewport?.content ?? "";
    if (viewport && !previousContent.includes("viewport-fit")) viewport.content = `${previousContent}, viewport-fit=cover`;
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.appendChild(referrer);
    return () => {
      if (viewport) viewport.content = previousContent;
      referrer.remove();
    };
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${copy.title} — Phylax`;
    return () => { document.title = previousTitle; };
  }, [copy.title]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    abortRef.current?.abort();
  }, []);

  // Moving between the four routes keeps this component mounted, so start each one clean.
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    abortRef.current?.abort();
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
    setPhase("idle"); setErrors({}); setResult(null); setLeaving(false); setCooldown(0);
    setPassword(""); setShowPassword(false); setDifferentDevice(false); setEmail("");
    setRaw(view === "redeem-link" ? urlToken : ""); setFound(view === "redeem-link" && urlToken !== "");
  }, [view, urlToken]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // Move focus to the outcome when it arrives (after the pane has mostly landed), so it is announced and the keyboard is in the right place.
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => messageRef.current?.focus({ preventScroll: true }), 380);
    return () => window.clearTimeout(timer);
  }, [shown]);

  // ---- Running a request. -------------------------------------------------------------------------------------------
  const shake = useCallback(() => {
    setShaking(false);
    window.requestAnimationFrame(() => setShaking(true));
    buzz([14, 40, 14]);
  }, []);

  const problem = useCallback((message: string, cta?: Result["cta"]) => {
    setResult({ tone: "problem", icon: "alert", message, cta });
    setPhase("error");
    buzz([14, 40, 14]);
  }, []);

  const run = useCallback(async <T,>(task: (signal: AbortSignal) => Promise<T>, onSuccess: (value: T) => void) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("busy");
    setErrors({});
    try {
      const value = await task(controller.signal);
      if (!controller.signal.aborted) onSuccess(value);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof TokenError && view === "reset-password") return problem(error.message, { label: "Request a new link", href: FORGOT_URL });
      if (error instanceof TokenError && view === "confirm-email") return problem(error.message, { label: "Sign in", href: LOGIN_URL });
      const known = error instanceof AuthError ? error : null;
      setErrors(known ? (known instanceof TokenError ? { token: known.message } : known.field === "email" || known.field === "password" ? { [known.field]: known.message } : { form: known.message }) : { form: NETWORK_ERROR });
      setPhase("error");
      shake();
    }
  }, [problem, shake, view]);

  /** The button shows its drawn check, then the outcome takes over the sheet. */
  const settle = useCallback((next: Result) => {
    setPhase("done");
    buzz([10, 30, 18]);
    timersRef.current.push(window.setTimeout(() => { setResult(next); setPhase("idle"); }, SETTLE_MS));
  }, []);

  /** Redeemed: the check shows, the sheet drops away, and the dashboard opens. */
  const finish = useCallback(() => {
    setPhase("done");
    buzz([10, 30, 18]);
    timersRef.current.push(
      window.setTimeout(() => setLeaving(true), LEAVE_DELAY_MS),
      window.setTimeout(() => navigate(DASHBOARD_URL, { replace: true }), LEAVE_DELAY_MS + LEAVE_MS),
    );
  }, [navigate]);

  const fail = (found: Errors, focus?: HTMLInputElement | null) => {
    setErrors(found);
    setPhase("error");
    shake();
    focus?.focus();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    if (view === "forgot-password") {
      const address = email.trim();
      if (!address) return fail({ email: "Enter your email address." }, emailRef.current);
      if (!emailOk) return fail({ email: "Enter a valid email, like name@work.com." }, emailRef.current);
      void run((signal) => requestPasswordReset(address, signal), () => { setCooldown(RESEND_SECONDS); settle({ tone: "ok", icon: "mail", message: MSG_RESET_SENT }); });
    } else if (view === "reset-password") {
      if (!password) return fail({ password: "Enter a new password." }, passwordRef.current);
      if (password.length < PASSWORD_MIN) return fail({ password: `Use at least ${PASSWORD_MIN} characters.` }, passwordRef.current);
      void run((signal) => resetPassword({ token: urlToken, password }, signal), () => settle({ tone: "ok", icon: "check", message: MSG_RESET_DONE, cta: { label: "Sign in", href: LOGIN_URL } }));
    } else if (view === "confirm-email") {
      void run((signal) => confirmEmail(urlToken, signal), ({ provisionalCleared }) => settle(provisionalCleared
        ? { tone: "notice", icon: "alert", message: MSG_PROVISIONAL, cta: { label: "Sign in", href: LOGIN_URL } }
        : { tone: "ok", icon: "check", message: MSG_CONFIRMED, cta: { label: "Sign in", href: LOGIN_URL } }));
    } else {
      if (!parsed.token) return fail({ token: "Paste your sign-in link or token." }, tokenRef.current);
      if (!tokenOk) return fail({ token: "That doesn't look like a sign-in link or token." }, tokenRef.current);
      void run((signal) => redeemSignInLink({ token: parsed.token, differentDevice }, signal), finish);
    }
  };

  const resend = () => {
    if (locked || cooldown > 0) return;
    void run((signal) => requestPasswordReset(email.trim(), signal), () => { setCooldown(RESEND_SECONDS); setPhase("idle"); });
  };

  const differentEmail = () => {
    if (locked) return;
    setResult(null); setErrors({}); setPhase("idle"); setCooldown(0);
    window.setTimeout(() => emailRef.current?.focus({ preventScroll: true }), 380);
  };

  // ---- Field handlers. ----------------------------------------------------------------------------------------------
  const clearError = () => { if (errors.email || errors.password || errors.token || errors.form) setErrors({}); if (phase === "error") setPhase("idle"); };
  const editEmail = (value: string) => { setEmail(value); clearError(); };
  const editPassword = (value: string) => { setPassword(value); clearError(); };
  const editRaw = (value: string) => { setRaw(value); setFound(false); clearError(); };

  /** Pasting a whole link keeps only its token, and the field answers with a brief ring so the change is seen. */
  const onPasteToken = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = parseToken(event.clipboardData.getData("text"));
    if (!pasted.fromLink || !pasted.token) return;
    event.preventDefault();
    setRaw(pasted.token);
    setFound(true);
    clearError();
    buzz(8);
    setPulse(false);
    window.requestAnimationFrame(() => setPulse(true));
  };

  const togglePassword = () => {
    const input = passwordRef.current;
    const start = input?.selectionStart ?? null;
    const end = input?.selectionEnd ?? null;
    buzz(8);
    setShowPassword((shownNow) => !shownNow);
    window.requestAnimationFrame(() => { if (input && start !== null && end !== null && document.activeElement === input) input.setSelectionRange(start, end); });
  };

  // ---- Derived UI state. ---------------------------------------------------------------------------------------------
  const ready = view === "forgot-password" ? emailOk : view === "reset-password" ? password.length >= PASSWORD_MIN : view === "confirm-email" ? true : tokenOk;
  const progress = shown ? (shown.tone === "problem" ? 0.3 : 1)
    : done ? 1
    : busy ? 0.86
    : view === "forgot-password" ? 0.1 + (emailOk ? 0.45 : 0)
    : view === "reset-password" ? 0.1 + (Math.min(password.length, PASSWORD_MIN) / PASSWORD_MIN) * 0.6
    : view === "confirm-email" ? 0.4
    : 0.1 + (tokenOk ? 0.5 : 0);
  const status = shown ? (shown.tone === "problem" ? "Link not valid" : copy.ok)
    : done ? copy.ok
    : busy ? copy.busy
    : phase === "error" ? (errors.form ? "Couldn't reach Phylax" : "Check the details")
    : view === "confirm-email" ? copy.ready
    : ready ? copy.ready
    : copy.waiting;
  const ctaState = done ? "done" : busy ? "busy" : undefined;
  const dataPhase = shown?.tone === "problem" ? "error" : phase;

  // The result pane is always laid out (with this view's own outcome while nothing has happened yet), so the sheet never changes height.
  const placeholder: Result = view === "forgot-password" ? { tone: "ok", icon: "mail", message: MSG_RESET_SENT }
    : view === "confirm-email" ? { tone: "ok", icon: "check", message: MSG_CONFIRMED, cta: { label: "Sign in", href: LOGIN_URL } }
    : { tone: "ok", icon: "check", message: MSG_RESET_DONE, cta: { label: "Sign in", href: LOGIN_URL } };
  const outcome = shown ?? placeholder;

  const hint = (id: string | undefined, text?: string) => <p className="lg-hint" id={id} aria-live="polite">{text ? <span key={text}>{text}</span> : null}</p>;

  const pane = (id: "form" | "result", children: ReactNode) => {
    const active = stage === id;
    return (
      <motion.div
        className="lg-pane rc-pane"
        data-pane={id}
        data-active={active || undefined}
        initial={false}
        animate={{ opacity: active ? 1 : 0, y: active ? 0 : id === "result" ? 40 : -20, scale: active ? 1 : 0.985 }}
        transition={active ? { duration: 0.55, ease: EASE_OUT, delay: 0.1 } : { duration: 0.22, ease: EASE_IN }}
        inert={!active}
        aria-hidden={!active}
      >
        {children}
      </motion.div>
    );
  };

  const submit = (
    <button type="submit" className="lg-cta" data-state={ctaState} aria-disabled={locked || undefined}>
      <span className="lg-cta-label">{copy.cta}</span>
      <span className="lg-cta-spin" aria-hidden="true" />
      <AnimatedCheck show={ctaState === "done"} className="lg-cta-check" strokeWidth={2.6} />
    </button>
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="lg rc" data-view={view} data-stage={stage} data-phase={dataPhase} data-leaving={leaving || undefined} style={{ "--lg-p": progress, "--rc-lines": copy.msgLines } as CSSProperties}>
        <div className="lg-progress" aria-hidden="true" />
        <div className="lg-canvas" aria-hidden="true">
          <BarField />
          <div className="lg-wash" />
        </div>

        <header className="lg-head">
          <div className="lg-top">
            <Link href="/" className="brand-lockup lg-brand" aria-label="Phylax home"><PhylaxMark /><span className="brand-name">Phylax</span></Link>
          </div>
          <div className="lg-hero">
            {/* Remounted per route, so its two lines rise again. The full heading is in the page for assistive tech and search. */}
            <h1 className="lg-title rc-title" key={view}>
              <span className="ob-sr">{copy.heading}</span>
              <span aria-hidden="true">
                <span className="lg-line"><span style={{ "--i": 0 } as CSSProperties}>{copy.lines[0]}</span></span>
                <span className="lg-line lg-line-accent"><span style={{ "--i": 1 } as CSSProperties}>{copy.lines[1]}</span></span>
              </span>
            </h1>
            <p className="lg-sub">{copy.sub}</p>
            <p className="lg-status" role="status"><span className="signal-dot" />{status}</p>
          </div>
        </header>

        <main className="lg-sheet" aria-label={copy.title}>
          <div className="lg-grab" aria-hidden="true" />

          <div className={`lg-stack${shaking ? " is-shaking" : ""}`} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setShaking(false); }}>
            {/* 1. The form for this route. */}
            {pane("form", (
              <form className="lg-form" onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
                <p className="ob-lead rc-lead">{copy.lead}</p>

                {view === "forgot-password" && (
                  <>
                    <Field label="Email" type="email" name="email" required inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                      value={email} onValueChange={editEmail} invalid={!!errors.email} describedBy="rc-email-hint" inputRef={emailRef} readOnly={locked} />
                    {hint("rc-email-hint", errors.email ?? errors.form)}
                  </>
                )}

                {view === "reset-password" && (
                  <>
                    <Field label="New password" type={showPassword ? "text" : "password"} name="new-password" required minLength={PASSWORD_MIN} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                      value={password} onValueChange={editPassword} invalid={!!errors.password} describedBy="rc-password-hint" inputRef={passwordRef} readOnly={locked}
                      trailing={<EyeToggle shown={showPassword} onToggle={togglePassword} />} />
                    <div className="ob-meta">
                      {hint("rc-password-hint", errors.password ?? errors.form)}
                      <span className="ob-count rc-count" data-met={password.length >= PASSWORD_MIN || undefined} aria-hidden="true">{Math.min(password.length, PASSWORD_MIN)}/{PASSWORD_MIN}</span>
                    </div>
                  </>
                )}

                {view === "confirm-email" && (
                  <div className="rc-token" aria-label="Confirmation link found">
                    <span className="rc-token-label">From your email link</span>
                    <span className="rc-token-value" aria-hidden="true">{urlToken.length >= 8 ? `•••• ${urlToken.slice(-4)}` : "••••"}</span>
                  </div>
                )}

                {view === "redeem-link" && (
                  <>
                    <div className="rc-pulse" data-on={pulse || undefined} onAnimationEnd={() => setPulse(false)}>
                      <Field label="Sign-in link or token" name="token" required autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
                        value={raw} onValueChange={editRaw} onPaste={onPasteToken} invalid={!!errors.token} describedBy="rc-token-hint" inputRef={tokenRef} readOnly={locked} />
                    </div>
                    {errors.token || errors.form
                      ? hint("rc-token-hint", errors.token ?? errors.form)
                      : <p className="rc-help" id="rc-token-hint" data-found={found || undefined} aria-live="polite">{found ? "Token found in your link." : "A full link works. We'll find the token in it."}</p>}
                    <label className="ob-agree rc-agree" data-on={differentDevice || undefined}>
                      <input className="ob-agree-input" type="checkbox" name="differentDevice" checked={differentDevice} disabled={locked} onChange={(event) => { buzz(6); setDifferentDevice(event.target.checked); }} />
                      <span className="ob-box" aria-hidden="true"><AnimatedCheck show={differentDevice} className="ob-box-check" strokeWidth={2.8} /></span>
                      <span className="ob-agree-text">I am using a different device or browser</span>
                    </label>
                  </>
                )}

                {submit}
                {view === "confirm-email" && hint(undefined, errors.form)}
              </form>
            ))}

            {/* 2. The outcome. */}
            {pane("result", (
              <>
                <div className="lg-center rc-result" data-tone={outcome.tone}>
                  <div className="lg-bio" data-state={outcome.tone === "ok" ? "done" : "idle"} aria-hidden="true">
                    <span className="lg-bio-ring" /><span className="lg-bio-ring lg-bio-ring-2" />
                    <span className="lg-bio-core">
                      {outcome.icon === "mail" ? <IconMail className="lg-bio-check" strokeWidth={1.6} />
                        : outcome.icon === "alert" ? <IconAlert className="lg-bio-check" />
                        : <AnimatedCheck show={stage === "result"} className="lg-bio-check" strokeWidth={2.4} />}
                    </span>
                  </div>
                  <p className="rc-msg" tabIndex={-1} ref={messageRef}>{outcome.message}</p>
                </div>
                {outcome.cta && <Link href={outcome.cta.href} className="lg-cta">{outcome.cta.label}</Link>}
                {view === "forgot-password" && !outcome.cta && (
                  <>
                    <div className="lg-row rc-row">
                      <button type="button" className="lg-link" onClick={differentEmail}>Use a different email</button>
                      <button type="button" className="lg-link" onClick={resend} aria-disabled={cooldown > 0 || locked || undefined}>
                        {busy ? "Sending…" : cooldown > 0 ? <>Resend in <span className="lg-count">{cooldown}s</span></> : "Resend link"}
                      </button>
                    </div>
                    {hint(undefined, shown ? errors.form : undefined)}
                  </>
                )}
              </>
            ))}
          </div>

          <footer className="lg-foot">
            <p className="lg-note"><IconLock aria-hidden="true" />Phylax never asks for your staffing-app logins.</p>
            <nav className="rc-foot-nav" aria-label="Sign in">
              <Link href={LOGIN_URL} className="rc-back"><IconChevronLeft width={18} height={18} /><span>Back to sign in</span></Link>
            </nav>
          </footer>
        </main>
      </div>
    </MotionConfig>
  );
}
