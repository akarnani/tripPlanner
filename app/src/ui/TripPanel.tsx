import { costFunctions } from "@/engine/costFns";
import type { FlightRule } from "@/engine/hemispheric";

interface Props {
  origin: string;
  destination: string;
  onOriginChange: (v: string) => void;
  onDestinationChange: (v: string) => void;
  flightRule: FlightRule;
  onFlightRuleChange: (r: FlightRule) => void;
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
  flightRule,
  onFlightRuleChange,
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
        <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">
          Flight rule
        </span>
        <div className="mt-1 inline-flex overflow-hidden rounded border border-slate-300">
          {(["VFR", "IFR"] as FlightRule[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onFlightRuleChange(r)}
              className={
                "px-3 py-1 text-xs font-semibold " +
                (flightRule === r
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 hover:bg-slate-100")
              }
            >
              {r}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          {flightRule === "VFR"
            ? "Cruise altitudes round to odd-/even-thousands + 500."
            : "Cruise altitudes round to odd/even thousands."}
        </p>
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
