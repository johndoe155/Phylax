import { useEffect, useState } from "react";
import { localDay, msUntilNextLocalDay } from "@/lib/liveCalendar";

/**
 * The viewer's current local day of month, kept current: it rolls over at local midnight, and is re-read when the tab
 * becomes visible again or the page is restored from the back/forward cache (timers are throttled or frozen in
 * background tabs and during sleep, so a long-open tab could otherwise show yesterday's date after waking).
 */
export function useLocalDay(): number {
  const [day, setDay] = useState(() => localDay());

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      const now = new Date();
      setDay(localDay(now)); // no-op when unchanged
      timer = window.setTimeout(sync, msUntilNextLocalDay(now));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return day;
}
