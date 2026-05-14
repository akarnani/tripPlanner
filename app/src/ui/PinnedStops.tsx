import { useState } from "react";
import type { Airport } from "@/data/loaders";
import { airportByIdent } from "@/data/loaders";
import type { FuelType } from "@/data/aircraft";
import { airportSellsCompatibleFuel } from "@/engine/filters";

interface Props {
  /** Ordered list of airport ids the user has pinned as required
   *  intermediate stops. */
  pinnedIds: readonly string[];
  airports: readonly Airport[];
  /** Used to flag pinned airports that don't stock the aircraft's fuel
   *  type — those are pass-through waypoints, not refuel stops. */
  aircraftFuelType: FuelType;
  /** Origin/destination idents to reject collisions on input. */
  originIdent: string;
  destinationIdent: string;
  /** Append one or more airport ids to the pin list. Called once per
   *  submit (even when the user types multiple ICAOs) so the planner
   *  only re-runs once. */
  onAdd: (airportIds: string[]) => void;
  onRemove: (airportId: string) => void;
  /** Replace the entire ordered pinned list. Called once on drop. */
  onReorder: (nextPinnedIds: string[]) => void;
}

export function PinnedStops({
  pinnedIds,
  airports,
  aircraftFuelType,
  originIdent,
  destinationIdent,
  onAdd,
  onRemove,
  onReorder,
}: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Index of the row whose grip handle is currently being dragged, or
  // null when no drag is in progress. dragOverIndex is the row the
  // cursor is hovering over while dragging — used for a visible
  // drop-target outline.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const byId = new Map<string, Airport>();
  for (const a of airports) byId.set(a.id, a);

  const labelFor = (id: string) => {
    const a = byId.get(id);
    return a ? (a.icao ?? a.lid) : id;
  };

  function submit() {
    const raw = draft.trim();
    if (!raw) return;
    // Accept space- or comma-delimited lists so users can paste a
    // route segment in one go (e.g. "KSEA KGEG KBOI" or
    // "KSEA, KGEG, KBOI"). Validate each token independently; invalid
    // tokens are reported but don't block the valid ones.
    const tokens = raw.split(/[\s,]+/).filter((t) => t.length > 0);
    const origin = originIdent.toUpperCase();
    const dest = destinationIdent.toUpperCase();
    const toAdd: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      const u = token.toUpperCase();
      if (u === origin || u === dest) {
        invalid.push(`${u} (origin/destination)`);
        continue;
      }
      const a = airportByIdent(airports, token);
      if (!a) {
        invalid.push(`${u} (unknown)`);
        continue;
      }
      if (pinnedIds.includes(a.id) || seen.has(a.id)) continue;
      seen.add(a.id);
      toAdd.push(a.id);
    }
    if (toAdd.length > 0) {
      onAdd(toAdd);
      // Only clear the input once at least one waypoint landed, so a
      // typo doesn't silently swallow what the user was typing.
      setDraft("");
    }
    setError(invalid.length > 0 ? `couldn't add: ${invalid.join(", ")}` : null);
  }

  function dropAt(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    const next = [...pinnedIds];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next);
  }

  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        Required stops (via)
      </p>
      <div className="flex gap-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value.toUpperCase());
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="KICAO or KSEA KGEG KBOI"
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs uppercase"
        />
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-100"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
      {pinnedIds.length > 0 && (
        <ol className="mt-2 space-y-1">
          {pinnedIds.map((id, i) => {
            const a = byId.get(id);
            const hasFuel = a
              ? airportSellsCompatibleFuel(a, aircraftFuelType)
              : true; // unknown airport: don't second-guess the user
            const isDragging = dragIndex === i;
            const isDropTarget =
              dragOverIndex === i && dragIndex !== null && dragIndex !== i;
            return (
              <li
                key={id}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverIndex !== i) setDragOverIndex(i);
                }}
                onDragLeave={() => {
                  if (dragOverIndex === i) setDragOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropAt(i);
                  setDragIndex(null);
                  setDragOverIndex(null);
                }}
                className={
                  "flex items-center gap-1 rounded border bg-white px-2 py-1 text-xs transition-colors " +
                  (isDropTarget
                    ? "border-orange-400 ring-1 ring-orange-200"
                    : "border-slate-200") +
                  (isDragging ? " opacity-50" : "")
                }
              >
                <span
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = "move";
                    // Drag the whole row visually, not just the grip
                    // handle. parentElement is the <li>; falling back
                    // to the handle itself keeps the drag working if
                    // the DOM ever shifts.
                    const row = e.currentTarget.parentElement;
                    if (row) e.dataTransfer.setDragImage(row, 0, 0);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDragOverIndex(null);
                  }}
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  className="-ml-1 cursor-grab px-1 text-slate-400 hover:text-slate-700 active:cursor-grabbing"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3 w-3"
                    aria-hidden="true"
                  >
                    <circle cx="5" cy="3" r="1.2" />
                    <circle cx="11" cy="3" r="1.2" />
                    <circle cx="5" cy="8" r="1.2" />
                    <circle cx="11" cy="8" r="1.2" />
                    <circle cx="5" cy="13" r="1.2" />
                    <circle cx="11" cy="13" r="1.2" />
                  </svg>
                </span>
                <span className="w-4 text-right text-slate-400">{i + 1}.</span>
                <span className="font-mono">{labelFor(id)}</span>
                {!hasFuel && (
                  <span
                    title={`Doesn't stock ${aircraftFuelType} — treated as a pass-through, fuel state carries through`}
                    className="rounded bg-amber-100 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-800"
                  >
                    no fuel
                  </span>
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  title={`Unpin ${labelFor(id)}`}
                  className="rounded px-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
