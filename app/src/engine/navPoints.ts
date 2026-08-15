import {
  airportByIdent,
  type Airport,
  type NavPoint,
} from "@/data/loaders";
import { greatCircleNM, type LatLon } from "./geo";

/**
 * What a typed waypoint token resolved to.
 *
 * Identifier namespaces overlap: 479 of the 1,165 navaids share an
 * ident with an airport's ICAO or FAA LID — "BOI" is both the Boise
 * VORTAC and KBOI, "SEA" both the Seattle VORTAC and KSEA. Airports win,
 * because that is what a pilot typing a route into a trip planner
 * almost always means, but the loser is reported so the UI can offer
 * the alternative rather than silently picking one.
 */
export interface ResolvedWaypoint {
  kind: "airport" | "navPoint";
  airport?: Airport;
  navPoint?: NavPoint;
  /** A same-ident nav point that lost to an airport, if there was one. */
  alsoNavPoint?: NavPoint;
}

/**
 * Resolves one ident to an airport or a nav point.
 *
 * When several nav points share an ident — 37 low-power NDBs do, all
 * two-letter — the one nearest `near` wins. That is what a pilot means
 * by naming a fix on their route: the one they're going to fly over,
 * not whichever the dataset happened to list first.
 */
export function resolveWaypointIdent(
  ident: string,
  airports: readonly Airport[],
  navPointsByIdent: ReadonlyMap<string, readonly NavPoint[]>,
  near?: readonly LatLon[],
): ResolvedWaypoint | undefined {
  const u = ident.trim().toUpperCase();
  if (!u) return undefined;

  const candidates = navPointsByIdent.get(u) ?? [];
  const navPoint = pickNearest(candidates, near);
  const airport = airportByIdent(airports, u);

  if (airport) {
    return {
      kind: "airport",
      airport,
      ...(navPoint ? { alsoNavPoint: navPoint } : {}),
    };
  }
  if (navPoint) return { kind: "navPoint", navPoint };
  return undefined;
}

/** Nav point closest to any of the reference points, or the first when
 *  there's nothing to measure against. */
function pickNearest(
  candidates: readonly NavPoint[],
  near?: readonly LatLon[],
): NavPoint | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1 || !near || near.length === 0) {
    return candidates[0];
  }
  let best = candidates[0];
  let bestNm = Infinity;
  for (const c of candidates) {
    for (const ref of near) {
      const d = greatCircleNM(c, ref);
      if (d < bestNm) {
        bestNm = d;
        best = c;
      }
    }
  }
  return best;
}

/**
 * Label for a nav point in tables, exports, and the map.
 * Navaids get their type ("SEA VORTAC"), fixes just their name.
 */
export function navPointLabel(p: NavPoint): string {
  return p.kind === "navaid" && p.type ? `${p.ident} ${p.type}` : p.ident;
}

/**
 * Garmin FPL `<waypoint-type>` for a nav point. Fixes are intersections;
 * navaids are VOR or NDB by facility type. Emitting AIRPORT for these
 * (as the exporter did when every waypoint was an airport) makes a
 * panel GPS either reject the plan or resolve the ident to the wrong
 * facility.
 */
export function fplWaypointType(p: NavPoint): "VOR" | "NDB" | "INT" {
  if (p.kind === "fix") return "INT";
  return p.type?.startsWith("NDB") ? "NDB" : "VOR";
}
