import { ArrowUpRight, Play } from "lucide-react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PhylaxMark } from "@/components/PhylaxMark";
import {
  ARMED, HELD, IDLE, LOOP_LEAD, PAUSED, RA, RESUME_HELD, T, TICKS,
  buzz, fmtClock, fmtLeft, frameAt, paint, resumeAlertAt,
  type Frame,
} from "@/lib/phoneAlertTimeline";
import "./PhoneAlert.css";

/**
 * "The alert, by text" (Alerts, card 01): a phone that lives through the night, then asks you a question.
 * See lib/phoneAlertTimeline.ts for the story and the timing.
 *
 * Playback:
 *  - It is idle until the whole illustration is on screen (IntersectionObserver, see `isFullyVisible`), then plays once:
 *    two alert texts, then a third that asks whether to keep getting alerts, with two RCS quick replies. It stops there
 *    and waits. Scrolling away and back does not replay it; leaving before the question lands rewinds it to the idle
 *    frame, and it starts again from the top the next time it is fully in view.
 *  - The quick replies are real buttons. The thread's state lives in `reducePref` (below); the ring and the clock are
 *    painted straight to the DOM by the timeline engine and never touch React state.
 *  - "Keep alerts": the visitor's reply, Phylax's "Saved preference", the closing line, and the ring carries on cycling.
 *  - "STOP": the same reply and confirmation, the ring comes to rest, and a "Resume receiving alerts" button appears.
 *    Pressing it sends RESUME (the button becomes the visitor's bubble), Phylax answers in a message of its own, and then
 *    a NEW alert lands (different shifts from the opening one) and the ring locks on to its fresh window. Only after that
 *    does the dial settle into the same "No conflicts" loop the "Keep alerts" path runs.
 *  - "Phylax warns. You decide." stays hidden until the visitor has answered.
 *  - The messages after the dial and clock live in one scrolling viewport (`.pa-messages`, capped in height). Each new
 *    message pins the view to the bottom, so older ones slide up and out like in a messaging app, cut off by a hard edge
 *    at the top of the viewport. Scrolling up to reread is allowed; the next message brings the view back down.
 *  - The closing line is the one thing that is not in the scroller: it is pinned to the bottom of the card (`.pa-foot`,
 *    a sibling of the masked `.pa-stage`), so scrolling the thread never moves it and the phone's bottom fade-out never
 *    touches it. The screen leaves it exactly the room it needs, which is what keeps the phone short.
 *
 * With reduced motion (and before JS runs) it shows the held frame: the question on screen, nothing playing. The
 * buttons still work and resolve instantly; the ring never animates.
 */

const ARIA_LABEL = "Example text messages from Phylax on a phone";

/** The question, the two quick replies (the second one sends the same keyword the footer promises), and what each answer earns. */
const ASK_TEXT = "Keep getting Phylax alerts? Reply STOP any time to opt out.";
type Choice = "keep" | "stop";
const REPLY_LABEL: Record<Choice, string> = { keep: "Keep alerts", stop: "STOP" };
const SAVED: Record<Choice | "resume", string> = {
  keep: "Saved preference. Alerts stay on. Reply STOP any time to opt out.",
  stop: "Saved preference. Alerts are paused until you resume them.",
  resume: "Saved preference. Alerts are back on. Reply STOP any time to opt out.",
};
const RESUME_LABEL = "Resume receiving alerts";
/** What the visitor's tap actually sends: the keyword, like STOP. */
const RESUME_REPLY = "RESUME";
/** The conflict Phylax finds right after RESUME: different shifts and a fresh window from the opening alert. */
const NEW_ALERT_TEXT = "Conflict detected: your ShiftKey shift at Maple Court overlaps your CareRev shift at Mercy General. CareRev's cancellation window closes in 3 hours. Review both before cancelling.";
const CUE = "Your turn. Tap a reply.";
const VERDICT = "Phylax warns. You decide.";

/** Beat between the visitor's reply and Phylax's confirmation landing. */
const CONFIRM_DELAY = 750;
/** Beat between Phylax confirming RESUME and the new alert landing. */
const ALERT_DELAY = 900;

/** One tick per percent: a target taller than the viewport never reaches ratio 1, so `isFullyVisible` needs to hear about every step. */
const THRESHOLDS = Array.from({ length: 101 }, (_, i) => i / 100);

const TICK_LIST = Array.from({ length: TICKS }, (_, i) => i);

