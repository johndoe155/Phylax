import { useEffect, useRef, useState } from "react";

/**
 * True from the moment any part of the element first enters the viewport, and it stays true (it never goes back to false, so
 * a one-shot animation is not replayed when the visitor scrolls away and back).
 *
 * No threshold and no root margin on purpose: the point is to react the instant the element's box touches the screen. Without
 * IntersectionObserver (very old browsers) it reports true straight away, so what it gates is never left hidden.
 */
export function useInViewOnce<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return [ref, seen] as const;
}
