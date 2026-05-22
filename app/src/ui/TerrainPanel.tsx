import type { TerrainAnalysis } from "@/engine/terrain";
import type { TerminalCorridorWarning } from "@/engine/terrainPenalty";

interface Props {
  analysis: TerrainAnalysis | null;
  targetAltFt: number;
  onReplanAtMinSafe: () => void;
  /** Per-airport corridor warnings derived from edge metadata in the
   *  selected route. Surfaced here alongside cruise-clearance warnings
   *  so SA for terminal-area terrain is in one place. */
  terminalWarnings?: TerminalCorridorWarning[];
}

export function TerrainPanel({
  analysis,
  targetAltFt,
  onReplanAtMinSafe,
  terminalWarnings,
}: Props) {
  if (!analysis) return null;
  const needsReplan = analysis.replanTargetFt > targetAltFt;
  const corridor = terminalWarnings ?? [];
  const allClear = analysis.warnings.length === 0 && corridor.length === 0;
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
        <span className="text-[11px] text-slate-600">
          Suggested target:{" "}
          <span className="font-mono font-semibold text-slate-900">
            {analysis.replanTargetFt.toLocaleString()} ft
          </span>
        </span>
      </div>
      {allClear ? (
        <p className="text-xs text-slate-600">
          All legs clear terrain and obstacles by ≥ 2,000 ft.
        </p>
      ) : (
        <>
          {analysis.warnings.length > 0 && (
            <ul className="space-y-1.5 text-xs text-slate-700">
              {analysis.warnings.map((w, i) => (
                <li
                  key={i}
                  className="rounded-md border border-amber-200 bg-white/70 px-2 py-1.5"
                >
                  <strong className="font-mono">
                    {w.fromIdent} → {w.toIdent}
                  </strong>{" "}
                  at {w.cruise_alt_ft.toLocaleString()} ft has{" "}
                  {w.clearance_ft.toFixed(0)} ft over{" "}
                  <em>{w.worst.source_label}</em> ({w.worst.elevation_ft.toLocaleString()} ft MSL).
                </li>
              ))}
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
      {needsReplan && (
        <button
          type="button"
          onClick={onReplanAtMinSafe}
          className="btn-warning w-full"
        >
          Replan with {analysis.replanTargetFt.toLocaleString()} ft target
        </button>
      )}
    </div>
  );
}
