import type { Airport } from "@/data/loaders";
import { approachIndex, hasApproachData } from "@/data/loaders";

export type TowerMode = "any" | "required" | "forbidden";
export type ApproachRequirement = "any" | "precision" | "rnav";

export interface HardFilters {
  minRunwayFt: number;
  tower: TowerMode;
  approach: ApproachRequirement;
}

export const DEFAULT_FILTERS: HardFilters = {
  minRunwayFt: 0,
  tower: "any",
  approach: "any",
};

// ARINC 424 approach-type characters considered "precision".
// ILS, GLS/GBAS, RNP AR, IGS, and SBAS-served RNAV approaches qualify
// for our v1 filter.
const PRECISION_TYPES = new Set(["I", "J", "H", "G"]);
const RNAV_TYPES = new Set(["R", "P", "F", "H"]);

function approachOK(
  airportId: string,
  requirement: ApproachRequirement,
): boolean {
  if (requirement === "any") return true;
  // If CIFP data hasn't shipped yet, don't filter — treat as best-effort.
  if (!hasApproachData) return true;
  const types = approachIndex.get(airportId);
  if (!types) return false;
  const wanted = requirement === "precision" ? PRECISION_TYPES : RNAV_TYPES;
  for (const t of types) if (wanted.has(t)) return true;
  return false;
}

export function applyFilters(
  airports: readonly Airport[],
  f: HardFilters,
): Airport[] {
  return airports.filter((a) => {
    if (!a.public_use) return false;
    if ((a.max_runway_ft ?? 0) < f.minRunwayFt) return false;
    if (f.tower === "required" && !a.has_control_tower) return false;
    if (f.tower === "forbidden" && a.has_control_tower) return false;
    if (!approachOK(a.id, f.approach)) return false;
    return true;
  });
}
