import type { Aircraft } from "@/data/aircraft";
import type { RangeOutput } from "@/engine/performance";

interface Props {
  aircraft: readonly Aircraft[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  altitude_ft: number;
  onAltitudeChange: (alt: number) => void;
  reserve_min: number;
  onReserveChange: (min: number) => void;
  range: RangeOutput;
}

export function AircraftPanel({
  aircraft,
  selectedSlug,
  onSelect,
  altitude_ft,
  onAltitudeChange,
  reserve_min,
  onReserveChange,
  range,
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
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Cruise altitude (ft)
          </label>
          <input
            type="number"
            min={0}
            max={18000}
            step={500}
            value={altitude_ft}
            onChange={(e) =>
              onAltitudeChange(Number.parseInt(e.target.value, 10) || 0)
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Reserve (min)
          </label>
          <input
            type="number"
            min={0}
            step={5}
            value={reserve_min}
            onChange={(e) =>
              onReserveChange(Number.parseInt(e.target.value, 10) || 0)
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded bg-white p-3 text-xs text-slate-700 ring-1 ring-slate-200">
        <dt className="text-slate-500">TAS</dt>
        <dd className="text-right">{range.tas_kt.toFixed(0)} kt</dd>
        <dt className="text-slate-500">Burn</dt>
        <dd className="text-right">{range.fuel_gph.toFixed(1)} gph</dd>
        <dt className="text-slate-500">Reserve</dt>
        <dd className="text-right">{range.reserve_gal.toFixed(1)} gal</dd>
        <dt className="text-slate-500">Endurance</dt>
        <dd className="text-right">{range.endurance_hr.toFixed(2)} hr</dd>
        <dt className="font-medium text-slate-900">Range</dt>
        <dd className="text-right font-medium text-slate-900">
          {range.range_nm.toFixed(0)} nm
        </dd>
      </dl>
    </div>
  );
}
