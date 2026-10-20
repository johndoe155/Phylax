import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { MotionConfig, motion } from "framer-motion";
import "../login.css";
import "../onboarding.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { BarField } from "@/components/login/BarField";
import { Field } from "@/components/login/Field";
import { AnimatedCheck, EASE_IN, EASE_OUT, IconChevronLeft, IconClose, IconLock } from "@/components/login/icons";
import { IconArrowUpRight } from "@/components/onboarding/icons";
import { AuthError, createAccount, discardPendingSignup, getPendingSignup } from "@/lib/auth";
import { DISPLAY_NAME_MAX, displayNameLength, normalizeDisplayName, validateDisplayName } from "@/lib/displayName";
import { PRIVACY_URL, PRIVACY_VERSION, TERMS_URL, TERMS_VERSION } from "@/lib/legal";

/**
 * Account creation: the three steps a first-time person walks through after sign-in found no account for them.
 *
 *   1. Terms & privacy  - read both documents, tick the agreement, Continue
 *   2. Your name        - a display name, with live validation; "Complete setup" creates the account
 *   3. Account created  - a short confirmation, then the dashboard (after 2 seconds, or at once with the button)
 *
 * It is the login page's own layout (ink canvas and hero on top, cream sheet in the thumb zone; a brand column and a form
 * panel on desktop), reached from Login.tsx. The person's sign-in is waiting in `getPendingSignup()` (lib/auth.ts); with
 * none, there is nothing to create an account for and the page sends them back to sign-in.
 */

const LOGIN_URL = "/login";
const DASHBOARD_URL = "/dashboard";
const REDIRECT_MS = 2000; //  how long the confirmation shows before the dashboard opens
const LEAVE_MS = 580; //      the sheet's drop-away, a touch longer than the .55s exit in login.css (same as Login.tsx)
const SETTLE_MS = 650; //     how long the button's drawn check shows before step 3 takes over

type Step = "terms" | "profile" | "created";
type Phase = "idle" | "busy" | "done" | "error";

/** How "deep" each step sits: later steps rise up from below, and earlier ones exit upward (and the reverse on Back). */
const DEPTH: Record<Step, number> = { terms: 0, profile: 1, created: 2 };

/** A short tick on devices that can vibrate (Android browsers). iOS Safari has no API for it; the on-screen motion covers that. */
function buzz(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* not available */ }
}

/** Message line under a field. Always rendered (fixed height) so an error never moves anything. */
function Hint({ id, children }: { id?: string; children?: string }) {
  return <p className="lg-hint" id={id} aria-live="polite">{children ? <span key={children}>{children}</span> : null}</p>;
}

/**
 * One screen of the sheet. Same mechanism as the login page's panes: all steps share one grid cell, so the sheet is exactly
 * as tall as its tallest step and never resizes between them. The step that is not current is transparent, inert and out of
 * the accessibility tree.
 */
function StepPane({ id, current, className, children }: { id: Step; current: Step; className?: string; children: ReactNode }) {
  const active = id === current;
  const waitingBelow = DEPTH[id] > DEPTH[current];
  return (
    <motion.div
      className={className ? `lg-pane ${className}` : "lg-pane"}
      data-pane={id}
      data-active={active || undefined}
      initial={false}
      animate={{ opacity: active ? 1 : 0, y: active ? 0 : waitingBelow ? 40 : -20, scale: active ? 1 : 0.985 }}
      transition={active ? { duration: 0.55, ease: EASE_OUT, delay: 0.1 } : { duration: 0.22, ease: EASE_IN }}
      inert={!active}
      aria-hidden={!active}
    >
      {children}
    </motion.div>
  );
}

/** "Step 1 of 2" and its two bars (the hero's shift bars, small): ink when finished, steel blue for the step you are on. */
function Steps({ n }: { n: 1 | 2 }) {
  return (
    <div className="ob-steps">
      <p className="ob-steps-text">Step <strong>{n}</strong> of 2</p>
      <div className="ob-segs" aria-hidden="true">
        <span className="ob-seg" data-state={n === 1 ? "current" : "done"} />
        <span className="ob-seg" data-state={n === 2 ? "current" : "todo"} />
      </div>
    </div>
  );
}

