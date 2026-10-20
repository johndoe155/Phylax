/**
 * Typed access to the page loader gate. The gate itself is the inline script in index.html: it has to run before first
 * paint, so it cannot live in the bundle, and keeping a second copy of its rules here would let the two drift apart.
 * Everything below only calls it.
 *
 * Rules (full text in index.html):
 *   - Document load (first paint, reload, an installed app launching): the loader plays only if it has not played for
 *     that page in the last 30 minutes. Each page has its own window.
 *   - Page switch (client-side navigation to a different route): the loader plays every time, for every route, with
 *     no per-route configuration, and stamps the target page so its cooldown keeps working.
 */

export interface LoaderGate {
  /** The cooldown, in milliseconds. */
  windowMs: number;
  /** Normalises a pathname into the page identity the cooldown is kept under (lower case, no trailing slash). */
  routeOf(pathname: string): string;
  /** force = false: a document load, the cooldown applies. force = true: a page switch, it does not. Stamps when it says yes. */
  shouldPlay(route: string, force: boolean): boolean;
}

declare global {
  interface Window {
    /** Set by the inline script in index.html: true only when this document load should play the loader. */
    __PHYLAX_LOADER__?: boolean;
    __PHYLAX_LOADER_GATE__?: LoaderGate;
  }
}

/** The page the browser is on now, in the gate's normalised form. */
export function currentRoute(): string {
  const pathname = window.location.pathname;
  return window.__PHYLAX_LOADER_GATE__?.routeOf(pathname) ?? (pathname.toLowerCase().replace(/\/+$/, "") || "/");
}

/**
 * Should the loader play now that the app has switched to `route`? Always yes (unless the visitor prefers reduced
 * motion), and the page's cooldown stamp is refreshed. If the gate is missing the loader stays off.
 */
export function shouldPlayOnSwitch(route: string): boolean {
  try {
    return window.__PHYLAX_LOADER_GATE__?.shouldPlay(route, true) === true;
  } catch {
    return false;
  }
}
