/**
 * Timeline + painter for <PhoneAlert />, the "alert, by text" illustration (Alerts, card 01).
 *
 * The story is one night, compressed:
 *   9:42 PM   Phylax finds the overlap. The phone buzzes, the text lands, and the CareRev window (3 h) lights up
 *             as a ring of 36 ticks, one tick per 5 minutes.
 *   fast-fwd  The clock races two hours. The ring drains tick by tick, counter-clockwise.
 *   11:42 PM  One hour left. Second buzz, second text, the last 12 ticks turn bright and the ring pulses.
 *   11:43 PM  Third text: "Keep getting Phylax alerts?" with two quick replies. The intro stops here, on `HELD`,
 *             and waits for the visitor. Everything after that (their reply, Phylax's confirmation, the closing line)
 *             is the component's reducer, not this timeline.
 *
 * After the visitor has answered, the ring keeps cycling (`frameAt` on a wrapping clock, painted as "dial" only) if
 * alerts stay on, or rests on `PAUSED` if they chose to stop, until they resume.
 *
 * Resuming after a STOP is its own short beat (`ARMED`, then `resumeAlertAt`): alerts are back on and the dial reads
 * "No conflicts" while Phylax confirms, then a NEW conflict is found at 11:44 PM (a fresh 3 h window, different shifts from
 * the opening alert) and the ring locks on to it. Only once that alert has had its moment does the dial hand over to the
 * same cycling loop the "keep alerts" path uses.
 *
 * Everything is a pure function of elapsed milliseconds (`frameAt`), so the intro, the loop, a scrubber, and the
 * reduced-motion frame all share one definition. `paint` writes a frame to the DOM without touching React state.
 *
 * Consistency note: the window closes at 12:42 AM (9:42 PM + 3 h), so "1 hour left" is 11:42 PM, not 12:40 AM.
 */

export const TICKS = 36; // one tick = 5 minutes
export const WINDOW_MIN = 180; // CareRev cancellation window when the conflict is found
export const SKIP_MIN = 120; // the fast-forward: 9:42 PM -> 11:42 PM
export const START_MIN = 21 * 60 + 42; // 9:42 PM, in minutes after midnight
export const CLOSES_MIN = START_MIN + WINDOW_MIN; // 12:42 AM
export const ASK_MIN = 1; // the preference prompt lands a minute after the heads-up: 11:43 PM, 59 minutes left

/** Milliseconds from the start of a loop. */
export const T = {
  tick: 700, // idle clock rolls 9:41 -> 9:42
  n1: 800, // buzz + first text + ring locks on
  lockEnd: 1500,
  ffStart: 2800, // after a ~2 s read
  ffEnd: 5400,
  n2: 5400, // buzz + second text, last hour goes bright
  ask: 6400, // buzz + the preference prompt; the clock steps on to 11:43 PM
  askEnd: 7100, // the intro ends here and holds until the visitor answers
  out: 9800, // loop only: the dial fades out ...
  reset: 10300, // ... and swaps to the idle state, unseen
  loop: 10500,
} as const;

/** After an answer that keeps alerts on, the loop picks up this far before the dial's fade-out. */
export const LOOP_LEAD = 1800;

