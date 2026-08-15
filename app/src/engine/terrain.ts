import type { Airport, Obstacle } from "@/data/loaders";
import {
  greatCircleNM,
  interpolateGreatCircle,
  interpolatePolyline,
  type LatLon,
} from "./geo";
import {
  hemisphericAltitude,
  initialTrueCourseDeg,
  magneticCourseDeg,
  type FlightRule,
} from "./hemispheric";

/** East-positive magnetic variation in degrees, or null if unavailable. */
export type VariationFn = (point: LatLon) => number | null;

export const TERRAIN_BUFFER_FT = 2000;
/** Width of the per-leg corridor in nautical miles used for obstacle pickup. */
export const CORRIDOR_NM = 1;
/** Sample spacing along each leg in nautical miles. */
export const SAMPLE_SPACING_NM = 1;

/**
 * Elevation provider abstraction. The browser plugs in a sampler that
 * decodes the committed CONUS DEM grid; tests can inject anything.
 */
export interface DEMSampler {
  /** Returns the ground elevation in feet MSL at the given lat/lon, or
   *  null if unavailable. Should be cheap to call (~10⁴ times per plan). */
  elevationFt(point: LatLon): number | null;
}

export const nullDEMSampler: DEMSampler = { elevationFt: () => null };

/**
 * Optional fast path for "how high can the ground be along this leg".
 *
 * Implementations must return a value that is never *below* the true
 * peak, so a caller can treat "bound + buffer ≤ altitude" as proof of
 * clearance. null means "unknown" — the path left the covered area or
 * the data isn't loaded — and must never be read as "clear".
 *
 * Kept separate from DEMSampler so test doubles and nullDEMSampler stay
 * valid samplers without having to implement it.
 */
export interface TerrainBoundSampler {
  maxTerrainAlongFt(a: LatLon, b: LatLon): number | null;
}

export function hasTerrainBound(
  dem: DEMSampler,
): dem is DEMSampler & TerrainBoundSampler {
  return typeof (dem as Partial<TerrainBoundSampler>).maxTerrainAlongFt === "function";
}

export interface LegTerrainPeak {
  /** Highest terrain MSL found along the leg, or null if the DEM had
   *  nothing to say about any of it. */
  peakFt: number | null;
  /** True when at least one sample fell outside the DEM's coverage.
   *  Callers that gate on terrain must fail closed on this. */
  offGrid: boolean;
}

/**
 * Samples the great circle between two points and returns the highest
 * terrain along it, ignoring the endpoints' own field elevations.
 *
 * This is the raw measurement behind `legMinSafeCruiseAltFt`, split out
 * so callers that need the peak itself (rather than a hemispherically
 * rounded altitude) don't have to round-trip through the cruise-level
 * rules to get it back.
 */
export function legTerrainPeakFt(input: {
  from: LatLon;
  to: LatLon;
  dem: DEMSampler;
  /** Nav points the leg is shaped through, if any. */
  via?: readonly LatLon[];
  /** Sample spacing in nm; defaults to SAMPLE_SPACING_NM. */
  spacing_nm?: number;
}): LegTerrainPeak {
  const { from, to, dem, via } = input;
  const spacing = input.spacing_nm ?? SAMPLE_SPACING_NM;
  if (greatCircleNM(from, to) <= 0 && (!via || via.length === 0)) {
    const e = dem.elevationFt(from);
    return { peakFt: e, offGrid: e === null };
  }
  const path = legGroundTrack(from, to, via, spacing);
  let peak: number | null = null;
  let offGrid = false;
  for (const p of path) {
    const e = dem.elevationFt(p);
    if (e === null) {
      offGrid = true;
      continue;
    }
    if (peak === null || e > peak) peak = e;
  }
  return { peakFt: peak, offGrid };
}

export interface TerrainSample {
  point: LatLon;
  elevation_ft: number;
  /** Identifier of the source — airport id, obstacle id, or "dem". */
  source: string;
  source_label: string;
}

export interface TerrainWarning {
  legIndex: number;
  fromIdent: string;
  toIdent: string;
  worst: TerrainSample;
  clearance_ft: number;
  /** The leg's actual planned cruise altitude (hemispheric-correct). */
  cruise_alt_ft: number;
}

