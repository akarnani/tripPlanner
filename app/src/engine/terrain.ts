import type { Airport, Obstacle } from "@/data/loaders";
import { greatCircleNM, interpolateGreatCircle, type LatLon } from "./geo";

export const TERRAIN_BUFFER_FT = 2000;
/** Width of the per-leg corridor in nautical miles used for obstacle pickup. */
export const CORRIDOR_NM = 1;
/** Sample spacing along each leg in nautical miles. */
export const SAMPLE_SPACING_NM = 1;

/**
 * Elevation provider abstraction. v1 ships a null sampler that returns no
 * DEM data; the only "terrain" comes from airport elevations and DOF
 * obstacles. When the PMTiles DEM build lands, drop in a sampler that
 * returns the underlying ground elevation at the queried point.
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
}

export interface TerrainAnalysis {
  samples: TerrainSample[];
  warnings: TerrainWarning[];
  /** Suggested minimum safe cruise altitude, rounded up to next 500 ft. */
  minSafeAltFt: number;
}

export interface AnalyzeInput {
  legs: Array<{
    from: Airport;
    to: Airport;
    fromIdent: string;
    toIdent: string;
  }>;
  obstacles: readonly Obstacle[];
  cruiseAltFt: number;
  dem?: DEMSampler;
}

export function analyzeTerrain(input: AnalyzeInput): TerrainAnalysis {
  const dem = input.dem ?? nullDEMSampler;
  const samples: TerrainSample[] = [];
  const warnings: TerrainWarning[] = [];

  input.legs.forEach((leg, i) => {
    const dist = greatCircleNM(leg.from, leg.to);
    const segments = Math.max(1, Math.ceil(dist / SAMPLE_SPACING_NM));
    const path = interpolateGreatCircle(leg.from, leg.to, segments);

    // Discrete terrain candidates for this leg: endpoint airport
    // elevations, DEM samples along the path, and DOF obstacles within
    // the corridor.
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
      const minToPath = Math.min(
        ...path.map((p) => greatCircleNM(p, o)),
      );
      if (minToPath > CORRIDOR_NM) continue;
      legSamples.push({
        point: o,
        elevation_ft: o.height_msl_ft,
        source: o.id,
        source_label: `${o.type} ${o.height_agl_ft}' AGL`,
      });
    }
    samples.push(...legSamples);

    let worst: TerrainSample | null = null;
    for (const s of legSamples) {
      if (!worst || s.elevation_ft > worst.elevation_ft) worst = s;
    }
    if (worst) {
      const clearance = input.cruiseAltFt - worst.elevation_ft;
      if (clearance < TERRAIN_BUFFER_FT) {
        warnings.push({
          legIndex: i,
          fromIdent: leg.fromIdent,
          toIdent: leg.toIdent,
          worst,
          clearance_ft: clearance,
        });
      }
    }
  });

  const maxElevation = samples.reduce(
    (m, s) => Math.max(m, s.elevation_ft),
    0,
  );
  const minSafeAltFt = roundUpTo500(maxElevation + TERRAIN_BUFFER_FT);

  return { samples, warnings, minSafeAltFt };
}

function roundUpTo500(n: number): number {
  return Math.ceil(n / 500) * 500;
}
