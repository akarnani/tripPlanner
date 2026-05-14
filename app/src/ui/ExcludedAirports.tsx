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
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        Excluded stops
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
      {excludedIds.size > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {[...excludedIds].sort().map((id) => (
            <li key={id}>
              <button
                type="button"
                title={`Allow ${labelFor(id)} as a stop again`}
                onClick={() => onInclude(id)}
                className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-mono text-[11px] text-red-700 hover:bg-red-100"
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
