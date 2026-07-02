import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { greatCircleNM, interpolateGreatCircle } from "./geo";
import { climbFromTo } from "./performance";
import {
  SAMPLE_SPACING_NM,
  TERRAIN_BUFFER_FT,
  type DEMSampler,
} from "./terrain";
import {
  STANDARD_DESCENT_FT_PER_NM,
  TERMINAL_BUFFER_FT,
} from "./terrainPenalty";

/** Reference gradients that mark "normal" climb-out / descent-in —
 *  shared with the route-profile chart (`RouteProfile.tsx`) so the
 *  chart's bands and any other gradient-based copy (e.g. the "why
 *  these stops" panel) always agree on what counts as terrain-driven.
 *  These are the *upper* edges of the chart's reference bands; the
 *  gentler lower edges (200 ft/nm, 3°) are cosmetic-only and stay
 *  local to the chart. */
export const NORMAL_CLIMB_MAX_FT_PER_NM = 400;
export const NORMAL_DESCENT_MAX_DEG = 3.5;

/** The standard departure climb gradient (ft/nm). A light aircraft is
 *  expected to make this and clear terrain that stays below the TERPS
 *  40:1 obstacle-clearance surface. Terrain that forces steeper than
 *  this is the trigger for a terrain callout. */
export const STANDARD_CLIMB_FT_PER_NM = 200;

/** The TERPS 40:1 obstacle-clearance surface slope (ft/nm). Terrain or
 *  obstacles below this surface (rising from the field) are cleared by
 *  a standard climb; terrain penetrating it requires a steeper one. */
export const OCS_40_TO_1_FT_PER_NM = 152;

/** Rate (ft per nm from the field) at which the required terrain
 *  clearance ramps up — the vertical margin a standard 200 ft/nm climb
 *  holds above the 40:1 surface, i.e. 200 − 152 = 48 ft/nm. This is the
 *  TERPS geometry made explicit: the clearance you must hold is ~zero
 *  off the departure end and grows with distance (capped at the 2,000
 *  ft enroute buffer). With it, terrain sitting exactly on the 40:1
 *  surface works out to a required gradient of exactly the 200 ft/nm
 *  standard climb — the natural boundary. A fixed buffer instead (500
 *  ft at every distance) divides by the tiny near-field distances and
 *  manufactures a steep phantom "requirement" over dead-flat ground. */
export const CLEARANCE_RAMP_FT_PER_NM =
  STANDARD_CLIMB_FT_PER_NM - OCS_40_TO_1_FT_PER_NM;

export interface LegProfilePoint {
  distNm: number;
  lat: number;
  lon: number;
  /** DEM elevation at this point, or null outside grid coverage. */
  terrainFt: number | null;
  /** Planned aircraft altitude at this point (climb/cruise/descent). */
  profileFt: number;
}

/** A contiguous stretch of the leg where the profile's terrain margin
 *  is thin ("caution") or gone entirely ("danger"). */
export interface LegProfileSpan {
  startNm: number;
  endNm: number;
  kind: "caution" | "danger";
}

/** A gradient paired with what standard practice calls for, so the UI
 *  can show both the normal-gradient reference band and how much
 *  steeper terrain actually demands. */
export interface LegProfileGradient {
  /** Standard gradient (ft/nm): POH climb rate for climbs, the fixed
   *  1,000 ft / 3 nm glidepath for descents. Not terrain-aware. */
  stdFtPerNm: number;
  /** Smallest gradient at/above standard that clears sampled terrain
   *  (+ TERMINAL_BUFFER_FT) inside the climb/descent corridor. Equals
   *  stdFtPerNm when terrain doesn't force anything steeper. This is
   *  the gradient the profile PATH is drawn with — never gentler than
   *  stdFtPerNm, so the drawn ramp stays realistic. */
  reqFtPerNm: number;
  /** The RAW gradient terrain forces to clear the corridor by the
   *  buffer, unclamped — can be gentler than stdFtPerNm, or zero over
   *  flat ground. Tier/severity logic keys off this so it reflects
   *  what the terrain requires, independent of what the aircraft
   *  happens to climb. */
  terrainReqFtPerNm: number;
}

