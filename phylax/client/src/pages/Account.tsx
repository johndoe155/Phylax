import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import "../account.css";
import "../timezone-picker.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { useAuth } from "@/hooks/useAuth";
import { getCurrentAccount, signOut } from "@/lib/auth";
import { DEFAULT_META, reauthRemaining, SIGN_IN_AGAIN_URL, type AccountMeta, type AccountProfile } from "@/lib/account";
import { getAccountMeta, getProfile } from "@/lib/accountApi";
import { AcButton, AcLinkButton, Chip } from "@/components/account/controls";
import { AccountProvider, isAbort, messageFor, useActionRunner } from "@/components/account/context";
import { ToastProvider } from "@/components/account/toasts";
import { TermsSection } from "@/components/account/TermsSection";
import { NotificationsSection } from "@/components/account/NotificationsSection";
import { ContactSection } from "@/components/account/ContactSection";
import { IdentitySection } from "@/components/account/IdentitySection";
import { PasskeysSection } from "@/components/account/PasskeysSection";
import { ReauthSection } from "@/components/account/ReauthSection";
import { DevicesSection } from "@/components/account/DevicesSection";
import { HistorySection } from "@/components/account/HistorySection";
import { DataSection } from "@/components/account/DataSection";

const DASHBOARD_URL = "/dashboard";
const NAV = [
  { id: "ac-terms", no: "01", name: "Terms & privacy" },
  { id: "ac-notify", no: "02", name: "Notifications" },
  { id: "ac-contact", no: "03", name: "Contact" },
  { id: "ac-identity", no: "04", name: "Name & password" },
  { id: "ac-passkeys", no: "05", name: "Passkeys" },
  { id: "ac-reauth", no: "06", name: "Confirm it's you" },
  { id: "ac-devices", no: "07", name: "Devices" },
  { id: "ac-history", no: "08", name: "History" },
  { id: "ac-data", no: "09", name: "Your data" },
] as const;

const Accent = ({ children }: { children: string }) => <span className="accent-word">{children}</span>;
const Eyebrow = ({ children }: { children: string }) => <div className="section-eyebrow"><span className="eyebrow-dot" />{children}</div>;

