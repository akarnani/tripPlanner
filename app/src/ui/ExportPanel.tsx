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

/** Save generated content as a file. Text exports are wrapped as
 *  `application/octet-stream` so the browser downloads them instead of
 *  rendering the XML inline (Safari in particular previews `*+xml` /
 *  `application/xml` blobs as plain text — which is what made the FPL
 *  "download" open in the browser and left GPX saves named "untitled").
 *  The `download` attribute then supplies the real filename. */
function download(filename: string, content: BlobPart) {
  // octet-stream even for the PDF Blob, so every export is saved rather
  // than previewed, with the filename honored.
  const blob = new Blob([content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function ExportPanel({ route, aircraft, terrain }: Props) {
  const seq = [
    route.legs[0].fromAirport,
    ...route.legs.map((l) => l.toAirport),
  ];
  const baseName =
    seq.map((a) => a.icao ?? a.lid).join("-") || "trip";

  return (
    <div className="flex gap-2 border-t border-hairline bg-surface p-3">
      <button
        type="button"
        onClick={() => download(`${baseName}.gpx`, toGPX(route, baseName))}
        className="flex-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        GPX
      </button>
      <button
        type="button"
        onClick={() => download(`${baseName}.fpl`, toFPL(route, baseName))}
        className="flex-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        Garmin FPL
      </button>
      <button
        type="button"
        onClick={() =>
          download(`${baseName}.pdf`, toPDF({ route, aircraft, terrain }))
        }
        className="flex-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        PDF
      </button>
    </div>
  );
}
