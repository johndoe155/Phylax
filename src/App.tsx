import { useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Info,
  MapPin,
  Menu,
  Minus,
  Plus,
  ShieldCheck,
  Siren,
  Sparkles,
  X,
} from 'lucide-react'
import { detectConflict, normalizeShiftInterval, type ConflictResult, type Shift } from './domain/conflicts'

const platforms = [
  { name: 'ShiftKey', mark: 'SK', tint: '#f1a24c' },
  { name: 'CareRev', mark: 'CR', tint: '#6d9bff' },
  { name: 'ShiftMed', mark: 'SM', tint: '#c995ff' },
  { name: 'IntelyCare', mark: 'IC', tint: '#7fd4ad' },
]

const templates = [
  { facility: 'Riverside Manor', meta: 'Day 7–7 · 12 hours', address: '18 Harbor Avenue', start: '07:00', end: '19:00', color: '#f1a24c' },
  { facility: 'St. Anne’s', meta: 'Night 7–7 · 12 hours', address: '402 South 9th Street', start: '19:00', end: '07:00', color: '#9f8bff' },
  { facility: 'Greenfield Rehab', meta: 'Evening 3–11 · 8 hours', address: '88 Greenfield Road', start: '15:00', end: '23:00', color: '#7fd4ad' },
]

function makeShift(id: string, platform: typeof platforms[number], template: typeof templates[number], date: string): Shift {
  const { startAt, endAt } = normalizeShiftInterval(date, template.start, template.end)
  return {
    id,
    platform: platform.name,
    platformMark: platform.mark,
    facility: template.facility,
    address: template.address,
    start: template.start,
    end: template.end,
    startAt,
    endAt,
    color: template.color,
  }
}

const initialShifts: Shift[] = [
  makeShift('shift-1', platforms[0], templates[0], '2026-10-12'),
  makeShift('shift-2', platforms[2], templates[1], '2026-10-13'),
]

