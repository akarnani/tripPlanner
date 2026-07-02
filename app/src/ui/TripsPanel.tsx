import { useEffect, useRef, useState } from "react";
import type { SavedTrip } from "@/data/trips";

interface Props {
  trips: SavedTrip[];
  /** Default name suggestion in the save input, e.g. the current
   *  origin → destination pair. */
  defaultName: string;
  onSave: (name: string) => void;
  onLoad: (trip: SavedTrip) => void;
  onDelete: (name: string) => void;
}

const SAVED_FLASH_MS = 1500;

export function TripsPanel({
  trips,
  defaultName,
  onSave,
  onLoad,
  onDelete,
}: Props) {
  const [name, setName] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const flashTimer = useRef<number>();
  const visible = showAll ? trips : trips.slice(0, 5);

  useEffect(() => {
    return () => {
      if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    };
  }, []);

  function submit() {
    const trimmed = (name || defaultName).trim();
    if (!trimmed) return;
    const overwriting = trips.some((t) => t.name === trimmed);
    if (
      overwriting &&
      !window.confirm(`A saved trip named "${trimmed}" already exists. Overwrite it?`)
    ) {
      return;
    }
    onSave(trimmed);
    setName("");
    setJustSaved(true);
    if (flashTimer.current !== undefined) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setJustSaved(false), SAVED_FLASH_MS);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName || "Trip name"}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="flex-1 rounded border border-hairline-input bg-card px-2 py-1 text-xs text-ink"
        />
        <button
          type="button"
          onClick={submit}
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:opacity-90"
        >
          {justSaved ? "Saved ✓" : "Save"}
        </button>
      </div>
      {trips.length === 0 ? (
        <p className="text-xs text-muted">
          No saved trips yet. Save the current trip to revisit later.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded border border-hairline bg-card">
          {visible.map((t) => (
            <li
              key={t.name}
              className="flex items-center gap-2 px-2 py-1.5 text-xs"
            >
              <button
                type="button"
                onClick={() => onLoad(t)}
                className="flex-1 truncate text-left text-ink hover:underline"
                title={`${t.origin} → ${t.destination}, saved ${formatDate(t.savedAt)}`}
              >
                <div>
                  <span className="font-medium">{t.name}</span>{" "}
                  <span className="text-muted">
                    · {t.origin} → {t.destination}
                  </span>
                </div>
                {t.routeSummary && (
                  <div className="text-muted">
                    {t.routeSummary.stopIdents.length} stop
                    {t.routeSummary.stopIdents.length === 1 ? "" : "s"} ·{" "}
                    {Math.round(t.routeSummary.distance_nm)} nm ·{" "}
                    {t.routeSummary.time_hr.toFixed(1)} hr
                  </div>
                )}
              </button>
              <button
                type="button"
                title={`Delete ${t.name}`}
                aria-label={`Delete ${t.name}`}
                onClick={() => onDelete(t.name)}
                className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:text-danger"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {trips.length > 5 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-muted hover:underline"
        >
          {showAll ? "Show fewer" : `Show all ${trips.length}`}
        </button>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
