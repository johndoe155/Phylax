import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { axis, CLASH, dayShift, nightShift, pct } from "@/lib/shiftLanes";
import { useShiftBoardWipe } from "@/hooks/useShiftBoardWipe";

/**
 * "Three taps" demo for card 01 of How it works.
 *
 * A self-playing walkthrough: a finger taps the platform chip, the saved shift, then Save. The night shift lands on
 * the board, and Phylax flags the 1-hour overlap with the CareRev shift. The stopwatch runs from the first tap to the
 * flag (3.0s), and the big numeral counts the taps.
 *
 * Playback:
 *  - It is static until the whole illustration is inside the viewport (IntersectionObserver, threshold 1).
 *  - It then plays exactly AUTOPLAY_LOOPS times and halts on the finished frame. It does this once; scrolling away and
 *    back does not replay it. If it is scrolled out of view (or the tab is hidden) mid-run, it resets to the idle frame
 *    and starts again, from the beginning, the next time it is fully in view.
 *  - When the autoplay completes, a cue ("Your turn") invites the visitor to try it themselves.
 *  - The controls are real: tapping ShiftKey, the shift tile and Save in order runs the demo by hand. Tapping the
 *    demo while it plays (or once it has finished) takes over / starts it again from the top.
 *  - "Replay preview" plays one more automatic loop (REPLAY_LOOPS).
 *
 * With reduced motion it shows the finished frame and never schedules an animation: no autoplay, no replay button.
 * Manual taps still work, and resolve instantly.
 *
 * The board itself is revealed by a wipe (hooks/useShiftBoardWipe): it stays hidden until it has scrolled into view,
 * then a #506b80 panel covers it and wipes away. That plays once per page load. The autoplay waits for it to finish, so
 * the demo never runs behind the panel.
 */

type FingerAt = "rest" | 1 | 2 | 3 | "gone";
type Fade = "no" | "out" | "reset";
type Frame = {
  step: 0 | 1 | 2 | 3;
  flagged: boolean;
  finger: FingerAt;
  fade: Fade;
  tapId: number;
  ring: { x: number; y: number } | null;
};
/** idle: waiting to be fully in view. playing: an automatic run. manual: the visitor is driving. ready: finished, cue shown. */
type Phase = "idle" | "playing" | "manual" | "ready";
type Target = 1 | 2 | 3;
/** Where a tap landed, in viewport (client) coordinates. Absent for taps with no pointer (keyboard, assistive tech). */
type TapPoint = { x: number; y: number };
type Api = { tap: (n: Target, point?: TapPoint) => void; root: () => void; replay: () => void };

const IDLE: Frame = { step: 0, flagged: false, finger: "rest", fade: "no", tapId: 0, ring: null };
const FINAL: Frame = { step: 3, flagged: true, finger: "gone", fade: "no", tapId: 0, ring: null };

/** How many times the animation plays when it first becomes fully visible, and how many "Replay preview" adds. */
const AUTOPLAY_LOOPS = 2;
const REPLAY_LOOPS = 1;

// Milliseconds from the start of a loop. The stopwatch runs tap1 -> flag = exactly 3.0s.
const T = {
  move1: 250,
  tap1: 700,
  move2: 900,
  tap2: 1900,
  move3: 2100,
  tap3: 3100,
  flag: 3700,
  out: 7100, // between loops: hold the finished frame ~3.4s, then fade out
  reset: 7500,
  again: 7600,
  done: 4200, // last loop of a run: settle on the finished frame, then hand over to the cue
};
const STOPWATCH_MAX = (T.flag - T.tap1) / 1000;
const MANUAL_STOPWATCH_MAX = 99.9;

const SAY: Record<string, string> = {
  idle: "Three taps to log",
  1: "Pick the app",
  2: "Tap a saved shift",
  3: "Save",
  flagged: "Overlap caught. The night shift stays one block across midnight.",
};

