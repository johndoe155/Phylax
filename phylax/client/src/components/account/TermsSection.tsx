import { useId, type FormEvent } from "react";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";
import { formatWhen } from "@/lib/account";
import { saveConsent } from "@/lib/accountApi";
import { AcButton, AcCheck, Chip, Group, Hint, Section } from "./controls";
import { useAccount, useDraft } from "./context";
import { IconArrowUpRight } from "./icons";

/** 01. The policy version in force and the person's acceptance of it. */
export function TermsSection() {
  const { profile, meta, applyProfile, run, stateOf } = useAccount();
  const version = meta.policyVersion;
  const accepted = profile.consent.version === version;
  const { draft: checked, setDraft: setChecked } = useDraft(accepted);
  const hintId = useId();

  const status = accepted
    ? `Accepted ${formatWhen(profile.consent.acceptedAt ?? "")}`
    : profile.consent.version
      ? `You accepted an earlier version (${profile.consent.version}). Please accept the current one.`
      : "Not accepted yet.";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!checked || accepted) return;
    const result = await run("consent", (signal) => saveConsent(version, signal), { success: "Policy consent saved." });
    if (result.ok) applyProfile(result.value);
  };

  return (
    <Section id="ac-terms" no="01" title="Terms & privacy" lead="The version of the Terms and Privacy notice that applies to your account, and your agreement to it.">
      <Group label="Current policy" aside={<Chip tone={accepted ? "on" : "off"}>{accepted ? "Accepted" : "Needs acceptance"}</Chip>}>
        <div className="ac-version">
          <span className="ac-version-label">Policy version</span>
          <strong className="ac-version-value" data-testid="policy-version">{version}</strong>
        </div>
        <ul className="ac-docs">
          <li><a className="ac-doc" href={TERMS_URL} target="_blank" rel="noopener noreferrer"><span className="ac-doc-text"><span className="ac-doc-name">Terms of use</span><span className="ac-doc-desc">What you can expect from Phylax, and what we expect of you.</span></span><IconArrowUpRight /></a></li>
          <li><a className="ac-doc" href={PRIVACY_URL} target="_blank" rel="noopener noreferrer"><span className="ac-doc-text"><span className="ac-doc-name">Privacy notice</span><span className="ac-doc-desc">What we keep, why, and how to take it with you.</span></span><IconArrowUpRight /></a></li>
        </ul>
      </Group>
      <form className="ac-form" onSubmit={submit} noValidate>
        <AcCheck checked={checked} onChange={setChecked} label="I accept the Terms and Privacy notice" describedBy={hintId} />
        <Hint id={hintId}>{status}</Hint>
        <AcButton type="submit" variant="solid" state={stateOf("consent")} disabled={!checked || accepted}>Save policy consent</AcButton>
      </form>
    </Section>
  );
}