// ---- The thread's state --------------------------------------------------------------------------------------------

/**
 * idle      waiting to be fully on screen
 * intro     the alert texts are arriving (timeline-driven)
 * asking    the question and its quick replies are live
 * answered  the visitor replied; `choice` says how, `confirmed` says whether Phylax's confirmation has landed yet
 * resumed   the visitor pressed "Resume receiving alerts" after stopping; `resumeConfirmed` says whether Phylax has
 *           answered RESUME yet, `alerted` whether the new alert behind it has landed
 */
type Stage = "idle" | "intro" | "asking" | "answered" | "resumed";
type Pref = { stage: Stage; choice: Choice | null; confirmed: boolean; resumeConfirmed: boolean; alerted: boolean };
type Action =
  | { type: "play" }
  | { type: "rewind" }
  | { type: "ask" }
  | { type: "skip" }
  | { type: "choose"; choice: Choice }
  | { type: "confirm" }
  | { type: "resume" }
  | { type: "confirmResume" }
  | { type: "alert" };

const IDLE_PREF: Pref = { stage: "idle", choice: null, confirmed: false, resumeConfirmed: false, alerted: false };
const ASKING_PREF: Pref = { ...IDLE_PREF, stage: "asking" };

function reducePref(s: Pref, a: Action): Pref {
  switch (a.type) {
    case "play": return s.stage === "idle" ? { ...s, stage: "intro" } : s;
    case "rewind": return s.stage === "intro" ? IDLE_PREF : s;
    case "ask": return s.stage === "intro" ? { ...s, stage: "asking" } : s;
    case "skip": return s.stage === "idle" || s.stage === "intro" ? ASKING_PREF : s; // reduced motion
    case "choose": return s.stage === "asking" ? { ...IDLE_PREF, stage: "answered", choice: a.choice } : s;
    case "confirm": return s.stage === "answered" ? { ...s, confirmed: true } : s;
    case "resume": return s.stage === "answered" && s.choice === "stop" && s.confirmed ? { ...s, stage: "resumed" } : s;
    case "confirmResume": return s.stage === "resumed" ? { ...s, resumeConfirmed: true } : s;
    case "alert": return s.stage === "resumed" && s.resumeConfirmed ? { ...s, alerted: true } : s;
  }
}

/** What each part of the thread shows, derived once so the markup stays declarative. */
function threadView(s: Pref) {
  const asked = s.stage !== "idle" && s.stage !== "intro";
  const resumed = s.stage === "resumed";
  const answered = s.stage === "answered" || resumed;
  const confirmed = answered && s.confirmed;
  const resumeConfirmed = resumed && s.resumeConfirmed;
  const alerted = resumed && s.alerted;
  const canResume = s.stage === "answered" && s.choice === "stop" && s.confirmed;
  return {
    asked,
    waiting: s.stage === "asking", // quick replies are live
    answered,
    reply: s.choice,
    confirmed,
    saved: confirmed && s.choice ? SAVED[s.choice] : null,
    canResume,
    // The RESUME branch: the visitor's keyword, Phylax's answer, then the new alert.
    resumed,
    resumeConfirmed,
    alerted,
    // "Keep alerts" runs the loop once Phylax has confirmed; a STOP rests the ring. The resume branch drives the ring itself.
    live: s.stage === "answered" && s.choice === "keep" && s.confirmed,
    stopped: canResume,
    // How many messages are on screen after the intro's alerts: each new one pins the viewport to the bottom.
    messages: [asked, answered, confirmed, resumed, resumeConfirmed, alerted].filter(Boolean).length,
  };
}

// ---- Small pieces ----------------------------------------------------------------------------------------------------

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * "Fully visible", honestly: an element taller than the viewport can never reach ratio 1, and this card is taller than a
 * short laptop window. So the bar is 100% (0.99 absorbs sub-pixel rounding) or, when the card is taller than 90% of the
 * viewport, "the viewport is nearly full of it".
 */
function isFullyVisible(entry: IntersectionObserverEntry) {
  const vh = entry.rootBounds?.height ?? window.innerHeight;
  const needed = Math.min(0.99, (vh * 0.9) / Math.max(1, entry.boundingClientRect.height));
  return entry.isIntersecting && entry.intersectionRatio >= needed;
}

