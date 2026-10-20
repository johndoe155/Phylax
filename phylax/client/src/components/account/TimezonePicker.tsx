import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "@/components/picker/Popover";
import { splitMatch } from "@/lib/places";
import {
  RECENT_KEY, SUGGESTED, deviceUses12Hour, describeZone, formatOffset, groupByRegion, parseOffsetQuery, pushRecent, readRecent, sameZone, searchZones, warmZone, zoneClock, type ZoneClock,
} from "@/lib/timezonePicker";
import { useMinuteNow } from "@/hooks/useMinuteNow";

/* A custom timezone picker in the account page's field language (account.css, timezone-picker.css): the 60px field with its
   label resting above, a panel that drops from it on a desktop and rises from the bottom edge on a phone. The panel is a
   combobox: focus stays in the search box while the arrow keys move through the list, Enter picks, Escape closes. */

type Section = { key: string; label: string; zones: string[] };
type Row = { key: string; zone: string; section: string };

const hasStorage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };
const finePointer = () => typeof window.matchMedia === "function" && !window.matchMedia("(pointer: coarse)").matches;

function Chevron() {
  return <svg className="tzp-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6.5 9.5L12 15l5.5-5.5" /></svg>;
}
function SearchIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>;
}
function CloseIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" /></svg>;
}

/** The time as it reads on the clock, redrawn with a short fade when the minute changes. */
function Time({ clock }: { clock: ZoneClock | null }) {
  return clock ? <span key={clock.time} className="tzp-tick">{clock.time}</span> : <span>--:--</span>;
}

// ---- Panel ------------------------------------------------------------------------------------------------------------

