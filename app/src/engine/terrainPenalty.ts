import type { Airport } from "@/data/loaders";
import { greatCircleNM } from "./geo";
import { initialTrueCourseDeg } from "./hemispheric";
import type { DEMSampler } from "./terrain";
import type { PlannedRoute } from "./plan";

/** Standard descent profile: 1,000 ft of altitude loss per 3 nm of ground
 *  distance — a comfortable ~3° glidepath at typical GA cruise speeds.
 *  Terrain that intrudes into this corridor on the approach side of an
 *  airport forces either an early step-down (extra cruise-low time) or a
 *  high arrival followed by holding/circling to lose altitude. */
export const STANDARD_DESCENT_FT_PER_NM = 1000 / 3;

/** Vertical buffer the climb / descent path must clear above the highest
 *  terrain sample. Smaller than the cruise terrain buffer because this
 *  scoring only looks at short corridors near the terminal airports;
 *  cruise-segment clearance is the existing terrain analyzer's job. */
export const TERMINAL_BUFFER_FT = 500;

/** Hard cap on corridor length. Bounds sample count even when the cruise
 *  altitude is unusually high so a single edge can't dominate planning
 *  cost from DEM I/O. */
export const MAX_CORRIDOR_NM = 30;

/** Sample spacing along the corridor in nautical miles. */
export const CORRIDOR_SAMPLE_NM = 1;

/** Minutes of equivalent flight time charged per 1,000 ft of arrival
 *  shortfall. Roughly approximates the cost of holding/circling to shed
 *  unwanted altitude when the standard descent is blocked. */
export const ARRIVAL_MIN_PER_KFT = 5;

/** Minutes of equivalent flight time charged per 1,000 ft of departure
 *  shortfall. Climb-before-on-course costs less than a forced hold —
 *  this is the "less bad" case per the routing requirements. */
export const DEPARTURE_MIN_PER_KFT = 2;

/** Minimum AGL the aircraft is modeled at inside the arrival corridor.
 *  Convention is 1,000 ft for the traffic pattern; most arrivals fly
 *  to pattern altitude and circle, not a long straight-in descent all
 *  the way to field elevation. Terrain below this floor within a few
 *  miles of the airport isn't a practical hazard — the aircraft is
 *  comfortably above it — so the corridor scoring shouldn't flag it.
 *  Without this floor, the 1,000/3 nm descent slope projects the
 *  aircraft to field elevation at d=0 and routinely flags low terrain
 *  within 1–2 nm of high-elevation fields that the pilot would never
 *  actually fly through. */
export const ARRIVAL_FLOOR_AGL_FT = 1000;

export interface TerrainPenaltyInput {
  from: Airport;
  to: Airport;
  /** Hemispheric-rounded cruise altitude actually flown on this leg. */
  cruise_alt_ft: number;
  /** Aircraft climb groundspeed in knots, used together with
   *  `climb_rate_fpm` to derive ft-per-nm climb gradient. This is the
   *  groundspeed *during the climb* (i.e. Vy or thereabouts) — NOT the
   *  cruise TAS. Using cruise TAS makes the gradient look much
   *  shallower than reality and falsely penalizes departure terrain
   *  that the aircraft can comfortably climb over. */
  climb_speed_kt: number;
  /** Aircraft climb rate (ft/min). */
  climb_rate_fpm: number;
  dem: DEMSampler;
  /** Precomputed great-circle distance from→to (nm). The routing
   *  graph already has this for every edge — passing it in skips a
   *  redundant sqrt + 4 trig on the hot path. */
  distance_nm?: number;
  /** Precomputed initial true course from→to (degrees). Same
   *  hot-path optimization as `distance_nm`. */
  true_course_deg?: number;
}

export interface TerrainPenalty {
  /** Total equivalent time cost (hours) to fold into routing objectives. */
  hr: number;
  /** Worst departure-corridor shortfall vs the required climb path, in
   *  feet. Zero when the climb clears all sampled terrain. */
  departure_shortfall_ft: number;
  /** Worst arrival-corridor shortfall vs the 1,000/3 nm descent path,
   *  in feet. Zero when terrain permits a standard descent. */
  arrival_shortfall_ft: number;
}

