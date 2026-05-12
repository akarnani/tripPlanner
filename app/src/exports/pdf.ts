import { jsPDF } from "jspdf";
import type { PlannedRoute } from "@/engine/plan";
import type { TerrainAnalysis } from "@/engine/terrain";
import type { Aircraft } from "@/data/aircraft";

interface Input {
  route: PlannedRoute;
  aircraft: Aircraft;
  altitude_ft: number;
  terrain: TerrainAnalysis | null;
}

/**
 * Generates a kneeboard-style PDF: a summary page followed by a leg
 * table, all rendered with jsPDF (no server). The output is a Blob
 * that the UI saves with the file API.
 */
export function toPDF(input: Input): Blob {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const { route, aircraft, altitude_ft, terrain } = input;
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

  doc.text(
    `Aircraft: ${aircraft.make} ${aircraft.model}  ·  Cruise: ${altitude_ft.toLocaleString()} ft`,
    m,
    y,
  );
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

  const cols = [
    { label: "From", x: m },
    { label: "To", x: m + 70 },
    { label: "NM", x: m + 140, align: "right" as const },
    { label: "Time", x: m + 200, align: "right" as const },
    { label: "Fuel", x: m + 260, align: "right" as const },
  ];
  for (const c of cols)
    doc.text(c.label, c.x, y, c.align ? { align: c.align } : undefined);
  y += 4;
  doc.line(m, y, m + 300, y);
  y += 12;
  for (const leg of route.legs) {
    doc.text(leg.fromAirport.icao ?? leg.fromAirport.lid, m, y);
    doc.text(leg.toAirport.icao ?? leg.toAirport.lid, m + 70, y);
    doc.text(leg.distance_nm.toFixed(0), m + 140, y, { align: "right" });
    doc.text(`${(leg.time_hr * 60).toFixed(0)}m`, m + 200, y, {
      align: "right",
    });
    doc.text(leg.fuel_gal.toFixed(1), m + 260, y, { align: "right" });
    y += 14;
  }

  if (terrain) {
    y += 16;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(
      `Terrain  ·  min safe alt ${terrain.minSafeAltFt.toLocaleString()} ft`,
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
          `${w.fromIdent} → ${w.toIdent}: ${w.clearance_ft.toFixed(0)} ft clearance from ${w.worst.source_label} (${w.worst.elevation_ft.toLocaleString()} ft MSL)`,
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
