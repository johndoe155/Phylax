import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { PHONE_CODE_LENGTH, isE164, normalizePhone } from "@/lib/account";
import { changeEmail, sendEmailVerification, sendPhoneCode, verifyPhone } from "@/lib/accountApi";
import { AcButton, AcField, Chip, Group, Hint, Section, Warning } from "./controls";
import { inlineMessage, useAccount } from "./context";
import { Turnstile } from "./Turnstile";

const RESEND_SECONDS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 03. Prove the email address and the phone number belong to the person. */
export function ContactSection() {
  const { profile, meta, applyProfile, watchProfile, run, stateOf } = useAccount();
  const { email, phone } = profile;

  // ---- Email ----
  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailHint = useId();

  // The "sent" note is about one address; once it is verified, or changed, it no longer applies.
  useEffect(() => { if (email.verified || (sentTo && email.address !== sentTo)) setSentTo(null); }, [email.verified, email.address, sentTo]);

  const sendVerification = async () => {
    const result = await run("email-verify", (signal) => sendEmailVerification(signal), { success: "Verification email sent." });
    if (result.ok) { applyProfile(result.value); setSentTo(result.value.email.address); watchProfile(5 * 60_000); }
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    const next = newEmail.trim();
    if (!EMAIL_RE.test(next)) { setEmailError("Enter a valid email address."); return; }
    setEmailError(null);
    const result = await run("email-change", (signal) => changeEmail(next, signal), { success: "Email address changed. Verify it to use it for alerts.", quiet: true });
    if (result.ok) { applyProfile(result.value); setNewEmail(""); }
    else setEmailError(inlineMessage(result.error));
  };

  // ---- Phone ----
  const [number, setNumber] = useState(phone.pending ?? phone.number ?? "");
  const [code, setCode] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [challenge, setChallenge] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const phoneHint = useId();
  const codeHint = useId();
  const siteKey = meta.turnstileSiteKey;
  const lastServerNumber = useRef(phone.pending ?? phone.number ?? "");

  // Follow the server's number when it changes underneath us (verified elsewhere), but never overwrite what is being typed.
  useEffect(() => {
    const server = phone.pending ?? phone.number ?? "";
    if (server !== lastServerNumber.current) { lastServerNumber.current = server; setNumber(server); }
  }, [phone.pending, phone.number]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const normalized = normalizePhone(number);
  const sameAsVerified = phone.verified && normalized === phone.number;
  const needsToken = !!siteKey && !token;

  const submitPhone = async (event: FormEvent) => {
    event.preventDefault();
    if (!isE164(normalized)) { setPhoneError("Use the international format: a +, the country code, then the number. For example +14155550123."); return; }
    if (needsToken) { setPhoneError("Complete the security check first."); return; }
    setPhoneError(null);
    const result = await run("phone-send", (signal) => sendPhoneCode(normalized, token, signal), { success: `Code sent to ${normalized}.`, quiet: true });
    if (result.ok) {
      applyProfile(result.value);
      setCooldown(RESEND_SECONDS);
      setCode("");
      setCodeError(null);
      if (siteKey) { setToken(null); setChallenge((n) => n + 1); } // a token is good for one request
    } else setPhoneError(inlineMessage(result.error));
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== PHONE_CODE_LENGTH) { setCodeError(`Enter the ${PHONE_CODE_LENGTH}-digit code.`); return; }
    setCodeError(null);
    const result = await run("phone-verify", (signal) => verifyPhone(code, signal), { success: "Phone number verified.", quiet: true });
    if (result.ok) { applyProfile(result.value); setCode(""); }
    else setCodeError(inlineMessage(result.error));
  };

  return (
    <Section id="ac-contact" no="03" title="Verify contact" lead="Phylax only sends alerts to an email address or phone number you have proven is yours.">
      <Group label="Email" aside={<Chip tone={email.verified ? "on" : "off"}>{email.verified ? "Verified" : "Not verified"}</Chip>}>
        <p className="ac-value" data-empty={email.address ? undefined : ""}>{email.address ?? "No email address on this account"}</p>
        <div className="ac-actions">
          <AcButton variant="solid" state={stateOf("email-verify")} onClick={sendVerification} disabled={!email.address || email.verified}>Send verification email</AcButton>
        </div>
        {sentTo ? <p className="ac-sent" role="status"><span className="signal-dot" aria-hidden="true" />Sent to {sentTo}. Open the link in it and this page will update.</p> : null}

        <Warning title="Before you verify">
          The first time an email address is verified, Phylax wipes any provisional passwords, passkeys and existing sessions that were created before it. You will need to sign in again and set them up afterwards.
        </Warning>

        <form className="ac-form ac-form-tight" onSubmit={submitEmail} noValidate>
          <div className="ac-row">
            <div className="ac-cell">
              <AcField label="New email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={newEmail} onValueChange={(v) => { setNewEmail(v); if (emailError) setEmailError(null); }} invalid={!!emailError} hintId={emailHint} />
              <Hint id={emailHint} error={emailError}>A changed address starts out unverified.</Hint>
            </div>
            <AcButton type="submit" className="ac-row-tall" state={stateOf("email-change")} disabled={!newEmail.trim()}>Change email</AcButton>
          </div>
        </form>
      </Group>

      <Group label="Phone" aside={<Chip tone={phone.verified ? "on" : "off"}>{phone.verified ? "Verified" : "Not verified"}</Chip>}>
        <p className="ac-value" data-empty={phone.number || phone.pending ? undefined : ""}>
          {phone.pending ? <>Code sent to {phone.pending}</> : phone.number ?? "No phone number on this account"}
        </p>
        <form className="ac-form ac-form-tight" onSubmit={submitPhone} noValidate>
          <div className="ac-row">
            <div className="ac-cell">
              <AcField label="Phone number" type="tel" inputMode="tel" autoComplete="tel" placeholder="+14155550123" mono value={number} onValueChange={(v) => { setNumber(v); if (phoneError) setPhoneError(null); }} invalid={!!phoneError} hintId={phoneHint} />
              <Hint id={phoneHint} error={phoneError}>International format, like +14155550123.</Hint>
            </div>
            <AcButton type="submit" className="ac-row-tall" state={stateOf("phone-send")} disabled={!normalized || sameAsVerified || cooldown > 0 || needsToken}>Send phone code</AcButton>
          </div>
          {siteKey ? <Turnstile key={challenge} siteKey={siteKey} onToken={setToken} /> : null}
          {cooldown > 0 ? <p className="ac-sent ac-sent-quiet" role="status">You can ask for another code in <span className="ac-count">{cooldown}s</span>.</p> : null}
        </form>

        <form className="ac-form ac-form-tight" onSubmit={submitCode} noValidate>
          <div className="ac-row">
            <div className="ac-cell">
              <AcField label="Six-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={PHONE_CODE_LENGTH} placeholder="123456" mono value={code} onValueChange={(v) => { setCode(v.replace(/\D/g, "").slice(0, PHONE_CODE_LENGTH)); if (codeError) setCodeError(null); }} invalid={!!codeError} hintId={codeHint} />
              <Hint id={codeHint} error={codeError}>{phone.pending ? `Enter the code we sent to ${phone.pending}.` : "Send a code to your number first."}</Hint>
            </div>
            <AcButton type="submit" variant="solid" className="ac-row-tall" state={stateOf("phone-verify")} disabled={code.length !== PHONE_CODE_LENGTH || !phone.pending}>Verify phone</AcButton>
          </div>
        </form>
      </Group>
    </Section>
  );
}