function App() {
  const [activeView, setActiveView] = useState<'home' | 'app'>('home')
  const [demoConflict, setDemoConflict] = useState(true)
  const [shifts, setShifts] = useState(initialShifts)
  const [showLog, setShowLog] = useState(false)
  const [selectedPlatform, setSelectedPlatform] = useState(platforms[1])
  const [selectedTemplate, setSelectedTemplate] = useState(templates[1])
  const [selectedDate, setSelectedDate] = useState('2026-10-12')
  const [result, setResult] = useState<ConflictResult | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const previewShift = useMemo(() => makeShift('preview', selectedPlatform, selectedTemplate, selectedDate), [selectedDate, selectedPlatform, selectedTemplate])
  const previewResult = useMemo(() => detectConflict(previewShift, shifts), [previewShift, shifts])

  const openApp = () => {
    setActiveView('app')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submitShift = () => {
    const check = detectConflict(previewShift, shifts)
    setResult(check)
    if (check.type === 'clear') setShifts((current) => [...current, { ...previewShift, id: `shift-${Date.now()}` }])
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => setActiveView('home')} aria-label="Phylax home">
          <span className="wordmark-mark"><span /></span>
          <span>phylax</span>
        </button>
        <nav className={menuOpen ? 'main-nav open' : 'main-nav'}>
          <a href="#signal" onClick={() => setMenuOpen(false)}>The signal</a>
          <a href="#how" onClick={() => setMenuOpen(false)}>How it works</a>
          <a href="#pricing" onClick={() => setMenuOpen(false)}>Pricing</a>
        </nav>
        <div className="topbar-actions">
          <button className="text-button desktop-only" onClick={openApp}>Sign in</button>
          <button className="button button-small" onClick={openApp}>Open Phylax <ArrowRight size={15} /></button>
          <button className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation"><Menu size={20} /></button>
        </div>
      </header>

      {activeView === 'home' ? (
        <>
          <main>
            <section className="hero section-pad">
              <div className="hero-copy">
                <div className="eyebrow"><span className="eyebrow-dot" /> A guardrail for the spaces between</div>
                <h1>Know before<br /><em>you commit.</em></h1>
                <p className="hero-lede">Phylax watches every shift you take across every staffing app — and speaks up before a tight handoff becomes a costly mistake.</p>
                <div className="hero-actions">
                  <button className="button button-primary" onClick={openApp}>Build your shift guardrail <ArrowRight size={17} /></button>
                  <a className="inline-link" href="#signal">See the signal <ChevronDown size={16} /></a>
                </div>
                <div className="hero-proof"><ShieldCheck size={16} /><span>Built for per-diem CNAs, LPNs & RNs</span><span className="proof-rule" /><span>15 sec logging</span></div>
              </div>
              <div className="hero-visual" aria-label="Interactive shift conflict demonstration">
                <div className="visual-topline"><span>LIVE WATCH FIELD</span><span>12 OCT · 2026</span></div>
                <div className="field-grid" />
                <div className="field-orbit orbit-one" /><div className="field-orbit orbit-two" />
                <div className="field-axis"><span>06:00</span><span>12:00</span><span>18:00</span><span>00:00</span></div>
                <div className="field-card card-back"><span className="mini-mark sm">SM</span><div><strong>St. Anne’s</strong><small>SHIFT MED · NIGHT</small></div><b>19:00 — 07:00</b></div>
                <div className={demoConflict ? 'field-card card-front is-conflict' : 'field-card card-front'}><span className="mini-mark sk">SK</span><div><strong>Riverside Manor</strong><small>SHIFTKEY · DAY</small></div><b>07:00 — 19:00</b><span className="card-signal"><Siren size={13} /> {demoConflict ? 'OVERLAP' : 'CLEAR'}</span></div>
                <div className={demoConflict ? 'field-alert active' : 'field-alert'}><span className="alert-icon"><Siren size={16} /></span><div><strong>{demoConflict ? 'Direct overlap detected' : 'Clear to commit'}</strong><small>{demoConflict ? 'Two commitments. One decision.' : 'No collision in your active shifts.'}</small></div></div>
                <button className="field-toggle" onClick={() => setDemoConflict(!demoConflict)}><span className={demoConflict ? 'toggle-dot active' : 'toggle-dot'} /><span>{demoConflict ? 'Conflict view' : 'Clear view'}</span><span className="toggle-hint">click to test</span></button>
                <div className="field-footer"><span><span className="pulse" /> Monitoring 2 active shifts</span><span>BUFFER 45 MIN</span></div>
              </div>
            </section>

            <section className="ticker"><div className="ticker-track"><span>PLATFORM AGNOSTIC</span><i /> <span>OVERNIGHT AWARE</span><i /> <span>HUMAN DECISION, CLEARER SIGNAL</span><i /> <span>PLATFORM AGNOSTIC</span><i /> <span>OVERNIGHT AWARE</span><i /> <span>HUMAN DECISION, CLEARER SIGNAL</span></div></section>

            <section className="split-story section-pad" id="signal">
              <div className="section-label"><span>01</span><span className="label-line" /><span>THE SIGNAL</span></div>
              <div className="story-grid"><div className="story-heading"><h2>The schedule<br />is <em>scattered.</em></h2><span className="side-note">/ 01 — THE PROBLEM</span></div><div className="story-body"><p>One shift lives in ShiftKey. Another in CareRev. A third is sitting in your memory — along with the drive time between them.</p><p className="muted-copy">Phylax is the quiet layer that sees the whole picture. No integrations. No heavy admin. Just a fifteen-second check before you say yes.</p><a href="#how" className="circle-link">Meet the guardrail <ArrowRight size={18} /></a></div></div>
              <div className="stat-row"><div><strong>3—5</strong><span>saved templates<br />to start</span></div><div><strong>15<span>s</span></strong><span>to log a<br />common shift</span></div><div><strong>24<span>/7</span></strong><span>the watch<br />stays on</span></div></div>
            </section>

            <section className="how-section section-pad" id="how"><div className="section-label"><span>02</span><span className="label-line" /><span>THE HANDOFF</span></div><div className="how-heading"><h2>One clear<br /><em>decision.</em></h2><p>Save the moments you repeat. Phylax handles the rest.</p></div><div className="steps"><Step number="01" title="Choose the platform" text="Tap the app where the shift came from. No typing, no digging." icon="platform" /><Step number="02" title="Pick your pattern" text="Your saved facility and time templates are ready when you are." icon="template" /><Step number="03" title="Get the signal" text="See overlap, buffer risk, and the safer next move before you commit." icon="signal" /></div></section>

            <section className="policy-banner section-pad"><div className="policy-copy"><span className="eyebrow"><Bell size={14} /> THE DETAIL THAT MATTERS</span><h2>Not just a warning.<br /><em>A way forward.</em></h2><p>When a conflict surfaces, Phylax shows which cancellation window is closing first — so you can make the call with context, not panic.</p></div><div className="policy-card"><div className="policy-card-head"><span><span className="mini-mark cr">CR</span> CareRev</span><span className="policy-status">POLICY WINDOW</span></div><div className="policy-clock"><Clock3 size={28} /><strong>03:18:42</strong><span>remaining</span></div><div className="policy-rule" /><div className="policy-foot"><span>Cancellation window closes at 16:00</span><ChevronRight size={16} /></div></div></section>

            <section className="pricing section-pad" id="pricing"><div className="pricing-intro"><div className="section-label"><span>03</span><span className="label-line" /><span>THE GUARDRAIL</span></div><h2>One avoidable<br /><em>mistake.</em></h2><p>Phylax costs less than the no-show, the penalty, or the shift you never got to work.</p></div><div className="price-card"><div><span className="plan-kicker">PHYLAX PRO</span><div className="price"><span>$</span>9<small>/ month</small></div><p>For the weeks when two apps become three.</p></div><div className="price-includes"><span><Check size={14} /> Unlimited active shifts</span><span><Check size={14} /> SMS conflict alerts</span><span><Check size={14} /> Travel-buffer warnings</span></div><button className="button button-primary" onClick={openApp}>Start watching <ArrowRight size={16} /></button><small className="price-note">Also available annually at $79</small></div></section>
          </main>
          <footer className="footer section-pad"><div className="footer-brand"><span className="wordmark-mark"><span /></span><strong>phylax</strong><p>The shift guardrail<br />for the people who keep<br />everything moving.</p></div><div className="footer-links"><a href="#signal">The signal</a><a href="#how">How it works</a><a href="#pricing">Pricing</a><button onClick={openApp}>Open app <ArrowUpRight /></button></div><div className="footer-bottom"><span>© 2026 Phylax Systems</span><span>Not a staffing platform. A clearer moment before you commit.</span></div></footer>
        </>
      ) : <AppView shifts={shifts} onBack={() => setActiveView('home')} onLog={() => { setShowLog(true); setResult(null) }} onRemove={(id) => setShifts((current) => current.filter((shift) => shift.id !== id))} />}

      {showLog && <LogSheet platform={selectedPlatform} setPlatform={setSelectedPlatform} template={selectedTemplate} setTemplate={setSelectedTemplate} date={selectedDate} setDate={setSelectedDate} result={result} previewResult={previewResult} onClose={() => setShowLog(false)} onSave={submitShift} />}
    </div>
  )
}

