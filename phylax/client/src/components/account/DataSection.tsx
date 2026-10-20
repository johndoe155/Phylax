import { useId, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { EXPORT_FILENAME, PASSWORD_MIN } from "@/lib/account";
import { deleteAccount, exportData, finishAccountDeletion } from "@/lib/accountApi";
import { AcButton, AcEye, AcField, Group, Hint, Section } from "./controls";
import { confirmAction } from "./confirm";
import { inlineMessage, useAccount } from "./context";
import { IconDownload, IconTrash } from "./icons";

/** 09. Take the data with you, or delete the account. */
export function DataSection() {
  const { profile, run, stateOf } = useAccount();
  const [, navigate] = useLocation();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hint = useId();

  const download = async () => {
    const result = await run("export", (signal) => exportData(signal), { success: `Downloaded ${EXPORT_FILENAME}.` });
    if (!result.ok) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = EXPORT_FILENAME;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (profile.hasPassword && password.length < PASSWORD_MIN) { setError("Enter your current password to delete your account."); return; }
    if (!(await confirmAction("Delete your account? This permanently removes your account and your data, and it can't be undone."))) return;
    setError(null);
    const result = await run("delete", (signal) => deleteAccount({ password: profile.hasPassword ? password : undefined }, signal), { quiet: true });
    // Leave first, then end the session: both updates land in one render, so the page never shows "Sign in to manage your account" on its way out.
    if (result.ok) { navigate("/"); finishAccountDeletion(); }
    else setError(inlineMessage(result.error));
  };

  return (
    <Section id="ac-data" no="09" title="Your data" lead="Your data is yours: take a copy, or remove it all.">
      <Group label="Export">
        <p className="ac-fine">Everything Phylax holds for your account, as one JSON file.</p>
        <div className="ac-actions"><AcButton variant="solid" state={stateOf("export")} icon={<IconDownload />} onClick={download}>Download data</AcButton></div>
      </Group>
      <form className="ac-form" onSubmit={remove} noValidate>
        <Group label="Delete account" className="ac-danger">
          <p className="ac-fine">Deleting your account is permanent. Your shifts, settings, passkeys and sign-in methods are removed and you are signed out.</p>
          {profile.hasPassword ? (
            <>
              <AcField label="Current password" type={show ? "text" : "password"} autoComplete="current-password" value={password} onValueChange={(v) => { setPassword(v); if (error) setError(null); }} invalid={!!error} hintId={hint} trailing={<AcEye shown={show} onToggle={() => setShow((s) => !s)} />} />
              <Hint id={hint} error={error} />
            </>
          ) : <Hint id={hint} error={error} />}
          <AcButton type="submit" variant="danger" state={stateOf("delete")} icon={<IconTrash />}>Delete account</AcButton>
        </Group>
      </form>
    </Section>
  );
}
