import { useState } from "react";

const STORAGE_KEY = "trip-planner.hint-dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Storage unavailable — the hint will just reappear next visit.
  }
}

interface Props {
  origin: string;
  destination: string;
}

/** One-line, dismissible nudge shown over the map before the pilot
 *  has planned anything. Meant to sit inside a `relative` map
 *  container (`absolute top-3` here). Dismissal is permanent for the
 *  browser/profile — renders null once dismissed. */
export function FirstRunHint({ origin, destination }: Props) {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed) return null;

  function dismiss() {
    writeDismissed();
    setDismissed(true);
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-md border border-hairline bg-card px-3 py-1.5 shadow-md">
        <span className="text-xs text-ink">
          Press <strong className="font-semibold">Plan trip</strong> to route{" "}
          {origin} → {destination}
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss hint"
          className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted hover:text-ink"
        >
          ×
        </button>
      </div>
    </div>
  );
}
