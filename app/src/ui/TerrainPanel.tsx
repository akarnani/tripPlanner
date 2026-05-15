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
  return (
    <div className="space-y-2 border-t border-slate-200 bg-amber-50/60 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Terrain</h3>
        <span className="text-xs text-slate-600">
          Suggested target:{" "}
          <strong className="text-slate-900">
            {analysis.replanTargetFt.toLocaleString()} ft
          </strong>
        </span>
      </div>
      {analysis.warnings.length === 0 ? (
        <p className="text-xs text-slate-600">
          All legs clear terrain and obstacles by ≥ 2,000 ft.
        </p>
      ) : (
        <ul className="space-y-1 text-xs text-slate-700">
          {analysis.warnings.map((w, i) => (
            <li key={i} className="rounded bg-amber-100 px-2 py-1">
              <strong>
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
        <ul className="space-y-1 text-xs text-slate-700">
          {corridor.map((w, i) => (
            <li key={i} className="rounded bg-amber-100 px-2 py-1">
              <strong>{w.ident}</strong>{" "}
              {w.kind === "departure" ? "departure" : "arrival"}: terrain{" "}
              {Math.round(w.shortfall_ft).toLocaleString()} ft above the
              standard {w.kind === "departure" ? "climb" : "1,000/3 nm descent"}{" "}
              profile.
            </li>
          ))}
        </ul>
      )}
      {needsReplan && (
        <button
          type="button"
          onClick={onReplanAtMinSafe}
          className="w-full rounded bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-700"
        >
          Replan with {analysis.replanTargetFt.toLocaleString()} ft target
        </button>
      )}
    </div>
  );
}
