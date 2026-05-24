import type { FlightRule } from "@/engine/hemispheric";

interface Props {
  targetAltFt: number;
  onChange: (alt: number) => void;
  flightRule: FlightRule;
  /** Hemispheric quick-pick chips depend on whether the next legal
   *  altitude is VFR (X,500) or IFR (X,000). The planner snaps to the
   *  legal level per-leg anyway; the chips are just shortcuts. */
}

/** Compact cruise-altitude selector that lives at the top of the
 *  results rail. Hosting altitude here (rather than in the Aircraft
 *  step) lets the pilot pick a level after they can actually see the
 *  stops the planner picked — terrain and leg lengths often dictate a
 *  different cruise than what feels right ahead of time. */
export function CruisePanel({ targetAltFt, onChange, flightRule }: Props) {
  // VFR chips end in 500; IFR chips end in 000. Range covers the most
  // common piston cruise band; the numeric input is the escape hatch
  // for turbines / unusual altitudes.
  const chips = flightRule === "VFR"
    ? [4500, 6500, 8500, 10500, 12500]
    : [4000, 6000, 8000, 10000, 12000];
  return (
    <div className="border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="cruise-alt-ft"
          className="text-[11px] font-medium uppercase tracking-wide text-slate-500"
        >
          Cruise altitude
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="cruise-alt-ft"
            type="number"
            min={0}
            max={45000}
            step={500}
            value={targetAltFt}
            onChange={(e) =>
              onChange(Number.parseInt(e.target.value, 10) || 0)
            }
            aria-label="Target altitude (ft)"
            className="input w-24 px-2 py-1 text-sm tabular-nums"
          />
          <span className="text-[11px] text-slate-500">ft</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((alt) => {
          const active = alt === targetAltFt;
          return (
            <button
              key={alt}
              type="button"
              onClick={() => onChange(alt)}
              className={
                "rounded-md border px-2 py-0.5 text-[11px] font-mono tabular-nums transition " +
                (active
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50")
              }
            >
              {alt.toLocaleString()}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[10px] text-slate-500">
        Each leg snaps to the next legal hemispheric altitude at or above
        this target for its course.
      </p>
    </div>
  );
}
