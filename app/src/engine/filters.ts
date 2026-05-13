import type { Airport } from "@/data/loaders";
import {
  hasApproachData,
  precisionApproachAirports,
  rnavApproachAirports,
} from "@/data/loaders";

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

// The actual eligibility sets are built in loaders.ts — they look at
// the per-approach SBAS service level and RNP fields, not just the
// approach-type character, so RNAV approaches that publish only LP or
// LNAV (no vertical guidance) are correctly excluded from "precision."
// See the comment over precisionApproachAirports for the operational-
// vs-regulatory distinction.

function approachOK(
  airportId: string,
  requirement: ApproachRequirement,
): boolean {
  if (requirement === "any") return true;
  // If CIFP data hasn't shipped yet, don't filter — treat as best-effort.
  if (!hasApproachData) return true;
  if (requirement === "precision") {
    return precisionApproachAirports.has(airportId);
  }
  return rnavApproachAirports.has(airportId);
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