export type Frame = {
  locked: boolean; // ring is live
  n1: boolean;
  n2: boolean;
  ask: boolean; // the preference prompt has landed (scene only: the component owns it from here)
  hot: boolean; // final hour
  paused: boolean; // the visitor stopped alerts: the ring is at rest
  out: boolean;
  reset: boolean; // transitions off while the idle state is swapped in
  ticks: number; // lit ticks, fractional (the leading tick fades)
  nowMin: number;
  remMin: number;
  closesMin: number; // when the window on the dial closes (the "Closes" label): a new alert has its own
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function frameAt(ms: number): Frame {
  if (ms >= T.reset) {
    return { locked: false, n1: false, n2: false, ask: false, hot: false, paused: false, out: true, reset: true, ticks: 0, nowMin: START_MIN - 1, remMin: WINDOW_MIN, closesMin: CLOSES_MIN };
  }
  const sweep = easeOut(clamp01((ms - T.n1) / (T.lockEnd - T.n1)));
  const skipped = SKIP_MIN * easeInOut(clamp01((ms - T.ffStart) / (T.ffEnd - T.ffStart)));
  const asked = ASK_MIN * easeInOut(clamp01((ms - T.ask) / (T.askEnd - T.ask)));
  return {
    locked: ms >= T.n1,
    n1: ms >= T.n1,
    n2: ms >= T.n2,
    ask: ms >= T.ask,
    hot: ms >= T.n2,
    paused: false,
    out: ms >= T.out,
    reset: false,
    ticks: (WINDOW_MIN * sweep - skipped - asked) / 5,
    nowMin: START_MIN + skipped + asked - (ms < T.tick ? 1 : 0),
    remMin: WINDOW_MIN - skipped - asked,
    closesMin: CLOSES_MIN,
  };
}

/** Nothing happening yet: the idle state the phone waits in until it is fully on screen. */
export const IDLE: Frame = frameAt(0);

/**
 * Where the intro stops and waits for an answer (also the reduced-motion / first-paint frame): both alerts in, the
 * ring at 59 minutes, the question on screen.
 */
export const HELD: Frame = frameAt(T.askEnd);

/** The visitor stopped alerts: the ring drains to rest and the dial says so. The clock stays where it was. */
export const PAUSED: Frame = { ...HELD, locked: false, hot: false, paused: true, ticks: 0, remMin: WINDOW_MIN };

/** The visitor pressed RESUME: alerts are on again but nothing is open yet, so the dial reads "No conflicts". The clock stays put. */
export const ARMED: Frame = { ...PAUSED, paused: false };

/** The conflict Phylax finds the minute after RESUME: 11:44 PM, a fresh 3 h window closing at 2:44 AM. */
export const RESUME_MIN = HELD.nowMin + 1;

/** Milliseconds from the moment that new alert lands. */
export const RA = {
  lockEnd: 800, // the ring locks on to the new window
  out: 4200, // after a ~3 s read the dial fades out ...
  reset: 4700, // ... and swaps to the idle state, unseen
  done: 4900, // hand over to the standard loop (`frameAt(0)`, "No conflicts")
} as const;

/** The dial for the new alert: the ring sweeps to a full 3 h window, holds, then leaves the way the loop's own cycle does. */
export function resumeAlertAt(ms: number): Frame {
  if (ms >= RA.reset) return frameAt(T.reset); // the loop's own reset frame: idle, faded out, transitions off
  const sweep = easeOut(clamp01(ms / RA.lockEnd));
  return {
    ...ARMED,
    locked: true,
    out: ms >= RA.out,
    ticks: (WINDOW_MIN * sweep) / 5,
    nowMin: RESUME_MIN,
    remMin: WINDOW_MIN,
    closesMin: RESUME_MIN + WINDOW_MIN,
  };
}

/** Where the new alert rests (also the reduced-motion frame): the ring full, 3:00 left. */
export const RESUME_HELD: Frame = resumeAlertAt(RA.lockEnd);


export const fmtClock = (min: number) => {
  const m = Math.round(min) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
export const fmtLeft = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

export type Els = { root: HTMLElement; phone: HTMLElement; count: HTMLElement; now: HTMLElement; closes: HTMLElement };

/** Shakes the phone once. */
export function buzz(phone: HTMLElement) {
  phone.classList.remove("is-buzz");
  void phone.offsetWidth; // restart the animation
  phone.classList.add("is-buzz");
}

/**
 * Writes one frame to the DOM. `prev` is the last painted frame (null on the first paint) and decides the buzz.
 *
 * `scene` = the intro: the two texts and the question arrive and the phone buzzes for each.
 * `dial`  = the loop and the paused state: only the ring, the counter and the clock move; the thread is left alone.
 */
export function paint(els: Els, f: Frame, prev: Frame | null, part: "scene" | "dial" = "scene") {
  const { root, phone, count, now, closes } = els;
  const flag = (k: string, v: boolean) => { const s = v ? "1" : "0"; if (root.dataset[k] !== s) root.dataset[k] = s; };
  flag("lock", f.locked);
  flag("hot", f.hot);
  flag("paused", f.paused);
  root.classList.toggle("is-out", f.out);
  root.classList.toggle("is-reset", f.reset);
  root.style.setProperty("--rem", Math.max(0, f.ticks).toFixed(3));
  count.textContent = fmtLeft(f.remMin);
  now.textContent = fmtClock(f.nowMin);
  const closesText = `Closes ${fmtClock(f.closesMin)}`;
  if (closes.textContent !== closesText) closes.textContent = closesText;

  if (part === "dial") return;
  flag("n1", f.n1);
  flag("n2", f.n2);

  // Buzz on each text arriving (not on the reset back to idle).
  if (prev && ((f.n1 && !prev.n1) || (f.n2 && !prev.n2) || (f.ask && !prev.ask))) buzz(phone);
}
