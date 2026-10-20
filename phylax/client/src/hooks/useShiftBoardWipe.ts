import { useLayoutEffect, type RefObject } from "react";
import { HIDDEN_CLIPS, shouldPlay, wipeClips, wipeProgressAt, WIPE } from "@/lib/shiftBoardWipe";

/** Set when the wipe has played, never reset: it plays once per page load, however often the board remounts. */
let played = false;

/**
 * Wipe reveal for the shift board (Section 01, card 01), played once.
 *
 * `wrap` is `.tap-wipe`: it holds the board (`.tap-demo`) and, on top of it, the solid panel (`.tap-wipe-panel`). The
 * board starts out clipped away entirely (the page background shows where it will be). When it has scrolled into an
 * adequate position (shouldPlay: nearly all of it on screen, so the whole bulge can be seen) the wipe starts and
 * plays by itself over WIPE.durationMs: the panel grows over the board, then wipes away to reveal it. The shapes and the
 * two phases are in lib/shiftBoardWipe.ts. It is not tied to scrolling: once started it plays to the end whatever the
 * visitor does, and it never runs again until the page is reloaded (scrolling back up shows the finished board).
 *
 * `data-wipe` on the wrapper says where it is: "active" while the board is still hidden or being wiped, "done" once
 * it is fully revealed (all clipping removed, so focus rings and the demo's hover/press effects are never clipped).
 * It fires a `wipechange` event on every change, which TapDemo uses to hold its autoplay until the board can be seen.
 *
 * With prefers-reduced-motion nothing is clipped or covered at all: the board is simply there.
 *
 * It is a layout effect so the first frame is already clipped; without that the board would flash before it was hidden.
 */
export function useShiftBoardWipe(wrapRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const board = wrap?.querySelector<HTMLElement>(":scope > .tap-demo");
    const panel = wrap?.querySelector<HTMLElement>(":scope > .tap-wipe-panel");
    if (!wrap || !board || !panel) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let waiting = 0; // rAF handle of the pending position check
    let playing = 0; // rAF handle of the running wipe
    let live = false; // listening for the right position, or playing

    const setState = (state: "active" | "done" | null) => {
      if ((wrap.dataset.wipe ?? null) === state) return;
      if (state) wrap.dataset.wipe = state;
      else delete wrap.dataset.wipe;
      wrap.dispatchEvent(new Event("wipechange"));
    };
    const clip = (clips: { board: string; panel: string } | null) => {
      board.style.clipPath = clips?.board ?? "";
      panel.style.clipPath = clips?.panel ?? "";
    };
    const finish = () => {
      live = false;
      clip(null);
      setState("done");
    };

    const unlisten = () => {
      window.removeEventListener("scroll", scheduleCheck);
      window.removeEventListener("resize", scheduleCheck);
      if (waiting) cancelAnimationFrame(waiting);
      waiting = 0;
    };

    const play = () => {
      unlisten();
      const t0 = performance.now();
      const tick = (now: number) => {
        const box = wrap.getBoundingClientRect();
        const clips = wipeClips(wipeProgressAt(now - t0), box.width, box.height);
        if (!clips || now - t0 >= WIPE.durationMs) {
          playing = 0;
          played = true;
          finish();
          return;
        }
        clip(clips);
        playing = requestAnimationFrame(tick);
      };
      playing = requestAnimationFrame(tick);
    };

    const check = () => {
      waiting = 0;
      if (shouldPlay(wrap.getBoundingClientRect(), window.innerWidth, window.innerHeight)) play();
    };
    function scheduleCheck() {
      if (!waiting) waiting = requestAnimationFrame(check);
    }

    const start = () => {
      if (live) return;
      if (played) {
        // Already shown this page load (the board remounted): just show it.
        finish();
        return;
      }
      live = true;
      clip(HIDDEN_CLIPS);
      setState("active");
      window.addEventListener("scroll", scheduleCheck, { passive: true });
      window.addEventListener("resize", scheduleCheck);
      check();
    };
    const stop = () => {
      unlisten();
      if (playing) cancelAnimationFrame(playing);
      playing = 0;
      live = false;
      clip(null);
      setState(null);
    };
    const sync = () => (mq.matches ? stop() : start());

    sync();
    mq.addEventListener("change", sync);
    // Web fonts change the height of everything above the board without any scroll.
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled && live && !playing) scheduleCheck(); });

    return () => {
      cancelled = true;
      mq.removeEventListener("change", sync);
      stop();
    };
  }, [wrapRef]);
}
