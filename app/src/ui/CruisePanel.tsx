import type { AltitudeStrategy } from "@/engine/interactive";
import type { Leg, PlannedRoute } from "@/engine/plan";
import { CRUISE_ALT_OPTIONS } from "./altitudeOptions";

interface Props {
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

/** Altitude control surface for the results rail.
 *
 *  The previous design had a single global "Cruise altitude" input
 *  alongside the per-leg picker. That was confusing — the global
 *  input *only* affected the planner's stop-selection cost model,
 *  while the actually-flown altitudes came from the strategy + the
 *  per-leg picker. Pilots can't easily reason about a number that
 *  isn't the one they see in the leg table.
 *
 *  Now the strategy is the global knob — it controls how every "auto"
 *  leg gets its altitude — and per-leg overrides handle the rest.
 *  The planner uses a sensible internal default for cost shopping;
 *  that detail stays out of the pilot's view. */
export function CruisePanel({
  altitudeStrategy,
  onChangeAltitudeStrategy,
  route,
  onChangeLegAltitude,
  isLegAltOverridden,
  cruiseCeilingFt,
}: Props) {
  const showLegOverrides =
    !!route && route.legs.length > 0 && !!onChangeLegAltitude;
  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Auto altitude
            </div>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {altitudeStrategy === "lowest"
                ? "Each leg flies the lowest legal hemispheric altitude that clears terrain."
                : "Each leg picks the most fuel-efficient legal altitude from the POH cruise table."}
            </p>
          </div>
          <div className="seg shrink-0" role="radiogroup" aria-label="Auto altitude strategy">
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
                    ? "Lowest legal hemispheric altitude that clears terrain on each leg."
                    : "Most fuel-efficient legal altitude from the POH cruise table — may climb high."
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {showLegOverrides && (
        <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Per-leg altitude
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
            ? "Custom altitude; pick 'auto' to revert to the auto-picked level"
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
