import { useCallback, useEffect, useState } from "react";
import { formatWhen, type AlertStatus, type History } from "@/lib/account";
import { listHistory } from "@/lib/accountApi";
import { AcButton, Group, Section } from "./controls";
import { isAbort, messageFor, useAccount } from "./context";
import { IconRefresh } from "./icons";

const STATUS: Record<AlertStatus, string> = { accepted: "Accepted by provider", failed: "Failed", skipped: "Skipped" };

/** 08. The last 50 security changes and the last 50 reminders. */
export function HistorySection() {
  const { run, stateOf } = useAccount();
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const result = await run("history", (signal) => listHistory(signal), { success: "History refreshed." });
    if (result.ok) { setHistory(result.value); setError(null); }
  };

  const first = useCallback((signal: AbortSignal) => {
    listHistory(signal).then(setHistory).catch((e: unknown) => { if (!isAbort(e)) setError(messageFor(e)); });
  }, []);
  useEffect(() => { const c = new AbortController(); first(c.signal); return () => c.abort(); }, [first]);

  return (
    <Section id="ac-history" no="08" title="Security & alert history" lead="The latest 50 changes to your account's security and the latest 50 reminders Phylax sent.">
      <div className="ac-actions"><AcButton variant="solid" state={stateOf("history")} icon={<IconRefresh />} onClick={refresh}>Refresh history</AcButton></div>
      {error ? <p className="ac-empty" role="alert">{error}</p> : null}
      <Group label="Security changes">
        {history === null ? <ul className="ac-log" aria-busy="true"><li className="ac-skel" /><li className="ac-skel" /></ul>
          : history.security.length === 0 ? <p className="ac-empty">No recent security changes</p>
          : <ul className="ac-log">{history.security.map((e) => <li key={e.id}><span className="ac-log-text">{e.summary}</span><time className="ac-log-time" dateTime={e.at}>{formatWhen(e.at)}</time></li>)}</ul>}
      </Group>
      <Group label="Alerts">
        {history === null ? <ul className="ac-log" aria-busy="true"><li className="ac-skel" /><li className="ac-skel" /></ul>
          : history.alerts.length === 0 ? <p className="ac-empty">No recent alerts</p>
          : <ul className="ac-log">{history.alerts.map((a) => <li key={a.id}><span className="ac-log-text">{a.subject}<span className="ac-log-sub">{a.channel === "email" ? "Email" : "Text"} · {STATUS[a.status]}</span></span><time className="ac-log-time" dateTime={a.at}>{formatWhen(a.at)}</time></li>)}</ul>}
        <p className="ac-fine">Provider acceptance is not proof of final delivery. An inbox or a carrier can still delay or drop a message after Phylax's provider accepts it.</p>
      </Group>
    </Section>
  );
}
