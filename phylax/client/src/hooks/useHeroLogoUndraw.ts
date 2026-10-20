import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";

gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin);

/** Height of the fixed nav (.global-nav). The undraw finishes as the logo slides up under it. */
const NAV_H = 76;
/** Never run the undraw over less scroll than this, so it stays visible on short screens. */
const MIN_RANGE = 140;

/**
 * Scroll-linked "undraw" of the hero logo: the page loader's DrawSVG, played backwards and scrubbed by scroll.
 *
 * Starts the moment the page begins to scroll and is complete when the logo's bottom edge reaches the nav, so the logo
 * is gone just as it leaves the screen. The bars retract back along their own paths toward the corner each one was
 * drawn from, in the reverse order of the intro (bar B first, then bar A, overlapping). Scrolling back up redraws it.
 * It is scrubbed with a little smoothing, so wheel notches ease instead of stepping.
 *
 * The two thin rules either side of the wordmark collapse on the same scroll: each shrinks inwards toward the word and
 * is gone by the time the logo is about 80% undrawn. (They are ::before / ::after, which GSAP cannot target, so the
 * timeline tweens the --rule custom property on .hero-wordmark and the CSS turns it into scaleX.)
 *
 * Both the real hero logo and its inverted blob twin are driven, so the twin never shows a logo the page has undrawn.
 * With prefers-reduced-motion the logo simply stays drawn.
 */
export function useHeroLogoUndraw(heroRef: { current: HTMLElement | null }) {
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const logo = hero.querySelector<SVGSVGElement>(":scope > .hero-brand .hero-logo");
    const barsA = hero.querySelectorAll<SVGPathElement>(".hero-logo-bar--a");
    const barsB = hero.querySelectorAll<SVGPathElement>(".hero-logo-bar--b");
    const wordmarks = hero.querySelectorAll<HTMLElement>(".hero-wordmark"); // real + blob twin
    if (!logo || !barsA.length || !barsB.length) return;

    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          start: 0, // absolute scroll positions: from the very top...
          end: () => Math.max(MIN_RANGE, logo.getBoundingClientRect().bottom + window.scrollY - NAV_H), // ...to logo under nav
          scrub: 0.6,
          invalidateOnRefresh: true, // re-measure on resize / font load
        },
      });

      // Retract each bar to its start corner. The square caps would leave a dot on a zero-length stroke (the loader
      // hides its strokes for the same reason), so each bar is also hidden the instant it has fully retracted.
      tl.to(barsB, { drawSVG: "0% 0%", duration: 0.7 }, 0)
        .to(barsB, { autoAlpha: 0, duration: 0.02 }, 0.68)
        .to(barsA, { drawSVG: "0% 0%", duration: 0.7 }, 0.3)
        .to(barsA, { autoAlpha: 0, duration: 0.02 }, 0.98)
        // The wordmark's rules draw in toward the word and disappear; the word itself stays.
        .to(wordmarks, { "--rule": 0, duration: 0.8 }, 0);
    });

    return () => mm.revert(); // also kills the ScrollTrigger and restores the strokes
  }, [heroRef]);
}
