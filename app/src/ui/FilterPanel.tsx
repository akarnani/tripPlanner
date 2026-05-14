import type {
  ApproachRequirement,
  HardFilters,
  TowerMode,
} from "@/engine/filters";

interface Props {
  filters: HardFilters;
  onChange: (next: HardFilters) => void;
  matchCount: number;
  totalCount: number;
  /** Threaded from App so FilterPanel rerenders when the async data
   *  load completes (the module-level loaders.hasApproachData binding
   *  changes but doesn't trigger React on its own). */
  hasApproachData: boolean;
}

export function FilterPanel({
  filters,
  onChange,
  matchCount,
  totalCount,
  hasApproachData,
}: Props) {
  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor="min-runway-ft"
          className="block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Minimum runway length (ft)
        </label>
        <input
          id="min-runway-ft"
          type="number"
          min={0}
          step={500}
          value={filters.minRunwayFt}
          onChange={(e) =>
            onChange({
              ...filters,
              minRunwayFt: Number.parseInt(e.target.value, 10) || 0,
            })
          }
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        />
      </div>
      <div>
        <label
          htmlFor="tower-req"
          className="block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Control tower
        </label>
        <select
          id="tower-req"
          value={filters.tower}
          onChange={(e) =>
            onChange({ ...filters, tower: e.target.value as TowerMode })
          }
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        >
          <option value="any">Any</option>
          <option value="required">Towered only</option>
          <option value="forbidden">Non-towered only</option>
        </select>
      </div>
      <div>
        <label
          htmlFor="approach-req"
          className="block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Approach
        </label>
        <select
          id="approach-req"
          value={filters.approach}
          disabled={!hasApproachData}
          onChange={(e) =>
            onChange({
              ...filters,
              approach: e.target.value as ApproachRequirement,
            })
          }
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm disabled:bg-slate-100"
        >
          <option value="off">No approach required</option>
          <option value="any">Any IAP (LOC / VOR / LDA / BC / NDB / …)</option>
          <option value="precision">Precision or LPV</option>
          <option value="rnav">RNAV / GPS</option>
        </select>
        {!hasApproachData && (
          <p className="mt-1 text-[11px] text-slate-500">
            CIFP data not loaded yet — filter disabled.
          </p>
        )}
      </div>
      <p className="text-xs text-slate-500">
        {matchCount.toLocaleString()} of {totalCount.toLocaleString()} airports
        match.
      </p>
    </div>
  );
}