const ZERO: TerrainPenalty = {
  hr: 0,
  departure_shortfall_ft: 0,
  arrival_shortfall_ft: 0,
};

/** Penalty for terrain that prevents a gradual departure climb or a
 *  standard 1,000/3 nm arrival descent on the given leg. Soft scoring
 *  only — never returns Infinity, so it can never disqualify an edge
 *  outright. */
export function computeTerrainPenalty(
  input: TerrainPenaltyInput,
): TerrainPenalty {
  const { from, to, cruise_alt_ft, climb_speed_kt, climb_rate_fpm, dem } = input;
  const total_nm = input.distance_nm ?? greatCircleNM(from, to);
  if (total_nm === 0) return ZERO;
  // Bearings out from each terminal. The leg bends very little over a
  // 30 nm corridor, so using the initial true course out of each airport
  // (rather than reinterpolating along the great-circle) introduces
  // negligible spatial error and saves hundreds of trig calls per edge.
  const from_to_bearing_deg =
    input.true_course_deg ?? initialTrueCourseDeg(from, to);
  const to_from_bearing_deg = initialTrueCourseDeg(to, from);

  const climb_ft_per_nm =
    climb_speed_kt > 0 ? (climb_rate_fpm * 60) / climb_speed_kt : Infinity;

  const departure_shortfall_ft = corridorShortfall({
    near: from,
    total_nm,
    bearing_deg: from_to_bearing_deg,
    airport_elev_ft: from.elevation_ft ?? 0,
    cruise_alt_ft,
    gradient_ft_per_nm: climb_ft_per_nm,
    dem,
    // Departure: the aircraft really is at field elevation at d=0
    // and climbs from there, so no AGL floor applies.
    min_aircraft_agl_ft: 0,
  });
  const arrival_shortfall_ft = corridorShortfall({
    near: to,
    total_nm,
    bearing_deg: to_from_bearing_deg,
    airport_elev_ft: to.elevation_ft ?? 0,
    cruise_alt_ft,
    gradient_ft_per_nm: STANDARD_DESCENT_FT_PER_NM,
    dem,
    min_aircraft_agl_ft: ARRIVAL_FLOOR_AGL_FT,
  });
  const departure_hr =
    (departure_shortfall_ft / 1000) * (DEPARTURE_MIN_PER_KFT / 60);
  const arrival_hr =
    (arrival_shortfall_ft / 1000) * (ARRIVAL_MIN_PER_KFT / 60);
  return {
    hr: departure_hr + arrival_hr,
    departure_shortfall_ft,
    arrival_shortfall_ft,
  };
}

interface CorridorInput {
  /** Airport the corridor anchors on (origin for departure, destination
   *  for arrival). Sampling proceeds outward from here along the leg. */
  near: Airport;
  total_nm: number;
  /** Initial true course leaving `near` along the leg, in degrees. */
  bearing_deg: number;
  airport_elev_ft: number;
  cruise_alt_ft: number;
  gradient_ft_per_nm: number;
  dem: DEMSampler;
  /** Floor on the modeled aircraft altitude above field elevation,
   *  in feet. Used on the arrival corridor so that low terrain inside
   *  the traffic pattern doesn't generate false warnings. Zero for
   *  departure, where the aircraft really is on the runway at d=0. */
  min_aircraft_agl_ft: number;
}

/** Degrees of latitude per nautical mile. */
const DEG_PER_NM = 1 / 60;

