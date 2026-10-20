import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import type { LoaderGate } from "./loaderGate";

/**
 * These tests run the REAL gate: the inline script from client/index.html, executed in a sandbox with a fake clock,
 * fake storage and a fake address bar. Nothing is re-implemented here, so they cannot drift from what ships.
 */

const MIN = 60 * 1000;
const HTML = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

class FakeStorage {
  private map = new Map<string, string>();
  broken = false;
  private guard() { if (this.broken) throw new Error("SecurityError"); }
  get length() { this.guard(); return this.map.size; }
  key(i: number) { this.guard(); return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { this.guard(); return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.guard(); this.map.set(k, String(v)); }
  removeItem(k: string) { this.guard(); this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}

interface Env {
  now: number;
  storage: FakeStorage;
  reduceMotion: boolean;
  classes: Set<string>;
  timers: number;
}

/** Simulates one document load of `pathname` against the given persistent state, and returns the gate it installed. */
function loadDocument(env: Env, pathname: string) {
  env.classes.clear();
  const win: Record<string, unknown> = {
    matchMedia: () => ({ matches: env.reduceMotion }),
  };
  const sandbox = {
    window: win,
    document: { documentElement: { classList: { add: (...c: string[]) => c.forEach((x) => env.classes.add(x)), remove: (...c: string[]) => c.forEach((x) => env.classes.delete(x)) } } },
    location: { pathname },
    localStorage: env.storage,
    setTimeout: () => { env.timers++; return 0; },
    Date: { now: () => env.now },
    Number, String, Math,
  };
  runInNewContext(SCRIPT, sandbox);
  return { played: win.__PHYLAX_LOADER__ as boolean, gate: win.__PHYLAX_LOADER_GATE__ as LoaderGate };
}

let env: Env;
beforeEach(() => {
  env = { now: Date.UTC(2026, 9, 20, 12, 0, 0), storage: new FakeStorage(), reduceMotion: false, classes: new Set(), timers: 0 };
});

describe("loader gate: the inline script", () => {
  it("was found in index.html", () => {
    expect(SCRIPT).toContain("__PHYLAX_LOADER_GATE__");
  });
});

describe("30-minute cooldown on a document load", () => {
  it("plays on the first visit and covers the page until the app takes over", () => {
    const { played } = loadDocument(env, "/dashboard");
    expect(played).toBe(true);
    expect(env.classes.has("phylax-loading") && env.classes.has("phylax-hold")).toBe(true);
    expect(env.timers).toBe(1); // the 8 s safety net
  });

  it("is suppressed on a reload or revisit of the same page within 30 minutes", () => {
    loadDocument(env, "/dashboard");
    for (const minutes of [0, 1, 10, 29]) {
      env.now += minutes === 0 ? 0 : MIN;
      expect(loadDocument(env, "/dashboard").played).toBe(false);
    }
    expect(env.classes.size).toBe(0); // and it leaves no cover behind
  });

  it("plays again once 30 minutes have passed, on a reload in the very same tab", () => {
    loadDocument(env, "/dashboard");
    env.now += 30 * MIN - 1;
    expect(loadDocument(env, "/dashboard").played).toBe(false); // 1 ms short
    env.now += 1;
    expect(loadDocument(env, "/dashboard").played).toBe(true); // exactly 30 minutes
  });

  it("measures the window from the last time it PLAYED, not from the last visit", () => {
    loadDocument(env, "/dashboard"); // t = 0, plays
    env.now += 25 * MIN;
    expect(loadDocument(env, "/dashboard").played).toBe(false); // t = 25, a quiet visit must not extend the window
    env.now += 6 * MIN;
    expect(loadDocument(env, "/dashboard").played).toBe(true); // t = 31
  });

  it("starts the next window when it plays again", () => {
    loadDocument(env, "/dashboard");
    env.now += 31 * MIN;
    expect(loadDocument(env, "/dashboard").played).toBe(true);
    env.now += 29 * MIN;
    expect(loadDocument(env, "/dashboard").played).toBe(false);
  });

  it("keeps a separate timer for every page", () => {
    expect(loadDocument(env, "/dashboard").played).toBe(true);
    expect(loadDocument(env, "/account").played).toBe(true); // /dashboard's timer does not cover /account
    expect(loadDocument(env, "/").played).toBe(true);
    expect(loadDocument(env, "/dashboard").played).toBe(false);
    expect(loadDocument(env, "/account").played).toBe(false);
    env.now += 20 * MIN;
    expect(loadDocument(env, "/shifts").played).toBe(true); // a page first opened now has its own, fresh window
    env.now += 11 * MIN; // /dashboard, /account and / are now 31 minutes old, /shifts is 11
    expect(loadDocument(env, "/dashboard").played).toBe(true);
    expect(loadDocument(env, "/shifts").played).toBe(false);
  });

  it("covers any route, with no list to maintain", () => {
    for (const path of ["/a-route-added-next-year", "/reset-password", "/terms", "/privacy"]) {
      expect(loadDocument(env, path).played).toBe(true);
      expect(loadDocument(env, path).played).toBe(false);
    }
  });

  it("treats case and a trailing slash as the same page, as the router does", () => {
    loadDocument(env, "/Dashboard/");
    expect(loadDocument(env, "/dashboard").played).toBe(false);
    expect(loadDocument(env, "/DASHBOARD//").played).toBe(false);
  });

  it("still honours stamps stored under the old key names", () => {
    env.storage.setItem("phylax:loader:last", String(env.now - 5 * MIN));
    env.storage.setItem("phylax:loader:dashboard:last", String(env.now - 40 * MIN));
    expect(loadDocument(env, "/").played).toBe(false);
    expect(loadDocument(env, "/dashboard").played).toBe(true);
  });

  it("ignores the old per-tab session flag", () => {
    // Old builds left phylax:loader = "1" in sessionStorage. The gate no longer reads session state at all (the
    // sandbox above has no sessionStorage either, so any use would throw and the tests above would fail).
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("sessionStorage");
  });

  it("treats a stamp from the future (clock changed) as expired", () => {
    env.storage.setItem("phylax:loader:dashboard:last", String(env.now + 5 * MIN));
    expect(loadDocument(env, "/dashboard").played).toBe(true);
  });

  it("treats a garbage stamp as expired", () => {
    env.storage.setItem("phylax:loader:dashboard:last", "not a number");
    expect(loadDocument(env, "/dashboard").played).toBe(true);
  });

  it("never plays for reduced motion, and does not start a window it did not use", () => {
    env.reduceMotion = true;
    expect(loadDocument(env, "/dashboard").played).toBe(false);
    expect(env.storage.keys()).toEqual([]);
    env.reduceMotion = false;
    expect(loadDocument(env, "/dashboard").played).toBe(true);
  });

  it("skips the loader when storage is unavailable (a load could not be kept to the cooldown)", () => {
    env.storage.broken = true;
    expect(loadDocument(env, "/dashboard").played).toBe(false);
    expect(env.classes.size).toBe(0);
  });
});

describe("page switch (forced)", () => {
  it("plays every time, even for pages inside their cooldown", () => {
    const { gate } = loadDocument(env, "/dashboard");
    expect(gate.shouldPlay("/account", true)).toBe(true);
    expect(gate.shouldPlay("/dashboard", true)).toBe(true); // played 0 minutes ago, still plays
    expect(gate.shouldPlay("/account", true)).toBe(true);
    env.now += 1000;
    expect(gate.shouldPlay("/", true)).toBe(true);
  });

  it("works for a route nobody has configured", () => {
    const { gate } = loadDocument(env, "/");
    expect(gate.shouldPlay("/some/future/page", true)).toBe(true);
  });

  it("does not run in the cooldown path: the same call with force off is suppressed", () => {
    const { gate } = loadDocument(env, "/dashboard");
    expect(gate.shouldPlay("/dashboard", false)).toBe(false);
  });

  it("never plays for reduced motion", () => {
    const { gate } = loadDocument(env, "/dashboard");
    env.reduceMotion = true;
    expect(gate.shouldPlay("/account", true)).toBe(false);
  });

  it("plays even if storage is unavailable, because a switch does not depend on the cooldown", () => {
    const { gate } = loadDocument(env, "/dashboard");
    env.storage.broken = true;
    expect(gate.shouldPlay("/account", true)).toBe(true);
  });
});

describe("cooldown state survives page switches (reloads and installed-app launches still obey it)", () => {
  it("a page reached by switching is quiet on reload for the next 30 minutes, then plays", () => {
    const { gate } = loadDocument(env, "/dashboard"); // t = 0
    env.now += 5 * MIN;
    expect(gate.shouldPlay("/account", true)).toBe(true); // switch to /account at t = 5
    env.now += 10 * MIN;
    expect(loadDocument(env, "/account").played).toBe(false); // reload at t = 15: within 30 of the switch
    env.now += 20 * MIN;
    expect(loadDocument(env, "/account").played).toBe(true); // reload at t = 35: 30 minutes since it played at t = 5
  });

  it("a switch back to a page refreshes its window", () => {
    const { gate } = loadDocument(env, "/dashboard"); // t = 0
    env.now += 20 * MIN;
    gate.shouldPlay("/dashboard", true); // t = 20: the loader plays again
    env.now += 20 * MIN;
    expect(loadDocument(env, "/dashboard").played).toBe(false); // t = 40: 20 minutes after the last play
    env.now += 11 * MIN;
    expect(loadDocument(env, "/dashboard").played).toBe(true); // t = 51: 31 minutes after the last play
  });

  it("a switch to one page leaves every other page's timer alone", () => {
    const { gate } = loadDocument(env, "/dashboard"); // t = 0
    env.now += 10 * MIN;
    gate.shouldPlay("/account", true);
    gate.shouldPlay("/shifts", true);
    env.now += 21 * MIN; // t = 31: /dashboard is expired, the other two are not
    expect(loadDocument(env, "/dashboard").played).toBe(true);
    expect(loadDocument(env, "/account").played).toBe(false);
    expect(loadDocument(env, "/shifts").played).toBe(false);
  });

  it("a switch never extends the cooldown of a page it did not target", () => {
    const { gate } = loadDocument(env, "/dashboard"); // t = 0
    env.now += 29 * MIN;
    gate.shouldPlay("/account", true);
    env.now += 2 * MIN; // t = 31
    expect(loadDocument(env, "/dashboard").played).toBe(true);
  });
});

describe("storage housekeeping", () => {
  it("sweeps expired stamps of other pages when a new one is written, and nothing else", () => {
    env.storage.setItem("theme", "dark");
    env.storage.setItem("phylax:demo:accounts", "{}");
    const { gate } = loadDocument(env, "/dashboard");
    gate.shouldPlay("/old-page", true);
    env.now += 31 * MIN;
    gate.shouldPlay("/new-page", true);
    expect(env.storage.keys().sort()).toEqual(["phylax:demo:accounts", "phylax:loader:new-page:last", "theme"]);
  });

  it("keeps stamps that are still inside their window", () => {
    const { gate } = loadDocument(env, "/dashboard");
    env.now += 10 * MIN;
    gate.shouldPlay("/account", true);
    expect(env.storage.keys().sort()).toEqual(["phylax:loader:account:last", "phylax:loader:dashboard:last"]);
  });
});

describe("routeOf", () => {
  it("normalises like the router", () => {
    const { gate } = loadDocument(env, "/");
    expect(gate.routeOf("/")).toBe("/");
    expect(gate.routeOf("")).toBe("/");
    expect(gate.routeOf("///")).toBe("/");
    expect(gate.routeOf("/Dashboard/")).toBe("/dashboard");
    expect(gate.routeOf("/a/B")).toBe("/a/b");
  });
});
