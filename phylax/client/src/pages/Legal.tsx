import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowUpRight } from "lucide-react";
import "../legal.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { useActiveSection } from "@/hooks/useActiveSection";
import { useAuth } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";
import { NOT_CONFIGURED, contactHref, fetchLegalConfig, type LegalConfig } from "@/lib/legalConfig";
import { LEGAL_DOCS, docForPath, type Section } from "@/lib/legalDocs";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";

const FACTS = [["Operator", "operator"], ["Contact", "contact"], ["Jurisdiction", "jurisdiction"]] as const;

function SectionBlock({ s }: { s: Section }) {
  return (
    <section id={s.id} aria-labelledby={`${s.id}-h`}>
      <h2 id={`${s.id}-h`}>{s.title}</h2>
      {s.body?.map((p) => <p key={p}>{p}</p>)}
      {s.items && <ul>{s.items.map((i) => <li key={i}>{i}</li>)}</ul>}
      {s.retention && <dl className="legal-retention">{s.retention.map((r) => <div key={r.what}><dt>{r.what}</dt><dd>{r.period}</dd></div>)}</dl>}
      {s.after?.map((p) => <p key={p}>{p}</p>)}
    </section>
  );
}

/** Serves /terms and /privacy. The path picks the document; /api/legal supplies who operates it and whether they approved it. */
export default function Legal() {
  const [path] = useLocation();
  const doc = docForPath(path);
  const other = LEGAL_DOCS[doc.kind === "terms" ? "privacy" : "terms"];
  const heading = doc.lines.join(" ");
  const { isAuthenticated } = useAuth();
  const [config, setConfig] = useState<LegalConfig | null>(null); // null while loading
  const active = useActiveSection(doc.sections.map((s) => s.id));
  const draft = config !== null && !config.approved;

  useDocumentMeta(`${heading} — Phylax`, doc.description, !config?.approved);

  useEffect(() => {
    const controller = new AbortController();
    fetchLegalConfig(controller.signal).then(setConfig, () => {});
    return () => controller.abort();
  }, []);

  // A deep link (/privacy#retention-and-deletion) lands on its section; switching documents starts at the top.
  useEffect(() => {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView({ behavior: "instant" });
    else window.scrollTo({ top: 0, behavior: "instant" });
  }, [doc.kind]);

  return (
    <div className="site-shell legal">
      <div className="grain" aria-hidden="true" />
      <div className="legal-progress" aria-hidden="true" />
      <header className="global-nav">
        <Link href="/" className="brand-lockup" aria-label="Phylax home"><PhylaxMark /><span className="brand-name">Phylax</span></Link>
        <div className="nav-center">Legal</div>
        <div className="nav-actions"><Link href={other.path} className="nav-store">{other.lines.join(" ")} <ArrowUpRight size={14} /></Link></div>
      </header>

      {draft && (
        <div className="legal-alert-wrap">
          <div className="legal-alert-clip">
            <p className="legal-alert" role="alert"><strong>Pre-launch draft.</strong> The operator hasn’t approved this document yet. Public launch is disabled.</p>
          </div>
        </div>
      )}

      <main className="legal-main" key={doc.kind}>
        <div className="legal-inner">
          <div className="legal-head">
            <div>
              <h1 className="legal-title">{doc.lines.map((line) => <span key={line}><span className="legal-line"><span>{line}</span></span>{" "}</span>)}</h1>
              <p className="legal-version">Version {doc.version}</p>
            </div>
            <dl className="legal-facts" aria-busy={!config}>
              {FACTS.map(([label, key]) => {
                const value = config?.[key] ?? null;
                const href = key === "contact" ? contactHref(value) : null;
                return (
                  <div key={key} data-state={!config ? "loading" : value ? "set" : "missing"}>
                    <dt>{label}</dt>
                    <dd>{!config ? <span className="legal-wait" role="img" aria-label="Loading" /> : value ? (href ? <a href={href}>{value}</a> : value) : NOT_CONFIGURED}</dd>
                  </div>
                );
              })}
            </dl>
          </div>

          <div className="legal-body">
            <nav className="legal-toc" aria-label="In this document">
              <ol>{doc.sections.map((s) => <li key={s.id}><a href={`#${s.id}`} aria-current={active === s.id ? "location" : undefined}>{s.title}</a></li>)}</ol>
            </nav>
            <article className="legal-doc">{doc.sections.map((s) => <SectionBlock key={s.id} s={s} />)}</article>
          </div>
        </div>
      </main>

      <footer className="legal-foot">
        <div className="legal-inner">
          <a className="text-link legal-account" href={isAuthenticated ? "/dashboard" : "/login?next=/dashboard"}>Manage your account <ArrowUpRight size={14} /></a>
          <nav aria-label="Legal documents">
            <Link href={TERMS_URL} aria-current={doc.kind === "terms" ? "page" : undefined}>Terms of service</Link>
            <Link href={PRIVACY_URL} aria-current={doc.kind === "privacy" ? "page" : undefined}>Privacy notice</Link>
          </nav>
          <span>© {new Date().getFullYear()} Phylax</span>
        </div>
      </footer>
    </div>
  );
}
