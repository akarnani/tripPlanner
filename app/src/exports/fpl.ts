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
 * Produces a Garmin flight-plan XML document. Garmin's spec defines a
 * <waypoint-table> of unique waypoints and a <route> referencing them
 * by `<waypoint-identifier>`. Each waypoint carries lat/lon and a type
 * (we mark airports as "AIRPORT"; user-defined fixes would be "USER WAYPOINT"
 * but we don't generate those in v1).
 */
export function toFPL(route: PlannedRoute, name = "Trip"): string {
  const seq = airportSequence(route);
  const unique = new Map<string, (typeof seq)[number]>();
  for (const a of seq) unique.set(identOf(a), a);

  const waypointTable = [...unique.values()]
    .map((a) => {
      const ident = identOf(a);
      return [
        `    <waypoint>`,
        `      <identifier>${escapeXml(ident)}</identifier>`,
        `      <type>AIRPORT</type>`,
        `      <country-code>US</country-code>`,
        `      <lat>${a.lat}</lat>`,
        `      <lon>${a.lon}</lon>`,
        `      <comment>${escapeXml(a.name)}</comment>`,
        `    </waypoint>`,
      ].join("\n");
    })
    .join("\n");

  const routePoints = seq
    .map((a) => {
      const ident = identOf(a);
      return [
        `    <route-point>`,
        `      <waypoint-identifier>${escapeXml(ident)}</waypoint-identifier>`,
        `      <waypoint-type>AIRPORT</waypoint-type>`,
        `      <waypoint-country-code>US</waypoint-country-code>`,
        `    </route-point>`,
      ].join("\n");
    })
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<flight-plan xmlns="http://www8.garmin.com/xmlschemas/FlightPlan/v1">`,
    `  <created>${new Date().toISOString()}</created>`,
    `  <waypoint-table>`,
    waypointTable,
    `  </waypoint-table>`,
    `  <route>`,
    `    <route-name>${escapeXml(name)}</route-name>`,
    `    <flight-plan-index>1</flight-plan-index>`,
    routePoints,
    `  </route>`,
    `</flight-plan>`,
    "",
  ].join("\n");
}

function identOf(a: { icao: string | null; lid: string }): string {
  return a.icao ?? a.lid;
}

function airportSequence(route: PlannedRoute) {
  const out = [route.legs[0].fromAirport];
  for (const leg of route.legs) out.push(leg.toAirport);
  return out;
}
