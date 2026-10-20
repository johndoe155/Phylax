import { useEffect, useState } from "react";
import { Route, Switch } from "wouter";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Account from "./pages/Account";
import ManageShifts from "./pages/ManageShifts";
import Legal from "./pages/Legal";
import Recovery from "./pages/Recovery";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import NotFound from "./pages/NotFound";
import PageLoader from "./components/PageLoader";
import { RequireSession } from "./components/RequireSession";
import { hydrateSession } from "@/lib/auth";

/**
 * The router.
 *
 * One thing happens before any route renders: `hydrateSession()` reads the session (GET /auth/session), which is also what
 * mints the CSRF cookie every mutation needs, and warms the pending sign-up so /welcome can render synchronously after an
 * email link or a provider redirect. Until it has answered, the app renders the same dark shell the pages use and nothing
 * else — the page loader is already playing over it (components/PageLoader.tsx, gated by index.html), so there is no flash
 * of the wrong state and no request made on a guess about who is signed in.
 *
 * The signed-in routes are wrapped in RequireSession, which holds them while the answer is still arriving and redirects to
 * `/login?next=…` once it is known that nobody is signed in.
 */
export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    hydrateSession()
      .catch(() => undefined) // a failure is not fatal: the pages read the session as "signed out" and say so
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <div className="site-shell" data-boot="hydrating" aria-busy="true" style={{ minHeight: "100vh" }} />;
  }

  return (
    <>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/login" component={Login} />
        <Route path="/welcome" component={Onboarding} />
        <Route path="/forgot-password" component={Recovery} />
        <Route path="/reset-password" component={Recovery} />
        <Route path="/confirm-email" component={Recovery} />
        <Route path="/redeem-link" component={Recovery} />
        <Route path="/dashboard">{() => <RequireSession><Dashboard /></RequireSession>}</Route>
        <Route path="/shifts">{() => <RequireSession><ManageShifts /></RequireSession>}</Route>
        {/*
          The account page is NOT wrapped in RequireSession: it draws its own signed-out card ("Sign in to manage your
          account") and its own busy shell while the session is loading, so redirecting would replace the one page that
          explains why you are not signed in. It guards itself the same way this gate does.
        */}
        <Route path="/account" component={Account} />
        {/* One page, two documents: Legal reads the path to pick which. */}
        <Route path="/terms" component={Legal} />
        <Route path="/privacy" component={Legal} />
        <Route component={NotFound} />
      </Switch>
      {/* Mounted at the app root, outside the router, so navigating never remounts it. It plays on every switch to a different route (see PageLoader), for every route above and any added later. */}
      <PageLoader />
    </>
  );
}
