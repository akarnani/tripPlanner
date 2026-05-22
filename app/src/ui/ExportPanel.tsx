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
    <div className="border-t border-slate-200 bg-white p-3">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        Export route
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => download(`${baseName}.gpx`, "application/gpx+xml", toGPX(route, baseName))}
          className="btn-secondary flex-1 text-xs"
        >
          GPX
        </button>
        <button
          type="button"
          onClick={() => download(`${baseName}.fpl`, "application/xml", toFPL(route, baseName))}
          className="btn-secondary flex-1 text-xs"
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
          className="btn-primary flex-1 text-xs"
        >
          PDF
        </button>
      </div>
    </div>
  );
}
