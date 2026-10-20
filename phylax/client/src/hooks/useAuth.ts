import { useSyncExternalStore } from "react";
import { getAuthStatus, subscribeToAuth, type AuthStatus } from "@/lib/auth";

export type { AuthStatus };

/**
 * Whether anyone is signed in.
 *
 * "loading" until the server has answered GET /auth/session (lib/auth.ts `hydrateAuth()`, called once at boot from
 * App.tsx). Every signed-in page waits for that answer instead of flashing a signed-out state first — the dashboard,
 * the account page and manage-shifts are held by components/RequireSession.tsx, and the "Log in" button in the nav
 * already reserves its space while loading (see components/AuthLink.tsx).
 */
export function useAuth(): { status: AuthStatus; isAuthenticated: boolean } {
  // The snapshot is a stable object owned by the auth store, so `useSyncExternalStore` can compare it with Object.is.
  const status = useSyncExternalStore(subscribeToAuth, getAuthStatus, () => "loading" as const);
  return { status, isAuthenticated: status === "authenticated" };
}
