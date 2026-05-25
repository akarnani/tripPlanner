import type { FlightRule } from "@/engine/hemispheric";
import type { AltitudeStrategy } from "@/engine/interactive";
import type { Leg, PlannedRoute } from "@/engine/plan";
import { CRUISE_ALT_OPTIONS } from "./altitudeOptions";

interface Props {
  targetAltFt: number;
  onChange: (alt: number) => void;
  flightRule: FlightRule;
  /** How non-overridden legs pick their altitude. See AltitudeStrategy
   *  in engine/interactive.ts for semantics. */
  altitudeStrategy: AltitudeStrategy;
  onChangeAltitudeStrategy: (s: AltitudeStrategy) => void;
  /** The currently-displayed route. When present (and the override
   *  callbacks are wired), the panel lists each leg with its own
   *  altitude dropdown so the pilot can pin individual legs to a
   *  specific level. Omitted in interactive mode — that flow owns its
   *  own per-leg picker in the sidebar's InteractivePanel. */
  route?: PlannedRoute | null;
  onChangeLegAltitude?: (leg: Leg, altFt: number | null) => void;
  isLegAltOverridden?: (leg: Leg) => boolean;
  /** Highest published cruise altitude for the selected aircraft — the
   *  override dropdown hides options above this so the pilot can't
   *  pick a level the POH cruise table doesn't cover. */
  cruiseCeilingFt?: number;
}

/** Compact cruise-altitude selector that lives at the top of the
 *  results rail. Hosting altitude here (rather than in the Aircraft
 *  step) lets the pilot pick a level after they can actually see the
 *  stops the planner picked — terrain and leg lengths often dictate a
 *  different cruise than what feels right ahead of time. When a route
 *  is in view, a per-leg override list appears underneath so the
 *  pilot can pin individual legs without affecting the global target. */
export function CruisePanel({
  targetAltFt,
  onChange,
  flightRule,
  altitudeStrategy,
  onChangeAltitudeStrategy,
  route,
  onChangeLegAltitude,
  isLegAltOverridden,
  cruiseCeilingFt,
}: Props) {
  // VFR chips end in 500; IFR chips end in 000. Range covers the most
  // common piston cruise band; the numeric input is the escape hatch
  // for turbines / unusual altitudes.
  const chips = flightRule === "VFR"
    ? [4500, 6500, 8500, 10500, 12500]
    : [4000, 6000, 8000, 10000, 12000];
  const showLegOverrides =
    !!route && route.legs.length > 0 && !!onChangeLegAltitude;
  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="px-4 py-3">
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
      {showLegOverrides && (
        <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Per-leg altitude
            </div>
            <div className="seg" role="radiogroup" aria-label="Auto altitude strategy">
              {(
                [
                  { id: "lowest", label: "Lowest safe" },
                  { id: "cheapest", label: "Most efficient" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={altitudeStrategy === opt.id}
                  onClick={() => onChangeAltitudeStrategy(opt.id)}
                  className={
                    "seg-btn " +
                    (altitudeStrategy === opt.id ? "seg-btn-active" : "")
                  }
                  title={
                    opt.id === "lowest"
                      ? "Auto picks the lowest hemispheric-legal altitude at or above the cruise target (and any terrain floor)."
                      : "Auto picks the most fuel-efficient legal altitude from the POH cruise table — may go well above target."
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <ul className="mt-2 space-y-1.5">
            {route!.legs.map((leg, i) => (
              <LegAltRow
                key={`${leg.fromAirport.id}-${leg.toAirport.id}-${i}`}
                leg={leg}
                onChangeLegAltitude={onChangeLegAltitude!}
                isLegAltOverridden={isLegAltOverridden}
                cruiseCeilingFt={cruiseCeilingFt}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface LegAltRowProps {
  leg: Leg;
  onChangeLegAltitude: (leg: Leg, altFt: number | null) => void;
  isLegAltOverridden?: (leg: Leg) => boolean;
  cruiseCeilingFt?: number;
}

function LegAltRow({
  leg,
  onChangeLegAltitude,
  isLegAltOverridden,
  cruiseCeilingFt,
}: LegAltRowProps) {
  // Merge canonical options with whatever altitude the route currently
  // flies — the planner can pick a level outside CRUISE_ALT_OPTIONS
  // (e.g. a published cruise row at 12,500 in IFR) and that has to
  // remain selectable so the dropdown can show "currently flying X".
  const ceiling = cruiseCeilingFt ?? Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  const opts: number[] = [];
  for (const a of CRUISE_ALT_OPTIONS) {
    if (a > ceiling) continue;
    if (!seen.has(a)) {
      opts.push(a);
      seen.add(a);
    }
  }
  if (!seen.has(leg.cruise_alt_ft)) opts.push(leg.cruise_alt_ft);
  opts.sort((a, b) => a - b);

  const overridden = isLegAltOverridden?.(leg) ?? false;
  const value = overridden ? String(leg.cruise_alt_ft) : "auto";
  const fromIdent = leg.fromAirport.icao ?? leg.fromAirport.lid;
  const toIdent = leg.toAirport.icao ?? leg.toAirport.lid;
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="flex-1 truncate font-mono tabular-nums text-slate-700">
        <span className="font-semibold">{fromIdent}</span>
        <span className="px-1 text-slate-300">→</span>
        <span className="font-semibold">{toIdent}</span>
      </span>
      <select
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          onChangeLegAltitude(
            leg,
            raw === "auto" ? null : Number.parseInt(raw, 10),
          );
        }}
        aria-label={`Cruise altitude for ${fromIdent} → ${toIdent}`}
        title={
          overridden
            ? "Custom altitude; pick 'auto' to revert to the planner-picked level"
            : "Auto — pick a specific altitude to pin this leg"
        }
        className={
          "rounded-md border px-2 py-0.5 text-[11px] font-mono tabular-nums transition focus:outline-none focus:ring-2 focus:ring-brand-500/30 " +
          (overridden
            ? "border-orange-300 bg-orange-50 text-orange-900"
            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300")
        }
      >
        <option value="auto">
          auto ({leg.cruise_alt_ft.toLocaleString()})
        </option>
        {opts.map((alt) => (
          <option key={alt} value={alt}>
            {alt.toLocaleString()}
          </option>
        ))}
      </select>
    </li>
  );
}
