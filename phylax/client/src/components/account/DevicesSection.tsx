import { useCallback, useEffect, useState } from "react";
import { describeUserAgent, formatAgo, formatWhen, type SessionInfo } from "@/lib/account";
import { listSessions, revokeSession, signOutOthers } from "@/lib/accountApi";
import { AcButton, Group, Section } from "./controls";
import { isAbort, messageFor, useAccount } from "./context";
import { IconMonitor } from "./icons";

/** 07. Every browser that is signed in to the account, and a way to end the ones that shouldn't be. */
export function DevicesSection() {
  const { run, stateOf } = useAccount();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setError(null);
    listSessions(signal).then(setSessions).catch((e: unknown) => { if (!isAbort(e)) setError(messageFor(e)); });
  }, []);
  useEffect(() => { const c = new AbortController(); load(c.signal); return () => c.abort(); }, [load]);

  const others = (sessions ?? []).filter((s) => !s.current);

  const revoke = async (id: string) => {
    const result = await run(`revoke-${id}`, (signal) => revokeSession(id, signal), { success: "Device signed out." });
    if (result.ok) setSessions(result.value);
  };
  const signOutAll = async () => {
    const result = await run("sessions-others", (signal) => signOutOthers(signal), { success: "Signed out of your other devices." });
    if (result.ok) setSessions(result.value);
  };

  return (
    <Section id="ac-devices" no="07" title="Signed-in devices" lead="Where your account is signed in right now. Don't recognise one? Revoke it.">
      <Group label="Sessions" aside={<AcButton size="sm" variant="danger" state={stateOf("sessions-others")} onClick={signOutAll} disabled={others.length === 0}>Sign out other devices</AcButton>}>
        {error ? (
          <div className="ac-empty" role="alert">{error} <AcButton variant="quiet" size="sm" onClick={() => load()}>Try again</AcButton></div>
        ) : sessions === null ? (
          <ul className="ac-sessions" aria-busy="true">{[0, 1].map((i) => <li className="ac-session ac-skel" key={i} />)}</ul>
        ) : (
          <ul className="ac-sessions">
            {sessions.map((session) => (
              <li className="ac-session" key={session.id} data-current={session.current || undefined}>
                <span className="ac-session-icon" aria-hidden="true"><IconMonitor /></span>
                <span className="ac-session-text">
                  <span className="ac-session-name">{session.current ? "This device" : describeUserAgent(session.userAgent)}</span>
                  <span className="ac-session-meta">{session.current ? `${describeUserAgent(session.userAgent)} · ` : ""}Last seen <time dateTime={session.lastSeenAt} title={formatWhen(session.lastSeenAt)}>{formatAgo(session.lastSeenAt)}</time></span>
                </span>
                {!session.current ? <AcButton size="sm" variant="danger" state={stateOf(`revoke-${session.id}`)} onClick={() => revoke(session.id)}>Revoke</AcButton> : <span className="ac-session-badge">Active</span>}
              </li>
            ))}
          </ul>
        )}
      </Group>
    </Section>
  );
}
