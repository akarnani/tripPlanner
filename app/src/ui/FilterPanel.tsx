import type {
  ApproachRequirement,
  HardFilters,
  TowerMode,
} from "@/engine/filters";
import type { FuelType } from "@/data/aircraft";
import { Select } from "./Select";

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
  return (
    <div className="space-y-4">
      {!runwayCheckActive && (
        <div>
          <label
            htmlFor="min-runway-ft"
            className="block text-xs font-medium uppercase tracking-wide text-muted"
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
            className="mt-1 w-full rounded border border-hairline-input bg-card px-2 py-1 text-sm text-ink"
          />
        </div>
      )}
      {runwayCheckActive && (
        <p className="text-xs text-muted">
          Manual minimum-runway filter is replaced by the POH-driven
          runway check (above).
        </p>
      )}
      <div>
        <label
          htmlFor="tower-req"
          className="block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Control tower
        </label>
        <div className="mt-1">
          <Select
            id="tower-req"
            value={filters.tower}
            onChange={(v) => onChange({ ...filters, tower: v as TowerMode })}
            options={[
              { value: "any", label: "Any" },
              { value: "required", label: "Towered only" },
              { value: "forbidden", label: "Non-towered only" },
            ]}
            className="w-full rounded border border-hairline-input bg-card px-2 py-1 text-sm text-ink"
          />
        </div>
      </div>
      <div>
        <label
          htmlFor="approach-req"
          className="block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Approach
        </label>
        <div className="mt-1">
          <Select
            id="approach-req"
            value={filters.approach}
            disabled={!hasApproachData}
            onChange={(v) =>
              onChange({ ...filters, approach: v as ApproachRequirement })
            }
            options={[
              { value: "off", label: "No approach required" },
              {
                value: "any",
                label: "Any IAP (LOC / VOR / LDA / BC / NDB / …)",
              },
              { value: "precision", label: "Precision or LPV" },
              { value: "rnav", label: "RNAV / GPS" },
            ]}
            className="w-full rounded border border-hairline-input bg-card px-2 py-1 text-sm text-ink disabled:bg-surface"
          />
        </div>
        {!hasApproachData && (
          <p className="mt-1 text-xs text-muted">
            CIFP data not loaded yet — filter disabled.
          </p>
        )}
      </div>
      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={filters.requireFuel}
            onChange={(e) =>
              onChange({ ...filters, requireFuel: e.target.checked })
            }
            className="h-4 w-4 rounded border-hairline-input"
          />
          Airport must sell {aircraftFuelType}
        </label>
        <p className="mt-1 text-xs text-muted">
          Origin and destination are exempt — only intermediate fuel
          stops are constrained.
        </p>
      </div>
      <p className="text-xs text-muted">
        {matchCount.toLocaleString()} of {totalCount.toLocaleString()} airports
        match.
      </p>
    </div>
  );
}
