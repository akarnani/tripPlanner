import type { Aircraft } from "@/data/aircraft";

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
  const fuelPct = capacityGal > 0
    ? Math.min(100, Math.max(0, (startingFuelGal / capacityGal) * 100))
    : 0;
  return (
    <div className="space-y-4">
      <div>
        <label className="field-label">Aircraft</label>
        <select
          value={selectedSlug}
          onChange={(e) => onSelect(e.target.value)}
          className="select mt-1"
        >
          {aircraft.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.make} {a.model}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <label htmlFor="target-altitude" className="field-label">
            Target altitude (ft)
          </label>
          <label htmlFor="reserve-min" className="field-label">
            Reserve (min)
          </label>
          <input
            id="target-altitude"
            type="number"
            min={0}
            // Goes up to FL450 to cover any current or future
            // turbine; below FL180 the +500 VFR convention applies,
            // above it the value clamps to the next legal IFR
            // thousand at planning time (see hemisphericAltitude).
            max={45000}
            step={500}
            value={targetAltFt}
            onChange={(e) =>
              onTargetAltChange(Number.parseInt(e.target.value, 10) || 0)
            }
            className="input"
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
            className="input"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          Each leg flies the next legal hemispheric altitude at or above
          target altitude for its course.
        </p>
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="starting-fuel" className="field-label">
            Starting fuel (gal)
          </label>
          <span className="text-[11px] tabular-nums text-slate-500">
            {startingFuelGal.toFixed(1)} / {capacityGal} gal
          </span>
        </div>
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
          className="input mt-1"
        />
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-600 transition-[width]"
            style={{ width: `${fuelPct}%` }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          Fuel onboard at departure. Capped at {capacityGal} gal (full
          tanks). Only the first leg uses this; refuel stops imply a
          top-off.
        </p>
      </div>
    </div>
  );
}
