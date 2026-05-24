import { useEffect, useRef, type ReactNode } from "react";

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
  /** Optional footer "Continue →" action. Implementations typically
   *  pass a handler that collapses this section and expands the next
   *  one in the wizard. */
  onContinue?: () => void;
  continueLabel?: string;
  children: ReactNode;
}

/** Collapsible card used to build the sidebar accordion. Highlights
 *  the active step with a brand-blue ring and step badge, smoothly
 *  scrolls into view when it expands, and exposes an optional
 *  "Continue →" footer for wizard advancement. */
export function SidebarSection({
  number,
  title,
  summary,
  expanded,
  onToggle,
  onContinue,
  continueLabel = "Continue →",
  children,
}: Props) {
  const ref = useRef<HTMLElement>(null);
  const wasExpanded = useRef(expanded);

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
        <div className="border-t border-slate-100 p-4">
          {children}
          {onContinue && (
            <div className="mt-4 flex justify-end border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={onContinue}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 transition hover:text-brand-800"
              >
                {continueLabel}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
