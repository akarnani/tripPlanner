import type { FlightRule } from "@/engine/hemispheric";

interface Props {
  origin: string;
  destination: string;
  onOriginChange: (v: string) => void;
  onDestinationChange: (v: string) => void;
  flightRule: FlightRule;
  onFlightRuleChange: (r: FlightRule) => void;
  capLegTime: boolean;
  onCapLegTimeChange: (b: boolean) => void;
  maxLegHr: number;
  onMaxLegHrChange: (h: number) => void;
  /** Surfaced planner errors ("no route found — try relaxing
   *  constraints", etc). Shown below the inputs because every change
   *  triggers a fresh auto-replan and the user needs to see the result
   *  in context. */
  error: string | null;
}

export function TripPanel({
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  flightRule,
  onFlightRuleChange,
  capLegTime,
  onCapLegTimeChange,
  maxLegHr,
  onMaxLegHrChange,
  error,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="origin" className="field-label">
            From
          </label>
          <input
            id="origin"
            type="text"
            value={origin}
            onChange={(e) => onOriginChange(e.target.value.toUpperCase())}
            placeholder="KSEA"
            className="input input-mono mt-1"
          />
        </div>
        <div>
          <label htmlFor="destination" className="field-label">
            To
          </label>
          <input
            id="destination"
            type="text"
            value={destination}
            onChange={(e) => onDestinationChange(e.target.value.toUpperCase())}
            placeholder="KBOI"
            className="input input-mono mt-1"
          />
        </div>
      </div>
      <div>
        <span className="field-label">Flight rule</span>
        <div className="seg mt-1">
          {(["VFR", "IFR"] as FlightRule[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onFlightRuleChange(r)}
              className={
                "seg-btn " + (flightRule === r ? "seg-btn-active" : "")
              }
            >
              {r}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {flightRule === "VFR"
            ? "Cruise altitudes round to odd-/even-thousands + 500."
            : "Cruise altitudes round to odd/even thousands."}
        </p>
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5">
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={capLegTime}
            onChange={(e) => onCapLegTimeChange(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>Cap each leg at</span>
          <input
            id="max-leg-hr"
            type="number"
            min={0.5}
            max={12}
            step={0.25}
            value={maxLegHr}
            disabled={!capLegTime}
            onChange={(e) =>
              onMaxLegHrChange(Number.parseFloat(e.target.value) || 2)
            }
            className="input w-16 px-1.5 py-0.5 text-sm"
          />
          <span>hours</span>
        </label>
      </div>
      <p className="text-[11px] text-slate-500">
        The planner runs whenever a setting changes. Routes appear in the
        results pane on the right.
      </p>
      {error && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
