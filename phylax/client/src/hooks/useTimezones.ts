import { useEffect, useMemo, useState } from "react";
import { FALLBACK_TIMEZONES, deviceTimezone, fetchTimezones, orderTimezones } from "@/lib/timezones";

export type TimezoneSource = "loading" | "server" | "fallback";

/**
 * The options for the timezone select. Starts on the offline shortlist (so there is never an empty select), swaps in the
 * server's list when it arrives, and keeps the device's own zone first and the saved zone second the whole time.
 */
export function useTimezones(saved: string | null): { zones: string[]; device: string | null; source: TimezoneSource } {
  const [remote, setRemote] = useState<string[] | null>(null);
  const [source, setSource] = useState<TimezoneSource>("loading");
  const device = useMemo(() => deviceTimezone(), []);

  useEffect(() => {
    const controller = new AbortController();
    fetchTimezones(controller.signal)
      .then((zones) => { setRemote(zones); setSource("server"); })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError" && controller.signal.aborted) return;
        setSource("fallback");
      });
    return () => controller.abort();
  }, []);

  const zones = useMemo(() => orderTimezones(remote ?? FALLBACK_TIMEZONES, device, saved), [remote, device, saved]);
  return { zones, device, source };
}
