import type { Airport } from "@/data/loaders";
import {
  greatCircleNM,
  interpolateGreatCircle,
  pointAtFraction,
} from "./geo";
import type { DEMSampler } from "./terrain";

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

export interface TerrainPenaltyInput {
  from: Airport;
  to: Airport;
  /** Hemispheric-rounded cruise altitude actually flown on this leg. */
  cruise_alt_ft: number;
  /** TAS at cruise; used to estimate climb groundspeed. A modest
   *  overestimate is fine — under-penalizing slightly is better than
   *  spurious penalties from assumed-slow climb. */
  tas_kt: number;
  /** Aircraft climb rate (ft/min). */
  climb_rate_fpm: number;
  dem: DEMSampler;
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
  const { from, to, cruise_alt_ft, tas_kt, climb_rate_fpm, dem } = input;
  const total_nm = greatCircleNM(from, to);
  if (total_nm === 0) return ZERO;

  const climb_ft_per_nm =
    tas_kt > 0 ? (climb_rate_fpm * 60) / tas_kt : Infinity;

  const departure_shortfall_ft = corridorShortfall({
    near: from,
    far: to,
    total_nm,
    airport_elev_ft: from.elevation_ft ?? 0,
    cruise_alt_ft,
    gradient_ft_per_nm: climb_ft_per_nm,
    dem,
  });
  const arrival_shortfall_ft = corridorShortfall({
    near: to,
    far: from,
    total_nm,
    airport_elev_ft: to.elevation_ft ?? 0,
    cruise_alt_ft,
    gradient_ft_per_nm: STANDARD_DESCENT_FT_PER_NM,
    dem,
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
  /** Other endpoint of the leg; defines the corridor's direction. */
  far: Airport;
  total_nm: number;
  airport_elev_ft: number;
  cruise_alt_ft: number;
  gradient_ft_per_nm: number;
  dem: DEMSampler;
}

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
  const segments = Math.max(1, Math.ceil(corridor_nm / CORRIDOR_SAMPLE_NM));
  const corridor_end = pointAtFraction(
    c.near,
    c.far,
    corridor_nm / c.total_nm,
  );
  const path = interpolateGreatCircle(c.near, corridor_end, segments);

  let worst = 0;
  for (let i = 0; i < path.length; i++) {
    const d_from_airport = (i / segments) * corridor_nm;
    // Aircraft altitude profile from the airport outward: rising along
    // the descent / climb slope until it intercepts cruise altitude,
    // then level at cruise. Terrain above this profile (with the buffer)
    // is what costs us — either it pierces the standard descent slope,
    // or it pokes above the planned cruise so the leg itself isn't
    // flyable at the chosen altitude.
    const aircraft_alt = Math.min(
      c.cruise_alt_ft,
      c.airport_elev_ft + d_from_airport * c.gradient_ft_per_nm,
    );
    const e = c.dem.elevationFt(path[i]);
    if (e === null) continue;
    // Buffer doesn't drag the limit below the airport itself — at field
    // elevation the aircraft is on the runway and isn't expected to be
    // 500 ft above local terrain.
    const limit = Math.max(
      aircraft_alt - TERMINAL_BUFFER_FT,
      c.airport_elev_ft,
    );
    const shortfall = e - limit;
    if (shortfall > worst) worst = shortfall;
  }
  return worst;
}
