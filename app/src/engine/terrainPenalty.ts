import type { Airport } from "@/data/loaders";
import { greatCircleNM, polylineLengthNM, type LatLon } from "./geo";
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
  /** Nav points the leg is shaped through, if any. Both corridors then
   *  follow the shaped track — outward along its first segments, inward
   *  along its last — because a leg bent to dodge terrain leaves and
   *  arrives on headings the direct course knows nothing about, and
   *  scoring the direct course would charge it for terrain it avoids
   *  while missing the terrain it turned toward. */
  via?: readonly LatLon[];
  /** Precomputed length of the leg's ground track (nm) — the polyline
   *  length when `via` is present, the great circle otherwise. The
   *  routing graph already has this for every edge, so passing it in
   *  skips a redundant sqrt + 4 trig on the hot path. */
  distance_nm?: number;
  /** Precomputed initial true course out of `from` (degrees) — along
   *  the first shaped segment when `via` is present, which is what the
   *  departure corridor wants either way. Same hot-path optimization as
   *  `distance_nm`. */
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
  const { from, to, cruise_alt_ft, climb_speed_kt, climb_rate_fpm, dem, via } =
    input;
  const shaped = via !== undefined && via.length > 0;
  const outbound: LatLon[] = shaped ? [from, ...via, to] : [from, to];
  const total_nm = input.distance_nm ?? polylineLengthNM(outbound);
  if (total_nm === 0) return ZERO;

  const climb_ft_per_nm =
    climb_speed_kt > 0 ? (climb_rate_fpm * 60) / climb_speed_kt : Infinity;

  const departure_shortfall_ft = corridorShortfall({
    track: outbound,
    total_nm,
    // The caller's precomputed course is the one out of `from` along
    // the track's first segment, shaped or not, so it still applies.
    first_bearing_deg: input.true_course_deg,
    airport_elev_ft: from.elevation_ft ?? 0,
    cruise_alt_ft,
    gradient_ft_per_nm: climb_ft_per_nm,
    dem,
    // Departure: the aircraft really is at field elevation at d=0
    // and climbs from there, so no AGL floor applies.
    min_aircraft_agl_ft: 0,
  });
  const arrival_shortfall_ft = corridorShortfall({
    // Same track walked from the far end: the arrival corridor is the
    // last 30 nm of the leg, which on a shaped leg is the inbound
    // segment out of the final nav point, not the direct course.
    // Walked by index rather than a reversed copy — this runs for every
    // candidate edge in the graph, and two array allocations per edge
    // is measurably worse than the scalar code this replaced.
    track: outbound,
    reversed: true,
    total_nm,
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
  /** The leg's ground track, ordered from the airport the corridor
   *  anchors on (origin for departure, destination for arrival) outward
   *  through any nav points the leg is shaped through. Sampling
   *  proceeds from `track[0]` along it. */
  track: readonly LatLon[];
  total_nm: number;
  /** Walk `track` from its last element backwards, for the arrival
   *  corridor. Avoids materialising a reversed copy per edge. */
  reversed?: boolean;
  /** Initial true course along the first walked pair, when the caller
   *  already has it. Omitted, the corridor computes its own. */
  first_bearing_deg?: number;
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

/** Per-nm lat/lon step along `a`→`b` in a flat-earth frame anchored at
 *  `a`. `bearing_deg` short-circuits the course computation for callers
 *  that already have it. */
function stepPerNm(
  a: LatLon,
  b: LatLon,
  bearing_deg?: number,
): { dlat: number; dlon: number } {
  const bearing_rad =
    ((bearing_deg ?? initialTrueCourseDeg(a, b)) * Math.PI) / 180;
  const cos_lat = Math.cos((a.lat * Math.PI) / 180);
  return {
    dlat: Math.cos(bearing_rad) * DEG_PER_NM,
    dlon: cos_lat !== 0 ? (Math.sin(bearing_rad) * DEG_PER_NM) / cos_lat : 0,
  };
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
  const samples = Math.max(1, Math.ceil(corridor_nm / CORRIDOR_SAMPLE_NM));
  // Equirectangular projection, re-anchored wherever the track bends. At
  // 30 nm scales the great-circle path differs from a straight line by
  // sub-arcminute — using a flat-earth step here skips the per-sample
  // trig the full geodesic needs and makes the hot loop a
  // few-multiplies-per-sample affair. A shaped corridor pays that trig
  // once per bend it actually reaches, never per sample.
  // The frame lives in scalars, not in an object read per sample: this
  // loop runs ~60 times for every candidate edge in the graph.
  // Index math inlined rather than wrapped in a closure: this function
  // is called twice for every candidate edge in the graph, and a
  // per-call closure allocation shows up in the profile.
  const track = c.track;
  const last = track.length - 1;
  const rev = c.reversed === true;
  let seg = 0;
  let seg_start_nm = 0;
  // A corridor with only one segment can't advance off it, so it never
  // needs the segment's length — and an unshaped leg is that case.
  let seg_end_nm =
    last > 1
      ? greatCircleNM(track[rev ? last : 0], track[rev ? last - 1 : 1])
      : Infinity;
  let step = stepPerNm(
    track[rev ? last : 0],
    track[rev ? last - 1 : 1],
    c.first_bearing_deg,
  );
  let anchor_lat = track[rev ? last : 0].lat;
  let anchor_lon = track[rev ? last : 0].lon;
  let dlat_per_nm = step.dlat;
  let dlon_per_nm = step.dlon;

  let worst = 0;
  for (let i = 1; i <= samples; i++) {
    const d_from_airport = (i / samples) * corridor_nm;
    // Walk onto the segment this sample falls in. Past the final vertex
    // the last segment's heading is simply held — the corridor can only
    // outrun the track if `total_nm` overstates it, and extrapolating on
    // the final heading is what the unshaped case has always done.
    while (d_from_airport > seg_end_nm && seg + 2 < c.track.length) {
      seg_start_nm = seg_end_nm;
      seg++;
      const a = track[rev ? last - seg : seg];
      const b = track[rev ? last - seg - 1 : seg + 1];
      seg_end_nm += greatCircleNM(a, b);
      step = stepPerNm(a, b);
      anchor_lat = a.lat;
      anchor_lon = a.lon;
      dlat_per_nm = step.dlat;
      dlon_per_nm = step.dlon;
    }
    const d_in_seg = d_from_airport - seg_start_nm;
    const lat = anchor_lat + d_in_seg * dlat_per_nm;
    const lon = anchor_lon + d_in_seg * dlon_per_nm;
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
