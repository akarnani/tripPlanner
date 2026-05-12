import type { Airport, Obstacle } from "@/data/loaders";
import { greatCircleNM, interpolateGreatCircle, type LatLon } from "./geo";
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
  /** Minimum safe altitude on this leg, hemispheric-rounded for its course. */
  minSafeAltFt: number;
}

export interface TerrainAnalysis {
  samples: TerrainSample[];
  warnings: TerrainWarning[];
  perLeg: PerLegAnalysis[];
  /** Single global "if you replan, target at least this" altitude, the
   *  max of all legs' hemispheric min-safe altitudes. The engine then
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
  }>;
  obstacles: readonly Obstacle[];
  flightRule: FlightRule;
  dem?: DEMSampler;
  variation?: VariationFn;
}

export function analyzeTerrain(input: AnalyzeInput): TerrainAnalysis {
  const dem = input.dem ?? nullDEMSampler;
  const samples: TerrainSample[] = [];
  const warnings: TerrainWarning[] = [];
  const perLeg: PerLegAnalysis[] = [];

  input.legs.forEach((leg, i) => {
    const dist = greatCircleNM(leg.from, leg.to);
    const segments = Math.max(1, Math.ceil(dist / SAMPLE_SPACING_NM));
    const path = interpolateGreatCircle(leg.from, leg.to, segments);

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

    const trueCourse = initialTrueCourseDeg(leg.from, leg.to);
    const variation = input.variation?.(leg.from) ?? null;
    const magneticCourse =
      variation !== null
        ? magneticCourseDeg(trueCourse, variation)
        : trueCourse;
    const minSafeAltFt = hemisphericAltitude(
      worst.elevation_ft + TERRAIN_BUFFER_FT,
      magneticCourse,
      input.flightRule,
    );
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

  const replanTargetFt = perLeg.reduce((m, l) => Math.max(m, l.minSafeAltFt), 0);

  return { samples, warnings, perLeg, replanTargetFt };
}
