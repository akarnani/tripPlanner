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
  onPlan: () => void;
  /** When true, the Plan button shows a spinner and is disabled. */
  isPlanning: boolean;
  /** When true, the Plan button is disabled with a "loading…" label. */
  dataReady: boolean;
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
  onPlan,
  isPlanning,
  dataReady,
  error,
}: Props) {
  const buttonLabel = !dataReady
    ? "Loading airport database…"
    : isPlanning
      ? "Planning…"
      : "Plan trip";
  const buttonDisabled = !dataReady || isPlanning;
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
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={capLegTime}
            onChange={(e) => onCapLegTimeChange(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Cap each leg at
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
            className="w-14 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-sm disabled:bg-slate-100 disabled:text-slate-400"
          />
          hours
        </label>
      </div>
      <button
        type="button"
        onClick={onPlan}
        disabled={buttonDisabled}
        className="flex w-full items-center justify-center gap-2 rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-400"
      >
        {(isPlanning || !dataReady) && (
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
          />
        )}
        {buttonLabel}
      </button>
      <p className="text-[11px] text-slate-500">
        Each plan returns one route per objective (fewest stops, shortest
        time). Duplicates are dropped.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