export interface LegProfileData {
  points: LegProfilePoint[];
  distanceNm: number;
  cruiseAltFt: number;
  /** Distance from departure at which the profile reaches cruise. */
  topOfClimbNm: number;
  /** Distance from departure at which the descent begins. */
  topOfDescentNm: number;
  spans: LegProfileSpan[];
  climb: LegProfileGradient;
  descent: LegProfileGradient;
}

/** One terrain sample along the leg's great-circle path, tagged with its
 *  distance from departure. Collected once and reused both to derive the
 *  required climb/descent gradients and to build the drawn points. */
interface RawSample {
  distNm: number;
  lat: number;
  lon: number;
  terrainFt: number | null;
}

/** Smallest gradient (ft/nm) at or above `stdFtPerNm` such that a
 *  constant-gradient ramp from cruise into `fieldElevFt` clears every
 *  terrain sample (+ TERMINAL_BUFFER_FT) within the ramp's own
 *  footprint. `distFromField` maps a raw sample to its distance from
 *  the field the ramp anchors on (departure for climb, arrival for
 *  descent) — samples inside the field's own cell, and anywhere a
 *  standard ramp wouldn't yet clear a full buffer above the field
 *  (see `minDistNm` below), are ignored, and so is anything beyond
 *  the ramp's current footprint.
 *
 *  Steeper g ⇒ shorter footprint D ⇒ fewer candidate samples, so
 *  tightening g can only ever raise the bar further, never walk it
 *  back down — three passes is enough to settle. */
function requiredGradient(params: {
  cruiseAltFt: number;
  fieldElevFt: number;
  stdFtPerNm: number;
  samples: RawSample[];
  distFromField: (s: RawSample) => number;
}): { required: number; terrainDemand: number } {
  const { cruiseAltFt, fieldElevFt, stdFtPerNm, samples, distFromField } =
    params;
  const rise = cruiseAltFt - fieldElevFt;
  if (!(rise > 0) || !Number.isFinite(stdFtPerNm) || stdFtPerNm <= 0) {
    return { required: stdFtPerNm, terrainDemand: 0 };
  }
  // Below this distance, even a *standard*-gradient ramp hasn't yet
  // climbed/descended a full buffer's worth above the field — every
  // airport sits on ground at roughly its own elevation, so without
  // this the field's own surroundings would "require" a steeper ramp
  // on every single leg, standard terrain or not. This is the same
  // concern terrainPenalty's ARRIVAL_FLOOR_AGL_FT addresses (terrain
  // inside the pattern isn't a practical hazard); expressing it as a
  // distance floor keeps the search purely in terms of the linear
  // Ignore the immediate runway environment (obstacles inside the
  // first half nm are a takeoff-briefing matter, not a cruise-profile
  // one) and guard the division against d → 0.
  const minDistNm = 0.5;
  // Required clearance above terrain at distance d from the field: a
  // TERPS-style ramp — near zero at the field, growing to the full
  // enroute buffer far out. This is what makes the demand honest: a
  // fixed 500 ft buffer near the field divides by a tiny distance and
  // manufactures a steep phantom gradient over flat ground, whereas a
  // ramp asks only for the clearance you could actually have that
  // close in.
  const roc = (d: number) =>
    Math.min(TERRAIN_BUFFER_FT, CLEARANCE_RAMP_FT_PER_NM * d);
  // `required` is the drawn ramp gradient (never gentler than std, so
  // the path is realistic); `terrainDemand` is the *raw* gradient the
  // terrain forces to clear it by the ramped clearance, UNclamped — it
  // can be gentler than std. The tier logic keys off terrainDemand so
  // it reflects what terrain requires, not what the aircraft climbs.
  let g = stdFtPerNm;
  let terrainDemand = 0;
  for (let pass = 0; pass < 3; pass++) {
    const footprintNm = rise / g;
    let worst = 0;
    for (const s of samples) {
      if (s.terrainFt === null) continue;
      // Below-field terrain isn't an obstacle to a ramp anchored at the
      // field. Real terrain above it contributes its own rise plus the
      // distance-appropriate clearance.
      if (s.terrainFt <= fieldElevFt) continue;
      const d = distFromField(s);
      if (d < minDistNm || d > footprintNm) continue;
      const need = (s.terrainFt + roc(d) - fieldElevFt) / d;
      if (need > worst) worst = need;
    }
    terrainDemand = worst;
    g = Math.max(stdFtPerNm, worst);
  }
  return { required: g, terrainDemand };
}