function corridorShortfall(c: CorridorInput): number {
  if (c.gradient_ft_per_nm <= 0) return 0;
  // Defensive: cruise altitude at or below the airport itself is a
  // degenerate input (negative climb / descent). Skip rather than score.
  if (c.cruise_alt_ft <= c.airport_elev_ft) return 0;
  // Always sample out to MAX_CORRIDOR_NM (or the leg length, if shorter).
  // The corridor used to shrink to TOD distance, but that missed terrain
  // *above* cruise altitude near the airport — exactly the case where a
  // standard descent / gradual climb is impossible.
  const corridor_nm = Math.min(c.total_nm, MAX_CORRIDOR_NM);
  if (corridor_nm <= 0) return 0;
  const samples = Math.max(1, Math.ceil(corridor_nm / CORRIDOR_SAMPLE_NM));
  // Equirectangular projection. At 30 nm scales the great-circle path
  // differs from a straight line by sub-arcminute — using a flat-earth
  // step here skips the per-sample trig the full geodesic needs and
  // makes the hot loop a few-multiplies-per-sample affair.
  const bearing_rad = (c.bearing_deg * Math.PI) / 180;
  const lat_rad = (c.near.lat * Math.PI) / 180;
  const cos_lat = Math.cos(lat_rad);
  const dlat_per_nm = Math.cos(bearing_rad) * DEG_PER_NM;
  const dlon_per_nm =
    cos_lat !== 0 ? (Math.sin(bearing_rad) * DEG_PER_NM) / cos_lat : 0;

  let worst = 0;
  for (let i = 1; i <= samples; i++) {
    const d_from_airport = (i / samples) * corridor_nm;
    const lat = c.near.lat + d_from_airport * dlat_per_nm;
    const lon = c.near.lon + d_from_airport * dlon_per_nm;
    // Aircraft altitude profile from the airport outward: bounded
    // below by the AGL floor (pattern altitude on arrival, zero on
    // departure), rising along the descent / climb slope, capped at
    // the planned cruise altitude. Terrain above this profile (with
    // the buffer) is what costs us — either it pierces the standard
    // descent slope, or it pokes above the planned cruise so the leg
    // itself isn't flyable at the chosen altitude.
    const slope_alt =
      c.airport_elev_ft + d_from_airport * c.gradient_ft_per_nm;
    const floor_alt = c.airport_elev_ft + c.min_aircraft_agl_ft;
    const aircraft_alt = Math.min(c.cruise_alt_ft, Math.max(floor_alt, slope_alt));
    // Buffer doesn't drag the limit below the airport itself — at field
    // elevation the aircraft is on the runway and isn't expected to be
    // 500 ft above local terrain.
    const limit = Math.max(
      aircraft_alt - TERMINAL_BUFFER_FT,
      c.airport_elev_ft,
    );
    const e = c.dem.elevationFt({ lat, lon });
    if (e === null) continue;
    const shortfall = e - limit;
    if (shortfall > worst) worst = shortfall;
  }
  return worst;
}

export interface TerminalCorridorWarning {
  /** Airport ICAO/LID identifier the warning attaches to. */
  ident: string;
  /** Whether the warning applies to the climb out of this airport or
   *  the approach into it. An intermediate stop can have both — the
   *  caller receives two warnings in that case. */
  kind: "departure" | "arrival";
  /** Worst-sample shortfall in feet — terrain peak minus the safe
   *  altitude profile (climb slope or descent slope, with buffer)
   *  capped at the airport's own elevation. */
  shortfall_ft: number;
  /** Aircraft altitude in feet at the shortfall point. Useful for
   *  phrasing the warning ("terrain X ft below your climb/descent"). */
  aircraft_alt_ft: number;
}

/** Pulls per-airport terrain shortfalls off a planned route's edge
 *  metadata into a tidy list for UI display. The shortfalls
 *  themselves are written by `computeTerrainPenalty` into
 *  `edge.extra.terrain_departure_shortfall_ft` /
 *  `terrain_arrival_shortfall_ft` during graph construction. */
export function terminalCorridorWarnings(
  route: PlannedRoute,
): TerminalCorridorWarning[] {
  const out: TerminalCorridorWarning[] = [];
  for (const leg of route.legs) {
    const dep = leg.extra?.terrain_departure_shortfall_ft;
    if (dep !== undefined && dep > 0) {
      out.push({
        ident: leg.fromAirport.icao ?? leg.fromAirport.lid,
        kind: "departure",
        shortfall_ft: dep,
        aircraft_alt_ft: leg.fromAirport.elevation_ft ?? 0,
      });
    }
    const arr = leg.extra?.terrain_arrival_shortfall_ft;
    if (arr !== undefined && arr > 0) {
      out.push({
        ident: leg.toAirport.icao ?? leg.toAirport.lid,
        kind: "arrival",
        shortfall_ft: arr,
        aircraft_alt_ft: leg.toAirport.elevation_ft ?? 0,
      });
    }
  }
  return out;
}
