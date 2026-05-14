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
          className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={submit}
          className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-800"
        >
          Save
        </button>
      </div>
      {trips.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          No saved trips yet. Save the current trip to revisit later.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {visible.map((t) => (
            <li
              key={t.name}
              className="flex items-center gap-2 px-2 py-1 text-xs"
            >
              <button
                type="button"
                onClick={() => onLoad(t)}
                className="flex-1 truncate text-left text-slate-800 hover:underline"
                title={`${t.origin} → ${t.destination}, saved ${formatDate(t.savedAt)}`}
              >
                <span className="font-medium">{t.name}</span>{" "}
                <span className="text-slate-500">
                  · {t.origin} → {t.destination}
                </span>
              </button>
              <button
                type="button"
                title={`Delete ${t.name}`}
                onClick={() => onDelete(t.name)}
                className="rounded px-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
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
          className="text-[11px] text-slate-500 hover:underline"
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
