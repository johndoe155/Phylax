import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * The "1·2·3" signature under the Section 01 copy.
 *
 * It is invisible until it scrolls into view (once; scrolling away and back does not replay it). Then:
 *   1  pops in from the left edge of the screen,
 *   2  slides out of 1's slot into its own with the same pop,
 *   3  slides out of 2's slot into its own with the same pop,
 * each one starting after the previous has landed, so they read 1 → 2 → 3.
 *
 * The distances are measured at the moment the sequence starts and handed to the CSS as custom properties
 * (--sig-from-1/2/3), so the motion is right at any viewport width. With reduced motion the numbers are simply shown.
 */
export function SignatureSequence() {
  const rootRef = useRef<HTMLSpanElement>(null);
  const n1 = useRef<HTMLSpanElement>(null);
  const n2 = useRef<HTMLSpanElement>(null);
  const n3 = useRef<HTMLSpanElement>(null);
  const [played, setPlayed] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !n1.current || !n2.current || !n3.current) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        const [a, b, c] = [n1.current, n2.current, n3.current];
        if (a && b && c) {
          // 1 starts just past the left edge of the viewport; 2 and 3 start on top of the number before them.
          root.style.setProperty("--sig-from-1", `${-(a.getBoundingClientRect().right + 40)}px`);
          root.style.setProperty("--sig-from-2", `${-(b.offsetLeft - a.offsetLeft)}px`);
          root.style.setProperty("--sig-from-3", `${-(c.offsetLeft - b.offsetLeft)}px`);
        }
        setPlayed(true);
      },
      { threshold: 0.6 },
    );
    io.observe(root);
    return () => io.disconnect();
  }, []);

  const step = (i: number) => ({ "--i": i }) as CSSProperties;

  return (
    <span ref={rootRef} className="signature" role="img" aria-label="1, 2, 3" data-played={played}>
      <span ref={n1} className="sig-n sig-n-1" style={step(0)} aria-hidden="true">1</span>
      <span className="sig-dot" style={step(1)} aria-hidden="true">·</span>
      <span ref={n2} className="sig-n sig-n-2" style={step(1)} aria-hidden="true">2</span>
      <span className="sig-dot" style={step(2)} aria-hidden="true">·</span>
      <span ref={n3} className="sig-n sig-n-3" style={step(2)} aria-hidden="true">3</span>
    </span>
  );
}
