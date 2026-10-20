import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { PASSKEY_NAME_MAX, formatDay, passkeyTypeLabel, type PasskeyInfo } from "@/lib/account";
import { addPasskey, removePasskey, renamePasskey } from "@/lib/accountApi";
import { IconFingerprint } from "@/components/login/icons";
import { AcButton, AcField, Group, Hint, Section } from "./controls";
import { confirmAction } from "./confirm";
import { inlineMessage, useAccount } from "./context";

function PasskeyRow({ passkey }: { passkey: PasskeyInfo }) {
  const { applyProfile, run, stateOf } = useAccount();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const saveKey = `pk-save-${passkey.id}`;
  const removeKey = `pk-del-${passkey.id}`;

  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);

  const open = () => { setName(passkey.name); setError(null); setEditing(true); };
  const close = () => { setEditing(false); setError(null); window.setTimeout(() => trigger.current?.focus(), 0); };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    const label = name.trim().replace(/\s+/g, " ");
    if (!label) { setError("Give the passkey a name."); return; }
    if (label === passkey.name) { close(); return; }
    const result = await run(saveKey, (signal) => renamePasskey(passkey.id, label, signal), { success: "Passkey renamed.", quiet: true });
    if (result.ok) { applyProfile(result.value); close(); }
    else setError(inlineMessage(result.error));
  };

  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };

  const remove = async () => {
    if (!(await confirmAction(`Remove the passkey "${passkey.name}"? You won't be able to sign in with it any more.`))) return;
    const result = await run(removeKey, (signal) => removePasskey(passkey.id, signal), { success: "Passkey removed." });
    if (result.ok) applyProfile(result.value);
  };

  return (
    <li className="ac-pk" data-editing={editing || undefined}>
      <div className="ac-pk-name">
        {editing ? (
          <form className="ac-pk-edit" onSubmit={save} onKeyDown={onKeyDown} noValidate>
            <AcField ref={input} label="Passkey name" maxLength={PASSKEY_NAME_MAX} value={name} onValueChange={(v) => { setName(v); if (error) setError(null); }} invalid={!!error} hintId={errorId} />
            <Hint id={errorId} error={error} />
            <div className="ac-pk-edit-actions">
              <AcButton type="submit" variant="solid" size="sm" state={stateOf(saveKey)}>Save name</AcButton>
              <AcButton size="sm" onClick={close}>Cancel</AcButton>
            </div>
          </form>
        ) : (
          <>
            <span className="ac-pk-icon" aria-hidden="true"><IconFingerprint width={20} height={20} /></span>
            <span className="ac-pk-title">{passkey.name}</span>
          </>
        )}
      </div>
      <div className="ac-pk-cell" data-label="Device type">{passkeyTypeLabel(passkey.deviceType)}</div>
      <div className="ac-pk-cell" data-label="Added"><time dateTime={passkey.createdAt}>{formatDay(passkey.createdAt)}</time></div>
      {!editing ? (
        <div className="ac-pk-actions">
          <AcButton ref={trigger} size="sm" onClick={open} aria-label={`Rename ${passkey.name}`}>Rename</AcButton>
          <AcButton variant="danger" size="sm" state={stateOf(removeKey)} onClick={remove} aria-label={`Remove ${passkey.name}`}>Remove</AcButton>
        </div>
      ) : null}
    </li>
  );
}

/** 05. Passkeys: sign in with a fingerprint, face or screen lock instead of a password. */
export function PasskeysSection() {
  const { profile, applyProfile, run, stateOf } = useAccount();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hint = useId();
  const supported = typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = await run("pk-add", (signal) => addPasskey(name, signal), { success: "Passkey added.", quiet: true });
    if (result.ok) { applyProfile(result.value); setName(""); }
    else setError(inlineMessage(result.error));
  };

  return (
    <Section id="ac-passkeys" no="05" title="Passkeys" lead="A passkey signs you in with your fingerprint, face or screen lock. There is nothing to remember and nothing to phish.">
      <form className="ac-form" onSubmit={submit} noValidate>
        <Group label="Add a passkey">
          <div className="ac-row">
            <div className="ac-cell">
              <AcField label="Name this device" maxLength={PASSKEY_NAME_MAX} placeholder="Work laptop" autoComplete="off" value={name} onValueChange={(v) => { setName(v); if (error) setError(null); }} invalid={!!error} hintId={hint} />
              <Hint id={hint} error={error ?? (supported ? null : "This browser can't create passkeys. Try another browser or device.")}>Optional. It helps you tell your passkeys apart.</Hint>
            </div>
            <AcButton type="submit" variant="solid" className="ac-row-tall" state={stateOf("pk-add")} disabled={!supported} icon={<IconFingerprint width={20} height={20} />}>Add a passkey</AcButton>
          </div>
        </Group>
      </form>

      <Group label="Your passkeys" aside={<span className="ac-count ac-count-text">{profile.passkeys.length}</span>}>
        {profile.passkeys.length === 0 ? (
          <p className="ac-empty">No passkeys yet. Add one above to sign in without a password.</p>
        ) : (
          <ul className="ac-pks" aria-label="Passkeys">
            <li className="ac-pks-head" aria-hidden="true"><span>Name</span><span>Device type</span><span>Added</span><span /></li>
            {profile.passkeys.map((passkey) => <PasskeyRow key={passkey.id} passkey={passkey} />)}
          </ul>
        )}
      </Group>
    </Section>
  );
}