export interface PerLegAnalysis {
  legIndex: number;
  /** Highest single sample (terrain or obstacle MSL) along the leg. */
  worst: TerrainSample;
  /** Minimum safe altitude on this leg: hemispheric-rounded for every
   *  segment of its ground track, then the highest of those — the same
   *  rule routing.ts uses to pick the altitude the leg actually flies. */
  minSafeAltFt: number;
}

export interface TerrainAnalysis {
  samples: TerrainSample[];
  warnings: TerrainWarning[];
  perLeg: PerLegAnalysis[];
  /** Single global "if you replan, target at least this" altitude:
   *  the max hemispheric min-safe altitude across the legs that
   *  warned (route-wide max when nothing warned). The engine then
   *  re-rounds per leg as legs go opposite directions. */
  replanTargetFt: number;
}

export interface AnalyzeInput {
  legs: Array<{
    from: Airport;
    to: Airport;
    fromIdent: string;
    toIdent: string;
    /** Planned cruise altitude on this leg. */
    cruise_alt_ft: number;
    /** Nav points the leg is shaped through. When present the leg is
     *  analysed along [from, ...via, to], not the direct great circle
     *  — otherwise the app would warn about terrain on a path the
     *  aircraft isn't flying, and miss terrain on the path it is. */
    via?: readonly LatLon[];
  }>;
  obstacles: readonly Obstacle[];
  flightRule: FlightRule;
  dem?: DEMSampler;
  variation?: VariationFn;
}

/**
 * The points a leg's ground track actually passes over, sampled at
 * `SAMPLE_SPACING_NM`. A leg shaped through nav points follows the
 * polyline through them; an unshaped leg is a plain great circle.
 *
 * Every consumer that reasons about what a leg overflies — terrain,
 * obstacles, the vertical profile, the map — must go through here, so
 * they can't disagree about where the aeroplane is.
 */
export function legGroundTrack(
  from: LatLon,
  to: LatLon,
  via?: readonly LatLon[],
  spacing_nm = SAMPLE_SPACING_NM,
): LatLon[] {
  if (via && via.length > 0) {
    return interpolatePolyline([from, ...via, to], spacing_nm);
  }
  const dist = greatCircleNM(from, to);
  const segments = Math.max(1, Math.ceil(dist / spacing_nm));
  return interpolateGreatCircle(from, to, segments);
}

/**
 * Lowest hemispheric-legal level at or above `floorFt` that a leg can
 * be flown at, taking parity from every segment of its ground track
 * rather than from the straight line between its endpoints.
 *
 * A leg flies one altitude, and routing.ts picks it as the highest
 * level any individual segment wants (see `Edge.cruise_alt_ft`). The
 * advisory side has to answer with the same rule or the two disagree
 * on exactly the legs this matters for: bend a leg across the 0/180
 * course boundary and its segments want opposite parities, so the
 * endpoint course names a level the router would never fly. That
 * number is not cosmetic — it is what the "Replan at N ft" button
 * hands back to the planner, and a target the planner immediately
 * rounds somewhere else is worse than no target.
 *
 * Variation is sampled once at the leg origin, matching how routing.ts
 * builds the same segment courses; sampling per segment would make the
 * two disagree on legs long enough to cross an isogonic line.
 */
function legHemisphericAltitudeFt(input: {
  floorFt: number;
  from: LatLon;
  to: LatLon;
  via?: readonly LatLon[];
  flightRule: FlightRule;
  variation?: VariationFn;
}): number {
  const { floorFt, from, to, via, flightRule } = input;
  const varDeg = input.variation?.(from) ?? null;
  const track: LatLon[] =
    via && via.length > 0 ? [from, ...via, to] : [from, to];
  let alt = 0;
  for (let i = 0; i < track.length - 1; i++) {
    const trueCourse = initialTrueCourseDeg(track[i], track[i + 1]);
    const course =
      varDeg !== null ? magneticCourseDeg(trueCourse, varDeg) : trueCourse;
    const a = hemisphericAltitude(floorFt, course, flightRule);
    if (a > alt) alt = a;
  }
  return alt;
}

/** Minimum hemispheric-correct cruise altitude that clears the terrain
 *  along a leg's ground track, with the standard 2,000 ft buffer.
 *  Returns 0 when the DEM has no data for the leg. */
