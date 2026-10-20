import { useEffect, useState } from "react";

/**
 * The current time, refreshed on the minute (on the :00 second, so a clock built from it never lags). It is re-read when the
 * tab becomes visible again or the page is restored from the back/forward cache, because timers are throttled in the
 * background and frozen during sleep.
 */
export function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      const at = new Date();
      setNow(at);
      timer = window.setTimeout(sync, 60_000 - (at.getSeconds() * 1000 + at.getMilliseconds()) + 20);
    };
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return now;
}
