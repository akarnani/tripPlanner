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

/** iOS Safari (and iPadOS, which reports as a Mac but has touch)
 *  ignores the `download` attribute on blob URLs, so a normal anchor
 *  click does nothing. Detect it to fall back to opening the file. */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function download(name: string, type: string, content: BlobPart) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  if (isIOS()) {
    // Open the file so the user can save/share it from the viewer; the
    // download attribute wouldn't fire here.
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }
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
    <div className="flex gap-2 border-t border-hairline bg-surface p-3">
      <button
        type="button"
        onClick={() => download(`${baseName}.gpx`, "application/gpx+xml", toGPX(route, baseName))}
        className="flex-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        GPX
      </button>
      <button
        type="button"
        onClick={() => download(`${baseName}.fpl`, "application/xml", toFPL(route, baseName))}
        className="flex-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
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
        className="flex-1 rounded bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        PDF
      </button>
    </div>
  );
}
