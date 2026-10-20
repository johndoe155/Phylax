import { MarkerWrite } from "@/components/MarkerWrite";
import { useInViewOnce } from "@/hooks/useInViewOnce";

/**
 * The footer's wordmark with the "Shifts." kicker written across its top (see .footer-kicker in index.css).
 *
 * The kicker is written, fast, the moment this block (the wordmark and the kicker over it) scrolls into view. The block is what is
 * observed rather than the kicker alone, so the writing starts as soon as the lockup shows, not only once the small note itself has.
 */
export function FooterBrand() {
  const [ref, inView] = useInViewOnce<HTMLDivElement>();
  return (
    <div className="footer-brand" ref={ref}>
      <span className="footer-wordmark">PHY<em>LAX</em></span>
      <MarkerWrite className="footer-kicker" speed="fast" active={inView}>Shifts.</MarkerWrite>
    </div>
  );
}
