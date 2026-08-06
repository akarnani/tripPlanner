import type { PlannedRoute } from "@/engine/plan";
import { fplWaypointType } from "@/engine/navPoints";
import {
  routePointIdent,
  routePointLabel,
  routeSequence,
  type RoutePoint,
} from "./routePoints";

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
 * by `<waypoint-identifier>` plus `<waypoint-type>`.
 *
 * The type is not decoration: it is half of the key the panel GPS looks
 * the ident up under. Airports are "AIRPORT"; nav points a leg is
 * shaped through are VOR / NDB / INT. Filing a fix as an AIRPORT gets
 * the plan rejected, or worse, silently resolved to an airfield that
 * happens to share the ident — which 479 navaids do.
 */
export function toFPL(route: PlannedRoute, name = "Trip"): string {
  const seq = routeSequence(route);
  // Keyed by type as well as identifier, for that same overlap: a trip
  // that lands at an airport and overflies the same-named station has
  // two genuinely different waypoints, and an ident-only key would drop
  // one of them from the table the route-points reference.
  const unique = new Map<string, RoutePoint>();
  for (const p of seq) {
    unique.set(`${waypointType(p)} ${routePointIdent(p)}`, p);
  }

  const waypointTable = [...unique.values()]
    .map((p) => {
      const at = p.kind === "airport" ? p.airport : p.navPoint;
      const comment = p.kind === "airport" ? p.airport.name : routePointLabel(p);
      return [
        `    <waypoint>`,
        `      <identifier>${escapeXml(routePointIdent(p))}</identifier>`,
        `      <type>${waypointType(p)}</type>`,
        `      <country-code>US</country-code>`,
        `      <lat>${at.lat}</lat>`,
        `      <lon>${at.lon}</lon>`,
        `      <comment>${escapeXml(comment)}</comment>`,
        ...frequencyLines(p),
        `    </waypoint>`,
      ].join("\n");
    })
    .join("\n");

  const routePoints = seq
    .map((p) =>
      [
        `    <route-point>`,
        `      <waypoint-identifier>${escapeXml(routePointIdent(p))}</waypoint-identifier>`,
        `      <waypoint-type>${waypointType(p)}</waypoint-type>`,
        `      <waypoint-country-code>US</waypoint-country-code>`,
        `    </route-point>`,
      ].join("\n"),
    )
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

function waypointType(p: RoutePoint): string {
  return p.kind === "airport" ? "AIRPORT" : fplWaypointType(p.navPoint);
}

/** Namespace for our <extensions> content. Garmin's schema admits any
 *  element there *except* one of its own, so the namespace has to be
 *  ours; a URN because there is no document to serve at a URL. */
const EXT_NS = "urn:trip-planner:flight-plan:v1";

/** A VOR's frequency is what a pilot cross-checks when the box tunes
 *  the station, so it travels with the waypoint — inside <extensions>,
 *  because Garmin's Waypoint_t is a closed xsd:sequence (identifier,
 *  type, country-code, lat, lon, comment, elevation, description,
 *  symbol, extensions) with no frequency element of its own. A loose
 *  <frequency> would fail validation, and a rejected plan is exactly
 *  the outcome typing the waypoints correctly is meant to avoid;
 *  <extensions> is the schema's own escape hatch, so an importer that
 *  doesn't know the element skips it and still reads the route.
 *
 *  NASR publishes every facility in kHz and this value is MHz, so only
 *  VOR-family stations get one: an NDB is 341 kHz, not 0.341 MHz, and a
 *  plausible-looking wrong number is worse than none. Fixes have
 *  nothing to tune. */
function frequencyLines(p: RoutePoint): string[] {
  if (p.kind !== "navPoint") return [];
  const khz = p.navPoint.freq_khz;
  if (khz === undefined || fplWaypointType(p.navPoint) !== "VOR") return [];
  const mhz = (khz / 1000).toFixed(2);
  return [
    `      <extensions>`,
    `        <frequency xmlns="${EXT_NS}" units="MHz">${mhz}</frequency>`,
    `      </extensions>`,
  ];
}
