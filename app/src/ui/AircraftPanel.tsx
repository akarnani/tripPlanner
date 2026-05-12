import type { Aircraft } from "@/data/aircraft";

interface Props {
  aircraft: readonly Aircraft[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  targetAltFt: number;
  onTargetAltChange: (alt: number) => void;
  reserveMin: number;
  onReserveChange: (min: number) => void;
}

export function AircraftPanel({
  aircraft,
  selectedSlug,
  onSelect,
  targetAltFt,
  onTargetAltChange,
  reserveMin,
  onReserveChange,
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
            Target altitude (ft)
          </label>
          <input
            type="number"
            min={0}
            max={18000}
            step={500}
            value={targetAltFt}
            onChange={(e) =>
              onTargetAltChange(Number.parseInt(e.target.value, 10) || 0)
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
          <p className="mt-1 text-[11px] text-slate-500">
            Each leg flies the next legal hemispheric altitude at or above
            this for its course.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Reserve (min)
          </label>
          <input
            type="number"
            min={0}
            step={5}
            value={reserveMin}
            onChange={(e) =>
              onReserveChange(Number.parseInt(e.target.value, 10) || 0)
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
        </div>
      </div>
    </div>
  );
}
