import { load } from "js-yaml";

export type FuelType = "100LL" | "Jet-A" | "MoGas";

export interface CruiseRow {
  altitude_ft: number;
  power_pct: number;
  tas_kt: number;
  fuel_gph: number;
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
    return { slug: slugFromPath(path), ...parsed };
  })
  .sort((a, b) => a.model.localeCompare(b.model));

export function aircraftBySlug(slug: string): Aircraft | undefined {
  return aircraft.find((a) => a.slug === slug);
}