function Panel({ zones, value, device, now, twelve, onPick, onClose }: {
  zones: string[]; value: string; device: string | null; now: Date; twelve: boolean; onPick: (zone: string) => void; onClose: () => void;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => readRecent(hasStorage()));
  const q = query.trim();

  const zoneSet = useMemo(() => new Set(zones), [zones]);
  const clocks = useMemo(() => new Map(zones.map((z) => [z, zoneClock(z, now, twelve)] as const)), [zones, now, twelve]);

  const sections = useMemo<Section[]>(() => {
    if (q) {
      const hits = searchZones(zones, q, (z) => clocks.get(z)?.offset ?? null);
      return [{ key: "results", label: `${hits.length} ${hits.length === 1 ? "result" : "results"}`, zones: hits }];
    }
    const out: Section[] = [];
    if (device && zoneSet.has(device)) out.push({ key: "device", label: "This device", zones: [device] });
    const mine = recent.filter((z) => zoneSet.has(z) && !sameZone(z, device)).slice(0, 4);
    if (mine.length) out.push({ key: "recent", label: "Recent", zones: mine });
    else {
      const common = SUGGESTED.filter((z) => zoneSet.has(z) && !sameZone(z, device));
      if (common.length) out.push({ key: "suggested", label: "Suggested", zones: common });
    }
    for (const g of groupByRegion(zones)) out.push({ key: `r:${g.label}`, label: g.label, zones: g.zones });
    return out;
  }, [q, zones, zoneSet, clocks, device, recent]);

  const rows = useMemo<Row[]>(() => sections.flatMap((s) => s.zones.map((zone) => ({ key: `${s.key}:${zone}`, zone, section: s.key }))), [sections]);

  // Start on the saved zone: its place in the full list when it isn't pinned above, so the list opens scrolled to it.
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    const own = rows.filter((r) => sameZone(r.zone, value));
    return (own.find((r) => r.section.startsWith("r:")) ?? own[0] ?? rows[0])?.key ?? null;
  });
  const activeIndex = rows.findIndex((r) => r.key === activeKey);

  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>("[data-active]");
    if (list.current && el) list.current.scrollTop = Math.max(0, el.offsetTop - (list.current.clientHeight - el.offsetHeight) / 2);
  }, []); // once, on open

  // A new query starts at the best match.
  useEffect(() => {
    if (q) setActiveKey(rows[0]?.key ?? null);
    if (list.current) list.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const move = (to: number) => {
    if (!rows.length) return;
    const next = rows[(to + rows.length) % rows.length];
    setActiveKey(next.key);
    requestAnimationFrame(() => list.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }));
  };

  const pick = (zone: string) => {
    const next = pushRecent(recent, zone);
    setRecent(next);
    try { hasStorage()?.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode: the pick still works */ }
    onPick(zone);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); move(activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(activeIndex < 0 ? rows.length - 1 : activeIndex - 1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(Math.min(activeIndex + 6, rows.length - 1)); }
    else if (e.key === "PageUp") { e.preventDefault(); move(Math.max(activeIndex - 6, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[activeIndex]) pick(rows[activeIndex].zone); }
  };

  const wantsOffset = parseOffsetQuery(q) !== null;
  const mark = (text: string) => {
    if (!q || wantsOffset) return text;
    const [a, hit, b] = splitMatch(text, q);
    return hit ? <>{a}<mark>{hit}</mark>{b}</> : text;
  };
  const abbrHit = (zone: string) => (q && !wantsOffset ? describeZone(zone).abbrs.find((a) => a.toLowerCase() === q.toLowerCase()) : undefined);

  const optionId = (key: string) => `${id}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <div className="tzp-panel">
      <div className="tzp-sheet-head">
        <span className="tzp-sheet-title">Timezone</span>
        <button type="button" className="tzp-x" onClick={onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div className="tzp-search">
        <SearchIcon />
        <input
          className="tzp-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={activeKey && activeIndex >= 0 ? optionId(activeKey) : undefined}
          aria-autocomplete="list"
          aria-label="Search timezones"
          placeholder="City, country, EST or +01:00"
          value={query}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="go"
          data-autofocus={finePointer() ? "" : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {query ? <button type="button" className="tzp-clear" onClick={() => setQuery("")} aria-label="Clear search"><CloseIcon /></button> : null}
      </div>

      <div className="tzp-list" id={`${id}-list`} role="listbox" aria-label="Timezones" ref={list} data-empty={rows.length === 0 || undefined}>
        {rows.length === 0 ? (
          <div className="tzp-empty">
            <p className="tzp-empty-title">No timezone matches “{q}”.</p>
            <p className="tzp-empty-copy">Try a city, a country, an abbreviation like EST, or an offset like +05:30.</p>
            <button type="button" className="tzp-link" onClick={() => setQuery("")}>Clear search</button>
          </div>
        ) : sections.map((section) => (
          <div className="tzp-group" role="group" aria-label={section.label} key={section.key}>
            <div className="tzp-head" aria-hidden="true">{section.label}</div>
            {section.zones.map((zone) => {
              const key = `${section.key}:${zone}`;
              const info = describeZone(zone);
              const clock = clocks.get(zone) ?? null;
              const selected = sameZone(zone, value);
              const abbr = abbrHit(zone);
              return (
                <div
                  key={key}
                  id={optionId(key)}
                  role="option"
                  className="tzp-opt"
                  aria-selected={selected}
                  data-selected={selected || undefined}
                  data-active={key === activeKey || undefined}
                  onMouseDown={(e) => e.preventDefault()} // keep focus in the search box
                  onPointerMove={() => { if (key !== activeKey) setActiveKey(key); }}
                  onClick={() => pick(zone)}
                >
                  <span className="tzp-main">
                    <span className="tzp-city">{mark(info.city)}</span>
                    <span className="tzp-sub">
                      <span className="tzp-place">{mark(info.place)}</span>
                      {abbr ? <span className="tzp-abbr">{abbr}</span> : null}
                      {section.key !== "device" && sameZone(zone, device) ? <span className="tzp-current">Current</span> : null}
                    </span>
                  </span>
                  <span className="tzp-side">
                    <span className="tzp-time"><Time clock={clock} />{clock && clock.dayShift !== 0 ? <span className="tzp-day" title={clock.dayShift > 0 ? "Tomorrow where you are" : "Yesterday where you are"}>{clock.dayShift > 0 ? "+1D" : "−1D"}</span> : null}</span>
                    <span className="tzp-off">{clock ? formatOffset(clock.offset) : ""}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <span className="sr-only" role="status">{q ? `${rows.length} ${rows.length === 1 ? "timezone" : "timezones"} found` : ""}</span>
    </div>
  );
}

// ---- Field --------------------------------------------------------------------------------------------------------------

export function TimezonePicker({ label = "Timezone", value, onValueChange, zones, device, hintId }: {
  label?: string; value: string; onValueChange: (zone: string) => void; zones: string[]; device: string | null; hintId?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const now = useMinuteNow();
  const twelve = useMemo(() => deviceUses12Hour(), []);
  const close = useCallback(() => setOpen(false), []);

  const info = describeZone(value);
  const clock = zoneClock(value, now, twelve);
  const isDevice = sameZone(value, device);

  // Build the clock formatters while the page is idle, so the first open is as quick as the second.
  useEffect(() => {
    let cancelled = false, at = 0;
    const idle = (cb: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(cb, { timeout: 600 }) : window.setTimeout(cb, 80));
    const step = () => {
      if (cancelled) return;
      for (const end = Math.min(at + 24, zones.length); at < end; at++) warmZone(zones[at]);
      if (at < zones.length) idle(step);
    };
    idle(step);
    return () => { cancelled = true; };
  }, [zones]);

  // On a phone the keyboard covers the bottom of the layout viewport. Follow the visual viewport so the sheet sits above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const root = document.documentElement;
    const sync = () => {
      root.style.setProperty("--tzp-vh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--tzp-kb", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => { vv.removeEventListener("resize", sync); vv.removeEventListener("scroll", sync); root.style.removeProperty("--tzp-vh"); root.style.removeProperty("--tzp-kb"); };
  }, [open]);

  return (
    <div className="ac-field tzp-field" data-float="" data-open={open || undefined}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="tzp-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${id}-l ${id}-v`}
        aria-describedby={`${id}-o${hintId ? ` ${hintId}` : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tzp-value" id={`${id}-v`}>
          <span className="tzp-city">{info.city}</span>
          <span className="tzp-place">{info.place}</span>
        </span>
        <span className="tzp-clock"><Time clock={clock} /></span>
        <Chevron />
      </button>
      <label className="ac-label" id={`${id}-l`} htmlFor={id}>{label}</label>
      <span className="tzp-tags" aria-hidden="true">
        {isDevice ? <span className="tzp-current">Current</span> : null}
        <span className="tzp-offset" id={`${id}-o`}>{clock ? formatOffset(clock.offset) : ""}</span>
      </span>
      <Popover open={open} anchorRef={trigger} label={`Choose ${label.toLowerCase()}`} onClose={close} scrimClass="tzp-scrim" popClass="tzp-pop">
        <Panel zones={zones} value={value} device={device} now={now} twelve={twelve} onPick={(zone) => { onValueChange(zone); close(); }} onClose={close} />
      </Popover>
    </div>
  );
}
