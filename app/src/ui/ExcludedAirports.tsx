import type { Airport } from "@/data/loaders";

interface Props {
  /** Airport ids the user has excluded. Resolved against `airports`
   *  to display ICAO/LID labels; ids without a matching airport
   *  (stale-data case) are still shown by id so the user can clear
   *  them. */
  excludedIds: ReadonlySet<string>;
  airports: readonly Airport[];
  onInclude: (airportId: string) => void;
}

export function ExcludedAirports({
  excludedIds,
  airports,
  onInclude,
}: Props) {
  if (excludedIds.size === 0) return null;
  const byId = new Map<string, Airport>();
  for (const a of airports) byId.set(a.id, a);

  const labelFor = (id: string) => {
    const a = byId.get(id);
    if (!a) return id;
    return a.icao ?? a.lid;
  };

  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
        Excluded stops
      </p>
      <ul className="flex flex-wrap gap-1">
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
    </div>
  );
}