const ARIA_LABEL =
  "Interactive example: three taps log a shift. Choose ShiftKey, tap the Riverside Manor night template, save. Phylax then flags a one-hour overlap with a CareRev shift that starts at 6 AM.";

const CUE_FIRST = "Your turn. Tap ShiftKey, a saved shift, then Save.";
const CUE_AGAIN = "Caught in one pass. Tap the preview to try again.";
/** How long the cue stays on screen after the demo leaves "ready", so it can slide out (matches .tap-cue-text.is-leaving). */
const CUE_EXIT_MS = 450;

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

export function TapDemo() {
  const reduced = usePrefersReducedMotion();
  const [frame, setFrame] = useState<Frame>(reduced ? FINAL : IDLE);
  const [phase, setPhase] = useState<Phase>(reduced ? "ready" : "idle");
  // Whether the visitor has run the demo themselves (switches the cue's wording).
  const [tried, setTried] = useState(false);

  // The cue is kept mounted for a moment after the demo leaves "ready", so it can slide out. It keeps the wording it had.
  const cueText = tried ? CUE_AGAIN : CUE_FIRST;
  const [cue, setCue] = useState<{ id: number; text: string; leaving: boolean } | null>(
    () => (phase === "ready" ? { id: 0, text: cueText, leaving: false } : null),
  );
  useEffect(() => {
    if (phase === "ready") {
      setCue((c) => ({ id: (c?.id ?? 0) + 1, text: cueText, leaving: false }));
      return;
    }
    setCue((c) => (c && !c.leaving ? { ...c, leaving: true } : c));
    const t = window.setTimeout(() => setCue(null), reduced ? 0 : CUE_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [phase, cueText, reduced]);

  const wipeRef = useRef<HTMLDivElement>(null);
  useShiftBoardWipe(wipeRef);
  const rootRef = useRef<HTMLDivElement>(null);
  const ctrlsRef = useRef<HTMLDivElement>(null);
  const fingerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const apiRef = useRef<Api | null>(null);
  const targets = { 1: useRef<HTMLSpanElement>(null), 2: useRef<HTMLDivElement>(null), 3: useRef<HTMLDivElement>(null) };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const setTimer = (seconds: number) => {
      if (timerRef.current) timerRef.current.textContent = `${seconds.toFixed(1)}s`;
    };

    // Where the finger (and the tap ring) sits for a given target, in px relative to the controls column.
    const locate = (which: "rest" | Target) => {
      const ctrls = ctrlsRef.current;
      if (!ctrls) return { x: 0, y: 0 };
      const box = ctrls.getBoundingClientRect();
      if (which === "rest") return { x: box.width - 24, y: box.height + 20 };
      const el = targets[which].current;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left + r.width * (which === 1 ? 0.5 : 0.75), y: r.top - box.top + r.height / 2 };
    };
    // A viewport point (where the visitor actually clicked or touched) as px relative to the controls column, the
    // same space the finger and the tap ring are positioned in.
    const toCtrls = (point: TapPoint) => {
      const ctrls = ctrlsRef.current;
      if (!ctrls) return null;
      const box = ctrls.getBoundingClientRect();
      return { x: point.x - box.left, y: point.y - box.top };
    };
    const place = (which: "rest" | Target) => {
      const { x, y } = locate(which);
      fingerRef.current?.style.setProperty("--fx", `${x}px`);
      fingerRef.current?.style.setProperty("--fy", `${y}px`);
    };

    // `cur` mirrors the rendered frame so the click handlers can read it without a re-render.
    let cur: Frame = reduced ? FINAL : IDLE;
    const show = (f: Frame) => { cur = f; setFrame(f); };
    const update = (fn: (f: Frame) => Frame) => show(fn(cur));

    let timers: number[] = [];
    let raf = 0;
    let t0 = 0;
    let running = false; // an automatic run is in progress
    let runKind: "auto" | "replay" | null = null;
    let autoplayed = false; // the initial two-loop autoplay has finished (or the visitor took over): never autoplay again
    let fullyInView = false;

    const at = (ms: number, fn: () => void) => void timers.push(window.setTimeout(fn, ms));
    const halt = () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers = [];
      window.cancelAnimationFrame(raf);
      running = false;
      runKind = null;
    };
    const resetIdle = () => {
      halt();
      place("rest");
      setTimer(0);
      show(IDLE);
    };
    const startWatch = (cap: number) => {
      t0 = performance.now();
      const tick = () => {
        setTimer(Math.min((performance.now() - t0) / 1000, cap));
        raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
    };

    // ---- Automatic playback: `left` loops, the last one stays on the finished frame ----
    const runLoop = (left: number, kind: "auto" | "replay") => {
      halt();
      running = true;
      runKind = kind;
      place("rest");
      setTimer(0);
      show(IDLE);
      setPhase("playing");

      const tap = (n: Target) => update((f) => ({ ...f, step: n, tapId: f.tapId + 1, ring: locate(n) }));

      at(T.move1, () => { place(1); update((f) => ({ ...f, finger: 1 })); });
      at(T.tap1, () => { startWatch(STOPWATCH_MAX); tap(1); });
      at(T.move2, () => { place(2); update((f) => ({ ...f, finger: 2 })); });
      at(T.tap2, () => tap(2));
      at(T.move3, () => { place(3); update((f) => ({ ...f, finger: 3 })); });
      at(T.tap3, () => tap(3));
      at(T.flag, () => {
        window.cancelAnimationFrame(raf);
        setTimer(STOPWATCH_MAX);
        update((f) => ({ ...f, flagged: true, finger: "gone" }));
      });

      if (left > 1) {
        // Not the last loop: fade out, snap back, go again.
        at(T.out, () => update((f) => ({ ...f, fade: "out" })));
        at(T.reset, () => { place("rest"); setTimer(0); show({ ...IDLE, fade: "reset" }); });
        at(T.again, () => runLoop(left - 1, kind));
      } else {
        // Last loop: it stops here, on the finished frame, and the cue takes over.
        at(T.done, () => {
          halt();
          if (kind === "auto") autoplayed = true;
          setPhase("ready");
        });
      }
    };

    // ---- Visitor-driven: the real controls ----
    const enterManual = () => {
      autoplayed = true;
      setPhase("manual");
    };
    const interrupt = () => {
      resetIdle();
      enterManual();
    };

    const tapTarget = (n: Target, point?: TapPoint) => {
      if (running || cur.flagged) {
        // Taking over an automatic run, or starting again from a finished demo. A tap while it plays on
        // ShiftKey counts as the first tap; otherwise the demo just returns to the top.
        const wasRunning = running;
        interrupt();
        if (!(wasRunning && n === 1)) return;
      } else {
        enterManual();
      }
      if (n !== cur.step + 1) return; // taps go in order; the pulsing control shows which is next

      if (n === 1) startWatch(MANUAL_STOPWATCH_MAX);
      // The ring marks the exact spot the visitor pressed; only a tap with no pointer position (keyboard) falls back
      // to the control's own anchor point, which is where the automatic preview taps.
      const ring = (point && toCtrls(point)) || locate(n);
      update((f) => ({ ...f, step: n, tapId: f.tapId + 1, ring, finger: "gone" }));

      if (n === 3) {
        const finish = () => {
          const elapsed = Math.min((performance.now() - t0) / 1000, MANUAL_STOPWATCH_MAX);
          halt();
          setTimer(elapsed);
          update((f) => ({ ...f, flagged: true }));
          setTried(true);
          setPhase("ready");
        };
        // Reduced motion: no delay, the flag appears at once.
        if (reduced) finish();
        else at(T.flag - T.tap3, finish);
      }
    };

    // A tap on the illustration itself (outside the three controls): take over or start again, but apply no step.
    const tapRoot = () => {
      if (running || cur.flagged) interrupt();
    };

    const replay = () => {
      if (running || reduced) return;
      autoplayed = true;
      runLoop(REPLAY_LOOPS, "replay");
    };

    apiRef.current = { tap: tapTarget, root: tapRoot, replay };

    place("rest");

    if (reduced) {
      show(FINAL);
      setTimer(STOPWATCH_MAX);
      setPhase("ready");
      return () => { halt(); apiRef.current = null; };
    }

    resetIdle();
    setPhase("idle");

    // Autoplay: only when the whole illustration is on screen and uncovered, and only until it has played once.
    const wipe = wipeRef.current;
    const uncovered = () => wipe?.dataset.wipe !== "active";
    const sync = () => {
      const visible = fullyInView && uncovered() && !document.hidden;
      if (visible && !running && !autoplayed) runLoop(AUTOPLAY_LOOPS, "auto");
      else if (!visible && running && runKind === "auto") {
        // Scrolled away (or tab hidden) before it finished: back to idle, and it starts over when fully visible again.
        resetIdle();
        setPhase("idle");
      }
    };
    // threshold 1 = 100% visible; the 0.99 floor absorbs sub-pixel rounding at the edges.
    const io = new IntersectionObserver(
      ([entry]) => { fullyInView = entry.isIntersecting && entry.intersectionRatio >= 0.99; sync(); },
      { threshold: 1 },
    );
    io.observe(root);
    document.addEventListener("visibilitychange", sync);
    wipe?.addEventListener("wipechange", sync);

    return () => {
      halt();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      wipe?.removeEventListener("wipechange", sync);
      apiRef.current = null;
    };
    // targets are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const { step, flagged, finger, fade, tapId, ring } = frame;
  const say = flagged ? SAY.flagged : step === 0 ? SAY.idle : SAY[step];
  // While the visitor is driving, the next control pulses so it is obvious what to tap.
  const next: Target | null = phase === "manual" && !flagged ? ((step + 1) as Target) : null;
  const cls = [
    "visual tap-demo",
    fade === "out" && "is-out",
    fade === "reset" && "is-reset",
    step >= 3 && "is-saved",
    flagged && "is-flagged",
    phase === "ready" && "is-cue",
  ].filter(Boolean).join(" ");

  const press = (n: Target) => ({
    role: "button" as const,
    tabIndex: 0,
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      // detail === 0 marks a click with no pointer behind it (Enter/Space on a button, assistive tech), whose
      // clientX/Y are meaningless; those fall back to the control's anchor point.
      apiRef.current?.tap(n, e.detail > 0 ? { x: e.clientX, y: e.clientY } : undefined);
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); apiRef.current?.tap(n); }
    },
  });

  return (
    <>
      {/* The board and, over it, the panel that wipes it into view once it has scrolled on screen (see useShiftBoardWipe). */}
      <div ref={wipeRef} className="tap-wipe">
        <div
          ref={rootRef}
          className={cls}
          data-step={step}
          data-phase={phase}
          role="group"
          aria-label={ARIA_LABEL}
          onClick={() => apiRef.current?.root()}
        >
          <div className="tap-body">
            <div className="v-head" aria-hidden="true">
              <span>Shift board</span>
              <span className="tap-timer" ref={timerRef}>0.0s</span>
            </div>

            <div className="tap-top" aria-hidden="true">
              <div className="tap-count">
                <div className="tap-count-stack" style={{ transform: `translateY(calc(${-step} * var(--tap-num)))` }}>
                  {[0, 1, 2, 3].map((n) => <span key={n} className={n === 0 ? "is-zero" : undefined}>{n}</span>)}
                </div>
              </div>
              <p className="tap-say"><span key={say}>{say}</span></p>
            </div>

            <div className="tap-ctrls" ref={ctrlsRef}>
              <div className="chips">
                <span
                  ref={targets[1]}
                  className={`chip t1 ${step >= 1 ? "chip-on" : ""} ${next === 1 ? "is-next" : ""}`}
                  aria-label="Choose ShiftKey"
                  aria-pressed={step >= 1}
                  {...press(1)}
                >ShiftKey</span>
                <span className="chip" aria-hidden="true">CareRev</span>
                <span className="chip" aria-hidden="true">ShiftMed</span>
                <span className="chip" aria-hidden="true">+2</span>
              </div>
              <div
                ref={targets[2]}
                className={`tap-tile t2 ${step >= 2 ? "is-on" : ""} ${next === 2 ? "is-next" : ""}`}
                aria-label="Tap the Riverside Manor night template, 7 PM to 7 AM"
                aria-pressed={step >= 2}
                {...press(2)}
              >
                <strong>Riverside Manor</strong><span>Night · 7P–7A</span>
              </div>
              <div
                ref={targets[3]}
                className={`tap-save t3 ${step >= 3 ? "is-done" : step >= 2 ? "is-ready" : ""} ${next === 3 ? "is-next" : ""}`}
                aria-label="Save the shift"
                {...press(3)}
              >
                {step >= 3 ? "Saved" : "Save"}
              </div>

              {ring && <i key={tapId} className="tap-ring" aria-hidden="true" style={{ left: ring.x, top: ring.y }} />}
              <div ref={fingerRef} className={`tap-finger ${typeof finger === "number" ? "is-on" : ""}`} aria-hidden="true">
                <i key={tapId} className="tap-dot" />
              </div>
            </div>

            <div className="lanes" aria-hidden="true">
              <div className="lane-axis">
                {axis.map((tick) => (
                  <span key={tick.at} style={{ left: `${pct(tick.at)}%` }}>{tick.label}</span>
                ))}
              </div>
              <div className="tap-pair">
                <div className="lane">
                  <div className="lane-label"><span>ShiftKey</span></div>
                  <div className="lane-track">
                    <div
                      className="lane-bar tap-bar-night"
                      style={{ left: `${pct(nightShift.from)}%`, width: `${pct(nightShift.to) - pct(nightShift.from)}%` }}
                    >
                      {nightShift.name}<small>{nightShift.time}</small>
                    </div>
                  </div>
                </div>
                <div className="lane">
                  <div className="lane-label"><span>CareRev</span></div>
                  <div className="lane-track">
                    <div
                      className="lane-bar lane-bar-blue"
                      style={{
                        left: `${pct(dayShift.from)}%`,
                        width: `${pct(dayShift.to) - pct(dayShift.from)}%`,
                        // Keep the label clear of the overlap band, which starts at this bar's left edge.
                        paddingLeft: `calc(${pct(CLASH[1]) - pct(CLASH[0])}% + 4px)`,
                        paddingRight: 6,
                      }}
                    >
                      {dayShift.name}<small>{dayShift.time}</small>
                    </div>
                  </div>
                </div>
                <div
                  className="tap-band"
                  style={{ left: `${pct(CLASH[0])}%`, width: `${pct(CLASH[1]) - pct(CLASH[0])}%` }}
                />
              </div>
              <div className="lane">
                <div className="lane-label"><span>Phylax flags</span><span className="lane-flag">6A–7A · 1 HR</span></div>
                <div className="lane-track">
                  <div
                    className="lane-clash tap-clash"
                    style={{ left: `${pct(CLASH[0])}%`, width: `${pct(CLASH[1]) - pct(CLASH[0])}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
          {/* Spoken version of the on-screen caption, so the result of each tap is announced. */}
          <span className="sr-only" role="status">{flagged ? SAY.flagged : ""}</span>
        </div>
        <div className="tap-wipe-panel" aria-hidden="true" />
      </div>

      <div className="tap-meta">
        {/* The cue: shown once the autoplay has finished (and again after each manual run). */}
        <p className="tap-cue" role="status">
          {cue && <span key={cue.id} className={`tap-cue-text${cue.leaving ? " is-leaving" : ""}`}>{cue.text}</span>}
        </p>
        {!reduced && (
          <button
            type="button"
            className="tap-replay"
            disabled={phase === "playing"}
            onClick={() => apiRef.current?.replay()}
          >
            Replay preview
          </button>
        )}
      </div>
    </>
  );
}
