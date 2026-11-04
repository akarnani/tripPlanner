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
}: Props) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="origin"
            className="field-label"
          >
            From
          </label>
          <input
            id="origin"
            type="text"
            value={origin}
            onChange={(e) => onOriginChange(e.target.value.toUpperCase())}
            placeholder="KSEA"
            className="mt-1 w-full input font-mono text-sm uppercase"
          />
        </div>
        <div>
          <label
            htmlFor="destination"
            className="field-label"
          >
            To
          </label>
          <input
            id="destination"
            type="text"
            value={destination}
            onChange={(e) => onDestinationChange(e.target.value.toUpperCase())}
            placeholder="KBOI"
            className="mt-1 w-full input font-mono text-sm uppercase"
          />
        </div>
      </div>
      <div>
        <span className="field-label">
          Flight rule
        </span>
        <div className="seg mt-1">
          {(["VFR", "IFR"] as FlightRule[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onFlightRuleChange(r)}
              aria-pressed={flightRule === r}
              className={"seg-btn" + (flightRule === r ? " seg-btn-active" : "")}
            >
              {r}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">
          {flightRule === "VFR"
            ? "Cruise altitudes round to odd-/even-thousands + 500."
            : "Cruise altitudes round to odd/even thousands."}
        </p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-xs text-ink">
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
            className="w-14 input px-1.5 py-0.5"
          />
          hours
        </label>
      </div>
    </div>
  );
}
