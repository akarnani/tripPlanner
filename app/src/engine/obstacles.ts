import type { Obstacle } from "@/data/loaders";
import type { PlannedRoute } from "./plan";
import { greatCircleNM } from "./geo";

/**
 * Returns obstacles within `corridor_nm` of any leg in the route, by
 * crude great-circle endpoint distance. v1 keeps it simple — the
 * terrain engine in Phase 6 does the proper cross-track sampling.
 */
export function obstaclesNearRoute(
  obstacles: readonly Obstacle[],
  route: PlannedRoute | null,
  corridor_nm = 5,
): Obstacle[] {
  if (!route || route.legs.length === 0) return [];
  const points = route.legs.flatMap((leg) => [
    leg.fromAirport,
    leg.toAirport,
  ]);
  return obstacles.filter((o) =>
    points.some((p) => greatCircleNM(p, o) <= corridor_nm),
  );
}
