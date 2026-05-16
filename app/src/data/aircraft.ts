import { load } from "js-yaml";

export type FuelType = "100LL" | "Jet-A" | "MoGas";

export interface CruiseRow {
  altitude_ft: number;
  power_pct: number;
  tas_kt: number;
  fuel_gph: number;
}

/** One row of the POH "Time, Fuel, and Distance to Climb" table.
 *  Values are cumulative from sea level (or from the table's lowest
 *  altitude), so the climb cost from A to B is the difference between
 *  the rows at B and A. */
export interface ClimbRow {
  altitude_ft: number;
  time_min: number;
  fuel_gal: number;
  distance_nm: number;
}

/** One cell of a POH takeoff- or landing-distance table. POHs that
 *  publish multiple weight tiers (e.g. 2,550 / 2,400 / 2,200 lb for
 *  the 172S takeoff chart) include `weight_lb` on every row so the
 *  engine can interpolate between published weights rather than
 *  inventing a correction. POHs that only publish a single
 *  reference-weight table omit `weight_lb`; the loader defaults it
 *  to the aircraft's `weights.max_gross_lb` (or
 *  `weights.max_landing_lb` for landing rows), and the engine reads
 *  that single tier directly with no correction applied — exactly
 *  what the POH lets you do, no more.
 *
 *  Pressure altitude × outside-air-temperature pick the row;
 *  ground roll and the over-50' obstacle total are typical POH
 *  outputs. */
export interface RunwayDistanceRow {
  weight_lb: number;
  pressure_alt_ft: number;
  temp_c: number;
  ground_roll_ft: number;
  /** Total distance over a 50 ft obstacle, from the same POH cell.
   *  This is the figure used for runway-fit checks because it
   *  matches the published "landing distance" convention pilots
   *  evaluate against runway length. */
  total_50ft_ft: number;
}

export interface Aircraft {
  slug: string;
  make: string;
  model: string;
  fuel: {
    type: FuelType;
    density_lb_per_gal: number;
    usable_capacity_gal: number;
  };
  /** Operating weights, in pounds. Optional for back-compat with
   *  aircraft files that pre-date the runway-fit feature; when
   *  absent, runway checks are skipped for that aircraft. */
  weights?: {
    max_gross_lb: number;
    /** Max landing weight; falls back to `max_gross_lb` when absent
     *  (typical for piston singles). */
    max_landing_lb?: number;
  };
  cruise: CruiseRow[];
  climb: {
    rate_fpm: number;
    fuel_to_climb_gph: number;
    /** Optional cumulative-from-sea-level climb table from the POH.
     *  When present, the engine uses these values to model the climb
     *  segment of each leg precisely (so altitude choices on short
     *  legs reflect the real fuel cost of getting there). Without it,
     *  the engine falls back to rate_fpm + fuel_to_climb_gph. */
    table?: ClimbRow[];
  };
  /** POH takeoff distance table at the gross weight specified in
   *  `weights.max_gross_lb`. The runway-fit engine bilinearly
   *  interpolates by pressure altitude and temperature, then scales
   *  by (estimated_weight / gross)² for the optional "use estimated
   *  weight" mode. Missing → runway checks are skipped. */
  takeoff?: {
    distance_table: RunwayDistanceRow[];
  };
  /** POH landing distance table at the gross weight specified in
   *  `weights.max_landing_lb` (or `max_gross_lb` if not given).
   *  Same interpolation + weight-scaling story as `takeoff`. */
  landing?: {
    distance_table: RunwayDistanceRow[];
  };
}

// Vite-time glob of all aircraft performance files. The path segment
// between `/aircraft/` and `/performance.yaml` becomes the slug.
const rawFiles = import.meta.glob("../../../aircraft/*/performance.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function slugFromPath(path: string): string {
  const m = path.match(/\/aircraft\/([^/]+)\/performance\.yaml$/);
  if (!m) throw new Error(`unexpected aircraft path: ${path}`);
  return m[1];
}

function normalizeRunwayRows(
  rows: RunwayDistanceRow[],
  defaultWeightLb: number,
): RunwayDistanceRow[] {
  // POH rows that omit `weight_lb` inherit the table's reference
  // weight (max_gross_lb for takeoff, max_landing_lb for landing).
  // Sorted ascending by (weight, pressure_alt, temp) so the lookup
  // can walk the table without re-sorting on every call.
  return rows
    .map((r) => (r.weight_lb !== undefined ? r : { ...r, weight_lb: defaultWeightLb }))
    .sort((a, b) =>
      a.weight_lb !== b.weight_lb
        ? a.weight_lb - b.weight_lb
        : a.pressure_alt_ft !== b.pressure_alt_ft
          ? a.pressure_alt_ft - b.pressure_alt_ft
          : a.temp_c - b.temp_c,
    );
}

export const aircraft: Aircraft[] = Object.entries(rawFiles)
  .map(([path, raw]) => {
    const parsed = load(raw) as Omit<Aircraft, "slug">;
    parsed.cruise.sort((a, b) => a.altitude_ft - b.altitude_ft);
    if (parsed.climb.table) {
      parsed.climb.table.sort((a, b) => a.altitude_ft - b.altitude_ft);
    }
    if (parsed.takeoff?.distance_table && parsed.weights) {
      parsed.takeoff.distance_table = normalizeRunwayRows(
        parsed.takeoff.distance_table,
        parsed.weights.max_gross_lb,
      );
    }
    if (parsed.landing?.distance_table && parsed.weights) {
      parsed.landing.distance_table = normalizeRunwayRows(
        parsed.landing.distance_table,
        parsed.weights.max_landing_lb ?? parsed.weights.max_gross_lb,
      );
    }
    return { slug: slugFromPath(path), ...parsed };
  })
  .sort((a, b) => a.model.localeCompare(b.model));

export function aircraftBySlug(slug: string): Aircraft | undefined {
  return aircraft.find((a) => a.slug === slug);
}
