import type { Aircraft } from "@/data/aircraft";
import { Select } from "./Select";

interface Props {
  aircraft: readonly Aircraft[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  targetAltFt: number;
  onTargetAltChange: (alt: number) => void;
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
  reserveMin,
  onReserveChange,
  startingFuelGal,
  onStartingFuelChange,
  capacityGal,
}: Props) {
  return (
    <div className="space-y-3">
      <div>
        <label className="field-label">
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
            className="w-full input text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-x-2 gap-y-1">
        <label
          htmlFor="target-altitude"
          className="field-label"
        >
          Target altitude (ft)
        </label>
        <label
          htmlFor="reserve-min"
          className="field-label"
        >
          Reserve (min)
        </label>
        <label
          htmlFor="starting-fuel"
          className="field-label"
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
          className="w-full input font-mono text-sm"
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
          className="w-full input font-mono text-sm"
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
          className="w-full input font-mono text-sm"
        />
      </div>
      <div aria-hidden="true">
        <div className="mb-1 flex justify-between text-[11px] text-muted">
          <span>Fuel on board</span>
          <span className="font-mono">
            {Math.min(startingFuelGal, capacityGal).toFixed(0)} / {capacityGal} gal
          </span>
        </div>
        <div className="meter">
          <span
            style={{
              width: `${capacityGal > 0 ? Math.max(0, Math.min(100, (startingFuelGal / capacityGal) * 100)) : 0}%`,
            }}
          />
        </div>
      </div>
      <p className="text-xs text-muted">
        Each leg flies the next legal hemispheric altitude at or above
        target altitude for its course.
      </p>
      <p className="text-xs text-muted">
        Fuel onboard at departure. Capped at {capacityGal} gal (full
        tanks). Only the first leg uses this; refuel stops imply a
        top-off.
      </p>
    </div>
  );
}
