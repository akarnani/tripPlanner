import { useState } from "react";
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

export function TripsPanel({
  trips,
  defaultName,
  onSave,
  onLoad,
  onDelete,
}: Props) {
  const [name, setName] = useState("");
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? trips : trips.slice(0, 5);

  function submit() {
    const trimmed = (name || defaultName).trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName("");
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName || "Trip name"}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="input flex-1"
        />
        <button
          type="button"
          onClick={submit}
          className="btn-primary px-3 text-xs"
        >
          Save
        </button>
      </div>
      {trips.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2.5 text-center text-[11px] text-slate-500">
          No saved trips yet. Save the current trip to revisit later.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {visible.map((t) => (
            <li
              key={t.name}
              className="group flex items-center gap-2 px-2.5 py-1.5 text-xs transition hover:bg-slate-50"
            >
              <button
                type="button"
                onClick={() => onLoad(t)}
                className="flex flex-1 items-baseline gap-2 truncate text-left"
                title={`${t.origin} → ${t.destination}, saved ${formatDate(t.savedAt)}`}
              >
                <span className="truncate font-medium text-slate-900 group-hover:text-brand-700">
                  {t.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-slate-500">
                  {t.origin} → {t.destination}
                </span>
              </button>
              <button
                type="button"
                title={`Delete ${t.name}`}
                onClick={() => onDelete(t.name)}
                className="icon-btn icon-btn-danger opacity-0 group-hover:opacity-100"
                aria-label={`Delete ${t.name}`}
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
          className="text-[11px] font-medium text-brand-600 hover:text-brand-800"
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
