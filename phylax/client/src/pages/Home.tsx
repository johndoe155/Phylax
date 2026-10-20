import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDownRight, ArrowRight, ArrowUp, ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { useBlobReveal } from "@/hooks/useBlobReveal";
import { PhylaxMark, LOGO_BAR_A, LOGO_BAR_B } from "@/components/PhylaxMark";
import { DraggableFooterLogo } from "@/components/DraggableFooterLogo";
import { useHeroLogoUndraw } from "@/hooks/useHeroLogoUndraw";
import { useChecksScroll } from "@/hooks/useChecksScroll";
import { useChecksWarp } from "@/hooks/useChecksWarp";
import { useScrollReactiveMarquee } from "@/hooks/useScrollReactiveMarquee";
import { usePricingMorph } from "@/hooks/usePricingMorph";
import { useRailScrollHint } from "@/hooks/useRailScrollHint";
import { MenuTrigger } from "@/components/MenuTrigger";
import { MenuSketchLogo } from "@/components/MenuSketchLogo";
import { GapSequence } from "@/components/GapSequence";
import { TapDemo } from "@/components/TapDemo";
import { ScrollWords } from "@/components/ScrollWords";
import { SignatureSequence } from "@/components/SignatureSequence";
import { PhoneAlert } from "@/components/PhoneAlert";
import { PricingIconCycle } from "@/components/PricingIconCycle";
import { useStatCountUp } from "@/hooks/useStatCountUp";
import { FooterShape } from "@/components/FooterShape";
import { FooterBrand } from "@/components/FooterBrand";
import { InteractiveArrowButton } from "@/components/InteractiveArrowButton";
import { AuthLink } from "@/components/AuthLink";
import { ContactDialog } from "@/components/pricing/ContactDialog";
import type { ContactKind } from "@/lib/contact";

// TODO: replace with the real contact address before launch. (The waitlist and the pricing questions no longer use it:
// they open the dialogs in components/pricing, which send through lib/contact.ts.)
const CONTACT_EMAIL = "hello@phylax.app";
// TODO: no legal pages exist yet. Point these at the real Privacy Policy / Terms before launch.
const PRIVACY_URL = "/privacy";
const TERMS_URL = "/terms";
// Footer marquee: the disclaimer boiled down to three short lines. They are separated by spacing only (see .footer-marquee-group).
const FOOTER_NOTES = [
  "Not affiliated with or endorsed by any staffing platform.",
  "Cancellation details are guidance, not a guarantee. Verify with the platform.",
  "No patient information collected.",
];

/** Curved "U-turn" arrow for the footer Contact button, redrawn to match the design reference: the stroke leaves the
 *  bottom, curls round the left and runs back right into an open chevron head. */
function FooterCurvedArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14.2 21.4H9.2A6 6 0 0 1 9.2 9.4H20.4" />
      <path d="M14 3.4 20.4 9.4 14 15.4" />
    </svg>
  );
}

// Every section the nav label can report; `menu: true` ones also appear in the menu panel.
const sections = [
  { id: "home", label: "Home", menu: true },
  { id: "how-it-works", label: "How it works", menu: true },
  { id: "the-gap", label: "The gap" },
  { id: "checks", label: "The checks", menu: true },
  { id: "by-design", label: "By design" },
  { id: "alerts", label: "Alerts" },
  { id: "templates", label: "Templates" },
  { id: "pricing", label: "Pricing", menu: true },
];
const chapters = sections.filter((section) => section.menu);

// Sections that aren't menu entries (The gap, By design, Alerts…) count toward the menu entry that precedes them.
const chapterFor = (id: string) => {
  for (let i = sections.findIndex((section) => section.id === id); i >= 0; i--) {
    if (sections[i].menu) return sections[i].id;
  }
  return "home";
};

