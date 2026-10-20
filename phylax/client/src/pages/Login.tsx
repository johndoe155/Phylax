import { useCallback, useEffect, useRef, useState, type AnimationEvent as ReactAnimationEvent, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { Link, useLocation } from "wouter";
import { MotionConfig, motion, useDragControls, type HTMLMotionProps, type PanInfo } from "framer-motion";
import "../login.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { MarkerWrite } from "@/components/MarkerWrite";
import { BarField } from "@/components/login/BarField";
import { Field, EyeToggle } from "@/components/login/Field";
import {
  AnimatedCheck, EASE_IN, EASE_OUT, IconApple, IconChevronLeft, IconClose, IconFingerprint, IconGoogle, IconLock, IconMail,
} from "@/components/login/icons";
import { CreateAccountDialog } from "@/components/onboarding/CreateAccountDialog";
import { AuthError, sendMagicLink, signInWithPasskey, signInWithPassword, signInWithProvider, type AuthOutcome, type PendingSignup, type Provider } from "@/lib/auth";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";

// TODO: keep in step with Home.tsx (contact / waitlist destination) until these live in one shared module. The legal links now do (lib/legal.ts).
const CONTACT_EMAIL = "hello@phylax.app";
const WAITLIST_URL = `mailto:${CONTACT_EMAIL}?subject=Phylax%20waitlist`;
const DASHBOARD_URL = "/dashboard";
const WELCOME_URL = "/welcome"; // the account sequence (pages/Onboarding.tsx), for a sign-in that found no account

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Why the browser came back to this page with a reason in the address.
 *
 * Two flows leave the app and return here rather than to a page of their own: a provider sign-in (the server redirects to
 * `/login?error=oauth` when the state, the code exchange or the provider itself fails, and `/login?error=linking` when an
 * existing account would have to be linked to a provider without a fresh proof), and the emailed sign-in link
 * (`/login?error=link` when a link arrives without its token). Without this the person is simply back at the sign-in sheet
 * with no idea what happened. The wording stays inside the sheet's existing form-error line, so nothing moves.
 */
const QUERY_ERRORS: Record<string, string> = {
  oauth: "That sign-in was cancelled or didn't finish. Try again, or use an email link or a passkey.",
  linking: "That account already exists and needs a fresh sign-in before a provider can be linked to it. Sign in another way first.",
  link: "That sign-in link was incomplete. Request a new one and open it from the same browser.",
};
const LEAVE_DELAY_MS = 900; // how long the success state shows before the sheet drops away
const LEAVE_MS = 580; //       a touch longer than the .55s sheet exit in login.css, so it is fully gone before we navigate
const RESEND_SECONDS = 30;

type View = "options" | "email" | "sent" | "passkey";
type Mode = "password" | "link";
type Method = "passkey" | "apple" | "google" | "password" | "link";
type Phase = "idle" | "busy" | "done" | "error";
type Errors = { email?: string; password?: string; form?: string };

/** How "deep" each view sits: deeper views rise up from below, and anything shallower exits upward. */
const DEPTH: Record<View, number> = { options: 0, email: 1, passkey: 1, sent: 2 };

/** A short tick on devices that can vibrate (Android browsers). iOS Safari has no API for it; the on-screen motion covers that. */
function buzz(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* not available */ }
}

/** Where to go after signing in: `?next=/some/path` if it is a same-site path, otherwise the dashboard. */
function nextPath(): string {
  try {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login")) return next;
  } catch { /* fall through */ }
  return DASHBOARD_URL;
}

function validate(email: string, password: string, mode: Mode): Errors {
  const found: Errors = {};
  const trimmed = email.trim();
  if (!trimmed) found.email = "Enter your email address.";
  else if (!EMAIL_RE.test(trimmed)) found.email = "Enter a valid email, like name@work.com.";
  if (mode === "password" && !password) found.password = "Enter your password.";
  return found;
}

/** Message line under a field. Always rendered (fixed height) so an error never moves anything. */
function Hint({ id, children }: { id?: string; children?: string }) {
  return <p className="lg-hint" id={id} aria-live="polite">{children ? <span key={children}>{children}</span> : null}</p>;
}

/** Trailing slot of a method button: spinner while it works, a drawn check once it has worked. */
function Trail({ busy, done }: { busy: boolean; done: boolean }) {
  return (
    <span className="lg-btn-trail" aria-hidden="true">
      <span className="lg-spin" data-on={busy || undefined} />
      <AnimatedCheck show={done} className="lg-btn-check" />
    </span>
  );
}

