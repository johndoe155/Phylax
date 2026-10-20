import { useId, useState, type FormEvent } from "react";
import { AccountError, PASSWORD_MIN } from "@/lib/account";
import { saveName, setPassword } from "@/lib/accountApi";
import { DISPLAY_NAME_MAX, displayNameLength, normalizeDisplayName, validateDisplayName } from "@/lib/displayName";
import { AcButton, AcEye, AcField, Group, Hint, Section } from "./controls";
import { inlineMessage, useAccount, useDraft } from "./context";

/** 04. What Phylax calls the person, and the password they sign in with. */
export function IdentitySection() {
  const { profile, applyProfile, run, stateOf } = useAccount();

  // ---- Name ----
  const { draft: name, setDraft: setName } = useDraft(profile.displayName);
  const [nameTouched, setNameTouched] = useState(false);
  const nameHint = useId();
  const nameProblem = validateDisplayName(name);
  const nameChanged = normalizeDisplayName(name) !== profile.displayName;
  const length = displayNameLength(name);

  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    setNameTouched(true);
    if (nameProblem || !nameChanged) return;
    const result = await run("name", (signal) => saveName(name, signal), { success: "Name saved." });
    if (result.ok) { applyProfile(result.value); setNameTouched(false); }
  };

  // ---- Password ----
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const currentHint = useId();
  const nextHint = useId();
  const has = profile.hasPassword;

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    const missingCurrent = has && current.length === 0;
    const shortNext = next.length < PASSWORD_MIN;
    setCurrentError(missingCurrent ? "Enter your current password." : null);
    setNextError(shortNext ? `Use at least ${PASSWORD_MIN} characters.` : null);
    if (missingCurrent || shortNext) return;
    const result = await run("password", (signal) => setPassword({ current: has ? current : undefined, next }, signal), { success: has ? "Password changed." : "Password added.", quiet: true });
    if (result.ok) {
      applyProfile(result.value);
      setCurrent(""); setNext(""); setShowCurrent(false); setShowNext(false);
    } else {
      const message = inlineMessage(result.error);
      // The server says which input it means; without that, a failure to reach it belongs under the new password.
      const field = result.error instanceof AccountError ? result.error.field : undefined;
      if (field === "current") setCurrentError(message);
      else setNextError(message);
    }
  };

  return (
    <Section id="ac-identity" no="04" title="Name & password" lead="The name Phylax greets you with, and a password for signing in the traditional way.">
      <form className="ac-form" onSubmit={submitName} noValidate>
        <Group label="Display name" aside={<span className="ac-count" data-over={length > DISPLAY_NAME_MAX || undefined} aria-hidden="true">{length}/{DISPLAY_NAME_MAX}</span>}>
          <div className="ac-row">
            <div className="ac-cell">
              <AcField label="Display name" autoComplete="name" value={name} onValueChange={setName} onBlur={() => setNameTouched(true)} invalid={nameTouched && !!nameProblem} hintId={nameHint} />
              <Hint id={nameHint} error={nameTouched ? nameProblem ?? null : null}>Shown on your dashboard.</Hint>
            </div>
            <AcButton type="submit" variant="solid" className="ac-row-tall" state={stateOf("name")} disabled={!nameChanged || !!nameProblem}>Save name</AcButton>
          </div>
        </Group>
      </form>

      <form className="ac-form" onSubmit={submitPassword} noValidate>
        <Group label="Password" aside={<span className="ac-count ac-count-text">{has ? "Set" : "Not set"}</span>}>
          {has ? (
            <>
              <AcField label="Current password" type={showCurrent ? "text" : "password"} autoComplete="current-password" value={current} onValueChange={(v) => { setCurrent(v); if (currentError) setCurrentError(null); }} invalid={!!currentError} hintId={currentHint} trailing={<AcEye shown={showCurrent} onToggle={() => setShowCurrent((s) => !s)} />} />
              <Hint id={currentHint} error={currentError} />
            </>
          ) : null}
          <AcField label="New password" type={showNext ? "text" : "password"} autoComplete="new-password" minLength={PASSWORD_MIN} value={next} onValueChange={(v) => { setNext(v); if (nextError) setNextError(null); }} invalid={!!nextError} hintId={nextHint} trailing={<AcEye shown={showNext} onToggle={() => setShowNext((s) => !s)} />} />
          <Hint id={nextHint} error={nextError}>{`At least ${PASSWORD_MIN} characters.${has ? "" : " You have no password yet, so this adds one."}`}</Hint>
          <AcButton type="submit" variant="solid" state={stateOf("password")} disabled={next.length === 0}>{has ? "Change password" : "Add password"}</AcButton>
        </Group>
      </form>
    </Section>
  );
}
