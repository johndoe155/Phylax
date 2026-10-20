import { useId, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import type { Provider } from "@/lib/auth";
import { OAUTH_ENABLED, OAUTH_START, PASSWORD_MIN, type AccountProfile, REAUTH_MINUTES, SIGN_IN_AGAIN_URL, formatCountdown } from "@/lib/account";
import { reauthWithPasskey, reauthWithPassword, removeEmail, removePassword, sendReauthLink, unlinkProvider } from "@/lib/accountApi";
import { IconApple, IconFingerprint, IconGoogle, IconMail } from "@/components/login/icons";
import { AcButton, AcEye, AcField, AcLinkButton, Chip, Group, Hint, Section } from "./controls";
import { confirmAction } from "./confirm";
import { inlineMessage, useAccount } from "./context";
import { useToast } from "./toasts";
import { IconKey } from "./icons";

const PROVIDERS: { id: Provider; name: string; icon: ReactNode }[] = [
  { id: "google", name: "Google", icon: <IconGoogle /> },
  { id: "apple", name: "Apple", icon: <IconApple /> },
];

const REAUTH_MS = REAUTH_MINUTES * 60_000;

/** 06. Prove it's still the person (unlocks the sensitive changes for a few minutes), and manage the other ways of signing in. */
export function ReauthSection() {
  const { profile, applyProfile, watchProfile, run, stateOf, reauthLeft } = useAccount();
  const active = reauthLeft > 0;
  const hasPasskey = profile.passkeys.length > 0;
  const canMail = profile.email.verified;
  const passkeysSupported = typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";

  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);
  const hint = useId();
  const toast = useToast();

  const granted = `Reauthenticated for ${REAUTH_MINUTES} minutes.`;

  const confirmPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < PASSWORD_MIN) { setPasswordError("Enter your current password."); return; }
    setPasswordError(null);
    const result = await run("reauth-password", (signal) => reauthWithPassword(password, signal), { success: granted, quiet: true });
    if (result.ok) { applyProfile(result.value); setPassword(""); setShow(false); }
    else setPasswordError(inlineMessage(result.error));
  };

  const confirmPasskey = async () => {
    const result = await run("reauth-passkey", (signal) => reauthWithPasskey(signal), { success: granted });
    if (result.ok) applyProfile(result.value);
  };

  const sendLink = async () => {
    const result = await run("reauth-link", (signal) => sendReauthLink(signal), { success: "Confirmation link sent." });
    if (result.ok) { applyProfile(result.value); setLinkSent(true); watchProfile(3 * 60_000); }
  };

  // Until the OAuth endpoint exists the link would land on NotFound, so say so instead. Once OAUTH_ENABLED is true the <a> follows its href.
  const linkProvider = (name: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (OAUTH_ENABLED) return;
    event.preventDefault();
    toast({ tone: "info", message: `Linking ${name} isn't connected yet. Check back soon.` });
  };

  const guarded = async (key: string, confirmText: string, task: (signal: AbortSignal) => Promise<AccountProfile>, success: string) => {
    if (!(await confirmAction(confirmText))) return;
    const result = await run(key, task, { success });
    if (result.ok) applyProfile(result.value);
  };

  return (
    <Section id="ac-reauth" no="06" title="Confirm it's you" lead={`Removing a way to sign in, or changing your email, needs a fresh confirmation. Confirm once and it stays unlocked for ${REAUTH_MINUTES} minutes.`}>
      <Group label="Reauthentication" aside={<Chip tone={active ? "on" : "off"}>{active ? "Unlocked" : "Locked"}</Chip>}>
        <div className="ac-reauth" data-active={active || undefined} role="status" aria-live="polite">
          <div className="ac-reauth-text">
            <span className="ac-reauth-title">{active ? `Reauthenticated for ${REAUTH_MINUTES} minutes` : "Not confirmed recently"}</span>
            <span className="ac-reauth-sub">{active ? <><span className="ac-count">{formatCountdown(reauthLeft)}</span> left before it locks again.</> : "Use one of the methods below to unlock sensitive changes."}</span>
          </div>
          <div className="ac-reauth-bar" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, reauthLeft / REAUTH_MS)})` }} /></div>
        </div>

        <ul className="ac-methods">
          <li className="ac-method">
            <span className="ac-method-icon" aria-hidden="true"><IconKey /></span>
            <form className="ac-method-body" onSubmit={confirmPassword} noValidate>
              <div className="ac-method-copy">
                <span className="ac-method-name">Password</span>
                <span className="ac-method-desc">{profile.hasPassword ? "Type the password you sign in with." : "This account has no password yet. Add one in Name & password."}</span>
              </div>
              {profile.hasPassword ? (
                <div className="ac-row">
                  <div className="ac-cell">
                    <AcField label="Current password" type={show ? "text" : "password"} autoComplete="current-password" value={password} onValueChange={(v) => { setPassword(v); if (passwordError) setPasswordError(null); }} invalid={!!passwordError} hintId={hint} trailing={<AcEye shown={show} onToggle={() => setShow((s) => !s)} />} />
                    <Hint id={hint} error={passwordError} />
                  </div>
                  <AcButton type="submit" variant="solid" className="ac-row-tall" state={stateOf("reauth-password")}>Confirm current password</AcButton>
                </div>
              ) : (
                <AcButton variant="solid" disabled>Confirm current password</AcButton>
              )}
            </form>
          </li>
          <li className="ac-method">
            <span className="ac-method-icon" aria-hidden="true"><IconFingerprint /></span>
            <div className="ac-method-body">
              <div className="ac-method-copy">
                <span className="ac-method-name">Passkey</span>
                <span className="ac-method-desc">{!hasPasskey ? "Add a passkey in Passkeys to use this." : !passkeysSupported ? "This browser can't use passkeys." : "Use your fingerprint, face or screen lock."}</span>
              </div>
              <AcButton variant="solid" state={stateOf("reauth-passkey")} onClick={confirmPasskey} disabled={!hasPasskey || !passkeysSupported}>Confirm with a passkey</AcButton>
            </div>
          </li>
          <li className="ac-method">
            <span className="ac-method-icon" aria-hidden="true"><IconMail /></span>
            <div className="ac-method-body">
              <div className="ac-method-copy">
                <span className="ac-method-name">Email link</span>
                <span className="ac-method-desc">{!canMail ? "Verify your email address to use this." : linkSent ? `Link sent to ${profile.email.address}. Open it and this page will update.` : `We'll email ${profile.email.address} a link to confirm it's you.`}</span>
              </div>
              <AcButton variant="solid" state={stateOf("reauth-link")} onClick={sendLink} disabled={!canMail}>Send an email confirmation link</AcButton>
            </div>
          </li>
        </ul>
      </Group>

      <Group label="Linked sign-ins">
        <ul className="ac-links">
          {PROVIDERS.map(({ id, name, icon }) => {
            const linked = profile.providers.includes(id);
            const key = `unlink-${id}`;
            return (
              <li className="ac-link-row" key={id}>
                <span className="ac-link-icon" aria-hidden="true">{icon}</span>
                <span className="ac-link-text"><span className="ac-link-name">{name}</span><span className="ac-link-state">{linked ? "Linked" : "Not linked"}</span></span>
                {linked ? (
                  <AcButton variant="danger" size="sm" state={stateOf(key)} onClick={() => guarded(key, `Unlink ${name}? You won't be able to sign in with ${name} until you link it again.`, (signal) => unlinkProvider(id, signal), `${name} unlinked.`)}>{`Unlink ${name}`}</AcButton>
                ) : (
                  <AcLinkButton size="sm" href={OAUTH_START(id)} onClick={linkProvider(name)}>{`Link ${name}`}</AcLinkButton>
                )}
              </li>
            );
          })}
          <li className="ac-link-row">
            <span className="ac-link-icon" aria-hidden="true"><IconKey /></span>
            <span className="ac-link-text"><span className="ac-link-name">Password</span><span className="ac-link-state">{profile.hasPassword ? "Set" : "Not set"}</span></span>
            {profile.hasPassword ? (
              <AcButton variant="danger" size="sm" state={stateOf("remove-password")} onClick={() => guarded("remove-password", "Remove your password? You'll need another way to sign in.", (signal) => removePassword(signal), "Password removed.")}>Remove password</AcButton>
            ) : null}
          </li>
          <li className="ac-link-row">
            <span className="ac-link-icon" aria-hidden="true"><IconMail /></span>
            <span className="ac-link-text"><span className="ac-link-name">{profile.email.address ?? "Email"}</span><span className="ac-link-state">{profile.email.address ? (profile.email.verified ? "Verified" : "Not verified") : "None"}</span></span>
            {profile.email.address ? (
              <AcButton variant="danger" size="sm" state={stateOf("remove-email")} onClick={() => guarded("remove-email", "Remove your email address? Email alerts will be turned off.", (signal) => removeEmail(signal), "Email removed. Email alerts are off.")}>Remove email</AcButton>
            ) : null}
          </li>
        </ul>
        <div className="ac-actions">
          <AcLinkButton variant="ghost" href={SIGN_IN_AGAIN_URL}>Sign in again with another method</AcLinkButton>
        </div>
      </Group>
    </Section>
  );
}