function MethodButton({ variant, icon, label, onClick, busy = false, done = false, locked = false, buttonRef }: {
  variant: "solid" | "ghost";
  icon: ReactNode;
  label: string;
  onClick: () => void;
  busy?: boolean;
  done?: boolean;
  locked?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={buttonRef} type="button" className="lg-btn" data-variant={variant} data-state={done ? "done" : busy ? "busy" : undefined} aria-disabled={locked || undefined} onClick={onClick}>
      <span className="lg-btn-icon" aria-hidden="true">{icon}</span>
      <span className="lg-btn-label">{label}</span>
      <Trail busy={busy} done={done} />
    </button>
  );
}

/**
 * One screen of the sheet. All panes live in the same grid cell, so the sheet is exactly as tall as its tallest pane and
 * never resizes between them (nothing animates height, so it is all transform and opacity). The pane that is not current
 * is transparent, inert and out of the accessibility tree.
 */
function Pane({ id, current, children, motionProps }: { id: View; current: View; children: ReactNode; motionProps?: HTMLMotionProps<"div"> }) {
  const active = id === current;
  const waitingBelow = DEPTH[id] > DEPTH[current];
  return (
    <motion.div
      className="lg-pane"
      data-pane={id}
      initial={false}
      animate={{ opacity: active ? 1 : 0, y: active ? 0 : waitingBelow ? 40 : -20, scale: active ? 1 : 0.985 }}
      transition={active ? { duration: 0.55, ease: EASE_OUT, delay: 0.1 } : { duration: 0.22, ease: EASE_IN }}
      inert={!active}
      aria-hidden={!active}
      {...motionProps}
    >
      {children}
    </motion.div>
  );
}

