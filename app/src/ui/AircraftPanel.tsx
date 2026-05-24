import type { Aircraft } from "@/data/aircraft";

interface Props {
  aircraft: readonly Aircraft[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
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
        <label htmlFor="reserve-min" className="field-label">
          Reserve (min)
        </label>
        <input
          id="reserve-min"
          type="number"
          min={0}
          step={5}
          value={reserveMin}
          onChange={(e) =>
            onReserveChange(Number.parseInt(e.target.value, 10) || 0)
          }
          className="input mt-1"
        />
        <p className="mt-1.5 text-[11px] text-slate-500">
          Time-on-board fuel reserve above the planned route — added to
          every leg's minimum-fuel check.
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
      <p className="rounded-md border border-brand-100 bg-brand-50 px-2.5 py-2 text-[11px] text-brand-800">
        Cruise altitude moved to the results pane — adjust it once you see
        the route, since stop choice often dictates the right level.
      </p>
    </div>
  );
}