const checks = [
  {
    n: "01",
    level: "CRITICAL",
    name: "Direct overlap",
    sub: "Two shifts at the same time, overnight ones included",
    flag: "CAN'T DO BOTH",
    detail:
      "If a new shift starts before another one ends and ends after it starts, Phylax flags it the moment you save. A 7 p.m. to 7 a.m. shift is one continuous block, so it is checked against the next morning too.",
  },
  {
    n: "02",
    level: "HIGH",
    name: "Travel buffer",
    sub: "Different facilities, too little time between them",
    flag: "TIGHT WINDOW",
    detail:
      "Shifts that don't overlap can still be impossible to attend. If the gap between two facilities is shorter than your travel buffer, you get a tight-window warning instead of a surprise on the road.",
  },
  {
    n: "03",
    level: "DECIDE",
    name: "Cancellation window",
    sub: "Which shift is safer to drop, and by when",
    flag: "VERIFY POLICY",
    detail:
      "The alert names each platform's cancellation window and how much time is left, so you can choose which commitment is safer to drop. Policies vary and change, so always confirm the current policy with the platform.",
  },
];

type Template = { facility: string; label: string; start: number; end: number };
const templates: Template[] = [
  { facility: "Riverside Manor", label: "Day", start: 7, end: 19 },
  { facility: "Riverside Manor", label: "Night", start: 19, end: 7 },
  { facility: "St. Anne's", label: "8-hour day", start: 7, end: 15 },
  { facility: "Greenfield Rehab", label: "Evening", start: 15, end: 23 },
  { facility: "Harbor View", label: "Early", start: 6, end: 14 },
  { facility: "Maple Court", label: "Short", start: 16, end: 20 },
];

