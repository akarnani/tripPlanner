import type { Airport } from "@/data/loaders";

export type TowerMode = "any" | "required" | "forbidden";

export interface HardFilters {
  minRunwayFt: number;
  tower: TowerMode;
}

export const DEFAULT_FILTERS: HardFilters = {
  minRunwayFt: 0,
  tower: "any",
};

export function applyFilters(
  airports: readonly Airport[],
  f: HardFilters,
): Airport[] {
  return airports.filter((a) => {
    if (!a.public_use) return false;
    if ((a.max_runway_ft ?? 0) < f.minRunwayFt) return false;
    if (f.tower === "required" && !a.has_control_tower) return false;
    if (f.tower === "forbidden" && a.has_control_tower) return false;
    return true;
  });
}