export default function Login() {
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>("options");
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [method, setMethod] = useState<Method | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [prompt, setPrompt] = useState<PendingSignup | null>(null); // passkey / email found no account: "Create an account?" is open
  const [signup, setSignup] = useState(false); //                       leaving for the account sequence rather than the dashboard
  // The "Hi!!" note is written only after the heading has fully risen into place: the last line's rise (lg-rise in login.css) ends
  // last, and that animationend starts the writing. The timer is only a backstop for a browser that never fires it (animations off).
  const [headingSettled, setHeadingSettled] = useState(false);
  const onHeadingRiseEnd = useCallback((event: ReactAnimationEvent<HTMLSpanElement>) => {
    if (event.target === event.currentTarget && event.animationName === "lg-rise") setHeadingSettled(true);
  }, []);
  useEffect(() => {
    const backstop = window.setTimeout(() => setHeadingSettled(true), 3000);
    return () => window.clearTimeout(backstop);
  }, []);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const emailTriggerRef = useRef<HTMLButtonElement>(null);
  const passkeyHeadingRef = useRef<HTMLHeadingElement>(null);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<number[]>([]);
  const viewRef = useRef<View>("options");
  const pushedRef = useRef(false); // true while the history entry pushed for a sub-view is still on the stack (lets Back close it)
  const previousView = useRef<View>("options");
  const emailReadyRef = useRef(false); // is the typed email already valid? (read by the focus effect without re-running it)
  const dragControls = useDragControls();

  viewRef.current = view;
  const busy = phase === "busy";
  const done = phase === "done";
  const locked = busy || done;
  const emailOk = EMAIL_RE.test(email.trim());
  emailReadyRef.current = emailOk;

  // ---- Page chrome: allow the sheet to reach the screen edges on notched phones, and set the tab title. ----------
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousContent = meta?.content ?? "";
    if (meta && !previousContent.includes("viewport-fit")) meta.content = `${previousContent}, viewport-fit=cover`;
    const previousTitle = document.title;
    document.title = "Sign in — Phylax";
    return () => {
      if (meta) meta.content = previousContent;
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    abortRef.current?.abort();
  }, []);

  // ---- The reason a provider or a link sent us back here (see QUERY_ERRORS). ----------------------------------------
  useEffect(() => {
    let reason: string | null = null;
    try {
      reason = new URLSearchParams(window.location.search).get("error");
    } catch {
      reason = null;
    }
    const message = reason ? QUERY_ERRORS[reason] : undefined;
    if (!message) return;
    setErrors({ form: message });
    setPhase("error");
  }, []);

  // ---- Resend countdown for the magic link. -----------------------------------------------------------------------
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // ---- View navigation. Sub-views push one history entry, so the phone's Back gesture returns to the options. -----
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setMethod(null);
  }, []);

  const enter = useCallback((next: View) => {
    if (!pushedRef.current) {
      history.pushState({ phylaxLogin: true }, "");
      pushedRef.current = true;
    }
    setView(next);
  }, []);

  const toOptions = useCallback(() => {
    reset();
    setErrors({});
    setPrompt(null);
    setView("options");
    if (pushedRef.current) {
      pushedRef.current = false;
      history.back();
    }
  }, [reset]);

  useEffect(() => {
    const onPopState = () => {
      if (!pushedRef.current) return;
      pushedRef.current = false;
      reset();
      setPrompt(null);
      setView("options");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [reset]);

  useEffect(() => {
    if (view === "options" || done || prompt) return; // with the dialog open, Escape belongs to the dialog
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") toOptions(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, done, prompt, toOptions]);

  // Move focus with the view (after the pane has mostly arrived), never on first load.
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const timer = window.setTimeout(() => {
      if (view === "email") (emailReadyRef.current ? passwordRef.current : emailRef.current)?.focus({ preventScroll: true });
      else if (view === "passkey") passkeyHeadingRef.current?.focus({ preventScroll: true });
      else if (view === "sent") sentHeadingRef.current?.focus({ preventScroll: true });
      else emailTriggerRef.current?.focus({ preventScroll: true });
    }, 380);
    return () => window.clearTimeout(timer);
  }, [view]);

  // ---- Running a sign-in. -------------------------------------------------------------------------------------------
  const shake = useCallback(() => {
    setShaking(false);
    window.requestAnimationFrame(() => setShaking(true));
    buzz([14, 40, 14]);
  }, []);

  const finish = useCallback((destination: string) => {
    setPhase("done");
    buzz([10, 30, 18]);
    timersRef.current.push(
      window.setTimeout(() => setLeaving(true), LEAVE_DELAY_MS),
      window.setTimeout(() => navigate(destination), LEAVE_DELAY_MS + LEAVE_MS),
    );
  }, [navigate]);

  const fail = useCallback((error: unknown) => {
    const known = error instanceof AuthError ? error : new AuthError("Couldn't reach Phylax. Check your connection.");
    if (viewRef.current === "passkey") toOptions(); // nothing to retry in the prompt itself: go back to the choices
    setErrors(known.field ? { [known.field]: known.message } : { form: known.message });
    setPhase("error");
    setMethod(null);
    shake();
  }, [shake, toOptions]);

  const run = useCallback(async (next: Method, task: (signal: AbortSignal) => Promise<AuthOutcome>, onSuccess: (outcome: AuthOutcome) => void) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setMethod(next);
    setPhase("busy");
    setErrors({});
    try {
      const outcome = await task(controller.signal);
      if (!controller.signal.aborted) onSuccess(outcome);
    } catch (error) {
      if (!controller.signal.aborted) fail(error);
    }
  }, [fail]);

  /** Hands over to the account sequence: the sheet drops away, like a finished sign-in, and /welcome opens. */
  const startAccount = () => {
    setPrompt(null);
    setSignup(true);
    finish(WELCOME_URL);
  };

  /**
   * What a sign-in attempt came back with. A known account opens the dashboard; a sent link shows "Check your inbox"; an
   * unknown one starts the account sequence: straight away for Apple and Google, and only after "Create an account?"
   * for passkey and email.
   */
  const settle = (outcome: AuthOutcome, social: boolean) => {
    if (outcome.status === "signed-in") return finish(nextPath());
    if (outcome.status === "link-sent") {
      setPhase("idle");
      setMethod(null);
      setCooldown(RESEND_SECONDS);
      setView("sent");
      return;
    }
    if (social) return startAccount();
    setPhase("idle");
    setMethod(null);
    setPrompt(outcome.pending);
  };

  const confirmAccount = () => {
    if (!prompt) return;
    setMethod(prompt.method); // so the button that was pressed shows its check as the sheet leaves
    startAccount();
  };

  const declineAccount = useCallback(() => {
    const method = prompt?.method;
    setPrompt(null);
    if (method === "passkey") toOptions(); // nothing to retry in the passkey sheet: back to the choices (email stays as typed)
  }, [prompt, toOptions]);

  const startProvider = (provider: Provider) => {
    if (locked) return;
    buzz(10);
    run(provider, (signal) => signInWithProvider(provider, signal), (outcome) => settle(outcome, true));
  };

  const startPasskey = () => {
    if (locked) return;
    buzz(10);
    enter("passkey");
    run("passkey", (signal) => signInWithPasskey(signal), (outcome) => settle(outcome, false));
  };

  const openEmail = () => {
    if (locked) return;
    buzz(8);
    setErrors({});
    setPhase("idle");
    enter("email");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    const found = validate(email, password, mode);
    if (found.email || found.password) {
      setErrors(found);
      setPhase("error");
      shake();
      (found.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    const address = email.trim();
    if (mode === "password") run("password", (signal) => signInWithPassword({ email: address, password }, signal), (outcome) => settle(outcome, false));
    else run("link", (signal) => sendMagicLink(address, signal), (outcome) => settle(outcome, false));
  };

  const resend = () => {
    if (locked || cooldown > 0) return;
    run("link", (signal) => sendMagicLink(email.trim(), signal), () => {
      setPhase("idle");
      setMethod(null);
      setCooldown(RESEND_SECONDS);
    });
  };

  const changeMode = (next: Mode) => {
    if (next === mode || locked) return;
    buzz(6);
    setMode(next);
    setErrors({});
    setPhase("idle");
    if (next === "password") setShowPassword(false);
  };

  const editEmail = (value: string) => {
    setEmail(value);
    if (errors.email || errors.form) { setErrors({ ...errors, email: undefined, form: undefined }); if (phase === "error") setPhase("idle"); }
  };
  const editPassword = (value: string) => {
    setPassword(value);
    if (errors.password || errors.form) { setErrors({ ...errors, password: undefined, form: undefined }); if (phase === "error") setPhase("idle"); }
  };

  const togglePassword = () => {
    const input = passwordRef.current;
    const start = input?.selectionStart ?? null;
    const end = input?.selectionEnd ?? null;
    buzz(8);
    setShowPassword((shown) => !shown);
    // Switching the input's type resets the caret on some browsers; put it back.
    window.requestAnimationFrame(() => { if (input && start !== null && end !== null && document.activeElement === input) input.setSelectionRange(start, end); });
  };

  const forgotPassword = () => {
    if (locked) return;
    changeMode("link");
    window.requestAnimationFrame(() => emailRef.current?.focus({ preventScroll: true }));
  };

  // ---- Derived UI state. --------------------------------------------------------------------------------------------
  const ready = emailOk && (mode === "link" || password.length > 0);
  const progress = done ? 1
    : busy ? 0.86
    : view === "sent" ? 0.7
    : view === "passkey" ? 0.5
    : view === "email" ? 0.12 + (emailOk ? 0.38 : 0) + (mode === "password" ? (password ? 0.3 : 0) : (emailOk ? 0.3 : 0))
    : 0.1;
  const status = done ? (signup ? "Starting your account" : "Signed in")
    : busy ? (method === "link" ? "Sending link" : "Checking")
    : prompt ? "No account found"
    : phase === "error" ? "Couldn't sign in"
    : view === "sent" ? "Link sent"
    : view === "email" ? (ready ? "Ready to sign in" : "Waiting for details")
    : "Waiting for sign-in";

  const onGrabberDown = (event: ReactPointerEvent) => {
    if (view === "email") dragControls.start(event);
  };
  const onEmailDragEnd = (_: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
    if (info.offset.y > 72 || info.velocity.y > 520) toOptions();
  };

  const cta = (mode === "password" ? "Sign in" : "Email me a link");
  const ctaState = done && method === "password" ? "done" : busy && (method === "password" || method === "link") ? "busy" : undefined;

  return (
    <MotionConfig reducedMotion="user">
      <div className="lg" data-view={view} data-phase={phase} data-leaving={leaving || undefined} style={{ "--lg-p": progress } as CSSProperties}>
        <div className="lg-progress" aria-hidden="true" />
        <div className="lg-canvas" aria-hidden="true">
          <BarField />
          <div className="lg-wash" />
        </div>

        <header className="lg-head" inert={prompt !== null}>
          <div className="lg-top">
            <Link href="/" className="brand-lockup lg-brand" aria-label="Phylax home"><PhylaxMark /><span className="brand-name">Phylax</span></Link>
            <Link href="/" className="lg-close" aria-label="Close sign-in and go to the home page"><IconClose /></Link>
          </div>
          <div className="lg-hero">
            <h1 className="lg-title has-marker-note">
              <span className="lg-line"><span style={{ "--i": 0 } as CSSProperties}>You're</span></span>
              <span className="lg-line lg-line-accent"><span style={{ "--i": 1 } as CSSProperties} onAnimationEnd={onHeadingRiseEnd}>back</span></span>
              {/* Hand-written "Hi!!" in Marker Hand, decorative (see .marker-note-hi). It sits outside the masked .lg-line spans so the
                  rise animation doesn't clip it. It is written slowly, and only once the heading has finished rising (headingSettled). The two "!" are the font's two exclamation marks: calt turns the second into excl_alt. */}
              <MarkerWrite className="marker-note marker-note-hi" speed="slow" active={headingSettled} aria-hidden="true">Hi!!</MarkerWrite>
            </h1>
            <p className="lg-sub">Sign in to see what's flagged across your apps.</p>
            <p className="lg-status" role="status"><span className="signal-dot" />{status}</p>
          </div>
        </header>

        <main className="lg-sheet" aria-label="Sign in" inert={prompt !== null}>
          <div className="lg-grab" onPointerDown={onGrabberDown} aria-hidden="true" />

          <div className={`lg-stack${shaking ? " is-shaking" : ""}`} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setShaking(false); }}>
            {/* 1. Choose a method: the one-tap options sit together at the bottom of the screen, within thumb reach. */}
            <Pane id="options" current={view}>
              <p className="lg-pane-title">Choose how to sign in</p>
              <MethodButton variant="solid" icon={<IconFingerprint />} label="Continue with passkey" onClick={startPasskey} locked={locked} />
              <MethodButton variant="ghost" icon={<IconApple />} label="Continue with Apple" onClick={() => startProvider("apple")} busy={busy && method === "apple"} done={done && method === "apple"} locked={locked} />
              <MethodButton variant="ghost" icon={<IconGoogle />} label="Continue with Google" onClick={() => startProvider("google")} busy={busy && method === "google"} done={done && method === "google"} locked={locked} />
              <div className="lg-or"><span>or</span></div>
              <MethodButton buttonRef={emailTriggerRef} variant="ghost" icon={<IconMail />} label="Continue with email" onClick={openEmail} locked={locked} />
              <Hint>{view === "options" ? errors.form : undefined}</Hint>
            </Pane>

            {/* 2. Email: password or a one-time link. Dragging the grabber down (or Back) returns to the options. */}
            <Pane
              id="email"
              current={view}
              motionProps={{ drag: "y", dragControls, dragListener: false, dragConstraints: { top: 0, bottom: 0 }, dragElastic: { top: 0, bottom: 0.6 }, dragSnapToOrigin: true, onDragEnd: onEmailDragEnd }}
            >
              <form className="lg-form" onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
                <div className="lg-bar">
                  <button type="button" className="lg-back" onClick={toOptions} aria-label="Back to all sign-in options"><IconChevronLeft /></button>
                  <div className="lg-seg" role="tablist" aria-label="Sign-in method">
                    {(["password", "link"] as const).map((item) => (
                      <button key={item} type="button" role="tab" aria-selected={mode === item} className="lg-seg-btn" data-on={mode === item || undefined} onClick={() => changeMode(item)}>
                        {mode === item && <motion.span layoutId="lg-seg-thumb" className="lg-seg-thumb" transition={{ type: "spring", stiffness: 520, damping: 42 }} />}
                        <span className="lg-seg-label">{item === "password" ? "Password" : "Email link"}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <Field
                  label="Email"
                  type="email"
                  name="email"
                  inputMode="email"
                  autoComplete="username webauthn"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint={mode === "password" ? "next" : "go"}
                  value={email}
                  onValueChange={editEmail}
                  invalid={!!errors.email}
                  describedBy="lg-email-hint"
                  inputRef={emailRef}
                  readOnly={locked}
                  onKeyDown={(event) => { if (event.key === "Enter" && mode === "password" && emailOk) { event.preventDefault(); passwordRef.current?.focus(); } }}
                />
                <Hint id="lg-email-hint">{view === "email" ? errors.email : undefined}</Hint>

                <div className="lg-slot">
                  <div className="lg-slot-item" data-on={mode === "password" || undefined} inert={mode !== "password"}>
                    <Field
                      label="Password"
                      type={showPassword ? "text" : "password"}
                      name="password"
                      autoComplete="current-password"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      enterKeyHint="go"
                      value={password}
                      onValueChange={editPassword}
                      invalid={!!errors.password}
                      describedBy="lg-password-hint"
                      inputRef={passwordRef}
                      readOnly={locked}
                      trailing={<EyeToggle shown={showPassword} onToggle={togglePassword} />}
                    />
                  </div>
                  <div className="lg-slot-item lg-slot-note" data-on={mode === "link" || undefined} inert={mode !== "link"}>
                    <p>We'll email you a link that signs you in. No password needed.</p>
                  </div>
                </div>

                <div className="lg-row">
                  <Hint id="lg-password-hint">{view === "email" ? (errors.password ?? errors.form) : undefined}</Hint>
                  <button type="button" className="lg-link" onClick={forgotPassword} tabIndex={mode === "password" ? 0 : -1} data-hidden={mode !== "password" || undefined}>Forgot password?</button>
                </div>

                <button type="submit" className="lg-cta" data-state={ctaState} aria-disabled={locked || undefined}>
                  <span className="lg-cta-label">{cta}</span>
                  <span className="lg-cta-spin" aria-hidden="true" />
                  <AnimatedCheck show={ctaState === "done"} className="lg-cta-check" strokeWidth={2.6} />
                </button>
              </form>
            </Pane>

            {/* 3. Passkey: Phylax's own "confirm" sheet around the device's Face ID / fingerprint prompt. */}
            <Pane id="passkey" current={view}>
              <div className="lg-center">
                <div className="lg-bio" data-state={done ? "done" : "busy"} aria-hidden="true">
                  <span className="lg-bio-ring" /><span className="lg-bio-ring lg-bio-ring-2" />
                  <span className="lg-bio-core"><IconFingerprint width={34} height={34} strokeWidth={1.5} className="lg-bio-print" /><AnimatedCheck show={done} className="lg-bio-check" strokeWidth={2.4} /></span>
                </div>
                <h2 className="lg-pane-h" tabIndex={-1} ref={passkeyHeadingRef}>{done ? (signup ? "Passkey confirmed" : "You're in") : "Confirm it's you"}</h2>
                <p className="lg-pane-p">{done ? (signup ? "Setting up your account." : "Opening your dashboard.") : "Use Face ID, your fingerprint or your screen lock to sign in with your passkey."}</p>
              </div>
              <button type="button" className="lg-btn" data-variant="ghost" onClick={toOptions} aria-disabled={done || undefined}><span /><span className="lg-btn-label">Cancel</span><span /></button>
            </Pane>

            {/* 4. Link sent. */}
            <Pane id="sent" current={view}>
              <div className="lg-center">
                <div className="lg-mail" aria-hidden="true"><IconMail width={30} height={30} strokeWidth={1.5} /></div>
                <h2 className="lg-pane-h" tabIndex={-1} ref={sentHeadingRef}>Check your inbox</h2>
                <p className="lg-pane-p">We sent a sign-in link to <strong>{email.trim()}</strong>. Open it on this device to continue.</p>
              </div>
              <button type="button" className="lg-btn" data-variant="ghost" onClick={resend} data-state={busy && method === "link" ? "busy" : undefined} aria-disabled={cooldown > 0 || locked || undefined}>
                <span /><span className="lg-btn-label">{cooldown > 0 ? <>Resend link in <span className="lg-count">{cooldown}s</span></> : "Resend link"}</span><Trail busy={busy && method === "link"} done={false} />
              </button>
              <button type="button" className="lg-link lg-link-center" onClick={() => { setErrors({}); setView("email"); }}>Use a different email</button>
              <Hint>{view === "sent" ? errors.form : undefined}</Hint>
            </Pane>
          </div>

          <footer className="lg-foot">
            <p className="lg-note"><IconLock aria-hidden="true" />Phylax never asks for your staffing-app logins.</p>
            <nav className="lg-links" aria-label="Help and legal">
              <a href={WAITLIST_URL}>No account? Join the waitlist</a>
              <span className="lg-legal"><a href={TERMS_URL}>Terms</a><a href={PRIVACY_URL}>Privacy</a></span>
            </nav>
          </footer>
        </main>

        {/* Passkey and email only: Apple and Google go straight into the account sequence. */}
        <CreateAccountDialog pending={prompt} onConfirm={confirmAccount} onDecline={declineAccount} />
      </div>
    </MotionConfig>
  );
}
