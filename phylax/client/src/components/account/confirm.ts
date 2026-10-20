/**
 * The one place the account page asks "are you sure?". Every call site awaits it, so swapping the native prompt for a
 * styled dialog (picker/Modal.tsx, which would need a host element and the picker styles ported to the dark page) is a
 * change to this file only: resolve true to go ahead, false to stop.
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  return window.confirm(message);
}
