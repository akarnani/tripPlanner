import type { Leg, PlannedRoute } from "@/engine/plan";
import type { TerrainAnalysis } from "@/engine/terrain";
import type { TerminalCorridorWarning } from "@/engine/terrainPenalty";

interface PinTarget {
  leg: Leg;
  altFt: number;
}

interface Props {
  analysis: TerrainAnalysis | null;
  /** The currently-displayed route. Used to map terrain warnings'
   *  legIndex onto Leg objects so the "Pin at X ft" buttons can write
   *  to legAltOverrides via the same handler the CruisePanel uses. */
  route: PlannedRoute | null;
  /** Fired when the user clicks a per-warning "Pin at X ft" button. */
  onPinLeg?: (leg: Leg, altFt: number) => void;
  /** Bulk variant: pin every supplied leg at its supplied altitude in
   *  a single state commit (avoids a render storm for routes with many
   *  warnings). */
  onPinLegs?: (targets: readonly PinTarget[]) => void;
  /** Per-airport corridor warnings derived from edge metadata in the
   *  selected route. Surfaced here alongside cruise-clearance warnings
   *  so SA for terminal-area terrain is in one place. Informational
   *  only — these are climb/descent profile issues, not cruise
   *  altitude problems, so we don't offer a "pin" fix. */
  terminalWarnings?: TerminalCorridorWarning[];
}

export function TerrainPanel({
  analysis,
  route,
  onPinLeg,
  onPinLegs,
  terminalWarnings,
}: Props) {
  if (!analysis) return null;
  const corridor = terminalWarnings ?? [];
  const allClear = analysis.warnings.length === 0 && corridor.length === 0;
  // For each cruise-clearance warning, the engine already computes the
  // minimum safe hemispheric altitude for that leg (in perLeg). Build
  // a list of (Leg, altFt) targets the pin buttons can act on.
  const fixable: PinTarget[] = [];
  if (route && onPinLeg) {
    const perLegByIndex = new Map(analysis.perLeg.map((p) => [p.legIndex, p]));
    for (const w of analysis.warnings) {
      const leg = route.legs[w.legIndex];
      const perLeg = perLegByIndex.get(w.legIndex);
      if (!leg || !perLeg) continue;
      // Only offer the fix when it would actually raise the leg —
      // skip cases where the leg is already at or above the min-safe
      // level (rare, but happens when only an obstacle penalty fires).
      if (perLeg.minSafeAltFt > leg.cruise_alt_ft) {
        fixable.push({ leg, altFt: perLeg.minSafeAltFt });
      }
    }
  }
  return (
    <div
      className={
        "space-y-2 border-t border-slate-200 p-4 " +
        (allClear ? "bg-emerald-50/50" : "bg-amber-50/60")
      }
    >
      <div className="flex items-baseline justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <span
            className={
              "inline-block h-2 w-2 rounded-full " +
              (allClear ? "bg-emerald-500" : "bg-amber-500")
            }
            aria-hidden="true"
          />
          Terrain
        </h3>
        {fixable.length > 1 && onPinLegs && (
          <button
            type="button"
            onClick={() => onPinLegs(fixable)}
            className="btn-warning text-xs"
            title="Pin every affected leg at its minimum safe altitude"
          >
            Pin all {fixable.length} legs
          </button>
        )}
      </div>
      {allClear ? (
        <p className="text-xs text-slate-600">
          All legs clear terrain and obstacles by ≥ 2,000 ft.
        </p>
      ) : (
        <>
          {analysis.warnings.length > 0 && (
            <ul className="space-y-1.5 text-xs text-slate-700">
              {analysis.warnings.map((w, i) => {
                const leg = route?.legs[w.legIndex];
                const perLeg = analysis.perLeg.find(
                  (p) => p.legIndex === w.legIndex,
                );
                const canPin =
                  !!leg &&
                  !!perLeg &&
                  !!onPinLeg &&
                  perLeg.minSafeAltFt > leg.cruise_alt_ft;
                return (
                  <li
                    key={i}
                    className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5"
                  >
                    <div>
                      <strong className="font-mono">
                        {w.fromIdent} → {w.toIdent}
                      </strong>{" "}
                      at {w.cruise_alt_ft.toLocaleString()} ft has{" "}
                      {w.clearance_ft.toFixed(0)} ft over{" "}
                      <em>{w.worst.source_label}</em> ({w.worst.elevation_ft.toLocaleString()} ft MSL).
                    </div>
                    {canPin && (
                      <button
                        type="button"
                        onClick={() => onPinLeg!(leg!, perLeg!.minSafeAltFt)}
                        className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900 transition hover:bg-amber-200"
                      >
                        Pin this leg at{" "}
                        <span className="font-mono">
                          {perLeg!.minSafeAltFt.toLocaleString()} ft
                        </span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {corridor.length > 0 && (
            <ul className="space-y-1.5 text-xs text-slate-700">
              {corridor.map((w, i) => (
                <li
                  key={i}
                  className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5"
                >
                  <strong className="font-mono">{w.ident}</strong>{" "}
                  {w.kind === "departure" ? "departure" : "arrival"}: terrain{" "}
                  {Math.round(w.shortfall_ft).toLocaleString()} ft above the
                  standard {w.kind === "departure" ? "climb" : "1,000/3 nm descent"}{" "}
                  profile.
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
