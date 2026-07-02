import type {
  ApproachRequirement,
  HardFilters,
  TowerMode,
} from "@/engine/filters";
import type { FuelType } from "@/data/aircraft";

interface Props {
  filters: HardFilters;
  onChange: (next: HardFilters) => void;
  matchCount: number;
  totalCount: number;
  /** Threaded from App so FilterPanel rerenders when the async data
   *  load completes (the module-level loaders.hasApproachData binding
   *  changes but doesn't trigger React on its own). */
  hasApproachData: boolean;
  /** Selected aircraft's fuel type — drives the label on the fuel
   *  toggle so the user knows what's actually being matched. */
  aircraftFuelType: FuelType;
  /** True when the POH-driven runway check is active for the
   *  current aircraft. When set, the manual "minimum runway length"
   *  control is hidden — the runway check is strictly better
   *  (aircraft- and weight-specific), so layering the manual
   *  cutoff on top would either over-constrain or be ignored. */
  runwayCheckActive: boolean;
}

export function FilterPanel({
  filters,
  onChange,
  matchCount,
  totalCount,
  hasApproachData,
  aircraftFuelType,
  runwayCheckActive,
}: Props) {
  const pct =
    totalCount > 0
      ? Math.round((matchCount / totalCount) * 100)
      : 0;
  return (
    <div className="space-y-4">
      {!runwayCheckActive && (
        <div>
          <label htmlFor="min-runway-ft" className="field-label">
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
            className="input mt-1"
          />
        </div>
      )}
      {runwayCheckActive && (
        <p className="rounded-md border border-brand-100 bg-brand-50 px-2.5 py-1.5 text-[11px] text-brand-800">
          Manual minimum-runway filter is replaced by the POH-driven
          runway check.
        </p>
      )}
      <div>
        <label htmlFor="tower-req" className="field-label">
          Control tower
        </label>
        <select
          id="tower-req"
          value={filters.tower}
          onChange={(e) =>
            onChange({ ...filters, tower: e.target.value as TowerMode })
          }
          className="select mt-1"
        >
          <option value="any">Any</option>
          <option value="required">Towered only</option>
          <option value="forbidden">Non-towered only</option>
        </select>
      </div>
      <div>
        <label htmlFor="approach-req" className="field-label">
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
          className="select mt-1"
        >
          <option value="off">No approach required</option>
          <option value="any">Any IAP (LOC / VOR / LDA / BC / NDB / …)</option>
          <option value="precision">Precision or LPV</option>
          <option value="rnav">RNAV / GPS</option>
        </select>
        {!hasApproachData && (
          <p className="mt-1.5 text-[11px] text-slate-500">
            CIFP data not loaded yet — filter disabled.
          </p>
        )}
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            checked={filters.requireFuel}
            onChange={(e) =>
              onChange({ ...filters, requireFuel: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 rounded border-slate-300"
          />
          <span>
            Airport must sell {aircraftFuelType}
            <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
              Origin and destination are exempt — only intermediate fuel
              stops are constrained.
            </span>
          </span>
        </label>
      </div>
      <div className="rounded-lg bg-slate-50 px-3 py-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-slate-500">Matching airports</span>
          <span className="text-xs font-semibold tabular-nums text-slate-900">
            {matchCount.toLocaleString()}
            <span className="font-normal text-slate-500">
              {" "}
              / {totalCount.toLocaleString()}
            </span>
          </span>
        </div>
        <div
          className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-200"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full bg-brand-500 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
