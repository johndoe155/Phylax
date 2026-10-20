import { Redirect, useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";

const LOGIN_URL = "/login";

/**
 * Holds a signed-in page until the session is known, then either renders it or sends the person to sign in.
 *
 * WHY THIS EXISTS. The session is an httpOnly cookie, so "is anybody signed in?" can only be answered by the server
 * (GET /auth/session, from lib/auth.ts `hydrateAuth()` at boot). Without a gate, every one of these pages would render its
 * signed-out layout for the few hundred milliseconds before that answer arrived — the dashboard with an empty schedule, the
 * account page with its "Sign in to manage your account" card — and then swap. Holding the page is both calmer and safer:
 * no request for somebody else's data is issued on a guess.
 *
 * The gate draws nothing of its own. It reuses the dark page shell the pages already sit in, so the only thing a person sees
 * is the page loader that is already playing over it.
 *
 * `/login?next=…` is where an unauthenticated visit lands, so signing in returns the person to the page they asked for
 * (pages/Login.tsx reads `next`).
 */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const [location] = useLocation();

  if (status === "loading") {
    return <div className="site-shell" data-auth-gate="loading" aria-busy="true" style={{ minHeight: "100vh" }} />;
  }
  if (status === "unauthenticated") {
    return <Redirect to={`${LOGIN_URL}?next=${encodeURIComponent(location)}`} replace />;
  }
  return <>{children}</>;
}
