import { useEffect, useRef, useState, type ReactNode } from "react";

interface NextAction {
  /** Short label for the next step — rendered inside the Next button
   *  ("Next: Trip →"). Omit to show a bare "Next →". */
  label?: string;
  /** Fires the manual advance. Implementations typically cancel any
   *  pending auto-advance and switch the expanded section. */
  onAdvance: () => void;
}

interface Props {
  /** Optional step number rendered as a circular badge. Omit for
   *  non-step sections (e.g. saved trips, which sits outside the
   *  wizard flow). */
  number?: number;
  title: string;
  /** Compact one-liner shown when the section is collapsed.
   *  Conveys the current selection at a glance so the user doesn't
   *  need to expand the section to see what's set. */
  summary?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** Footer "Next" action — shown only on numbered wizard steps. The
   *  terminal step (Filters) omits this so the footer disappears. */
  next?: NextAction;
  /** Absolute timestamp (Date.now() basis) of the pending auto-
   *  advance, when one is scheduled for this section. The footer
   *  renders a live countdown badge that ticks down to zero, then the
   *  parent's effect fires the advance. Null when no auto-advance is
   *  pending. */
  countdownDeadline?: number | null;
  /** Fired when focus enters or leaves the expanded content. The
   *  parent uses this to pause auto-advance while the user is mid-
   *  edit — yanking a section closed under the cursor would lose the
   *  keystroke they were about to type. React's synthetic focus/blur
   *  bubble (unlike the native events), so a single pair of handlers
   *  on the content wrapper catches every descendant. */
  onFocusedChange?: (focused: boolean) => void;
  children: ReactNode;
}

/** Live ms-remaining counter that re-renders ~10x per second while a
 *  deadline is in the future. Returns null when no deadline is set so
 *  consumers can skip rendering the countdown UI entirely. */
function useCountdown(deadline: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [deadline]);
  if (deadline == null) return null;
  return Math.max(0, deadline - now);
}

/** Collapsible card used to build the sidebar accordion. Highlights
 *  the active step with a brand-blue ring and step badge, smoothly
 *  scrolls into view when it expands, and exposes a footer "Next"
 *  button (with a live countdown chip when auto-advance is pending)
 *  for wizard progression. */
export function SidebarSection({
  number,
  title,
  summary,
  expanded,
  onToggle,
  next,
  countdownDeadline,
  onFocusedChange,
  children,
}: Props) {
  const ref = useRef<HTMLElement>(null);
  const wasExpanded = useRef(expanded);
  const remainingMs = useCountdown(expanded ? countdownDeadline : null);

  useEffect(() => {
    // Only scroll on a false→true transition so a manual collapse
    // doesn't bounce, and the initial mount of the default-expanded
    // section doesn't visibly scroll. block:"nearest" minimizes
    // movement when the section is already in view.
    if (expanded && !wasExpanded.current) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  return (
    <section
      ref={ref}
      className={
        "card overflow-hidden transition " +
        (expanded
          ? "ring-2 ring-brand-200/70 shadow-card-lg"
          : "hover:border-slate-300")
      }
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={title}
        data-section={title}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50/60"
      >
        {number !== undefined && (
          <span
            className={
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition " +
              (expanded
                ? "bg-brand-600 text-white shadow-sm"
                : "bg-slate-100 text-slate-500")
            }
          >
            {number}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div
            className={
              "text-[13px] font-semibold tracking-tight " +
              (expanded ? "text-slate-900" : "text-slate-800")
            }
          >
            {title}
          </div>
          {!expanded && summary !== undefined && summary !== null && (
            <div className="mt-0.5 truncate text-[11px] text-slate-500">
              {summary}
            </div>
          )}
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={
            "h-4 w-4 shrink-0 text-slate-400 transition-transform " +
            (expanded ? "rotate-180" : "")
          }
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {expanded && (
        <div
          className="border-t border-slate-100 p-4"
          onFocus={() => onFocusedChange?.(true)}
          onBlur={(e) => {
            // onBlur fires whenever focus leaves any descendant, even
            // if it moves to a sibling input within the same section.
            // Only emit "unfocused" when relatedTarget (the element
            // about to receive focus) is genuinely outside us.
            if (
              !e.currentTarget.contains(e.relatedTarget as Node | null)
            ) {
              onFocusedChange?.(false);
            }
          }}
        >
          {children}
          {next && (
            <div className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={next.onAdvance}
                className="btn-primary text-xs"
              >
                {next.label ? `Next: ${next.label} →` : "Next →"}
              </button>
              <span className="flex-1" />
              {remainingMs !== null && (
                <span
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] tabular-nums text-slate-600"
                  title="Auto-advancing — any interaction in this section resets the timer"
                  aria-live="polite"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3 w-3 text-slate-400"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 4.5a.75.75 0 011.5 0V8l2.4 1.6a.75.75 0 01-.83 1.25l-2.73-1.82A.75.75 0 017.25 8.5V4.5z"
                      clipRule="evenodd"
                    />
                  </svg>
                  advancing in {(remainingMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
