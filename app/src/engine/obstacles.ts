import type { Obstacle } from "@/data/loaders";
import type { PlannedRoute } from "./plan";
import { greatCircleNM, type LatLon } from "./geo";
import { legGroundTrack } from "./terrain";

/**
 * Returns obstacles within `corridor_nm` of the route's ground track.
 *
 * Sampling follows each leg's actual track — including any nav points
 * it is shaped through — rather than only its endpoints. A leg bent 100
 * nm off the direct line to dodge terrain overflies entirely different
 * ground, and picking obstacles from the endpoints alone would report
 * on airspace the aircraft never enters.
 *
 * The track is sampled at `corridor_nm` so consecutive samples can't
 * straddle an obstacle that sits between them.
 */
export function obstaclesNearRoute(
  obstacles: readonly Obstacle[],
  route: PlannedRoute | null,
  corridor_nm = 5,
): Obstacle[] {
  if (!route || route.legs.length === 0) return [];
  const points: LatLon[] = [];
  for (const leg of route.legs) {
    points.push(
      ...legGroundTrack(leg.fromAirport, leg.toAirport, leg.via, corridor_nm),
    );
  }
  return obstacles.filter((o) =>
    points.some((p) => greatCircleNM(p, o) <= corridor_nm),
  );
}
