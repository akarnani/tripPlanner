import type { PlannedRoute } from "@/engine/plan";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Produces a GPX 1.1 route document for the planned trip. One <rtept>
 * per airport along the route in order, with name set to the ICAO/FAA
 * identifier and a description containing the airport name.
 */
export function toGPX(route: PlannedRoute, name = "Trip"): string {
  const points = airportSequence(route);
  const rtepts = points
    .map((a) => {
      const ident = a.icao ?? a.lid;
      return [
        `    <rtept lat="${a.lat}" lon="${a.lon}">`,
        `      <ele>${a.elevation_ft != null ? a.elevation_ft * 0.3048 : 0}</ele>`,
        `      <name>${escapeXml(ident)}</name>`,
        `      <desc>${escapeXml(a.name)}</desc>`,
        `    </rtept>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="trip-planner" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <rte>`,
    `    <name>${escapeXml(name)}</name>`,
    rtepts,
    `  </rte>`,
    `</gpx>`,
    "",
  ].join("\n");
}

function airportSequence(route: PlannedRoute) {
  const out = [route.legs[0].fromAirport];
  for (const leg of route.legs) out.push(leg.toAirport);
  return out;
}
