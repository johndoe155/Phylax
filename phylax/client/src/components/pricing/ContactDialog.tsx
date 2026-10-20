import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import "../../login.css";
import "../../contact-dialog.css";
import { Field } from "@/components/login/Field";
import { IconClose } from "@/components/login/icons";
import {
  EMAIL_MAX, MESSAGE_MAX, NAME_MAX, sendContact, toRequest, validateContact,
  type ContactKind, type ContactValues,
} from "@/lib/contact";
import { Hint, TextAreaField } from "./ContactFields";

const EXIT_MS = 380; // a touch longer than the .34s exit in contact-dialog.css, so the dialog is fully gone before it unmounts
const STOPS = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FIELD_ORDER = ["name", "email", "message"] as const;
type FieldKey = (typeof FIELD_ORDER)[number];

/** Everything that differs between the two dialogs. One verb per action, kept from button to confirmation. */
const COPY: Record<ContactKind, {
  label: string; title: [string, string]; body: string; cta: string; note: string;
  doneTitle: [string, string]; done: (email: string) => ReactNode; autoMs: number;
}> = {
  waitlist: {
    label: "Join the waitlist",
    title: ["Join the", "waitlist"],
    body: "Leave your email and we'll write when your spot is ready.",
    cta: "Join waitlist",
    note: "We'll only use your email to tell you about Phylax.",
    doneTitle: ["You're on", "the list."],
    done: (email) => <>We'll email <strong>{email}</strong> when your spot is ready.</>,
    autoMs: 3000,
  },
  question: {
    label: "Ask a question",
    title: ["Ask a", "question"],
    body: "Ask about plans, pricing or how Phylax checks your shifts. We reply by email.",
    cta: "Send question",
    note: "Please don't include patient information.",
    doneTitle: ["Question", "sent."],
    done: (email) => <>We'll reply to <strong>{email}</strong>.</>,
    autoMs: 4000, // a little longer: there is more to read
  },
};

/** A short tick on devices that can vibrate (Android browsers). iOS Safari has no API for it; the on-screen motion covers that. */
function buzz(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* not available */ }
}

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Page scroll lock for as long as a dialog is mounted. The gutter stays reserved (see html.cd-scroll-lock), so the page never jumps sideways. */
let scrollLocks = 0;
function useScrollLock() {
  useEffect(() => {
    if (scrollLocks++ === 0) document.documentElement.classList.add("cd-scroll-lock");
    return () => { if (--scrollLocks === 0) document.documentElement.classList.remove("cd-scroll-lock"); };
  }, []);
}

/** Keeps the dialog inside the visible part of the screen: when a phone's keyboard opens, the sheet sits on top of it instead of behind. */
function useVisualViewportFrame(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = ref.current;
    if (!viewport || !node) return;
    const sync = () => {
      node.style.setProperty("--cd-h", `${viewport.height}px`);
      node.style.setProperty("--cd-top", `${viewport.offsetTop}px`);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => { viewport.removeEventListener("resize", sync); viewport.removeEventListener("scroll", sync); };
  }, [ref]);
}

/**
 * The dialog itself. It is mounted only while it is on screen (see ContactDialog), so every open starts from the draft.
 *
 * Validation: a field shows its error once it has been left (or after a send attempt), and from then on the message
 * follows the field as it is typed in, so it clears the moment the value is right.
 */
