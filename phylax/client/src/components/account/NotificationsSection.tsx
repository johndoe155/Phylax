import { useId, useMemo, useState, type FormEvent } from "react";
import { LEAD_MAX, LEAD_MIN, describeLead, parseLeadMinutes } from "@/lib/account";
import { saveSettings } from "@/lib/accountApi";
import { useTimezones } from "@/hooks/useTimezones";
import { describeZone } from "@/lib/timezonePicker";
import { AcButton, AcCheck, AcField, Group, Hint, Section } from "./controls";
import { TimezonePicker } from "./TimezonePicker";
import { useAccount, useDraft } from "./context";

/** A system notice: something the operator has switched off for everyone, so the person knows it isn't their account. */
function Notice({ children }: { children: string }) {
  return (
    <p className="ac-notice" role="status">
      <span className="signal-dot" aria-hidden="true" />
      {children}
    </p>
  );
}

/** 02. When and how Phylax reaches the person. */
export function NotificationsSection() {
  const { profile, meta, applyProfile, run, stateOf } = useAccount();
  const { settings } = profile;
  const emailAllowed = meta.channels.email && profile.email.verified;
  const textAllowed = meta.channels.text && profile.phone.verified;

  // A channel that can't be used shows (and saves) as off, whatever an older save says.
  const { draft, setDraft, dirty } = useDraft({
    timezone: settings.timezone,
    lead: String(settings.leadMinutes),
    email: settings.emailAlerts && emailAllowed,
    text: settings.textAlerts && textAllowed,
  });
  const [touched, setTouched] = useState(false);
  const { zones, device, source } = useTimezones(settings.timezone);
  const zoneHint = useId();
  const leadHint = useId();

  const lead = parseLeadMinutes(draft.lead);
  const leadError = touched && lead === null ? `Use a whole number of minutes, from ${LEAD_MIN} to ${LEAD_MAX}.` : null;
  const selectable = useMemo(() => (zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones]), [zones, draft.timezone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (lead === null) return;
    const result = await run(
      "settings",
      (signal) => saveSettings({ timezone: draft.timezone, leadMinutes: lead, emailAlerts: draft.email && emailAllowed, textAlerts: draft.text && textAllowed }, signal),
      { success: "Alert settings saved." },
    );
    if (result.ok) { applyProfile(result.value); setTouched(false); }
  };

  const zoneNote = source === "loading" ? "Loading the full list of timezones." : source === "fallback" ? "Showing common timezones: the full list couldn't be loaded." : null;

  return (
    <Section id="ac-notify" no="02" title="Delivery" lead="Choose the timezone your shifts run on, how early a reminder should reach you, and where it should go.">
      {!meta.channels.email || !meta.channels.text ? (
        <div className="ac-notices">
          {!meta.channels.email ? <Notice>Email alerts are switched off by Phylax right now, so nothing can be sent by email.</Notice> : null}
          {!meta.channels.text ? <Notice>Text alerts are switched off by Phylax right now, so nothing can be sent by text.</Notice> : null}
        </div>
      ) : null}

      <form className="ac-form" onSubmit={submit} noValidate>
        <Group label="Timing">
          <div className="ac-cell">
            <TimezonePicker value={draft.timezone} onValueChange={(timezone) => setDraft({ ...draft, timezone })} zones={selectable} device={device} hintId={zoneHint} />
            <Hint id={zoneHint}>{zoneNote ?? `Reminders follow ${describeZone(draft.timezone).city} time.`}</Hint>
          </div>
          <div className="ac-cell ac-cell-narrow">
            <AcField
              label="Reminder lead time (minutes)"
              value={draft.lead}
              onValueChange={(value) => setDraft({ ...draft, lead: value })}
              onBlur={() => setTouched(true)}
              type="number"
              inputMode="numeric"
              min={LEAD_MIN}
              max={LEAD_MAX}
              step={1}
              invalid={!!leadError}
              hintId={leadHint}
              autoComplete="off"
              mono
            />
            <Hint id={leadHint} error={leadError}>{lead !== null ? describeLead(lead) : null}</Hint>
          </div>
        </Group>

        <Group label="Alert channels">
          <div className="ac-checks">
            <AcCheck
              checked={draft.email && emailAllowed}
              onChange={(email) => setDraft({ ...draft, email })}
              disabled={!emailAllowed}
              label="Email alerts"
              note={!meta.channels.email ? "Turned off by Phylax for now." : !profile.email.verified ? "Verify your email address to turn this on." : `Sent to ${profile.email.address}.`}
            />
            <AcCheck
              checked={draft.text && textAllowed}
              onChange={(text) => setDraft({ ...draft, text })}
              disabled={!textAllowed}
              label="Text alerts"
              note={!meta.channels.text ? "Turned off by Phylax for now." : !profile.phone.verified ? "Verify your phone number to turn this on." : `Sent to ${profile.phone.number}.`}
            />
          </div>
        </Group>

        <AcButton type="submit" variant="solid" state={stateOf("settings")} disabled={!dirty}>Save alert settings</AcButton>
      </form>
    </Section>
  );
}