/** Vertical profile of one leg plotted against the terrain beneath it.
 *
 *  The flight path is drawn using the *required* climb/descent
 *  gradients (see `requiredGradient`), not the bare standard ones: a
 *  standard-gradient descent into a terrain-locked field would plunge
 *  straight through rising ground, which is exactly the defect this is
 *  meant to surface. When terrain doesn't force anything steeper, the
 *  required gradient collapses to the standard one and the path is
 *  unchanged from a straightforward POH climb / 1,000 ft-per-3 nm
 *  descent.
 *
 *  Margin spans mirror the engine's dual buffers: 2,000 ft in cruise,
 *  500 ft inside the climb / descent corridors. Because the drawn path
 *  itself now respects that 500 ft buffer wherever terrain allows,
 *  terminal-area "danger" spans should only appear where the leg is
 *  genuinely unclearable this way (e.g. the required gradient would
 *  have to exceed what any light GA aircraft can fly).
 *
 *  Short legs where climb + descent overlap get a clipped "tent"
 *  profile: the two ramps intersect below the requested cruise. */
export function buildLegProfile(input: {
  from: Airport;
  to: Airport;
  cruiseAltFt: number;
  aircraft: Aircraft;
  dem: DEMSampler;
}): LegProfileData {
  const { from, to, cruiseAltFt, aircraft, dem } = input;
  const distanceNm = greatCircleNM(from, to);
  const fromElev = from.elevation_ft ?? 0;
  const toElev = to.elevation_ft ?? 0;

  const segments = Math.max(1, Math.ceil(distanceNm / SAMPLE_SPACING_NM));
  const path = interpolateGreatCircle(from, to, segments);
  const rawSamples: RawSample[] = path.map((p, i) => ({
    distNm: (i / segments) * distanceNm,
    lat: p.lat,
    lon: p.lon,
    terrainFt: dem.elevationFt(p),
  }));

  const climbDistNm = climbFromTo(aircraft, fromElev, cruiseAltFt).distance_nm;
  const climbStdFtPerNm =
    climbDistNm > 0 ? (cruiseAltFt - fromElev) / climbDistNm : Infinity;
  const descentStdFtPerNm = STANDARD_DESCENT_FT_PER_NM;

  const climbReq = requiredGradient({
    cruiseAltFt,
    fieldElevFt: fromElev,
    stdFtPerNm: climbStdFtPerNm,
    samples: rawSamples,
    distFromField: (s) => s.distNm,
  });
  const descentReq = requiredGradient({
    cruiseAltFt,
    fieldElevFt: toElev,
    stdFtPerNm: descentStdFtPerNm,
    samples: rawSamples,
    distFromField: (s) => distanceNm - s.distNm,
  });
  const climbReqFtPerNm = climbReq.required;
  const descentReqFtPerNm = descentReq.required;

  const climbDistNmReq =
    Number.isFinite(climbReqFtPerNm) && climbReqFtPerNm > 0
      ? (cruiseAltFt - fromElev) / climbReqFtPerNm
      : 0;
  const descentDistNmReq = Math.max(
    0,
    (cruiseAltFt - toElev) / descentReqFtPerNm,
  );

  // Where the climb and descent ramps meet if there's no room for a
  // cruise segment. Both ramps are treated as linear in distance —
  // the same simplification the terminal-corridor scorer makes.
  let topOfClimbNm = Math.min(climbDistNmReq, distanceNm);
  let topOfDescentNm = Math.max(0, distanceNm - descentDistNmReq);
  if (topOfDescentNm < topOfClimbNm) {
    // Solve fromElev + c·x = toElev + d·(D − x) for the ramp meeting
    // point x; degenerate inputs fall back to the midpoint.
    const meet =
      Number.isFinite(climbReqFtPerNm) &&
      climbReqFtPerNm + descentReqFtPerNm > 0
        ? (toElev + descentReqFtPerNm * distanceNm - fromElev) /
          (climbReqFtPerNm + descentReqFtPerNm)
        : distanceNm / 2;
    topOfClimbNm = Math.min(Math.max(meet, 0), distanceNm);
    topOfDescentNm = topOfClimbNm;
  }

  const profileAt = (d: number): number => {
    if (d <= topOfClimbNm) {
      const t = topOfClimbNm > 0 ? d / topOfClimbNm : 1;
      return fromElev + t * (altAt(topOfClimbNm) - fromElev);
    }
    if (d >= topOfDescentNm) {
      return toElev + (distanceNm - d) * descentReqFtPerNm;
    }
    return cruiseAltFt;
  };
  // Altitude actually reached at top of climb — cruiseAltFt normally,
  // lower when the ramps meet early on a short leg.
  const altAt = (tocNm: number): number =>
    tocNm >= topOfDescentNm && topOfDescentNm < distanceNm
      ? toElev + (distanceNm - tocNm) * descentReqFtPerNm
      : cruiseAltFt;

  const points: LegProfilePoint[] = rawSamples.map((s) => ({
    distNm: s.distNm,
    lat: s.lat,
    lon: s.lon,
    terrainFt: s.terrainFt,
    profileFt: profileAt(s.distNm),
  }));
  // Anchor the endpoints on the published field elevations — the DEM
  // cell under a runway can disagree by a few dozen feet.
  if (points.length > 0) {
    points[0] = {
      distNm: 0,
      lat: from.lat,
      lon: from.lon,
      terrainFt: fromElev,
      profileFt: fromElev,
    };
    points[points.length - 1] = {
      distNm: distanceNm,
      lat: to.lat,
      lon: to.lon,
      terrainFt: toElev,
      profileFt: toElev,
    };
  }

  // Group consecutive thin-margin samples into shaded spans.
  const spans: LegProfileSpan[] = [];
  let open: LegProfileSpan | null = null;
  for (const pt of points) {
    const inTerminal =
      pt.distNm < topOfClimbNm || pt.distNm > topOfDescentNm;
    const buffer = inTerminal ? TERMINAL_BUFFER_FT : TERRAIN_BUFFER_FT;
    const clearance =
      pt.terrainFt === null ? Infinity : pt.profileFt - pt.terrainFt;
    const kind: LegProfileSpan["kind"] | null =
      clearance <= 0 ? "danger" : clearance < buffer ? "caution" : null;
    if (kind && open && open.kind === kind) {
      open.endNm = pt.distNm;
    } else if (kind) {
      if (open) spans.push(open);
      open = { startNm: pt.distNm, endNm: pt.distNm, kind };
    } else if (open) {
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);
  // The field itself always "touches" the path at both thresholds;
  // drop zero-width spans pinned to the runway ends.
  const filtered = spans.filter(
    (s) =>
      s.endNm > s.startNm &&
      !(s.kind === "danger" && (s.endNm <= 0 || s.startNm >= distanceNm)),
  );

  return {
    points,
    distanceNm,
    cruiseAltFt,
    topOfClimbNm,
    topOfDescentNm,
    spans: filtered,
    climb: {
      stdFtPerNm: climbStdFtPerNm,
      reqFtPerNm: climbReqFtPerNm,
      terrainReqFtPerNm: climbReq.terrainDemand,
    },
    descent: {
      stdFtPerNm: descentStdFtPerNm,
      reqFtPerNm: descentReqFtPerNm,
      terrainReqFtPerNm: descentReq.terrainDemand,
    },
  };
}