function LegalDoc({ href, name, description }: { href: string; name: string; description: string }) {
  return (
    <li>
      <a className="ob-doc" href={href} target="_blank" rel="noopener noreferrer">
        <span className="ob-doc-text"><span className="ob-doc-name">{name}</span><span className="ob-doc-desc">{description}</span></span>
        <IconArrowUpRight />
        <span className="ob-sr">(opens in a new tab)</span>
      </a>
    </li>
  );
}

export default function Onboarding() {
  const [, navigate] = useLocation();
  const [pending] = useState(() => getPendingSignup());
  const [step, setStep] = useState<Step>("terms");
  const [agreed, setAgreed] = useState(false);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false); // has the person interacted with the name yet? (an untouched, empty field is not an error)
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [serverField, setServerField] = useState(false); // does that message belong to the name field, or to the form?
  const [phase, setPhase] = useState<Phase>("idle");
  const [createdName, setCreatedName] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [shaking, setShaking] = useState(false);

  const agreeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const createdHeadingRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<number[]>([]); //   one-off timers (the check settling)
  const redirectRef = useRef<number[]>([]); // the confirmation's timers: the sheet dropping away, then the dashboard
  const pushedRef = useRef(false); //          true while the history entry pushed for step 2 is still on the stack (lets Back return to step 1)
  const previousStep = useRef<Step>("terms");
  const stepRef = useRef<Step>("terms");
  const lockedRef = useRef(false);

  const busy = phase === "busy";
  const done = phase === "done";
  const locked = busy || done;
  const created = step === "created";
  stepRef.current = step;
  lockedRef.current = locked;

  // ---- Validation, live: the problem is known on every keystroke, and shown once the person has touched the field. ---
  const problem = validateDisplayName(name);
  const clientError = touched ? problem : undefined;
  const hint = clientError ?? serverMessage ?? undefined;
  const invalid = !!clientError || (!!serverMessage && serverField);
  const count = displayNameLength(name);
  const nameOk = !problem;

  // ---- Page chrome: allow the sheet to reach the screen edges on notched phones, and set the tab title. ----------
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousContent = meta?.content ?? "";
    if (meta && !previousContent.includes("viewport-fit")) meta.content = `${previousContent}, viewport-fit=cover`;
    const previousTitle = document.title;
    document.title = "Create account — Phylax";
    return () => {
      if (meta) meta.content = previousContent;
      document.title = previousTitle;
    };
  }, []);

  // Nothing waiting for an account (opened directly, refreshed after a password sign-in, or the sign-up timed out): back to sign-in.
  useEffect(() => {
    if (!pending) navigate(LOGIN_URL, { replace: true });
  }, [pending, navigate]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    redirectRef.current.forEach((timer) => window.clearTimeout(timer));
    abortRef.current?.abort();
  }, []);

  // ---- Step navigation. Step 2 pushes one history entry, so the phone's Back gesture returns to step 1. ------------
  const toTerms = useCallback(() => {
    if (lockedRef.current) return;
    setStep("terms");
    if (pushedRef.current) {
      pushedRef.current = false;
      history.back();
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (!pushedRef.current) return;
      pushedRef.current = false;
      if (lockedRef.current || stepRef.current === "created") return;
      setStep("terms");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (step !== "profile" || locked) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") toTerms(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, locked, toTerms]);

  // Move focus with the step (after the pane has mostly arrived), never on first load.
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const timer = window.setTimeout(() => {
      if (step === "profile") nameRef.current?.focus({ preventScroll: true });
      else if (step === "created") createdHeadingRef.current?.focus({ preventScroll: true });
      else agreeRef.current?.focus({ preventScroll: true });
    }, 380);
    return () => window.clearTimeout(timer);
  }, [step]);

  // ---- Step 3: the sheet drops away and the dashboard opens, REDIRECT_MS after the confirmation appears. -----------
  const navigateRef = useRef(navigate); // read through a ref, so a new `navigate` identity can never restart the countdown
  navigateRef.current = navigate;

  const openDashboard = useCallback((delay: number) => {
    redirectRef.current.forEach((timer) => window.clearTimeout(timer));
    redirectRef.current = [
      window.setTimeout(() => setLeaving(true), Math.max(0, delay - LEAVE_MS)),
      window.setTimeout(() => navigateRef.current(DASHBOARD_URL, { replace: true }), delay),
    ];
  }, []);

  useEffect(() => {
    if (step === "created") openDashboard(REDIRECT_MS);
  }, [step, openDashboard]);

  const goNow = () => {
    if (leaving) return;
    buzz(8);
    openDashboard(LEAVE_MS);
  };

  // ---- Step 1 -> 2. ---------------------------------------------------------------------------------------------------
  const toProfile = () => {
    if (!agreed) return;
    buzz(8);
    setAcceptedAt(new Date().toISOString()); // the moment of agreement, for the consent record
    if (!pushedRef.current) {
      history.pushState({ phylaxOnboarding: true }, "");
      pushedRef.current = true;
    }
    setStep("profile");
  };

  // ---- Step 2: validate, then create the account. ----------------------------------------------------------------
  const shake = useCallback(() => {
    setShaking(false);
    window.requestAnimationFrame(() => setShaking(true));
    buzz([14, 40, 14]);
  }, []);

  const create = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("busy");
    setServerMessage(null);
    try {
      const account = await createAccount(
        {
          displayName: normalizeDisplayName(name),
          consent: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, acceptedAt: acceptedAt ?? new Date().toISOString() },
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setCreatedName(account.displayName);
      setPhase("done");
      buzz([10, 30, 18]);
      timersRef.current.push(window.setTimeout(() => setStep("created"), SETTLE_MS));
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof AuthError ? error : null;
      setServerMessage(known?.message ?? "Couldn't create your account. Check your connection and try again.");
      setServerField(known?.field === "displayName");
      setPhase("error");
      shake();
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (locked) return;
    setTouched(true);
    if (problem) {
      setServerMessage(null);
      setPhase("error");
      shake();
      nameRef.current?.focus();
      return;
    }
    void create();
  };

  const editName = (value: string) => {
    setName(value);
    setTouched(true);
    if (serverMessage) setServerMessage(null);
    if (phase === "error") setPhase("idle");
  };

  // ---- Derived UI state. --------------------------------------------------------------------------------------------
  const progress = created || done ? 1
    : busy ? 0.86
    : step === "profile" ? 0.5 + (nameOk ? 0.3 : 0)
    : agreed ? 0.3
    : 0.1;
  const status = created || done ? "Account created"
    : busy ? "Creating account"
    : phase === "error" ? (serverMessage ? "Couldn't create account" : "Check your name")
    : step === "profile" ? (nameOk ? "Ready to finish" : "Waiting for a name")
    : agreed ? "Agreement accepted"
    : "Waiting for agreement";
  const ctaState = done ? "done" : busy ? "busy" : undefined;

  if (!pending) return null;

  return (
    <MotionConfig reducedMotion="user">
      <div className="lg" data-view={step} data-phase={phase} data-leaving={leaving || undefined} style={{ "--lg-p": progress } as CSSProperties}>
        <div className="lg-progress" aria-hidden="true" />
        <div className="lg-canvas" aria-hidden="true">
          <BarField />
          <div className="lg-wash" />
        </div>

        <header className="lg-head">
          <div className="lg-top">
            <Link href="/" className="brand-lockup lg-brand" aria-label="Phylax home" onClick={discardPendingSignup}><PhylaxMark /><span className="brand-name">Phylax</span></Link>
            <Link href={LOGIN_URL} className="lg-close" aria-label="Cancel and go back to sign-in" onClick={discardPendingSignup}><IconClose /></Link>
          </div>
          <div className="lg-hero">
            {/* Remounted when the confirmation arrives, so its lines rise again: the page's one new entrance moment. */}
            <h1 className="lg-title has-marker-note" key={created ? "in" : "begin"}>
              {created ? (
                <>
                  <span className="lg-line"><span style={{ "--i": 0 } as CSSProperties}>You're</span></span>
                  <span className="lg-line lg-line-accent"><span style={{ "--i": 1 } as CSSProperties}>in</span></span>
                  {/* Decorative handwriting, the same Marker Hand note as the login page's "Hi!!" (see .marker-note-hi in login.css). */}
                  <span className="marker-note marker-note-hi" aria-hidden="true">Huzzah!!</span>
                </>
              ) : (
                <>
                  <span className="lg-line"><span style={{ "--i": 0 } as CSSProperties}>Let's</span></span>
                  <span className="lg-line lg-line-accent"><span style={{ "--i": 1 } as CSSProperties}>Begin</span></span>
                </>
              )}
            </h1>
            <p className="lg-sub">{created ? "Your account is ready." : "Two quick steps, then your dashboard."}</p>
            <p className="lg-status" role="status"><span className="signal-dot" />{status}</p>
          </div>
        </header>

        <main className="lg-sheet" aria-label="Create your account">
          <div className="lg-grab" aria-hidden="true" />

          <div className={`lg-stack${shaking ? " is-shaking" : ""}`} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setShaking(false); }}>
            {/* 1. Terms & privacy. Continue stays disabled until the agreement is ticked. */}
            <StepPane id="terms" current={step}>
              <div className="lg-bar ob-bar"><Steps n={1} /></div>
              <h2 className="lg-pane-h ob-h">Terms &amp; privacy</h2>
              <p className="ob-lead">Read both documents, then agree to continue.</p>
              <ul className="ob-docs">
                <LegalDoc href={TERMS_URL} name="Terms of Service" description="The rules for using Phylax" />
                <LegalDoc href={PRIVACY_URL} name="Privacy Policy" description="How Phylax handles your information" />
              </ul>
              <label className="ob-agree" data-on={agreed || undefined}>
                <input ref={agreeRef} className="ob-agree-input" type="checkbox" checked={agreed} onChange={(event) => { buzz(6); setAgreed(event.target.checked); }} />
                <span className="ob-box" aria-hidden="true"><AnimatedCheck show={agreed} className="ob-box-check" strokeWidth={2.8} /></span>
                <span className="ob-agree-text">I agree to the Terms of Service and the Privacy Policy.</span>
              </label>
              <button type="button" className="lg-cta ob-cta" disabled={!agreed} onClick={toProfile}>
                <span className="lg-cta-label">Continue</span>
              </button>
            </StepPane>

            {/* 2. The name. Back (or the phone's Back gesture, or Escape) returns to step 1. */}
            <StepPane id="profile" current={step} className="ob-profile">
              <form className="lg-form" onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
                <div className="lg-bar ob-bar">
                  <button type="button" className="lg-back" onClick={toTerms} aria-label="Back to terms and privacy" aria-disabled={locked || undefined}><IconChevronLeft /></button>
                  <Steps n={2} />
                </div>
                <h2 className="lg-pane-h ob-h">Your name</h2>
                <p className="ob-lead">What would you like to be called? This is the name Phylax shows you.</p>
                <Field
                  label="Display name"
                  name="displayName"
                  autoComplete="nickname"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  value={name}
                  onValueChange={editName}
                  invalid={invalid}
                  describedBy="ob-name-hint"
                  inputRef={nameRef}
                  readOnly={locked}
                  onBlur={() => setTouched(true)}
                />
                <div className="ob-meta">
                  <Hint id="ob-name-hint">{hint}</Hint>
                  <span className="ob-count" data-over={count > DISPLAY_NAME_MAX || undefined} aria-hidden="true">{count}/{DISPLAY_NAME_MAX}</span>
                </div>
                <button type="submit" className="lg-cta" data-state={ctaState} aria-disabled={locked || undefined}>
                  <span className="lg-cta-label">Complete setup</span>
                  <span className="lg-cta-spin" aria-hidden="true" />
                  <AnimatedCheck show={ctaState === "done"} className="lg-cta-check" strokeWidth={2.6} />
                </button>
              </form>
            </StepPane>

            {/* 3. Created. The dashboard opens by itself; the button does it now. */}
            <StepPane id="created" current={step} className="ob-created">
              <div className="lg-center">
                <div className="lg-bio" data-state="done" aria-hidden="true">
                  <span className="lg-bio-ring" /><span className="lg-bio-ring lg-bio-ring-2" />
                  <span className="lg-bio-core"><AnimatedCheck show={created} className="lg-bio-check" strokeWidth={2.4} /></span>
                </div>
                <h2 className="lg-pane-h" tabIndex={-1} ref={createdHeadingRef}>Account created</h2>
                <p className="lg-pane-p">Welcome, <strong>{createdName}</strong>. Opening your dashboard.</p>
              </div>
              <button type="button" className="lg-cta ob-go" onClick={goNow}>
                <span className="lg-cta-label">Go to dashboard</span>
                <span className="ob-go-timer" aria-hidden="true" />
              </button>
            </StepPane>
          </div>

          <footer className="lg-foot">
            <p className="lg-note"><IconLock aria-hidden="true" />Phylax never asks for your staffing-app logins.</p>
            <nav className="lg-links" aria-label="Help">
              <Link href={LOGIN_URL} onClick={discardPendingSignup}>Already have an account? Sign in</Link>
            </nav>
          </footer>
        </main>
      </div>
    </MotionConfig>
  );
}
