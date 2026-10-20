import { useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import gsap from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { LOGO_BAR_A, LOGO_BAR_B } from "@/components/PhylaxMark";
import { currentRoute, shouldPlayOnSwitch } from "@/lib/loaderGate";
import { BAND_COUNT, computeLayout, type LoaderLayout } from "@/lib/loaderGeometry";
import "../page-loader.css";

gsap.registerPlugin(DrawSVGPlugin);

// ── Timing (seconds) ────────────────────────────────────────────────────────────────────────────────
const T_DISMISS = 1.6; //          wordmark leaves; everything before this is the intro
const T_SPLIT_LEAD = 0.25; //      gap between the wordmark leaving and the screen starting to open
const BAND_DUR = 0.9; //           one band's slide off screen
const BAND_STAGGER = 0.03; //      delay between neighbouring bands (top to bottom: the screen unzips)
const FLIGHT_DUR = 1.1; //         logo flying into the nav
const SPLIT_SPAN = BAND_DUR + (BAND_COUNT - 1) * BAND_STAGGER; // first band starts to last band lands
const SKIP_JUMP = 0.35; //         how long the skip takes to fast-forward to the dismiss point

const BAND_INDEXES = Array.from({ length: BAND_COUNT }, (_, i) => i);

/**
 * Full-screen intro, available on every page. When it plays is decided by the gate in index.html (see lib/loaderGate.ts):
 *
 *   - On a document load (first visit, reload, an installed app launching) the page's own 30-minute cooldown applies.
 *   - On a client-side switch to a different route it plays every time, whatever that page's cooldown says. This is
 *     keyed off the pathname alone, so a route added to App.tsx later gets it with no further setup.
 *
 * The hand-off below is written for the home page. Elsewhere there is no hero, so the logo simply fades out with the
 * wordmark and the screen opens onto the page.
 *
 *   Phase 1  The logo draws itself with DrawSVG (the two bars run toward each other), then the wordmark fades in
 *            while its letter-spacing tightens.
 *   Phase 2  The wordmark fades out and the overlay splits down the middle. The cut is a zig-zag of large
 *            rectangular blocks whose lengths trace a shield (Phylax = "guard"). Each half is a stack of
 *            horizontal bands that leave one after another, top to bottom, with a short accent-coloured spark
 *            running along each cut edge. Meanwhile the logo flies from the centre onto the hero's logo
 *            (FLIP: same geometry, so it lands pixel-for-pixel) and the hero content settles from a slight zoom.
 *   Then     The overlay is unmounted, so nothing is left over the hero to catch pointer events.
 *
 * Skipping: the "LOAD PHYLAX" text at the bottom, or Esc, and nothing else. It fast-forwards to the dismiss
 * point and then plays the normal exit.
 *
 * Performance: bands, logo and edges only ever animate transform / opacity, on layers promoted with will-change,
 * and the tweens use force3D so they run as translate3d on the compositor.
 */
export default function PageLoader() {
  // null: not playing. A number: the id of the run that is playing. A page switch gets a fresh id, so a switch that
  // happens while the loader is still up (browser Back during the intro) restarts it for the page now showing.
  const [runId, setRunId] = useState<number | null>(() => (typeof window !== "undefined" && window.__PHYLAX_LOADER__ === true ? 0 : null));
  const rootRef = useRef<HTMLDivElement>(null);
  const runCount = useRef(0);
  const lastRoute = useRef<string | null>(null);
  const [location] = useLocation(); // only here to re-render on navigation; the route itself is read from the address bar

  // Page switch: whenever the app moves to a different route, ask the gate (which always says yes, unless the visitor
  // prefers reduced motion) and start a run. This is a layout effect, and the state change below is flushed before the
  // browser paints, so the new page is never seen uncovered. Same route (a query string or #hash change) is not a switch.
  useLayoutEffect(() => {
    const route = currentRoute();
    const previous = lastRoute.current ?? (lastRoute.current = route);
    if (route === previous) return;
    lastRoute.current = route;
    if (shouldPlayOnSwitch(route)) setRunId(++runCount.current);
  }, [location]);

  useLayoutEffect(() => {
    if (runId === null) return;
    const html = document.documentElement;
    const root = rootRef.current;
    if (!root) {
      html.classList.remove("phylax-loading", "phylax-hold");
      return;
    }
    const shell = document.querySelector<HTMLElement>(".site-shell");
    // Things on the page underneath that the loader hands off to. The hero logo is the landing spot for the flying
    // logo; the hero content gets a slight zoom-out during the split (the logo is NOT inside it, so the zoom cannot
    // move the landing spot). Either may be missing: the loader copes.
    const heroLogo = document.querySelector<SVGSVGElement>(".hero-section > .hero-brand .hero-logo");
    const heroContent = document.querySelector<HTMLElement>(".hero-section > .hero-content");
    // Only fly if the landing spot is on screen (it will not be if the browser restored a scrolled position).
    const target = heroLogo?.getBoundingClientRect();
    const canFly = !!target && target.width > 0 && target.bottom > 0 && target.top < window.innerHeight;
    const previousOverflow = html.style.overflow;
    const previousGutter = html.style.scrollbarGutter;

    // The overlay is in the DOM now, so the pre-paint cover from index.html can go. Lock scroll and keep the page
    // underneath out of the tab order until we are done.
    // Reserve the scrollbar's width while it is hidden, otherwise the page would jump wider when the lock releases.
    html.style.scrollbarGutter = "stable";
    html.style.overflow = "hidden";
    shell?.setAttribute("inert", "");
    html.classList.remove("phylax-loading");
    // Already set by index.html on a document load. A page switch sets it here, before paint, so the hero's own
    // entrance stays parked until the screen opens (it is released at the "split" label below).
    html.classList.add("phylax-hold");
    // The hero logo stays invisible until the flying logo lands on it (see page-loader.css).
    if (canFly) html.classList.add("phylax-flying");

    const bandsL = Array.from(root.querySelectorAll<HTMLElement>(".pl-band--l"));
    const bandsR = Array.from(root.querySelectorAll<HTMLElement>(".pl-band--r"));
    let layout: LoaderLayout = computeLayout(1, 1);

    const applyLayout = () => {
      const { width, height } = root.getBoundingClientRect();
      layout = computeLayout(width, height);
      root.style.setProperty("--pl-cell", `${layout.cell}px`);
      root.style.setProperty("--pl-cx", `${layout.cx}px`);
      root.style.setProperty("--pl-cy", `${layout.cy}px`);
      layout.bands.forEach((b, i) => {
        const l = bandsL[i];
        const r = bandsR[i];
        if (!l || !r) return;
        l.style.cssText = `left:${b.lx}px;top:${b.y}px;width:${b.lw}px;height:${b.h}px`;
        r.style.cssText = `left:${b.rx}px;top:${b.y}px;width:${b.rw}px;height:${b.h}px`;
      });
    };
    applyLayout();
    window.addEventListener("resize", applyLayout);

    let cancelled = false;
    const finish = () => {
      if (!cancelled) setRunId(null); // unmounts the overlay: it is removed from the DOM, not just hidden
    };

    let skipBtn: HTMLButtonElement | null = null;
    let onSkipClick: (() => void) | null = null;
    let onKey: ((e: KeyboardEvent) => void) | null = null;
    let skipTween: gsap.core.Tween | null = null; // the fast-forward, which is created outside the gsap context
    let fontTimer: number | undefined; //            the "never wait long for the font" timeout

    const ctx = gsap.context(() => {
      const q = gsap.utils.selector(root);
      const logo = q(".pl-logo")[0] as SVGSVGElement;
      const bars = q(".pl-bar");
      const word = q(".pl-word");
      const bg = q(".pl-bg");
      const edgesL = q(".pl-band--l .pl-edge");
      const edgesR = q(".pl-band--r .pl-edge");
      skipBtn = q(".pl-skip")[0] as HTMLButtonElement;

      // Starting state, applied before the first paint. Strokes are hidden as well as undrawn, because a
      // zero-length dash with a square cap would otherwise show as a dot.
      gsap.set(bars, { drawSVG: "0% 0%", autoAlpha: 0 });
      gsap.set(word, { autoAlpha: 0, letterSpacing: "0.6em", paddingLeft: "0.6em" }); // tightens to the CSS 0.3em
      gsap.set(logo, { transformOrigin: "0 0" });
      gsap.set(skipBtn, { autoAlpha: 0 });
      if (heroContent) gsap.set(heroContent, { scale: 1.06, transformOrigin: "50% 55%", force3D: true });

      const tl = gsap.timeline({ paused: true, onComplete: finish });
      const atSplit = (offset: number) => `split+=${offset.toFixed(3)}`;

      // ── Phase 1: self-drawing logo ─────────────────────────────────────────────────────────────
      tl.set(bars, { autoAlpha: 1 }, 0.1)
        // The two bars draw toward each other from opposite corners.
        .to(bars[0], { drawSVG: "0% 100%", duration: 0.8, ease: "power2.inOut" }, 0.1)
        .to(bars[1], { drawSVG: "0% 100%", duration: 0.8, ease: "power2.inOut" }, 0.25)
        .to(word, { autoAlpha: 1, letterSpacing: "0.3em", paddingLeft: "0.3em", duration: 0.55, ease: "power2.out" }, 0.85)
        .to(skipBtn, { autoAlpha: 0.55, duration: 0.4, ease: "power1.out" }, 0.4);

      // ── Phase 2: dismiss the wordmark, then unzip the screen ─────────────────────────────────────
      tl.addLabel("dismiss", T_DISMISS)
        .to(word, { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, "dismiss")
        .to(skipBtn, { autoAlpha: 0, duration: 0.25, ease: "power1.in" }, "dismiss")
        .addLabel("split", `dismiss+=${T_SPLIT_LEAD}`)
        .set(bg, { autoAlpha: 0 }, "split")
        .add(() => html.classList.remove("phylax-hold"), "split"); // hero text now enters with the reveal

      // Bands: every band travels the same distance; they differ only in when they start. Band i of L and R
      // share a start time, so the two halves of a row always part together.
      for (let i = 0; i < BAND_COUNT; i++) {
        const t = i * BAND_STAGGER;
        tl.to(bandsL[i], { x: () => -layout.exitLeft, duration: BAND_DUR, ease: "expo.inOut", force3D: true }, atSplit(t))
          .to(bandsR[i], { x: () => layout.exitRight, duration: BAND_DUR, ease: "expo.inOut", force3D: true }, atSplit(t))
          // Accent spark on the cut edges: flashes in as the band starts to move, then trails off as it leaves.
          .to([edgesL[i], edgesR[i]], { opacity: 1, duration: 0.1, ease: "none" }, atSplit(t))
          .to([edgesL[i], edgesR[i]], { opacity: 0, duration: 0.55, ease: "power2.out" }, atSplit(t + 0.1));
      }

      // The page arrives: hero content settles from a slight zoom while the screen opens.
      if (heroContent) {
        tl.to(heroContent, { scale: 1, duration: SPLIT_SPAN, ease: "power3.out", force3D: true }, "split");
      }

      // The logo flies onto the hero logo. Same 24x20 geometry and 2px-of-24 stroke at both ends, so scaling the
      // loader's SVG box onto the hero SVG box is exact. Measured when the tween starts, not when it is built, so
      // it uses the layout at that moment. If the hero logo is missing or off screen, the logo just fades out.
      let flight: { x: number; y: number; s: number } | null = null;
      const measureFlight = () => {
        const a = logo.getBoundingClientRect();
        const b = heroLogo?.getBoundingClientRect();
        if (!b || !a.width || !b.width) return { x: 0, y: 0, s: 1 };
        return { x: b.left - a.left, y: b.top - a.top, s: b.width / a.width };
      };
      const getFlight = () => (flight ??= measureFlight());
      if (canFly) {
        tl.to(
          logo,
          { x: () => getFlight().x, y: () => getFlight().y, scale: () => getFlight().s, duration: FLIGHT_DUR, ease: "expo.inOut", force3D: true },
          atSplit(0.05),
        );
      } else {
        tl.to(logo, { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, "dismiss");
      }

      // ── Start, and skip ─────────────────────────────────────────────────────────────────────────
      let started = false;
      const start = () => {
        if (started || cancelled) return;
        started = true;
        tl.play(0);
      };

      let skipped = false;
      const skip = () => {
        if (skipped || cancelled) return;
        const dismissAt = tl.labels.dismiss;
        if (started && tl.time() >= dismissAt) return; // already leaving: nothing left to skip
        skipped = true;
        started = true; // the font wait below must not restart the timeline
        if (skipBtn) skipBtn.style.pointerEvents = "none";
        // Fast-forward the intro to the dismiss point, then let the normal exit play at normal speed.
        skipTween = tl.pause().tweenTo(dismissAt, {
          duration: SKIP_JUMP,
          ease: "power1.inOut",
          onComplete: () => {
            if (!cancelled) tl.play();
          },
        });
      };
      onSkipClick = skip;
      onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") skip();
      };
      skipBtn.addEventListener("click", onSkipClick);
      window.addEventListener("keydown", onKey);

      // Start once the wordmark's font is in, but never wait long: a late font must not hold up the page.
      const fontReady = Promise.race([
        document.fonts ? document.fonts.load("800 32px Manrope").then(() => undefined) : Promise.resolve(),
        new Promise<void>((resolve) => {
          fontTimer = window.setTimeout(resolve, 1200);
        }),
      ]).catch(() => undefined);
      fontReady.then(start);
    }, root);

    return () => {
      cancelled = true;
      window.clearTimeout(fontTimer);
      skipTween?.kill();
      window.removeEventListener("resize", applyLayout);
      if (onKey) window.removeEventListener("keydown", onKey);
      if (skipBtn && onSkipClick) skipBtn.removeEventListener("click", onSkipClick);
      ctx.revert(); // also restores the hero content's transform
      html.style.overflow = previousOverflow;
      html.style.scrollbarGutter = previousGutter;
      html.classList.remove("phylax-loading", "phylax-hold", "phylax-flying"); // flying: the hero logo shows again
      // The page may have been swapped under the overlay (e.g. browser Back during the intro), so release every shell,
      // not just the one that was there when the loader started.
      shell?.removeAttribute("inert");
      document.querySelectorAll(".site-shell[inert]").forEach((el) => el.removeAttribute("inert"));
    };
  }, [runId]);

  if (runId === null) return null;

  return (
    // The key gives every run a fresh overlay, so a restart never inherits the last run's leftover inline styles.
    <div key={runId} ref={rootRef} className="pl-root" role="status" aria-label="Loading Phylax">
      <div className="pl-bg" />

      {/* Left half, then right half: BAND_COUNT bands each. Geometry is set from loaderGeometry.ts. */}
      {BAND_INDEXES.map((i) => (
        <div key={`l${i}`} className="pl-band pl-band--l" aria-hidden="true">
          <i className="pl-edge" />
        </div>
      ))}
      {BAND_INDEXES.map((i) => (
        <div key={`r${i}`} className="pl-band pl-band--r" aria-hidden="true">
          <i className="pl-edge" />
        </div>
      ))}

      <div className="pl-stage" aria-hidden="true">
        <svg className="pl-logo" viewBox="0 0 24 20" fill="none" focusable="false">
          <path className="pl-bar" d={LOGO_BAR_A} />
          <path className="pl-bar" d={LOGO_BAR_B} />
        </svg>
        <div className="pl-word">PHYLAX</div>
      </div>

      <button type="button" className="pl-skip" aria-keyshortcuts="Escape" aria-label="Load Phylax, skip the intro">
        LOAD PHYLAX
      </button>
    </div>
  );
}
