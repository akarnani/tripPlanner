import { useState } from "react";
import type { Airport } from "@/data/loaders";
import { airportByIdent } from "@/data/loaders";

interface Props {
  /** Airport ids the user has excluded. Resolved against `airports`
   *  to display ICAO/LID labels; ids without a matching airport
   *  (stale-data case) are still shown by id so the user can clear
   *  them. */
  excludedIds: ReadonlySet<string>;
  airports: readonly Airport[];
  /** Origin/destination idents to reject collisions on input. */
  originIdent: string;
  destinationIdent: string;
  /** Append one or more airport ids to the exclusion set. Called once
   *  per submit so the planner only re-runs once. */
  onExclude: (airportIds: string[]) => void;
  onInclude: (airportId: string) => void;
}

export function ExcludedAirports({
  excludedIds,
  airports,
  originIdent,
  destinationIdent,
  onExclude,
  onInclude,
}: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const byId = new Map<string, Airport>();
  for (const a of airports) byId.set(a.id, a);

  const labelFor = (id: string) => {
    const a = byId.get(id);
    if (!a) return id;
    return a.icao ?? a.lid;
  };

  function submit() {
    const raw = draft.trim();
    if (!raw) return;
    // Accept space- or comma-delimited lists, same as the
    // required-stops input.
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
      if (excludedIds.has(a.id) || seen.has(a.id)) continue;
      seen.add(a.id);
      toAdd.push(a.id);
    }
    if (toAdd.length > 0) {
      onExclude(toAdd);
      setDraft("");
    }
    setError(invalid.length > 0 ? `couldn't exclude: ${invalid.join(", ")}` : null);
  }

  return (
    <div>
      <p className="field-label mb-1.5">Excluded stops</p>
      <div className="flex gap-2">
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
          className="input input-mono flex-1 text-xs"
        />
        <button
          type="button"
          onClick={submit}
          className="btn-secondary shrink-0 px-3 text-xs"
        >
          Add
        </button>
      </div>
      {error && (
        <p className="mt-1.5 text-[11px] text-rose-600">{error}</p>
      )}
      {excludedIds.size > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {[...excludedIds].sort().map((id) => (
            <li key={id}>
              <button
                type="button"
                title={`Allow ${labelFor(id)} as a stop again`}
                onClick={() => onInclude(id)}
                className="chip-danger transition"
              >
                {labelFor(id)} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
