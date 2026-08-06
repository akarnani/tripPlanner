import type { Aircraft } from "@/data/aircraft";
import { Select } from "./Select";

interface Props {
  aircraft: readonly Aircraft[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  targetAltFt: number;
  onTargetAltChange: (alt: number) => void;
  /** Optional hard ceiling: for pilots who can't climb higher because
   *  of icing, oxygen, or a layer, and would rather be told no route
   *  exists than be handed one they can't fly. */
  capAltitude: boolean;
  onCapAltitudeChange: (on: boolean) => void;
  maxAltFt: number;
  onMaxAltChange: (ft: number) => void;
  reserveMin: number;
  onReserveChange: (min: number) => void;
  startingFuelGal: number;
  onStartingFuelChange: (gal: number) => void;
  /** Max usable fuel for the selected aircraft (display + clamp). */
  capacityGal: number;
}

export function AircraftPanel({
  aircraft,
  selectedSlug,
  onSelect,
  targetAltFt,
  onTargetAltChange,
  capAltitude,
  onCapAltitudeChange,
  maxAltFt,
  onMaxAltChange,
  reserveMin,
  onReserveChange,
  startingFuelGal,
  onStartingFuelChange,
  capacityGal,
}: Props) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-muted">
          Aircraft
        </label>
        <div className="mt-1">
          <Select
            ariaLabel="Aircraft"
            value={selectedSlug}
            onChange={onSelect}
            options={aircraft.map((a) => ({
              value: a.slug,
              label: `${a.make} ${a.model}`,
            }))}
            className="w-full rounded border border-hairline-input bg-card px-2 py-1 text-sm text-ink"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        <label
          htmlFor="target-altitude"
          className="block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Target altitude (ft)
        </label>
        <label
          htmlFor="reserve-min"
          className="block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Reserve (min)
        </label>
        <label
          htmlFor="starting-fuel"
          className="block text-xs font-medium uppercase tracking-wide text-muted"
        >
          Start fuel (gal)
        </label>
        <input
          id="target-altitude"
          type="number"
          min={0}
          // Goes up to FL450 to cover any current or future turbine;
          // below FL180 the +500 VFR convention applies, above it the
          // value clamps to the next legal IFR thousand at planning
          // time (see hemisphericAltitude).
          max={45000}
          step={500}
          value={targetAltFt}
          onChange={(e) =>
            onTargetAltChange(Number.parseInt(e.target.value, 10) || 0)
          }
          className="w-full rounded border border-hairline-input bg-card px-2 py-1 font-mono text-sm text-ink"
        />
        <input
          id="reserve-min"
          type="number"
          min={0}
          step={5}
          value={reserveMin}
          onChange={(e) =>
            onReserveChange(Number.parseInt(e.target.value, 10) || 0)
          }
          className="w-full rounded border border-hairline-input bg-card px-2 py-1 font-mono text-sm text-ink"
        />
        <input
          id="starting-fuel"
          type="number"
          min={0}
          max={capacityGal}
          step={1}
          value={startingFuelGal}
          onChange={(e) =>
            onStartingFuelChange(Number.parseFloat(e.target.value) || 0)
          }
          className="w-full rounded border border-hairline-input bg-card px-2 py-1 font-mono text-sm text-ink"
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          id="cap-altitude"
          type="checkbox"
          checked={capAltitude}
          onChange={(e) => onCapAltitudeChange(e.target.checked)}
        />
        <label htmlFor="cap-altitude" className="text-xs text-ink">
          Stay at or below
        </label>
        <input
          id="max-altitude"
          type="number"
          aria-label="Maximum altitude (ft)"
          min={0}
          max={45000}
          step={500}
          disabled={!capAltitude}
          value={maxAltFt}
          onChange={(e) =>
            onMaxAltChange(Number.parseInt(e.target.value, 10) || 0)
          }
          className="w-24 rounded border border-hairline-input bg-card px-2 py-1 font-mono text-sm text-ink disabled:opacity-40"
        />
        <span className="text-xs text-muted">ft</span>
      </div>
      <p className="text-xs text-muted">
        {capAltitude
          ? "Each leg flies the highest legal hemispheric altitude at or below the ceiling. Legs that can't clear terrain underneath it are dropped, so a route may not exist \u2014 which is the point. A leg into a field higher than the ceiling is flown above it and flagged."
          : "Each leg flies the next legal hemispheric altitude at or above target altitude for its course."}
      </p>
      <p className="text-xs text-muted">
        Fuel onboard at departure. Capped at {capacityGal} gal (full
        tanks). Only the first leg uses this; refuel stops imply a
        top-off.
      </p>
    </div>
  );
}
