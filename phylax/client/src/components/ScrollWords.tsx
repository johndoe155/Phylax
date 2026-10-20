import { useRef, type RefObject } from "react";
import { SCROLL_WORDS, useScrollWords } from "@/hooks/useScrollWords";

/**
 * The word that changes in "Not another ___": calendar. → schedule. → roster. → timesheet., bound to scroll
 * (see hooks/useScrollWords.ts). `triggerRef` is the element whose position in the viewport drives it: the headline.
 *
 * Markup: a one-word-tall window (`.scroll-words`) over a stack of the words with the first repeated at the end,
 * so the stack can finish where it started. The stack is decorative; assistive tech gets the one fixed word, so the
 * headline reads as it always has and nothing is announced as the words change. With no JS, or reduced motion, the
 * window simply shows the first word.
 */
export function ScrollWords({ triggerRef }: { triggerRef: RefObject<HTMLElement | null> }) {
  const trackRef = useRef<HTMLSpanElement>(null);
  useScrollWords(triggerRef, trackRef);
  return (
    <span className="scroll-words">
      <span className="sr-only">{SCROLL_WORDS[0]}</span>
      <span className="scroll-words-track" ref={trackRef} aria-hidden="true">
        {[...SCROLL_WORDS, SCROLL_WORDS[0]].map((word, i) => (
          <span className="scroll-words-item" key={i}>{word}</span>
        ))}
      </span>
    </span>
  );
}
