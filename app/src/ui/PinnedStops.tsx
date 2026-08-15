import { useState } from "react";
import type { Airport, NavPoint } from "@/data/loaders";
import { resolveWaypointIdent, navPointLabel } from "@/engine/navPoints";
import type { FuelType } from "@/data/aircraft";
import { airportSellsCompatibleFuel } from "@/engine/filters";
import { AirportLink } from "./AirportLink";

interface Props {
  /** Ordered list of airport ids the user has pinned as required
   *  intermediate stops. */
  pinnedIds: readonly string[];
  airports: readonly Airport[];
  /** Nav points by ident, for resolving typed VOR / fix identifiers. */
  navPointsByIdent: ReadonlyMap<string, readonly NavPoint[]>;
  /** Nav points by id, for labelling the pinned list. */
  navPointsById: ReadonlyMap<string, NavPoint>;
  /** Used to flag pinned airports that don't stock the aircraft's fuel
   *  type — those are pass-through waypoints, not refuel stops. */
  aircraftFuelType: FuelType;
  /** Origin/destination idents to reject collisions on input. */
  originIdent: string;
  destinationIdent: string;
  /** Append one or more airport ids to the pin list. Called once per
   *  submit (even when the user types multiple ICAOs) so the planner
   *  only re-runs once. */
  onAdd: (waypointIds: string[]) => void;
  onRemove: (waypointId: string) => void;
  /** Replace the entire ordered pinned list. Called once on drop. */
  onReorder: (nextPinnedIds: string[]) => void;
}

export function PinnedStops({
  pinnedIds,
  airports,
  navPointsByIdent,
  navPointsById,
  aircraftFuelType,
  originIdent,
  destinationIdent,
  onAdd,
  onRemove,
  onReorder,
}: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A collision note ("you got the airport") is information, not a
  // failure, and must not render in the danger colour.
  const [note, setNote] = useState<string | null>(null);

  const byId = new Map<string, Airport>();
  for (const a of airports) byId.set(a.id, a);

  const labelFor = (id: string) => {
    const a = byId.get(id);
    if (a) return a.icao ?? a.lid;
    const p = navPointsById.get(id);
    return p ? p.ident : id;
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
    const collisions: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      const u = token.toUpperCase();
      if (u === origin || u === dest) {
        invalid.push(`${u} (origin/destination)`);
        continue;
      }
      // Airports win a shared ident (479 navaids collide with an
      // airport's ICAO or LID), but the losing nav point is reported
      // so the pilot can see they got KBOI rather than the Boise
      // VORTAC and correct it if that isn't what they meant.
      const r = resolveWaypointIdent(u, airports, navPointsByIdent);
      if (!r) {
        invalid.push(`${u} (unknown)`);
        continue;
      }
      const a = r.kind === "airport" ? r.airport! : r.navPoint!;
      if (r.alsoNavPoint) {
        collisions.push(`${u} → airport (also ${navPointLabel(r.alsoNavPoint)})`);
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
    setNote(collisions.length > 0 ? `resolved ${collisions.join("; ")}` : null);
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
            setNote(null);
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
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
      {pinnedIds.length > 0 && (
        <ol className="mt-2 space-y-1">
          {pinnedIds.map((id, i) => {
            const a = byId.get(id);
            const navPoint = navPointsById.get(id);
            const hasFuel =
              a && !navPoint
                ? airportSellsCompatibleFuel(a, aircraftFuelType)
                : true; // nav point or unknown: no fuel claim to make
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
                  {navPoint ? labelFor(id) : <AirportLink ident={labelFor(id)} />}
                </span>
                {navPoint && (
                  <span
                    title={`${navPointLabel(navPoint)} — shapes the leg's track, not a stop`}
                    className="rounded bg-[color-mix(in_srgb,var(--muted)_15%,transparent)] px-1 text-xs font-medium uppercase tracking-wide text-muted"
                  >
                    overfly
                  </span>
                )}
                {!navPoint && !hasFuel && (
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