function Surface({ kind, open, onClose, returnFocusRef, draft }: {
  kind: ContactKind;
  open: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  draft: RefObject<ContactValues>;
}) {
  const copy = COPY[kind];
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const doneTitleRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const [values, setValues] = useState<ContactValues>(() => ({ ...draft.current }));
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [failed, setFailed] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [shaking, setShaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const busy = phase === "busy";
  const done = phase === "done";

  useScrollLock();
  useVisualViewportFrame(rootRef);

  // Focus lands on the first field; when the dialog closes it goes back to the button that opened it.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (open) return;
    abortRef.current?.abort(); // closing mid-send cancels it; the draft is kept
    const back = returnFocusRef.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, [open, returnFocusRef]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // After a send, the screen reader is told what happened and keyboard focus has somewhere to be.
  useEffect(() => {
    if (!done) return;
    const frame = window.requestAnimationFrame(() => doneTitleRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [done]);

  // Escape closes (not while an IME composition is using it).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const errors = validateContact(kind, values);
  const shown = (key: FieldKey) => (touched[key] || submitted ? errors[key] : undefined);
  const touch = (key: FieldKey) => () => { if (open) setTouched((current) => (current[key] ? current : { ...current, [key]: true })); };
  const edit = (key: keyof ContactValues) => (value: string) => {
    draft.current[key] = value;
    setValues((current) => ({ ...current, [key]: value }));
    setFailed(false);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busyRef.current || done) return; // a second press, or Enter, while sending does nothing
    setSubmitted(true);
    setFailed(false);
    const found = validateContact(kind, values);
    const firstBad = FIELD_ORDER.find((key) => found[key]);
    if (firstBad) {
      (firstBad === "name" ? nameRef : firstBad === "email" ? emailRef : messageRef).current?.focus({ preventScroll: false });
      if (!prefersReducedMotion()) setShaking(true);
      buzz([14, 40, 14]);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    setPhase("busy");
    try {
      const request = toRequest(kind, values);
      await sendContact(request, controller.signal);
      if (kind === "question") draft.current.message = ""; // the name and email stay, so the other dialog opens filled in
      setSentTo(request.email);
      setPhase("done");
      buzz(18);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase("idle");
      setFailed(true);
      buzz([14, 40, 14]);
    } finally {
      busyRef.current = false;
    }
  };

  // Tab stays inside the dialog.
  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (done && event.key !== "Escape") setPaused(true); // someone is using the keyboard: stop the countdown
    if (event.key !== "Tab" || !cardRef.current) return;
    const stops = Array.from(cardRef.current.querySelectorAll<HTMLElement>(STOPS)).filter((node) => !node.closest("[inert]"));
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const nameError = shown("name");
  const emailError = shown("email");
  const messageError = shown("message");
  const nameHint = `${uid}-name`;
  const emailHint = `${uid}-email`;
  const messageHint = `${uid}-message`;
  const countId = `${uid}-count`;
  const doneId = `${uid}-done`;
  const length = values.message.length;

  return (
    <div className="cd" ref={rootRef} data-state={open ? "open" : "closing"}>
      <div className="cd-scrim" aria-hidden="true" onPointerDown={onClose} />
      <div
        ref={cardRef}
        className="cd-card"
        role="dialog"
        aria-modal="true"
        aria-label={copy.label}
        inert={!open}
        data-paused={paused || undefined}
        onKeyDown={trap}
        onPointerDown={() => { if (done) setPaused(true); }}
      >
        {/* The countdown: the page's blue progress line, draining. The dialog closes when it runs out; any key or touch inside pauses it. */}
        {done && <span className="cd-timer" style={{ "--cd-auto": `${copy.autoMs}ms` } as CSSProperties} aria-hidden="true" onAnimationEnd={onClose} />}
        <button type="button" className="cd-close" aria-label="Close" onClick={onClose} onMouseDown={(event) => event.preventDefault()}><IconClose /></button>

        <div className="cd-scroll">
          <div className={`cd-panes${shaking ? " is-shaking" : ""}`} onAnimationEnd={(event) => { if (event.target === event.currentTarget) setShaking(false); }}>
            <form className="cd-pane" data-on={!done || undefined} inert={done} aria-hidden={done || undefined} noValidate onSubmit={submit}>
              <header className="cd-head">
                <h2 className="cd-title">{copy.title.map((line, index) => <span className="lg-line" key={line}><span style={{ "--i": index } as CSSProperties}>{line}</span></span>)}</h2>
                <p className="cd-body cd-rise" style={{ "--r": 0 } as CSSProperties}>{copy.body}</p>
              </header>

              <div className="cd-fields cd-rise" style={{ "--r": 1 } as CSSProperties}>
                <Field
                  label={kind === "waitlist" ? "Full name (optional)" : "Name"}
                  name="name" type="text" autoComplete="name" autoCapitalize="words" maxLength={NAME_MAX}
                  required={kind === "question"}
                  value={values.name} onValueChange={edit("name")} onBlur={touch("name")}
                  invalid={!!nameError} describedBy={nameError ? nameHint : undefined} inputRef={nameRef}
                />
                <Hint id={nameHint}>{nameError}</Hint>

                <Field
                  label="Email address"
                  name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={EMAIL_MAX}
                  required
                  value={values.email} onValueChange={edit("email")} onBlur={touch("email")}
                  invalid={!!emailError} describedBy={emailError ? emailHint : undefined} inputRef={emailRef}
                />
                <Hint id={emailHint}>{emailError}</Hint>

                {kind === "question" && (
                  <>
                    <TextAreaField
                      label="Your question"
                      name="message" maxLength={MESSAGE_MAX} required
                      value={values.message} onValueChange={edit("message")} onBlur={touch("message")}
                      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }}
                      invalid={!!messageError} describedBy={`${messageError ? `${messageHint} ` : ""}${countId}`} inputRef={messageRef}
                    />
                    <div className="cd-meta">
                      <Hint id={messageHint}>{messageError}</Hint>
                      <span className="cd-count" id={countId} data-near={length >= MESSAGE_MAX * 0.9 || undefined} data-limit={length >= MESSAGE_MAX || undefined}>
                        <span aria-hidden="true">{length} / {MESSAGE_MAX}</span>
                        <span className="cd-sr">{length} of {MESSAGE_MAX} characters</span>
                        <span className="cd-sr" aria-live="polite">{length >= MESSAGE_MAX ? "Character limit reached." : ""}</span>
                      </span>
                    </div>
                  </>
                )}
              </div>

              <button type="submit" className="lg-cta cd-cta cd-rise" style={{ "--r": 2 } as CSSProperties} data-state={busy ? "busy" : undefined} aria-disabled={busy || undefined}>
                <span className="lg-cta-label">{copy.cta}</span>
                <span className="lg-cta-spin" aria-hidden="true" />
              </button>
              <span className="cd-sr" role="status">{busy ? "Sending…" : ""}</span>
              {/* One row for the note and for the send error, so the dialog never changes height. */}
              <p className="cd-note cd-rise" style={{ "--r": 3 } as CSSProperties} aria-live="polite" data-error={failed || undefined}>
                {failed ? <span key="error">Couldn't send that. Check your connection and try again.</span> : copy.note}
              </p>
            </form>

            {done && (
              <section className="cd-pane cd-pane-done" data-on>
                <div className="cd-done">
                  <span className="cd-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M5.5 12.6l4.1 4.1 8.9-9.4" pathLength="1" /></svg>
                  </span>
                  <h2 className="cd-title cd-title-done" ref={doneTitleRef} tabIndex={-1} aria-describedby={doneId}>{copy.doneTitle.map((line, index) => <span className="lg-line" key={line}><span style={{ "--i": index } as CSSProperties}>{line}</span></span>)}</h2>
                  <p className="cd-body" id={doneId}>{copy.done(sentTo)}</p>
                  <button type="button" className="cd-btn" onClick={onClose}>Close</button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The two pricing dialogs: "Join the waitlist" and "Ask a question". Controlled by `kind`: a value opens that dialog,
 * null closes it. Mount it once; it renders into <body>.
 *
 * The page puts `inert` on everything else while a dialog is open. Focus goes to the first field and returns to
 * `returnFocusRef` (the button that opened it). The scrim, Escape and the close button all dismiss.
 * What was typed is kept in memory while the page is open: an accidental click outside does not lose a question, and
 * the name and email carry over from one dialog to the other.
 */
export function ContactDialog({ kind, onClose, returnFocusRef }: {
  kind: ContactKind | null;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const draft = useRef<ContactValues>({ name: "", email: "", message: "" });
  const [last, setLast] = useState<ContactKind | null>(kind); // stays set through the exit animation
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (kind) { setLast(kind); return; }
    const timer = window.setTimeout(() => setLast(null), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [kind]);

  const current = kind ?? last;
  if (!current) return null;
  return createPortal(<Surface key={current} kind={current} open={kind !== null} onClose={close} returnFocusRef={returnFocusRef} draft={draft} />, document.body);
}
