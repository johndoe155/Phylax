import type { KeyboardEvent } from "react";

/**
 * Arrow-key travel across a grid of buttons (the container is the event's currentTarget). Left/Right step by one,
 * Up/Down by a row, Home/End jump to the ends. `activate` clicks the button it lands on, which gives radio-style
 * groups the "arrow keys choose" behaviour. Returns true when the key was handled.
 */
export function moveFocus(e: KeyboardEvent<HTMLElement>, cols: number, activate = false): boolean {
  const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : e.key === "ArrowDown" ? cols : 0;
  if (!step && e.key !== "Home" && e.key !== "End") return false;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return false;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : at + step;
  if (next < 0 || next >= items.length) return true;
  items[next].focus({ preventScroll: true });
  if (activate) items[next].click();
  return true;
}