function Step({ number, title, text, icon }: { number: string; title: string; text: string; icon: string }) {
  return <article className="step"><div className={`step-icon ${icon}`}>{icon === 'platform' ? <span>SK</span> : icon === 'template' ? <CalendarDays size={21} /> : <Siren size={21} />}</div><span className="step-number">{number}</span><h3>{title}</h3><p>{text}</p><ArrowRight className="step-arrow" size={17} /></article>
}

function AppView({ shifts, onBack, onLog, onRemove }: { shifts: Shift[]; onBack: () => void; onLog: () => void; onRemove: (id: string) => void }) {
  return <main className="app-view"><div className="app-header"><div><button className="back-link" onClick={onBack}>← back to phylax</button><div className="app-greeting"><span className="eyebrow-dot" /> Monday, October 12 <span className="muted-copy">/ your watch field</span></div><h1>Good morning,<br /><em>Alex.</em></h1></div><div className="app-header-actions"><button className="icon-button"><Bell size={18} /></button><div className="avatar">AL</div></div></div><div className="app-layout"><section className="board"><div className="board-top"><div><span className="eyebrow">ACTIVE WATCH</span><h2>Your shifts <span>{shifts.length}</span></h2></div><button className="button button-primary" onClick={onLog}><Plus size={17} /> Log shift</button></div><div className="board-status"><span className="status-icon"><ShieldCheck size={18} /></span><div><strong>Watch is clear</strong><span>No active conflicts across your shifts.</span></div><span className="status-date">LAST CHECKED<br /><b>09:42 AM</b></span></div><div className="shift-list">{shifts.map((shift, index) => <ShiftRow key={shift.id} shift={shift} index={index} onRemove={() => onRemove(shift.id)} />)}</div><button className="add-template" onClick={onLog}><Plus size={16} /> Add another shift</button></section><aside className="app-side"><div className="side-card"><div className="side-card-top"><span className="eyebrow">QUICK LOG</span><Sparkles size={16} /></div><h3>Your patterns<br /><em>at a glance.</em></h3>{templates.map((template) => <button className="quick-template" key={template.facility} onClick={onLog}><span className="template-dot" style={{ background: template.color }} /><span><strong>{template.facility}</strong><small>{template.meta}</small></span><ChevronRight size={16} /></button>)}<button className="side-link" onClick={onLog}>Manage templates <ArrowRight size={15} /></button></div><div className="side-card quiet-card"><div className="quiet-mark"><span className="pulse" /></div><div><strong>SMS watch is on</strong><p>We’ll text you when a new conflict needs your attention.</p></div><ChevronRight size={16} /></div></aside></div></main>
}

