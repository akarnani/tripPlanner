import { costFunctions } from "@/engine/costFns";

interface Props {
  origin: string;
  destination: string;
  onOriginChange: (v: string) => void;
  onDestinationChange: (v: string) => void;
  costFnId: string;
  onCostFnChange: (id: string) => void;
  maxLegHr: number;
  onMaxLegHrChange: (h: number) => void;
  onPlan: () => void;
  error: string | null;
}

export function TripPanel({
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  costFnId,
  onCostFnChange,
  maxLegHr,
  onMaxLegHrChange,
  onPlan,
  error,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            From
          </label>
          <input
            type="text"
            value={origin}
            onChange={(e) => onOriginChange(e.target.value.toUpperCase())}
            placeholder="KSEA"
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm uppercase"
          />
        </div>
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            To
          </label>
          <input
            type="text"
            value={destination}
            onChange={(e) => onDestinationChange(e.target.value.toUpperCase())}
            placeholder="KBOI"
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm uppercase"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Optimize for
        </label>
        <select
          value={costFnId}
          onChange={(e) => onCostFnChange(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
        >
          {costFunctions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      {costFnId === "maxLegTime" && (
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
            Max leg time (hr)
          </label>
          <input
            type="number"
            min={0.5}
            step={0.25}
            value={maxLegHr}
            onChange={(e) =>
              onMaxLegHrChange(Number.parseFloat(e.target.value) || 2)
            }
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          />
        </div>
      )}
      <button
        type="button"
        onClick={onPlan}
        className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Plan trip
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
