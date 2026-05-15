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

export interface Aircraft {
  slug: string;
  make: string;
  model: string;
  fuel: {
    type: FuelType;
    density_lb_per_gal: number;
    usable_capacity_gal: number;
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

export const aircraft: Aircraft[] = Object.entries(rawFiles)
  .map(([path, raw]) => {
    const parsed = load(raw) as Omit<Aircraft, "slug">;
    parsed.cruise.sort((a, b) => a.altitude_ft - b.altitude_ft);
    if (parsed.climb.table) {
      parsed.climb.table.sort((a, b) => a.altitude_ft - b.altitude_ft);
    }
    return { slug: slugFromPath(path), ...parsed };
  })
  .sort((a, b) => a.model.localeCompare(b.model));

export function aircraftBySlug(slug: string): Aircraft | undefined {
  return aircraft.find((a) => a.slug === slug);
}
