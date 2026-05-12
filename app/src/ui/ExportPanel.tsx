import type { PlannedRoute } from "@/engine/plan";
import type { TerrainAnalysis } from "@/engine/terrain";
import type { Aircraft } from "@/data/aircraft";
import { toGPX } from "@/exports/gpx";
import { toFPL } from "@/exports/fpl";
import { toPDF } from "@/exports/pdf";

interface Props {
  route: PlannedRoute;
  aircraft: Aircraft;
  terrain: TerrainAnalysis | null;
}

function download(name: string, type: string, content: BlobPart) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportPanel({ route, aircraft, terrain }: Props) {
  const seq = [
    route.legs[0].fromAirport,
    ...route.legs.map((l) => l.toAirport),
  ];
  const baseName =
    seq.map((a) => a.icao ?? a.lid).join("-") || "trip";

  return (
    <div className="flex gap-2 border-t border-slate-200 bg-slate-100 p-3">
      <button
        type="button"
        onClick={() => download(`${baseName}.gpx`, "application/gpx+xml", toGPX(route, baseName))}
        className="flex-1 rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800"
      >
        GPX
      </button>
      <button
        type="button"
        onClick={() => download(`${baseName}.fpl`, "application/xml", toFPL(route, baseName))}
        className="flex-1 rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800"
      >
        Garmin FPL
      </button>
      <button
        type="button"
        onClick={() =>
          download(
            `${baseName}.pdf`,
            "application/pdf",
            toPDF({ route, aircraft, terrain }),
          )
        }
        className="flex-1 rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800"
      >
        PDF
      </button>
    </div>
  );
}