export function legMinSafeCruiseAltFt(input: {
  from: Airport;
  to: Airport;
  flightRule: FlightRule;
  variation?: VariationFn;
  dem: DEMSampler;
  /** Nav points the leg is shaped through, if any. */
  via?: readonly LatLon[];
  /** Optional override for the vertical buffer above terrain. Defaults
   *  to TERRAIN_BUFFER_FT (2,000 ft). */
  buffer_ft?: number;
}): number {
  const { from, to, flightRule, variation, dem, via } = input;
  const buffer = input.buffer_ft ?? TERRAIN_BUFFER_FT;
  const dist = greatCircleNM(from, to);
  if (dist <= 0 && (!via || via.length === 0)) return 0;
  const { peakFt } = legTerrainPeakFt({ from, to, dem, via });
  let worst = Math.max(from.elevation_ft ?? 0, to.elevation_ft ?? 0);
  if (peakFt !== null && peakFt > worst) worst = peakFt;
  if (worst <= 0) return 0;
  return legHemisphericAltitudeFt({
    floorFt: worst + buffer,
    from,
    to,
    via,
    flightRule,
    variation,
  });
}

export function analyzeTerrain(input: AnalyzeInput): TerrainAnalysis {
  const dem = input.dem ?? nullDEMSampler;
  const samples: TerrainSample[] = [];
  const warnings: TerrainWarning[] = [];
  const perLeg: PerLegAnalysis[] = [];

  input.legs.forEach((leg, i) => {
    const path = legGroundTrack(leg.from, leg.to, leg.via);

    const legSamples: TerrainSample[] = [];
    legSamples.push({
      point: leg.from,
      elevation_ft: leg.from.elevation_ft ?? 0,
      source: leg.from.id,
      source_label: `${leg.fromIdent} field elev`,
    });
    legSamples.push({
      point: leg.to,
      elevation_ft: leg.to.elevation_ft ?? 0,
      source: leg.to.id,
      source_label: `${leg.toIdent} field elev`,
    });
    for (const p of path) {
      const e = dem.elevationFt(p);
      if (e !== null) {
        legSamples.push({
          point: p,
          elevation_ft: e,
          source: "dem",
          source_label: "terrain",
        });
      }
    }
    for (const o of input.obstacles) {
      const minToPath = Math.min(...path.map((p) => greatCircleNM(p, o)));
      if (minToPath > CORRIDOR_NM) continue;
      legSamples.push({
        point: o,
        elevation_ft: o.height_msl_ft,
        source: o.id,
        source_label: `${o.type} ${o.height_agl_ft}' AGL`,
      });
    }
    samples.push(...legSamples);

    let worst: TerrainSample = legSamples[0];
    for (const s of legSamples)
      if (s.elevation_ft > worst.elevation_ft) worst = s;

    const minSafeAltFt = legHemisphericAltitudeFt({
      floorFt: worst.elevation_ft + TERRAIN_BUFFER_FT,
      from: leg.from,
      to: leg.to,
      via: leg.via,
      flightRule: input.flightRule,
      variation: input.variation,
    });
    perLeg.push({ legIndex: i, worst, minSafeAltFt });

    const clearance = leg.cruise_alt_ft - worst.elevation_ft;
    if (clearance < TERRAIN_BUFFER_FT) {
      warnings.push({
        legIndex: i,
        fromIdent: leg.fromIdent,
        toIdent: leg.toIdent,
        worst,
        clearance_ft: clearance,
        cruise_alt_ft: leg.cruise_alt_ft,
      });
    }
  });

  // Suggested replan target. Only legs that actually warned drive it:
  // the planner may already have lifted other legs' cruise altitudes
  // well above the shared target, and folding their (higher) min-safe
  // altitudes into the suggestion produces a "replan several thousand
  // feet up" prompt for a route whose only real problem is one
  // marginal leg. With no warnings, fall back to the route-wide max so
  // the value still reads as "lowest target that clears everything".
  const warnedLegs = new Set(warnings.map((w) => w.legIndex));
  const replanTargetFt = perLeg
    .filter((l) => warnedLegs.size === 0 || warnedLegs.has(l.legIndex))
    .reduce((m, l) => Math.max(m, l.minSafeAltFt), 0);

  return { samples, warnings, perLeg, replanTargetFt };
}