/**
 * Where the messaging viewport is scrolled, and whether it should follow the newest message.
 * `last` is the position the script itself last left it at: a scroll event that lands anywhere else was the visitor's.
 * (Distance from the bottom alone can't tell the two apart: while a row opens the content grows ~10px a frame, so a view
 * that is perfectly pinned still looks "scrolled up" for an instant.)
 */
type Follow = { on: boolean; last: number };

/** Straight to the newest message. Instant on purpose: it runs on every frame a row grows, so the view follows the growth. */
const pinToEnd = (box: HTMLElement, f: Follow) => { box.scrollTop = box.scrollHeight; f.last = box.scrollTop; };

/** A thread row that opens and closes smoothly (grid track 0fr <-> 1fr) so what sits below it glides instead of jumping. */
function Row({ open, className = "", children }: { open: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`pa-row ${className}`} data-open={open ? "1" : "0"} aria-hidden={!open}>
      <div className="pa-clip"><div className="pa-body">{children}</div></div>
    </div>
  );
}

function PhylaxText({ time, className = "", children }: { time: string; className?: string; children: ReactNode }) {
  return (
    <div className={`pa-note ${className}`}>
      <div className="pa-meta"><PhylaxMark className="pa-mark" /><span>PHYLAX · {time}</span></div>
      <p>{children}</p>
    </div>
  );
}

// ---- The phone -------------------------------------------------------------------------------------------------------

type Engine = {
  loop: (fromMs: number) => void; // alerts on: cycle the ring
  rest: () => void; // STOP: the ring at rest
  arm: () => void; // RESUME: alerts on again, "No conflicts"
  alert: () => void; // the new alert's ring, then on into the loop
};

