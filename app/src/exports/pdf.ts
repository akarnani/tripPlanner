import { jsPDF } from "jspdf";
import type { PlannedRoute } from "@/engine/plan";
import type { TerrainAnalysis } from "@/engine/terrain";
import type { Aircraft } from "@/data/aircraft";

interface Input {
  route: PlannedRoute;
  aircraft: Aircraft;
  terrain: TerrainAnalysis | null;
}

/**
 * Generates a kneeboard-style PDF: a summary page followed by a leg
 * table, all rendered with jsPDF (no server). The output is a Blob
 * that the UI saves with the file API.
 */
export function toPDF(input: Input): Blob {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const { route, aircraft, terrain } = input;
  const m = 48;
  let y = m;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Flight plan kneeboard", m, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const seq = airportSequence(route);
  const idents = seq.map((a) => a.icao ?? a.lid).join("  →  ");
  doc.text(idents, m, y);
  y += 18;

  doc.text(`Aircraft: ${aircraft.make} ${aircraft.model}`, m, y);
  y += 14;
  doc.text(
    `Total: ${route.totals.distance_nm.toFixed(0)} nm  ·  ${route.totals.time_hr.toFixed(1)} hr  ·  ${route.totals.fuel_gal.toFixed(1)} gal  ·  ${route.totals.stops} stop${route.totals.stops === 1 ? "" : "s"}`,
    m,
    y,
  );
  y += 22;

  doc.setFont("helvetica", "bold");
  doc.text("Legs", m, y);
  y += 14;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);

  const cols: Array<{ label: string; x: number; align?: "right" }> = [
    { label: "From", x: m },
    { label: "To", x: m + 60 },
    { label: "Alt", x: m + 140, align: "right" },
    { label: "Crs", x: m + 200, align: "right" },
    { label: "NM", x: m + 250, align: "right" },
    { label: "Time", x: m + 310, align: "right" },
    { label: "Fuel", x: m + 370, align: "right" },
  ];
  for (const c of cols)
    doc.text(c.label, c.x, y, c.align ? { align: c.align } : undefined);
  y += 4;
  doc.line(m, y, m + 380, y);
  y += 12;
  for (const leg of route.legs) {
    doc.text(leg.fromAirport.icao ?? leg.fromAirport.lid, m, y);
    doc.text(leg.toAirport.icao ?? leg.toAirport.lid, m + 60, y);
    doc.text(leg.cruise_alt_ft.toLocaleString(), m + 140, y, {
      align: "right",
    });
    doc.text(`${leg.course_deg.toFixed(0).padStart(3, "0")}°`, m + 200, y, {
      align: "right",
    });
    doc.text(leg.distance_nm.toFixed(0), m + 250, y, { align: "right" });
    doc.text(`${(leg.time_hr * 60).toFixed(0)}m`, m + 310, y, {
      align: "right",
    });
    doc.text(leg.fuel_gal.toFixed(1), m + 370, y, { align: "right" });
    y += 14;
  }

  if (terrain) {
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(
      `Terrain  ·  suggested target ${terrain.replanTargetFt.toLocaleString()} ft`,
      m,
      y,
    );
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    if (terrain.warnings.length === 0) {
      doc.text("All legs clear by ≥ 2,000 ft.", m, y);
    } else {
      for (const w of terrain.warnings) {
        doc.text(
          `${w.fromIdent} → ${w.toIdent} at ${w.cruise_alt_ft.toLocaleString()} ft: ${w.clearance_ft.toFixed(0)} ft over ${w.worst.source_label} (${w.worst.elevation_ft.toLocaleString()} ft MSL)`,
          m,
          y,
        );
        y += 12;
      }
    }
  }

  return doc.output("blob");
}

function airportSequence(route: PlannedRoute) {
  const out = [route.legs[0].fromAirport];
  for (const leg of route.legs) out.push(leg.toAirport);
  return out;
}