/** The site's own nav (index.css .global-nav), exactly as the landing page and the Dashboard draw it. */
function Shell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="site-shell ac">
      <div className="grain" aria-hidden="true" />
      <header className="global-nav">
        <Link href="/" className="brand-lockup" aria-label="Phylax home"><PhylaxMark /><span className="brand-name">Phylax</span></Link>
        <div className="nav-center">Account</div>
        {actions ? <div className="nav-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

function SignedOut() {
  return (
    <Shell>
      <main className="ac-main ac-main-out dark-section">
        <div className="ac-inner">
          <Eyebrow>Account & alerts</Eyebrow>
          <h1 className="display-heading ac-title"><span className="ac-title-line">ACCOUNT</span><br /><Accent>& ALERTS</Accent></h1>
          <div className="visual ac-out">
            <div className="v-head"><span>Signed out</span><span>Locked</span></div>
            <p className="v-title ac-out-title">Sign in to manage your account.</p>
            <div><AcLinkButton variant="solid" href={SIGN_IN_AGAIN_URL}>Go to sign in</AcLinkButton></div>
          </div>
        </div>
      </main>
    </Shell>
  );
}

function SignedIn() {
  const account = getCurrentAccount();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [meta, setMeta] = useState<AccountMeta>(DEFAULT_META);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [active, setActive] = useState<string>(NAV[0].id);
  const [signingOut, setSigningOut] = useState(false);
  const watchUntil = useRef(0);
  const rail = useRef<HTMLElement>(null);

  const goToReauth = useCallback(() => {
    const el = document.getElementById("ac-reauth");
    el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    window.setTimeout(() => document.getElementById("ac-reauth-title")?.focus({ preventScroll: true }), 450);
  }, []);
  const { run, stateOf } = useActionRunner(goToReauth);

  const load = useCallback((signal?: AbortSignal) => {
    setLoadError(null);
    Promise.all([getAccountMeta(signal), getProfile(signal)])
      .then(([m, p]) => { setMeta(m); setProfile(p); })
      .catch((e: unknown) => { if (!isAbort(e)) setLoadError(messageFor(e)); });
  }, []);
  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort(); }, [load]);

  // Quiet refresh: what changed elsewhere (a link opened in another tab) shows up without a reload.
  const refreshProfile = useCallback(() => { getProfile(undefined, true).then(setProfile).catch(() => { /* keep what is shown */ }); }, []);
  const watchProfile = useCallback((ms: number) => { watchUntil.current = Date.now() + ms; }, []);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshProfile(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => { if (Date.now() < watchUntil.current) refreshProfile(); }, 3000);
    return () => { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); window.clearInterval(timer); };
  }, [refreshProfile]);

  // The re-authentication countdown only ticks while there is time on it.
  const until = profile?.reauthUntil ?? null;
  useEffect(() => {
    setNow(Date.now());
    if (reauthRemaining(until) <= 0) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  const reauthLeft = reauthRemaining(until, now);

  // Scroll-spy for the index.
  useEffect(() => {
    if (!profile) return;
    const els = NAV.map((n) => document.getElementById(n.id)).filter((el): el is HTMLElement => !!el);
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-25% 0px -65% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [profile]);
  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    if (el && rail.current && rail.current.scrollWidth > rail.current.clientWidth) rail.current.scrollTo({ left: el.offsetLeft - 20, behavior: "smooth" });
  }, [active]);

  const leave = async () => {
    setSigningOut(true);
    try { await signOut(); } catch { setSigningOut(false); }
  };

  const ctx = useMemo(() => profile ? {
    profile, meta, run, stateOf, goToReauth, reauthLeft, refreshProfile, watchProfile, applyProfile: setProfile,
  } : null, [profile, meta, run, stateOf, goToReauth, reauthLeft, refreshProfile, watchProfile]);

  const actions = (
    <>
      <Link href={DASHBOARD_URL} className="nav-store ac-nav-back"><ArrowLeft size={14} aria-hidden="true" />Dashboard</Link>
      <button type="button" className="nav-store ac-nav-out" onClick={leave} disabled={signingOut} aria-busy={signingOut || undefined}>{signingOut ? "Signing out" : "Sign out"}</button>
    </>
  );

  return (
    <Shell actions={actions}>
      <main className="ac-main dark-section">
        <div className="ac-inner">
          <Eyebrow>Account & alerts</Eyebrow>
          <div className="ac-top">
            <h1 className="display-heading ac-title"><span className="ac-title-line">ACCOUNT</span><br /><Accent>& ALERTS</Accent></h1>
            <div className="ac-meta">
              <div className="calendar-meta"><span>SIGNED IN AS</span><span className="ac-meta-name">{profile?.displayName ?? account?.displayName ?? ""}</span></div>
              {profile ? <div className="ac-meta-chips"><Chip tone={profile.email.verified ? "on" : "off"}>{profile.email.verified ? "Email verified" : "Email not verified"}</Chip></div> : null}
            </div>
          </div>

          {loadError ? (
            <div className="visual ac-out" role="alert">
              <div className="v-head"><span>Couldn't load</span><span>Offline?</span></div>
              <p className="v-text">{loadError}</p>
              <div><AcButton variant="solid" onClick={() => load()}>Try again</AcButton></div>
            </div>
          ) : !ctx ? (
            <div className="ac-loading" aria-busy="true" aria-label="Loading your account"><span className="ac-skel" /><span className="ac-skel" /><span className="ac-skel" /></div>
          ) : (
            <div className="ac-layout">
              <nav className="ac-index" aria-label="Sections" ref={rail}>
                {NAV.map((n) => (
                  <a key={n.id} data-id={n.id} href={`#${n.id}`} className="ac-index-link" data-on={active === n.id || undefined} aria-current={active === n.id ? "location" : undefined}
                    onClick={(e) => { e.preventDefault(); document.getElementById(n.id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); history.replaceState(null, "", `#${n.id}`); }}>
                    <span className="ac-index-no">{n.no}</span><span className="ac-index-name">{n.name}</span>
                  </a>
                ))}
              </nav>
              <AccountProvider value={ctx}>
                <div className="ac-content">
                  <TermsSection /><NotificationsSection /><ContactSection /><IdentitySection /><PasskeysSection />
                  <ReauthSection /><DevicesSection /><HistorySection /><DataSection />
                </div>
              </AccountProvider>
            </div>
          )}
        </div>
      </main>
    </Shell>
  );
}

export default function Account() {
  const { status, isAuthenticated } = useAuth();
  if (status === "loading") return <Shell><main className="ac-main dark-section" aria-busy="true" /></Shell>;
  if (!isAuthenticated) return <SignedOut />;
  return <ToastProvider><SignedIn /></ToastProvider>;
}
