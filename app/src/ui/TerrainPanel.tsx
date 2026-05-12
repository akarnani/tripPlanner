import type { TerrainAnalysis } from "@/engine/terrain";

interface Props {
  analysis: TerrainAnalysis | null;
  cruiseAltFt: number;
  onReplanAtMinSafe: () => void;
}

export function TerrainPanel({
  analysis,
  cruiseAltFt,
  onReplanAtMinSafe,
}: Props) {
  if (!analysis) return null;
  const needsReplan = analysis.minSafeAltFt > cruiseAltFt;
  return (
    <div className="space-y-2 border-t border-slate-200 bg-amber-50/60 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Terrain</h3>
        <span className="text-xs text-slate-600">
          Min safe alt:{" "}
          <strong className="text-slate-900">
            {analysis.minSafeAltFt.toLocaleString()} ft
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
              {w.clearance_ft.toFixed(0)} ft clearance from{" "}
              <em>{w.worst.source_label}</em> at{" "}
              {w.worst.elevation_ft.toLocaleString()} ft MSL.
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
          Replan at {analysis.minSafeAltFt.toLocaleString()} ft
        </button>
      )}
    </div>
  );
}
