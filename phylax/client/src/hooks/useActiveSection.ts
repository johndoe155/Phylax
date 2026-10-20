import { useEffect, useState } from "react";

/**
 * The id of the section being read: the first one (in page order) that overlaps a band a little below the top of the
 * viewport. Null until the first one reaches it. Runs on the compositor's schedule (IntersectionObserver), not on scroll.
 */
export function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");

  useEffect(() => {
    setActive(null);
    const sections = key.split("|").map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (!sections.length || typeof IntersectionObserver === "undefined") return;
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) (entry.isIntersecting ? inBand.add(entry.target.id) : inBand.delete(entry.target.id));
        const first = sections.find((el) => inBand.has(el.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]);

  return active;
}
