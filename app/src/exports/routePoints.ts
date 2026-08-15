import type { Airport, NavPoint } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import { navPointLabel } from "@/engine/navPoints";

/**
 * One point along the route, still tagged with what it is. Airports and
 * nav points share almost nothing an exporter needs — a nav point has
 * no ICAO/LID, no field elevation, and is never landed at — so the two
 * stay distinguishable right up to the emitted file instead of being
 * flattened into a lat/lon early and guessed at later.
 */
export type RoutePoint =
  | { kind: "airport"; airport: Airport }
  | { kind: "navPoint"; navPoint: NavPoint };

/**
 * Every waypoint of the route in the order it is flown: the origin,
 * then each leg's shape points followed by that leg's destination.
 *
 * A leg's `via` points are part of its ground track, so a file listing
 * only the airports describes a route the aeroplane isn't flying — the
 * receiving GPS would fly the direct great circle through whatever the
 * pilot pinned a fix to avoid.
 */
export function routeSequence(route: PlannedRoute): RoutePoint[] {
  const out: RoutePoint[] = [
    { kind: "airport", airport: route.legs[0].fromAirport },
  ];
  for (const leg of route.legs) {
    for (const navPoint of leg.via ?? []) {
      out.push({ kind: "navPoint", navPoint });
    }
    out.push({ kind: "airport", airport: leg.toAirport });
  }
  return out;
}

/** Bare identifier, the way a navigation database keys it: ICAO (or the
 *  FAA LID when there is no ICAO) for airports, the published ident for
 *  nav points. */
export function routePointIdent(p: RoutePoint): string {
  return p.kind === "airport"
    ? (p.airport.icao ?? p.airport.lid)
    : p.navPoint.ident;
}

/** Identifier as shown to a pilot. Navaids carry their facility type
 *  ("SEA VORTAC") so a station can't be mistaken for a fix — or for an
 *  airport of the same name, which 479 of them have. */
export function routePointLabel(p: RoutePoint): string {
  return p.kind === "airport" ? routePointIdent(p) : navPointLabel(p.navPoint);
}
