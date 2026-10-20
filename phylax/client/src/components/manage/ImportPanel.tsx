import { useRef, useState, type DragEvent } from "react";
import { FileJson } from "lucide-react";
import {
  IMPORT_MAX_ROWS, IMPORT_MAX_BYTES, IMPORT_MIN_ROWS, fileProblem, formatBytes, makeRequestId, parseImport, plural, shortDay, timesParts,
  type ImportRow,
} from "@/lib/manageShifts";
import { importShifts, ApiError, type ImportResult } from "@/lib/shiftsApi";

type Staged = { fileName: string; bytes: number; format: "array" | "export"; rows: ImportRow[]; requestId: string };

const EXAMPLE = `[
  { "platform": "CareRev", "facility": "St. Anne's", "date": "2026-11-03",
    "start": "19:00", "end": "07:00", "label": "Night", "note": "Bring badge" }
]`;

/**
 * Append-only import. A file is checked, then staged here with a three-row preview; nothing is stored until the person
 * confirms. The confirm sends the staged rows with one request ID, kept for as long as the same file stays staged, so a
 * retry after a failure can never add the rows twice. Existing shifts are never removed or changed.
 */
export function ImportPanel({ onImported }: { onImported: (result: ImportResult) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const reset = () => { setStaged(null); setProblems([]); setFailure(""); setResult(null); };

  const take = async (file: File | undefined) => {
    if (!file) return;
    reset();
    const early = fileProblem(file);
    if (early) { setProblems([early]); return; }
    let source: string;
    try { source = await file.text(); } catch { setProblems(["That file couldn't be read. Try choosing it again."]); return; }
    const parsed = parseImport(source);
    if (!parsed.ok) { setProblems(parsed.errors); return; }
    setStaged({ fileName: file.name, bytes: file.size, format: parsed.format, rows: parsed.rows, requestId: makeRequestId() });
  };

  const confirm = async () => {
    if (!staged || busy) return;
    setBusy(true); setFailure("");
    try {
      const done = await importShifts({ requestId: staged.requestId, rows: staged.rows });
      setStaged(null); setResult(done);
      onImported(done);
    } catch (err) {
      setFailure(`${err instanceof ApiError ? err.message : "Couldn't reach Phylax."} Nothing was lost. Confirm again to retry: the same request ID is sent, so rows can't be added twice.`);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); void take(e.dataTransfer.files[0]); };
  const preview = staged?.rows.slice(0, 3) ?? [];

  return (
    <div className="ms-import">
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />

      <button
        type="button"
        className={`ms-drop ${dragging ? "is-over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        disabled={busy}
      >
        <FileJson size={20} strokeWidth={1.4} aria-hidden="true" />
        <span className="ms-drop-main">{staged ? "Choose a different file" : "Choose a JSON file"}</span>
        <span className="ms-drop-sub">or drop it here · up to {formatBytes(IMPORT_MAX_BYTES).replace(".0", "")} and {IMPORT_MAX_ROWS} shifts</span>
        <svg className="pk-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
      </button>

      <p className="ms-fine">Adds to your shifts. Nothing already saved is deleted or changed. Accepts a JSON array of shifts or a Phylax export, {IMPORT_MIN_ROWS} to {IMPORT_MAX_ROWS} shifts.</p>
      <details className="ms-details">
        <summary>Show the expected shape</summary>
        <pre>{EXAMPLE}</pre>
        <p>Times are 24-hour. An end at or before the start runs into the next day. Label and note are optional. A Phylax export wraps the same rows as <code>{`{ "format": "phylax.shifts", "version": 1, "shifts": [ … ] }`}</code>.</p>
      </details>

      {problems.length > 0 && (
        <div className="ms-notice is-error" role="alert">
          <strong>{problems.length === 1 ? "This file can't be imported" : `This file can't be imported: ${plural(problems.length, "problem")}`}</strong>
          <ul className="ms-problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
          <p>Nothing was staged. Fix the file and choose it again.</p>
        </div>
      )}

      {staged && (
        <section className="ms-staged" aria-label="Staged import">
          <div className="v-head"><span className="v-alert"><span className="signal-dot" /> Staged, not saved</span><span>{staged.format === "export" ? "Phylax export" : "JSON array"}</span></div>
          <div className="v-title">{plural(staged.rows.length, "shift")}<br />ready to append</div>
          <div className="ms-table-wrap">
            <table className="ms-table">
              <caption>Preview: the first {preview.length} of {plural(staged.rows.length, "row")} in {staged.fileName} ({formatBytes(staged.bytes)})</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Facility</th><th scope="col">Platform</th><th scope="col">Times</th></tr></thead>
              <tbody>
                {preview.map((r, i) => { const t = timesParts(r); return (
                  <tr key={i}><td>{shortDay(r.date)}</td><td>{r.facility}</td><td>{r.platform}</td><td>{t.start}–{t.end}{t.nextDay && <small> (next day)</small>}</td></tr>
                ); })}
              </tbody>
            </table>
          </div>
          <p className="ms-fine">Request ID <code title={staged.requestId}>{staged.requestId.slice(0, 8)}</code>. Rows that match a saved shift, or an earlier row in the file, are skipped and reported.</p>
          {failure && <p className="pk-note is-error" role="alert"><span>{failure}</span></p>}
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={confirm} disabled={busy}>{busy ? "Importing…" : "Confirm append import"}</button>
            <button type="button" className="ms-btn ms-btn-quiet" onClick={reset} disabled={busy}>Discard</button>
          </div>
        </section>
      )}

      {result && (
        <section className="ms-report" role="status" aria-label="Import report">
          <div className="v-head"><span className="v-alert"><span className="signal-dot" /> Import finished</span><span>{plural(result.imported + result.skipped, "source row")}</span></div>
          <div className="ms-report-nums">
            <div><strong>{result.imported}</strong><span>{result.imported === 1 ? "shift added" : "shifts added"}</span></div>
            <div><strong>{result.skipped}</strong><span>source {result.skipped === 1 ? "row" : "rows"} skipped</span></div>
          </div>
          {result.replayed && <p className="ms-fine">This request had already been processed, so nothing was added a second time.</p>}
          {result.skipped > 0 ? (
            <>
              <p className="v-text">{plural(result.skipped, "duplicate")} left out. Every skipped row is listed.</p>
              <ul className="ms-problems">
                {result.skippedRows.map((s) => <li key={s.row}>Row {s.row}: {s.reason === "exists" ? "already in your shifts" : "repeated earlier in this file"}</li>)}
              </ul>
            </>
          ) : <p className="v-text">No duplicates. Every row was added.</p>}
          <div className="ms-actions"><button type="button" className="ms-btn ms-btn-quiet" onClick={reset}>Done</button></div>
        </section>
      )}
    </div>
  );
}
