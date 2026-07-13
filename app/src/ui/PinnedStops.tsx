import { useState } from "react";
import type { Airport } from "@/data/loaders";
import { airportByIdent } from "@/data/loaders";
import type { FuelType } from "@/data/aircraft";
import { airportSellsCompatibleFuel } from "@/engine/filters";
import { AirportLink } from "./AirportLink";

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

  // Reorder by one position. Replaces the old HTML5 drag-and-drop grip,
  // which never fired on touch — up/down controls work with a finger or
  // the keyboard, and the pinned list is short enough that single-step
  // moves are fine.
  function moveStop(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= pinnedIds.length) return;
    const next = [...pinnedIds];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next);
  }

  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">
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
          className="w-full rounded border border-hairline-input bg-card px-2 py-1 font-mono text-xs uppercase text-ink"
        />
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded border border-hairline-input bg-card px-2 py-1 text-xs text-ink hover:bg-surface"
        >
          Add
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      {pinnedIds.length > 0 && (
        <ol className="mt-2 space-y-1">
          {pinnedIds.map((id, i) => {
            const a = byId.get(id);
            const hasFuel = a
              ? airportSellsCompatibleFuel(a, aircraftFuelType)
              : true; // unknown airport: don't second-guess the user
            return (
              <li
                key={id}
                className="flex items-center gap-1 rounded border border-hairline bg-card px-2 py-1 text-xs"
              >
                <div className="-ml-1 flex flex-col text-muted">
                  <button
                    type="button"
                    onClick={() => moveStop(i, -1)}
                    disabled={i === 0}
                    title={`Move ${labelFor(id)} up`}
                    aria-label={`Move ${labelFor(id)} up`}
                    className="flex h-3.5 w-6 items-center justify-center leading-none hover:text-ink disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStop(i, 1)}
                    disabled={i === pinnedIds.length - 1}
                    title={`Move ${labelFor(id)} down`}
                    aria-label={`Move ${labelFor(id)} down`}
                    className="flex h-3.5 w-6 items-center justify-center leading-none hover:text-ink disabled:opacity-30"
                  >
                    ▼
                  </button>
                </div>
                <span className="w-4 text-right text-muted">{i + 1}.</span>
                <span className="font-mono">
                  <AirportLink ident={labelFor(id)} />
                </span>
                {!hasFuel && (
                  <span
                    title={`Doesn't stock ${aircraftFuelType} — treated as a pass-through, fuel state carries through`}
                    className="rounded bg-[color-mix(in_srgb,var(--caution)_15%,transparent)] px-1 text-xs font-medium uppercase tracking-wide text-caution"
                  >
                    no fuel
                  </span>
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => onRemove(id)}
                  title={`Unpin ${labelFor(id)}`}
                  className="tap-target inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-danger"
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
