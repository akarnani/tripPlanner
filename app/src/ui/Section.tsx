import { useState, type ReactNode } from "react";

function storageKey(id: string): string {
  return `trip-planner.section.${id}`;
}

function readOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw === null) return defaultOpen;
    return raw === "1";
  } catch {
    return defaultOpen;
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(storageKey(id), open ? "1" : "0");
  } catch {
    // Storage unavailable — open state just won't persist.
  }
}

interface Props {
  /** localStorage key part: persisted as `trip-planner.section.<id>`. */
  id: string;
  title: string;
  /** Chip shown in the header when collapsed. */
  summary?: string;
  /** Default true; false renders a plain always-open section with no
   *  toggle affordance. */
  collapsible?: boolean;
  /** Default false. Only consulted the first time this id is seen —
   *  after that, localStorage wins. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Accordion section used to group sidebar controls (runway check,
 *  airport filters, …). Open/closed state persists per `id`. */
export function Section({
  id,
  title,
  summary,
  collapsible = true,
  defaultOpen = false,
  children,
}: Props) {
  const [open, setOpen] = useState(() =>
    collapsible ? readOpen(id, defaultOpen) : true,
  );

  function toggle() {
    if (!collapsible) return;
    setOpen((prev) => {
      const next = !prev;
      writeOpen(id, next);
      return next;
    });
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        disabled={!collapsible}
        className={
          "flex min-h-[24px] w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors " +
          (collapsible ? "hover:bg-surface" : "cursor-default")
        }
      >
        <span className="text-[13px] font-semibold tracking-tight text-ink">{title}</span>
        <span className="flex items-center gap-2">
          {!open && summary && (
            <span className="rounded-full border border-hairline bg-surface px-2 py-0.5 text-[11px] text-muted">
              {summary}
            </span>
          )}
          {collapsible && (
            <span
              aria-hidden="true"
              className={
                "inline-flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted transition-transform " +
                (open ? "rotate-90" : "")
              }
            >
              ▸
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-hairline px-4 py-3.5">{children}</div>
      )}
    </div>
  );
}