export function PhoneAlert() {
  const reduced = usePrefersReducedMotion();
  const [pref, dispatch] = useReducer(reducePref, reduced ? ASKING_PREF : IDLE_PREF);
  const view = threadView(pref);

  const rootRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLElement>(null);
  const nowRef = useRef<HTMLElement>(null);
  const closesRef = useRef<HTMLSpanElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null); // the scrolling viewport
  const flowRef = useRef<HTMLDivElement>(null); // what scrolls inside it: its height changes while a row opens
  const follow = useRef<Follow>({ on: true, last: 0 }); // `on` while the view should follow the newest message
  const engine = useRef<Engine | null>(null);

  // ---- The timeline engine: the intro, the loop, the paused frame. Owns the ring and the clock, nothing else. ----
  // useLayoutEffect so the idle frame is in place before the first paint (no flash of the held frame).
  useLayoutEffect(() => {
    const root = rootRef.current, phone = phoneRef.current, count = countRef.current, now = nowRef.current, closes = closesRef.current;
    if (!root || !phone || !count || !now || !closes) return;
    const els = { root, phone, count, now, closes };

    if (reduced) {
      // Nothing moves: the held frame, or the resting frame after a STOP. Answers still resolve, instantly.
      paint(els, HELD, null);
      dispatch({ type: "skip" });
      engine.current = {
        loop: () => paint(els, HELD, null, "dial"),
        rest: () => paint(els, PAUSED, null, "dial"),
        arm: () => paint(els, ARMED, null, "dial"),
        alert: () => paint(els, RESUME_HELD, null, "dial"),
      };
      return () => { engine.current = null; };
    }

    let prev: Frame | null = null;
    const show = (f: Frame, part: "scene" | "dial") => {
      paint(els, f, prev, part);
      prev = f;
    };

    let raf = 0;
    let t0 = 0;
    let phase: "idle" | "intro" | "held" = "idle"; // the single-play intro
    let asked = false; // the question has landed
    let looping = false; // the ring should be moving (an answer kept alerts on, or RESUME is under way)
    let mode: "loop" | "alert" = "loop"; // "alert" = the new alert's ring after RESUME, which hands over to "loop" when done
    let loopMs = 0; // elapsed in whichever of the two is running
    let fullyInView = false;
    let mostlyGone = true;
    let anyInView = false;

    const halt = () => { window.cancelAnimationFrame(raf); raf = 0; };

    const introTick = (nowMs: number) => {
      const ms = Math.min(nowMs - t0, T.askEnd);
      show(frameAt(ms), "scene");
      if (!asked && ms >= T.ask) { asked = true; dispatch({ type: "ask" }); }
      if (ms >= T.askEnd) { phase = "held"; raf = 0; return; } // done: it never plays again
      raf = window.requestAnimationFrame(introTick);
    };
    const startIntro = () => {
      halt();
      phase = "intro";
      asked = false;
      prev = null;
      t0 = performance.now();
      dispatch({ type: "play" });
      show(frameAt(0), "scene");
      raf = window.requestAnimationFrame(introTick);
    };
    const rewind = () => {
      halt();
      phase = "idle";
      asked = false;
      prev = null;
      dispatch({ type: "rewind" });
      show(IDLE, "scene");
    };
    // Left the screen once the question was already in: no rewinding, just settle on the frame it was heading for.
    const settle = () => { halt(); phase = "held"; show(HELD, "scene"); };

    const loopTick = (nowMs: number) => {
      let ms = nowMs - t0;
      if (mode === "alert") {
        if (ms < RA.done) {
          loopMs = ms;
          show(resumeAlertAt(ms), "dial");
          raf = window.requestAnimationFrame(loopTick);
          return;
        }
        // The new alert has had its moment: carry on into the standard loop, from its top ("No conflicts").
        mode = "loop";
        t0 = nowMs;
        ms = 0;
      }
      if (ms >= T.loop) { t0 = nowMs; ms = 0; }
      loopMs = ms;
      show(frameAt(ms), "dial");
      raf = window.requestAnimationFrame(loopTick);
    };

    // One place decides what should be moving, from where the card is and whether the tab is visible.
    const sync = () => {
      const visible = !document.hidden;
      if (looping) {
        if (visible && anyInView && !raf) { t0 = performance.now() - loopMs; raf = window.requestAnimationFrame(loopTick); }
        else if (!(visible && anyInView) && raf) halt();
        return;
      }
      if (phase === "idle" && visible && fullyInView) startIntro();
      else if (phase === "intro" && !(visible && !mostlyGone)) (asked ? settle : rewind)();
    };

    engine.current = {
      // Alerts on: carry on from the held frame (or, after Resume, from the idle frame so the ring locks on again).
      loop: (fromMs) => {
        halt();
        looping = true;
        mode = "loop";
        loopMs = fromMs;
        prev = null;
        show(frameAt(fromMs), "dial");
        sync();
      },
      // Alerts off: the ring comes to rest and nothing runs.
      rest: () => {
        halt();
        looping = false;
        prev = null;
        show(PAUSED, "dial");
      },
      // RESUME pressed: alerts are on again, the dial goes back to "No conflicts" while Phylax confirms. Nothing runs yet.
      arm: () => {
        halt();
        looping = false;
        prev = null;
        show(ARMED, "dial");
      },
      // The new alert lands: its ring locks on, holds, and `loopTick` then hands over to the loop on its own.
      alert: () => {
        halt();
        looping = true;
        mode = "alert";
        loopMs = 0;
        prev = null;
        show(resumeAlertAt(0), "dial");
        sync();
      },
    };

    show(IDLE, "scene"); // idle until it scrolls into view
    const io = new IntersectionObserver(([entry]) => {
      fullyInView = isFullyVisible(entry);
      anyInView = entry.isIntersecting;
      mostlyGone = !entry.isIntersecting || entry.intersectionRatio < 0.25;
      sync();
    }, { threshold: THRESHOLDS });
    io.observe(root);
    document.addEventListener("visibilitychange", sync);
    return () => {
      halt();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      engine.current = null;
    };
  }, [reduced]);

  // ---- The confirmation lands a beat after the reply ----
  useEffect(() => {
    if (pref.stage !== "answered" || pref.confirmed) return;
    const id = window.setTimeout(() => dispatch({ type: "confirm" }), reduced ? 0 : CONFIRM_DELAY);
    return () => window.clearTimeout(id);
  }, [pref.stage, pref.confirmed, reduced]);

  // ---- After RESUME: Phylax answers a beat later, and the new alert lands a beat after that ----
  useEffect(() => {
    if (pref.stage !== "resumed" || pref.resumeConfirmed) return;
    const id = window.setTimeout(() => dispatch({ type: "confirmResume" }), reduced ? 0 : CONFIRM_DELAY);
    return () => window.clearTimeout(id);
  }, [pref.stage, pref.resumeConfirmed, reduced]);
  useEffect(() => {
    if (pref.stage !== "resumed" || !pref.resumeConfirmed || pref.alerted) return;
    const id = window.setTimeout(() => dispatch({ type: "alert" }), reduced ? 0 : ALERT_DELAY);
    return () => window.clearTimeout(id);
  }, [pref.stage, pref.resumeConfirmed, pref.alerted, reduced]);

  // ---- The ring follows the thread ----
  const live = view.live, stopped = view.stopped, resumed = view.resumed, alerted = view.alerted;
  useEffect(() => {
    if (alerted) engine.current?.alert(); // the new alert's ring; the engine carries on into the loop by itself
    else if (resumed) engine.current?.arm();
    else if (stopped) engine.current?.rest();
    else if (live) engine.current?.loop(T.out - LOOP_LEAD);
  }, [live, stopped, resumed, alerted]);

  // Each text from Phylax after the intro buzzes the phone as it lands (the intro's own buzzes live in `paint`).
  const landed = (view.saved ? 1 : 0) + (view.resumeConfirmed ? 1 : 0) + (view.alerted ? 1 : 0);
  useEffect(() => {
    if (landed && !reduced && phoneRef.current) buzz(phoneRef.current);
  }, [landed, reduced]);

  // ---- The messaging viewport: it never grows past its cap, it scrolls, and it follows the newest message ----
  // A row opens over ~0.6 s (grid track 0fr -> 1fr), so the flow's height changes on every frame of it; the observer pins
  // the view to the bottom on each one and the older messages glide up and out instead of the newest one landing off screen.
  useLayoutEffect(() => {
    const box = msgsRef.current, flow = flowRef.current;
    if (!box || !flow) return;
    const fl = follow.current;
    const onScroll = () => {
      const top = box.scrollTop;
      // Following stops as soon as the visitor scrolls up to reread, and resumes when they are back at the bottom
      // (or when the next message arrives, see below). Our own pins land exactly on `last` and change nothing.
      if (Math.abs(top - fl.last) > 1) fl.on = box.scrollHeight - top - box.clientHeight < 8;
      fl.last = top;
    };
    const ro = new ResizeObserver(() => { if (fl.on) pinToEnd(box, fl); });
    ro.observe(flow);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); box.removeEventListener("scroll", onScroll); };
  }, []);
  // A new message always brings the view back down, even if the visitor had scrolled up.
  useLayoutEffect(() => {
    const box = msgsRef.current;
    if (!box) return;
    follow.current.on = true;
    pinToEnd(box, follow.current);
  }, [view.messages]);

  // The pressed button leaves the tab order as its row closes, so keep keyboard focus inside the phone.
  const keepFocus = () => rootRef.current?.focus({ preventScroll: true });
  const choose = (choice: Choice) => { keepFocus(); dispatch({ type: "choose", choice }); };
  const resume = () => { keepFocus(); dispatch({ type: "resume" }); };

  const status = !view.asked
    ? ""
    : view.alerted
      ? `New alert. ${NEW_ALERT_TEXT}`
      : view.resumeConfirmed
        ? SAVED.resume
        : view.resumed
          ? `You replied ${RESUME_REPLY}.`
          : view.confirmed
            ? `${view.saved} ${VERDICT}`
            : view.answered
              ? `You replied ${REPLY_LABEL[pref.choice!]}.`
              : `Phylax asks: ${ASK_TEXT} Replies: ${REPLY_LABEL.keep}, ${REPLY_LABEL.stop}.`;

  return (
    <>
    <div
      ref={rootRef}
      className="phone-alert"
      role="group"
      aria-label={ARIA_LABEL}
      tabIndex={-1}
      // First paint / no JS: the held frame. The layout effect takes over from here.
      data-lock="1" data-n1="1" data-n2="1" data-hot="1" data-paused="0"
      style={{ "--rem": HELD.ticks } as CSSProperties}
    >
      <div className="pa-stage">
        <div className="pa-phone" ref={phoneRef} onAnimationEnd={(e) => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("is-buzz"); }}>
          <span className="pa-island" aria-hidden="true" />
          <div className="pa-screen">
            <div className="pa-dial" aria-hidden="true">
              <div className="pa-ticks">
                {TICK_LIST.map((i) => <i key={i} style={{ "--i": i } as CSSProperties} />)}
              </div>
              <span className="pa-pulse" />
              <div className="pa-center">
                <span className="pa-idle">No conflicts</span>
                <span className="pa-rest">Alerts paused</span>
                <span className="pa-live">
                  <small>CareRev window</small>
                  <b ref={countRef}>{fmtLeft(HELD.remMin)}</b>
                  <small>left</small>
                </span>
              </div>
            </div>

            <p className="pa-clock" aria-hidden="true">
              <span>Now <em ref={nowRef}>{fmtClock(HELD.nowMin)}</em></span>
              <span className="pa-closes" ref={closesRef}>{`Closes ${fmtClock(HELD.closesMin)}`}</span>
            </p>

            {/* Everything the visitor reads and answers sits in one capped viewport that scrolls like a messaging app. */}
            <div className="pa-messages" ref={msgsRef} tabIndex={0} role="region" aria-label="Messages">
              <div className="pa-flow" ref={flowRef}>
                <div className="pa-notes">
                  <PhylaxText className="pa-n1" time="9:42 PM">
                    Conflict detected: your ShiftKey shift at Riverside Manor overlaps your CareRev shift at St. Anne's. CareRev's cancellation window closes in 3 hours. Review both before cancelling.
                  </PhylaxText>
                  <PhylaxText className="pa-n2" time="11:42 PM">
                    Heads up: your CareRev cancellation window closes in 1 hour.
                  </PhylaxText>
                </div>

                {/* The preference exchange. Rows open as the conversation moves; nothing above them ever shifts. */}
                <div className="pa-thread">
                  <Row open={view.asked} className="pa-r-ask">
                    <PhylaxText className="pa-ask" time="11:43 PM">{ASK_TEXT}</PhylaxText>
                  </Row>

                  {/* The quick replies and the visitor's own reply share one slot: the chosen chip becomes the bubble. */}
                  <Row open={view.asked} className="pa-r-act">
                    <div className="pa-act">
                      <div className="pa-chips" data-live={view.waiting ? "1" : "0"} aria-hidden={!view.waiting}>
                        {(["keep", "stop"] as const).map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={`pa-chip${view.waiting ? " is-cue" : ""}`}
                            tabIndex={view.waiting ? 0 : -1}
                            onClick={() => choose(c)}
                          >{REPLY_LABEL[c]}</button>
                        ))}
                      </div>
                      <div className="pa-out" data-live={view.answered ? "1" : "0"} aria-hidden={!view.answered}>
                        <span>{view.reply ? REPLY_LABEL[view.reply] : ""}</span>
                      </div>
                    </div>
                  </Row>

                  <Row open={view.waiting} className="pa-r-cue">
                    <p className="pa-cue"><i aria-hidden="true" />{CUE}</p>
                  </Row>

                  <Row open={view.confirmed} className="pa-r-saved">
                    <PhylaxText className="pa-saved" time="11:43 PM">{view.saved ?? ""}</PhylaxText>
                  </Row>

                  {/* After a STOP: the way back in. Same slot trick as the quick replies: the button becomes the RESUME bubble. */}
                  <Row open={view.canResume || view.resumed} className="pa-r-resume">
                    <div className="pa-act">
                      <div className="pa-chips" data-live={view.canResume ? "1" : "0"} aria-hidden={!view.canResume}>
                        <button type="button" className="pa-chip pa-chip-solid is-cue" tabIndex={view.canResume ? 0 : -1} onClick={resume}>
                          <Play aria-hidden="true" />{RESUME_LABEL}
                        </button>
                      </div>
                      <div className="pa-out" data-live={view.resumed ? "1" : "0"} aria-hidden={!view.resumed}>
                        <span>{RESUME_REPLY}</span>
                      </div>
                    </div>
                  </Row>

                  {/* Phylax's own message answering RESUME, then the new alert (a different conflict from the opening one). */}
                  <Row open={view.resumeConfirmed} className="pa-r-rsaved">
                    <PhylaxText className="pa-saved" time="11:43 PM">{SAVED.resume}</PhylaxText>
                  </Row>

                  <Row open={view.alerted} className="pa-r-alert">
                    <PhylaxText className="pa-alert2" time="11:44 PM">{NEW_ALERT_TEXT}</PhylaxText>
                  </Row>
                </div>
              </div>
            </div>
          </div>
        </div>
        <span className="sr-only" role="status">{status}</span>
      </div>

      {/* Phylax's closing line. A sibling of the masked stage and outside the scrolling viewport, so the bottom fade-out and
          the thread's scrolling never touch it. Appears once Phylax has confirmed the preference. */}
      <div className="pa-foot" data-open={view.confirmed ? "1" : "0"} aria-hidden="true">
        <p className="pa-verdict">{VERDICT}</p>
      </div>
    </div>
    <div className="pa-caption"><span>01 — The alert, by text</span><ArrowUpRight size={22} /></div>
    </>
  );
}
