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
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Aircraft
        </label>
        <select
          value={selectedSlug}
          onChange={(e) => onSelect(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
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
          {/* Labels in row 1, inputs in row 2 so the two columns'
              inputs share a y-position even when "Target altitude
              (ft)" wraps and "Reserve (min)" doesn't. */}
          <label
            htmlFor="target-altitude"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            Target altitude (ft)
          </label>
          <label
            htmlFor="reserve-min"
            className="block text-xs font-medium uppercase tracking-wide text-slate-500"
          >
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
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
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
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          Each leg flies the next legal hemispheric altitude at or above
          target altitude for its course.
        </p>
      </div>
      <div>
        <label
          htmlFor="starting-fuel"
          className="block text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Starting fuel (gal)
        </label>
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
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        />
        <p className="mt-1 text-[11px] text-slate-500">
          Fuel onboard at departure. Capped at {capacityGal} gal (full
          tanks). Only the first leg uses this; refuel stops imply a
          top-off.
        </p>
      </div>
    </div>
  );
}
