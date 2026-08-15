import type { Obstacle } from "@/data/loaders";
import type { PlannedRoute } from "./plan";
import { greatCircleNM, type LatLon } from "./geo";
import { legGroundTrack } from "./terrain";

/** Index cell size in degrees. One degree of latitude is 60 nm, so a
 *  cell comfortably contains any corridor width we search with. */
const CELL_DEG = 1;

/**
 * Obstacles bucketed by 1° cell.
 *
 * Cached against the dataset array itself: the app loads it once and
 * hands the same array to every scan, so the index is built once per
 * session rather than once per route.
 *
 * Without it the scan is (track samples × 200,027) great-circle calls.
 * Sampling the whole ground track rather than just the leg endpoints —
 * which is what makes a shaped leg's obstacles correct — pushed that
 * from ~6 points to ~430 and froze the main thread for ten seconds on a
 * transcontinental route. This runs in a synchronous `useMemo` that
 * re-fires whenever the displayed route changes, including on picking a
 * different alternate, so it has to be cheap.
 */
const indexCache = new WeakMap<object, Map<string, Obstacle[]>>();

function indexOf(obstacles: readonly Obstacle[]): Map<string, Obstacle[]> {
  const cached = indexCache.get(obstacles as unknown as object);
  if (cached) return cached;
  const index = new Map<string, Obstacle[]>();
  for (const o of obstacles) {
    const k = `${Math.floor(o.lat / CELL_DEG)},${Math.floor(o.lon / CELL_DEG)}`;
    const bucket = index.get(k);
    if (bucket) bucket.push(o);
    else index.set(k, [o]);
  }
  indexCache.set(obstacles as unknown as object, index);
  return index;
}

/**
 * Returns obstacles within `corridor_nm` of the route's ground track.
 *
 * Sampling follows each leg's actual track — including any nav points
 * it is shaped through — rather than only its endpoints. A leg bent 100
 * nm off the direct line to dodge terrain overflies entirely different
 * ground, and picking obstacles from the endpoints alone would report
 * on airspace the aircraft never enters.
 *
 * The track is sampled at half `corridor_nm`, so every point on it is
 * within a quarter of the corridor width of some sample — a sample pair
 * cannot straddle an obstacle sitting between them.
 */
export function obstaclesNearRoute(
  obstacles: readonly Obstacle[],
  route: PlannedRoute | null,
  corridor_nm = 5,
): Obstacle[] {
  if (!route || route.legs.length === 0) return [];
  const index = indexOf(obstacles);

  const points: LatLon[] = [];
  for (const leg of route.legs) {
    points.push(
      ...legGroundTrack(leg.fromAirport, leg.toAirport, leg.via, corridor_nm / 2),
    );
  }

  const latPad = corridor_nm / 60;
  const found = new Map<string, Obstacle>();
  for (const p of points) {
    // Degrees of longitude shrink with latitude, so pad using the
    // latitude this sample actually sits at.
    const lonPad =
      corridor_nm / (60 * Math.max(0.05, Math.cos((p.lat * Math.PI) / 180)));
    const iLo = Math.floor((p.lat - latPad) / CELL_DEG);
    const iHi = Math.floor((p.lat + latPad) / CELL_DEG);
    const jLo = Math.floor((p.lon - lonPad) / CELL_DEG);
    const jHi = Math.floor((p.lon + lonPad) / CELL_DEG);
    for (let i = iLo; i <= iHi; i++) {
      for (let j = jLo; j <= jHi; j++) {
        const bucket = index.get(`${i},${j}`);
        if (!bucket) continue;
        for (const o of bucket) {
          if (found.has(o.id)) continue;
          if (greatCircleNM(p, o) <= corridor_nm) found.set(o.id, o);
        }
      }
    }
  }
  return [...found.values()];
}
