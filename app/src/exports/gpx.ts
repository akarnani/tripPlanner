import type { PlannedRoute } from "@/engine/plan";
import { fplWaypointType } from "@/engine/navPoints";
import {
  routePointIdent,
  routePointLabel,
  routeSequence,
} from "./routePoints";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** <sym> is a free-form, device-defined string; these are the names
 *  Garmin's aviation symbol set uses, so a station doesn't draw as yet
 *  another airfield. The VOR/NDB/fix split is the same one the Garmin
 *  flight-plan type mapping makes, so it is borrowed rather than
 *  written out a second time to disagree with later. */
const NAV_SYM: Record<ReturnType<typeof fplWaypointType>, string> = {
  VOR: "VOR",
  NDB: "NDB",
  INT: "Intersection",
};

/**
 * Produces a GPX 1.1 route document for the planned trip. One <rtept>
 * per waypoint along the route in order — the airports plus any nav
 * points the legs are shaped through — with name set to the identifier
 * and a description naming the facility.
 *
 * Nav points get no <ele>. A NavPoint carries no elevation, and <ele>0
 * on a mountain VOR is a claim the receiver may act on; GPX makes the
 * element optional precisely so an unknown altitude can go unstated.
 */
export function toGPX(route: PlannedRoute, name = "Trip"): string {
  const rtepts = routeSequence(route)
    .map((p) => {
      const at = p.kind === "airport" ? p.airport : p.navPoint;
      const lines = [`    <rtept lat="${at.lat}" lon="${at.lon}">`];
      if (p.kind === "airport") {
        lines.push(
          `      <ele>${p.airport.elevation_ft != null ? p.airport.elevation_ft * 0.3048 : 0}</ele>`,
        );
      }
      lines.push(`      <name>${escapeXml(routePointIdent(p))}</name>`);
      lines.push(
        `      <desc>${escapeXml(p.kind === "airport" ? p.airport.name : routePointLabel(p))}</desc>`,
      );
      // Airports deliberately keep no <sym>: the receiver's default for
      // an unadorned route point is already an airfield, and adding one
      // would change every file we have ever written.
      if (p.kind === "navPoint") {
        lines.push(`      <sym>${NAV_SYM[fplWaypointType(p.navPoint)]}</sym>`);
      }
      lines.push(`    </rtept>`);
      return lines.join("\n");
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
