/** The Phylax mark: a shield whose interior is a vital-signs trace. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg
        viewBox="0 0 32 36"
        className="h-6 w-[22px] shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M16 1.6 30 7v11.4C30 27.4 24.2 32.9 16 34.9 7.8 32.9 2 27.4 2 18.4V7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M8 18.2h4.2l2.3-5.4 3 10.4 2-5h4.5"
          fill="none"
          stroke="var(--color-sentinel)"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="font-display text-[15px] font-extrabold tracking-[0.22em] text-bone uppercase"
        style={{ fontStretch: '118%' }}
      >
        Phylax
      </span>
    </span>
  )
}