function ShiftRow({ shift, index, onRemove }: { shift: Shift; index: number; onRemove: () => void }) {
  return <article className="shift-row" style={{ '--shift-color': shift.color } as React.CSSProperties}><div className="shift-time"><strong>{shift.start}</strong><span>{index === 0 ? 'TODAY' : 'TOMORROW'}</span></div><div className="shift-line"><span className="line-dot" /><span className="line-stem" /></div><div className="shift-main"><div className="shift-title"><span className="mini-mark" style={{ background: shift.color }}>{shift.platformMark}</span><div><strong>{shift.facility}</strong><span>{shift.platform} · {shift.start} — {shift.end}</span></div></div><div className="shift-location"><MapPin size={14} /> {shift.address}</div></div><button className="shift-remove" onClick={onRemove} aria-label={`Remove ${shift.facility}`}><X size={16} /></button></article>
}

function LogSheet({ platform, setPlatform, template, setTemplate, date, setDate, result, previewResult, onClose, onSave }: { platform: typeof platforms[number]; setPlatform: (platform: typeof platforms[number]) => void; template: typeof templates[number]; setTemplate: (template: typeof templates[number]) => void; date: string; setDate: (date: string) => void; result: ConflictResult | null; previewResult: ConflictResult; onClose: () => void; onSave: () => void }) {
  const current = result ?? previewResult
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="log-sheet"><div className="sheet-handle" /><div className="sheet-head"><div><span className="eyebrow">QUICK LOG</span><h2>What did you<br /><em>commit to?</em></h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="sheet-step"><span>01</span><div><label>Staffing platform</label><div className="platform-grid">{platforms.map((item) => <button className={platform.name === item.name ? 'platform-choice selected' : 'platform-choice'} key={item.name} onClick={() => setPlatform(item)}><span className="mini-mark" style={{ background: item.tint }}>{item.mark}</span><span>{item.name}</span>{platform.name === item.name && <Check size={15} />}</button>)}</div></div></div><div className="sheet-step"><span>02</span><div className="template-select"><label>Saved shift pattern</label>{templates.map((item) => <button className={template.facility === item.facility ? 'template-choice selected' : 'template-choice'} key={item.facility} onClick={() => setTemplate(item)}><span className="template-dot" style={{ background: item.color }} /><span><strong>{item.facility}</strong><small>{item.meta}</small></span>{template.facility === item.facility ? <Check size={15} /> : <ChevronRight size={15} />}</button>)}</div></div><div className="sheet-step"><span>03</span><div><label>Date</label><div className="date-choices"><button className={date === '2026-10-12' ? 'date-choice selected' : 'date-choice'} onClick={() => setDate('2026-10-12')}>Today <small>12 Oct</small></button><button className={date === '2026-10-13' ? 'date-choice selected' : 'date-choice'} onClick={() => setDate('2026-10-13')}>Tomorrow <small>13 Oct</small></button><button className={date !== '2026-10-12' && date !== '2026-10-13' ? 'date-choice selected' : 'date-choice'} onClick={() => setDate('2026-10-14')}>Choose <CalendarDays size={14} /></button></div></div></div><div className={`sheet-result ${current.type}`}><div className="result-icon">{current.type === 'clear' ? <ShieldCheck size={19} /> : current.type === 'buffer' ? <Info size={19} /> : <Siren size={19} />}</div><div><strong>{current.message}</strong><p>{current.detail}</p>{current.type !== 'clear' && <button className="result-link">Review cancellation windows <ArrowRight size={14} /></button>}</div></div><button className="button button-primary sheet-save" onClick={onSave}>{result ? 'Got it — keep watching' : current.type === 'clear' ? 'Save shift' : 'Save with warning'} <ArrowRight size={17} /></button><p className="sheet-disclaimer"><Info size={13} /> Phylax informs your decision — it never cancels a commitment for you.</p></section></div>
}

export default App