const clock = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h % 24 >= 12 ? "P" : "A"}`;

function TemplateTile({ template }: { template: Template }) {
  const { start, end } = template;
  const segments = end > start ? [[start, end]] : [[start, 24], [0, end]];
  const hour = (h: number) => `${h % 12 === 0 ? 12 : h % 12}`;
  return (
    <div className="tile">
      <span className="tile-label">{template.label}</span>
      <span className="tile-time">{hour(start)}—{hour(end)}</span>
      <div className="tile-bar" aria-hidden="true">
        {segments.map(([from, to]) => (
          <span key={from} style={{ left: `${(from / 24) * 100}%`, width: `${((to - from) / 24) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

// Marquee: the track holds an even number of identical pairs so the -50% loop lands exactly on a repeat.
type MarqueeItem = { text: string; className?: string };
function Marquee({ pair, reverse = false }: { pair: MarqueeItem[]; reverse?: boolean }) {
  return (
    <div className={`marquee-row ${reverse ? "marquee-row-reverse" : ""}`}>
      {Array.from({ length: 4 }, (_, copy) => pair.map((item, index) => <span key={`${copy}-${index}`} className={item.className}>{item.text}</span>))}
    </div>
  );
}

function Accent({ children }: { children: React.ReactNode }) {
  return <span className="accent-word">{children}</span>;
}

function SectionEyebrow({ children, light = false }: { children: React.ReactNode; light?: boolean }) {
  return <div className={`section-eyebrow ${light ? "section-eyebrow-light" : ""}`}><span className="eyebrow-dot" />{children}</div>;
}

// Hero background, inlined (rather than an <img>/background-image) so it can be rendered twice —
// normal and inverted — and so both copies share the same animation clock. Colors come from CSS variables.
const HERO_BARS: [x: number, y: number, w: number, o: number, accent?: boolean][] = [
  [154, 110, 691, 0.12], [576, 188, 614, 0.16], [998, 266, 730, 0.1], [38, 344, 538, 0.14],
  [768, 422, 730, 0.18], [1267, 500, 614, 0.12], [269, 578, 730, 0.1], [883, 656, 499, 0.8, true],
  [1152, 734, 653, 0.14], [384, 812, 730, 0.12], [1344, 890, 576, 0.1], [653, 968, 614, 0.16],
];

function HeroBars() {
  return (
    <svg className="hero-bars" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect className="hb-bg" width="1920" height="1080" />
      {Array.from({ length: 13 }, (_, i) => <line key={i} className="hb-grid" x1={i * 160} y1="0" x2={i * 160} y2="1080" />)}
      {HERO_BARS.map(([x, y, w, o, accent], i) => (
        <rect
          key={i}
          className={accent ? "hb-accent" : "hb-bar"}
          x={x} y={y} width={w} height="38"
          // Faint bars drift; each gets its own speed, distance, phase and direction.
          style={accent ? undefined : ({
            "--t": `${14 + ((i * 3) % 9)}s`,
            "--d": `${40 + ((i * 17) % 50)}px`,
            "--o": `${-((i * 2.7) % 12)}s`,
            animationDirection: i % 2 ? "alternate-reverse" : "alternate",
            fillOpacity: o,
          } as React.CSSProperties)}
        />
      ))}
      <rect className="hb-clash" x="1152" y="656" width="230" height="116" />
    </svg>
  );
}

// Everything in the hero. Rendered twice: once for real, once inverted inside the blob (decorative copy).
function HeroScene({ inverted = false, onScrollDown }: { inverted?: boolean; onScrollDown?: () => void }) {
  return (
    <>
      <div className="hero-backdrop"><HeroBars /></div>
      <div className="hero-wash" />
      <div className="hero-content">
        <h1 className="hero-title mobile-fit-hero-heading reveal">DOUBLE<br /><em>CHECK</em></h1>
        <div className="hero-footer reveal">
          <p>One log for every staffing app, checked for <Accent>overlap</Accent> before it costs you a <Accent>shift</Accent>.</p>
          {inverted
            ? <InteractiveArrowButton decorative variant="hero"><ArrowDownRight size={20} /></InteractiveArrowButton>
            : <InteractiveArrowButton variant="hero" onClick={onScrollDown} aria-label="Scroll to How it works"><ArrowDownRight size={20} /></InteractiveArrowButton>}
        </div>
      </div>
      {/* Brand block: top centre of the hero, deliberately outside .hero-content so the loader's zoom never moves it.
          The logo is what the page loader's logo flies onto, and it undraws as the page scrolls (useHeroLogoUndraw).
          The wordmark just reveals with the rest of the hero text. */}
      <div className="hero-brand">
        <svg className="hero-logo" viewBox="0 0 24 20" fill="none" aria-hidden="true" focusable="false">
          <path className="hero-logo-bar hero-logo-bar--a" d={LOGO_BAR_A} />
          <path className="hero-logo-bar hero-logo-bar--b" d={LOGO_BAR_B} />
        </svg>
        <p className="hero-wordmark reveal"><span>PHYLAX</span></p>
      </div>
      <div className="hero-vertical-label">FOR PER-DIEM CARE <span className="vertical-line" /> ONE LOG, EVERY APP</div>
      {/* Login: bold, underlined text button in the spot the old "checked on every save" kicker held. It reads "Dashboard"
          (and links there) once someone is signed in. The inverted twin is a decorative, non-focusable copy (it sits
          inside an aria-hidden, pointer-events:none layer) that follows the same state. */}
      <AuthLink className="hero-login" decorative={inverted} />
    </>
  );
}

function Home() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("home");
  const [openCheck, setOpenCheck] = useState<string | null>(null);
  // The pricing dialogs ("Join the waitlist", "Ask a question"): which one is open, and the button that opened it (focus returns there).
  const [dialog, setDialog] = useState<ContactKind | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const openDialog = useCallback((kind: ContactKind, trigger: HTMLElement) => {
    dialogTriggerRef.current = trigger;
    setDialog(kind);
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const [progress, setProgress] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // True while the history entry pushed for the open menu is still on the stack (lets Back close the menu).
  const menuEntryRef = useRef(false);
  const heroRef = useRef<HTMLElement>(null);
  // Section 01: the three illustrations scroll sideways on narrow screens; a hint under the first one says so.
  const railRef = useRef<HTMLDivElement>(null);
  const storyCaptionRef = useRef<HTMLDivElement>(null);
  const showRailHint = useRailScrollHint(railRef);
  const blobRef = useRef<HTMLDivElement>(null);
  const footerContentRef = useRef<HTMLDivElement>(null);
  const footerMarqueeRef = useRef<HTMLDivElement>(null);
  // The footer marquee runs in reverse while the visitor scrolls up.
  useScrollReactiveMarquee(footerMarqueeRef);
  useBlobReveal(heroRef, blobRef);
  useHeroLogoUndraw(heroRef);
  // "The checks": scrolling opens the three items one after another (exactly one open; none before the first step).
  const checksListRef = useRef<HTMLDivElement>(null);
  const openCheckAt = useCallback((index: number) => setOpenCheck(index < 0 ? null : checks[index].n), []);
  useChecksScroll(checksListRef, checks.length, openCheckAt);
  // ...and the section's bottom edge bulges outwards as it scrolls into view, then stays that way.
  const checksSectionRef = useRef<HTMLElement>(null);
  const checksWarpRef = useRef<HTMLDivElement>(null);
  useChecksWarp(checksSectionRef, checksWarpRef);
  // Templates -> Pricing: no edge. One wrapper, one background layer and one set of colour variables serve both
  // sections, so the whole viewport scroll-morphs from cream to ink as a single colour (text follows, frame for frame).
  const morphZoneRef = useRef<HTMLDivElement>(null);
  const pricingRef = useRef<HTMLElement>(null);
  const morphInkRef = useRef<HTMLDivElement>(null);
  // The sketch loop above "START FREE." waits for the morph to finish: true only once the colours have fully arrived at
  // Pricing's, false again if the visitor scrolls back up into the transition (which resets the loop to sketch 1).
  const [morphComplete, setMorphComplete] = useState(false);
  usePricingMorph(morphZoneRef, pricingRef, morphInkRef, setMorphComplete);
  // Section 04: the three big numbers rise and count up as the grid scrolls into view.
  const statsGridRef = useRef<HTMLDivElement>(null);
  useStatCountUp(statsGridRef);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? window.scrollY / max : 0);
      const items = sections.map((section) => document.getElementById(section.id)).filter(Boolean) as HTMLElement[];
      let current = "home";
      items.forEach((item) => {
        if (item.getBoundingClientRect().top <= window.innerHeight * 0.34) current = item.id;
      });
      setActiveSection(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const nodes = pageRef.current?.querySelectorAll(".reveal");
    if (!nodes) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add("is-visible");
      });
    }, { threshold: 0.16 });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    let nudgeTimer: number | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      nudgeTimer = window.setTimeout(() => hero.classList.add("hero-arrow-nudge-ready"), 1500);
    }, { threshold: 0.01 });
    observer.observe(hero);
    return () => {
      observer.disconnect();
      if (nudgeTimer !== undefined) window.clearTimeout(nudgeTimer);
    };
  }, []);

  const openMenu = () => {
    history.pushState({ phylaxMenu: true }, "");
    menuEntryRef.current = true;
    setMenuOpen(true);
  };

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    if (menuEntryRef.current) {
      menuEntryRef.current = false;
      history.back();
    }
  }, []);

  // The Back button (or a back swipe) closes the menu instead of leaving the page.
  useEffect(() => {
    const onPopState = () => {
      if (!menuEntryRef.current) return;
      menuEntryRef.current = false;
      setMenuOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // While the full-screen menu is open: lock page scroll, let Escape close it, and keep Tab inside it.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeMenu(); return; }
      if (event.key !== "Tab" || !panelRef.current) return;
      const items = [triggerRef.current, ...panelRef.current.querySelectorAll<HTMLElement>("a[href], button")].filter(Boolean) as HTMLElement[];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && (index === -1 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, closeMenu]);

  // Move focus into the menu when it opens (the current entry if there is one) and back to the trigger when it closes.
  const menuWasOpen = useRef(false);
  useEffect(() => {
    if (menuOpen) {
      const target = panelRef.current?.querySelector<HTMLElement>("[aria-current]") ?? panelRef.current?.querySelector<HTMLElement>("button");
      target?.focus({ preventScroll: true });
    } else if (menuWasOpen.current) {
      triggerRef.current?.focus({ preventScroll: true });
    }
    menuWasOpen.current = menuOpen;
  }, [menuOpen]);

  const jumpTo = (id: string) => {
    if (menuEntryRef.current) {
      // Jumping from the menu turns its history entry into this section's entry (same URL, no hash),
      // so Back returns to where the person was before opening the menu.
      menuEntryRef.current = false;
      history.replaceState(null, "");
    }
    setMenuOpen(false);
    // Let the scroll lock release before scrolling, otherwise the jump is ignored.
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }));
  };

  const activeLabel = sections.find((section) => section.id === activeSection)?.label ?? "";
  const activeChapter = chapterFor(activeSection);

  return (
    <div className="site-shell" ref={pageRef}>
      <div className="grain" aria-hidden="true" />
      <div className="scroll-progress" style={{ transform: `scaleX(${progress})` }} />
      <header className="global-nav" inert={dialog !== null}>
        <button className="brand-lockup" onClick={() => jumpTo("home")} aria-label="Phylax home">
          <PhylaxMark />
          <span className="brand-name">Phylax</span>
        </button>
        <div className="nav-center">{activeLabel}</div>
        <div className="nav-actions">
          <button className="nav-store" onClick={() => jumpTo("pricing")}>Get started <ArrowUpRight size={14} /></button>
          {/* Keeps the nav layout; the real button is <MenuTrigger> below. It is blended like this header but must be its own sibling, not a child, so each blends against the page. */}
          <span className="nav-trigger-slot" aria-hidden="true" />
        </div>
      </header>
      <MenuTrigger ref={triggerRef} open={menuOpen} onToggle={() => (menuOpen ? closeMenu() : openMenu())} controls="site-menu" />

      {/* The menu stays mounted so it can animate out as well as in. `data-state` drives every transition in
          index.css, and the closed state is visibility:hidden, so it is out of the tab order and the a11y tree.
          The curtain is the steel-blue edge that leads the dark panel on the way in and trails it on the way out. */}
      <div className="menu-curtain" data-state={menuOpen ? "open" : "closed"} aria-hidden="true" />
      <div id="site-menu" ref={panelRef} className="menu-panel" data-state={menuOpen ? "open" : "closed"} style={{ "--n": chapters.length } as CSSProperties} role="dialog" aria-label="Site menu">
        {/* The row above the links holds the stop-motion sketch logo; it runs only while the menu is open (see MenuSketchLogo). */}
        <div className="menu-panel-top"><MenuSketchLogo playing={menuOpen} /></div>
        <nav className="menu-links" aria-label="Sections">
          {chapters.map((chapter, index) => {
            const isActive = chapter.id === activeChapter;
            return (
              <button key={chapter.id} onClick={() => jumpTo(chapter.id)} aria-current={isActive ? "location" : undefined} style={{ "--i": index } as CSSProperties}>
                <span className="menu-label"><span>{chapter.label}</span></span>
                {isActive ? <span className="menu-here mx" aria-hidden="true" /> : <ArrowUpRight className="mx" size={21} strokeWidth={1.4} />}
              </button>
            );
          })}
        </nav>
        <div className="menu-foot">
          <div className="mx"><button className="menu-cta" onClick={() => jumpTo("pricing")}>Get started <ArrowUpRight size={16} /></button></div>
          <div className="mx"><AuthLink className="menu-login" /></div>
          <a className="menu-mail mx" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </div>
      </div>

      <main inert={menuOpen || dialog !== null}>
        <section id="home" ref={heroRef} className="hero-section" data-theme="dark">
          <HeroScene onScrollDown={() => jumpTo("how-it-works")} />
          {/* Inverted twin, revealed only inside the touch blob. Decorative: hidden from AT, ignores pointer events. */}
          <div className="hero-inverse" ref={blobRef} aria-hidden="true"><HeroScene inverted /></div>
        </section>

        <section className="marquee-section" aria-label="Log the shift, catch the clash. Every app, every shift.">
          <Marquee pair={[{ text: "LOG THE SHIFT" }, { text: "CATCH THE CLASH", className: "marquee-accent" }]} />
          <Marquee reverse pair={[{ text: "EVERY APP" }, { text: "EVERY SHIFT", className: "marquee-outline" }]} />
        </section>

        <section id="how-it-works" className="story-section dark-section">
          <div className="story-intro">
            <SectionEyebrow>01 / How it works</SectionEyebrow>
            <div className="story-intro-grid">
              <h2 className="display-heading mobile-fit-heading has-marker-note reveal">THREE<br /><Accent>TAPS</Accent>{/* Hand-written "3" in Marker Hand, decorative (see .marker-note-three). */}<span className="marker-note marker-note-three" aria-hidden="true">3</span></h2>
              <div className="story-copy reveal"><p>Pick the app, tap a saved shift, save. Phylax checks it against everything you've logged before you put your phone down.</p><SignatureSequence /></div>
            </div>
          </div>
          <div className="story-images horizontal-rail" ref={railRef}>
            <figure className="story-card story-card-large reveal">
              <TapDemo />
              <figcaption>
                <span>Example: three taps, then the check</span>
                {/* "Scroll" hint until the rail is first scrolled sideways, then the "01" label for good. */}
                <span className="story-index" data-hint={showRailHint}>
                  <span className="story-index-num">01</span>
                  <span className="story-index-hint" aria-hidden="true">Scroll <ArrowRight size={11} strokeWidth={2} /></span>
                </span>
              </figcaption>
            </figure>
            <figure className="story-card story-card-tall reveal">
              <div className="visual" role="img" aria-label="Example result after saving a shift: no overlap, travel buffer clear, and no cancellation window to weigh.">
                <div className="v-head"><span>Saved · checked</span><span>Example</span></div>
                <div className="v-title">Saved,<br />no clash</div>
                <div className="v-rows v-checks">
                  <div><span className="v-check"><Check size={11} strokeWidth={2.5} /></span><span>Direct overlap</span><span>Clear</span></div>
                  <div><span className="v-check"><Check size={11} strokeWidth={2.5} /></span><span>Travel buffer</span><span>Clear</span></div>
                  <div><span className="v-check"><Check size={11} strokeWidth={2.5} /></span><span>Cancellation window</span><span>Clear</span></div>
                </div>
                <p className="v-text">Checked against everything you've logged, across every app.</p>
                <div className="v-foot">Runs on every save.</div>
              </div>
              <figcaption><span>After the save, all clear</span><span>02</span></figcaption>
            </figure>
            <figure className="story-card story-card-medium reveal">
              <div className="visual" role="img" aria-label="Example alert: overlap of one hour between a ShiftKey and a CareRev shift; the CareRev cancellation window closes in 3 hours.">
                <div className="v-head"><span className="v-alert"><span className="signal-dot" /> Conflict detected</span><span>Example</span></div>
                <div className="v-title">Overlap,<br />1 hour</div>
                <div className="v-rows">
                  <div><span>ShiftKey · Riverside Manor</span><span>7P–7A</span></div>
                  <div><span>CareRev · St. Anne's</span><span>6A–2P</span></div>
                </div>
                <p className="v-text">CareRev's cancellation window closes in 3 hours. Review both before cancelling.</p>
                <div className="v-foot">Verify the current platform policy.</div>
              </div>
              <figcaption><span>The alert</span><span>03</span></figcaption>
            </figure>
          </div>
          <div className="story-caption" ref={storyCaptionRef}>
            <span className="story-caption-lead">Not another <ScrollWords triggerRef={storyCaptionRef} /></span>
            A warning at the <Accent>moment you need it.</Accent>
          </div>
        </section>

        <GapSequence>
          <div className="gap-curtain-inner">
            <SectionEyebrow light>02 / The gap</SectionEyebrow>
            <h2 className="display-heading dark-heading">THE<br /><span>GAP</span></h2>
            <div className="gap-curtain-copy">
              <p className="large-copy">Every staffing app sees only its own shifts. None sees the one you took elsewhere, so you become the sync layer.</p>
              <button className="text-link" onClick={() => jumpTo("checks")}>See the checks <ArrowUpRight size={16} /></button>
            </div>
          </div>
        </GapSequence>

        <section id="checks" className="calendar-section dark-section" ref={checksSectionRef}>
          <div className="calendar-head">
            <SectionEyebrow>03 / What it catches</SectionEyebrow>
            <div className="calendar-title-row"><h2 className="display-heading mobile-fit-heading reveal">THE<br /><Accent>CHECKS</Accent></h2><div className="calendar-meta"><span>RUNS ON SAVE</span><span>3 CHECKS</span></div></div>
          </div>
          <div className="calendar-list" ref={checksListRef}>
            {checks.map((check) => {
              const open = openCheck === check.n;
              // className must stay constant: the scroll-reveal observer adds `is-visible` to this node directly, and a
              // className that changed on toggle would make React overwrite it and fade the row out. Open state lives in data-open.
              return (
                <div className="calendar-item reveal" data-open={open} key={check.n}>
                  <button className="calendar-row" aria-expanded={open} aria-controls={`check-${check.n}`} onClick={() => setOpenCheck(open ? null : check.n)}>
                    <span className="race-number">{check.n}</span>
                    <span className="race-date">{check.level}</span>
                    <span className="race-place">{check.name}<small>{check.sub}</small></span>
                    <span className="race-time">{check.flag}</span>
                    <ChevronDown size={17} />
                  </button>
                  <div className="calendar-detail" id={`check-${check.n}`}><div><p>{check.detail}</p></div></div>
                </div>
              );
            })}
          </div>
          <div className="calendar-warp" ref={checksWarpRef} aria-hidden="true" />
        </section>

        <section id="by-design" className="stats-section cream-section">
          <div className="stats-top"><SectionEyebrow light>04 / By design</SectionEyebrow><span className="stats-label">NOTHING TO CONNECT</span></div>
          <div className="stats-grid" ref={statsGridRef}>
            <div className="stat-block reveal"><strong data-count="3">3</strong><span>taps to log a shift</span></div>
            <div className="stat-block reveal"><strong data-count="0">0</strong><span>platform logins needed</span></div>
            <div className="stat-block reveal"><strong data-count="1">1</strong><span>place for every staffing app</span></div>
          </div>
          <div className="stats-foot"><span>NO SCRAPING. NO INTEGRATIONS.</span><span>MANUAL ENTRY, MADE FAST</span></div>
        </section>

        <section id="alerts" className="journal-section dark-section">
          <div className="journal-header"><SectionEyebrow>05 / Alerts</SectionEyebrow><h2 className="display-heading mobile-fit-heading reveal">WARNED<br /><Accent>EARLY</Accent></h2><p className="journal-intro reveal">Know which shift is safer to drop, and by when.</p></div>
          <div className="journal-grid">
            <article className="journal-feature journal-feature-phone reveal">
              <PhoneAlert />
            </article>
            <article className="journal-card reveal"><div className="journal-card-number">02</div><h3>TEXT<br />FIRST</h3><p>Alerts arrive by SMS, so they work on any phone. Web push is optional.</p><button className="mini-link" onClick={() => jumpTo("checks")}>See the checks <ArrowUpRight size={14} /></button></article>
            <article className="journal-card journal-card-blue reveal"><div className="journal-card-number">03</div><h3>YOUR<br />CALL</h3><p>Phylax warns and explains. It never deletes a shift for you.</p><button className="mini-link" onClick={() => jumpTo("how-it-works")}>How it works <ArrowUpRight size={14} /></button></article>
          </div>
        </section>

        <div className="mx-zone" ref={morphZoneRef}>
          {/* The one background for Templates and Pricing: ink at an opacity driven by scroll (see usePricingMorph). */}
          <div className="mx-ink" ref={morphInkRef} aria-hidden="true" />
        <section id="templates" className="helmet-section cream-section">
          <div className="helmet-heading"><SectionEyebrow light>06 / Templates</SectionEyebrow><h2 className="display-heading dark-heading mobile-fit-heading reveal">SAVED<br /><span>TILES</span></h2><p className="large-copy reveal">Add a facility once with address autocomplete. After that, every shift is a single tile.</p></div>
          <div className="helmet-grid">{templates.map((template, index) => <article className="helmet-card reveal" key={`${template.facility}-${template.label}`}><div className="helmet-visual"><TemplateTile template={template} /><div className="helmet-overlay" /></div><div className="helmet-info"><span>{template.facility}</span><span>{clock(template.start)}–{clock(template.end)}</span></div><span className="helmet-index">0{index + 1}</span></article>)}</div>
        </section>

        <section id="pricing" ref={pricingRef} className="callout-section dark-section pricing-morph">
          <PricingIconCycle running={morphComplete} />
          <div className="callout-word mobile-fit-callout-heading has-marker-note reveal">START<br /><span>FREE.</span>{/* Hand-written "$0??" in Marker Hand, decorative. The two "?" are the font's two question-mark variants (see .marker-note-price). */}<span className="marker-note marker-note-price" aria-hidden="true">$0<span className="marker-q1">?</span><span className="marker-q2">?</span></span></div>
          <div className="callout-aside"><SectionEyebrow>07 / Pricing</SectionEyebrow><p>Free to start. Pro is $9 a month, or $79 a year.</p><div className="social-links"><button type="button" aria-haspopup="dialog" onClick={(event) => openDialog("waitlist", event.currentTarget)}>Join the waitlist <ArrowUpRight size={14} /></button><button type="button" aria-haspopup="dialog" onClick={(event) => openDialog("question", event.currentTarget)}>Ask a question <ArrowUpRight size={14} /></button></div><span className="callout-fine">The free tier limits active tracked shifts.</span></div>
        </section>
        </div>
      </main>

      <footer className="site-footer" inert={menuOpen || dialog !== null}>
        <div className="footer-frame">
          {/* Outside and above the cream panel, on its top-right edge. */}
          <div className="footer-bar"><InteractiveArrowButton variant="footer" onClick={() => jumpTo("home")} aria-label="Back to top"><ArrowUp size={20} /></InteractiveArrowButton></div>
          <FooterShape contentRef={footerContentRef}>
            {/* 1. Top banner: the disclaimer, in three short lines, as an infinite marquee. The second group is a seamless-loop copy, hidden from assistive tech. */}
            <div className="footer-marquee" role="note">
              <div className="footer-marquee-track" ref={footerMarqueeRef}>
                <div className="footer-marquee-group">{FOOTER_NOTES.map((note) => <span key={note}>{note}</span>)}</div>
                <div className="footer-marquee-group" aria-hidden="true">{FOOTER_NOTES.map((note) => <span key={note}>{note}</span>)}</div>
              </div>
            </div>
            <div className="footer-body">
              {/* 2. Navigation grid. Each column is ordered by text length as a diamond: shortest at the top and bottom, longest in the middle. */}
              <nav className="footer-nav" aria-label="Footer">
                <div><span>Explore</span><button onClick={() => jumpTo("pricing")}>Pricing</button><button type="button" aria-haspopup="dialog" onClick={(event) => openDialog("waitlist", event.currentTarget)}>Waitlist</button><button onClick={() => jumpTo("how-it-works")}>How it works</button><button onClick={() => jumpTo("checks")}>The checks</button><a href={PRIVACY_URL}>Privacy</a></div>
                <div><span>Shifts from</span><span>CareRev</span><span>ShiftMed</span><span>Clipboard Health</span><span>IntelyCare</span><span>ShiftKey</span></div>
              </nav>
              {/* 2b. Account link: under the Explore column, smaller than the nav items, in the wordmark's blue. Reads "Log in" until someone is signed in, then "Dashboard". */}
              <nav className="footer-account" aria-label="Account"><div><AuthLink /></div></nav>
              {/* 3. Branding. The "Shifts." kicker is written across the top of the wordmark (see .footer-kicker), fast, as the lockup scrolls into view (FooterBrand). */}
              <FooterBrand />
              {/* 4. Visual anchor (same geometry as phylax-logo-ink.svg). Draggable inside the cream panel. */}
              <DraggableFooterLogo boundsRef={footerContentRef} />
              {/* 5. Action button */}
              <a className="footer-cta" href={`mailto:${CONTACT_EMAIL}`}>Contact<FooterCurvedArrow /></a>
            </div>
          </FooterShape>
          {/* Outside and below the cream panel */}
          <div className="footer-legal">
            <a href={PRIVACY_URL}>Privacy Policy</a>
            <a href={TERMS_URL}>Terms</a>
            <span>© {new Date().getFullYear()} Phylax</span>
          </div>
        </div>
      </footer>

      {/* Rendered into <body>, above everything. While one is open the page behind it is inert. */}
      <ContactDialog kind={dialog} onClose={closeDialog} returnFocusRef={dialogTriggerRef} />
    </div>
  );
}

export default Home;
