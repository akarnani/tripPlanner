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

// Approach-type characters from ARINC 424. We expose two operational
// buckets to the user:
//
// "precision" — approaches that come with vertical guidance and
// typically reach minimums of ~200 ft AGL or lower. This deliberately
// includes RNAV (R) because modern RNAV procedures at well-equipped
// airports usually publish LPV minimums, which are operationally
// equivalent to ILS for planning purposes. NOTE that LPV is *not*
// legally a precision approach — ICAO classifies it as APV
// (approach with vertical guidance), and the FAA follows suit. The
// filter is named for the operational outcome the pilot is asking
// about ("can I get to low minimums?"), not the regulatory category.
// If/when CIFP's per-approach SBAS service level lands in
// approaches.json, we can split RNAV-LPV from RNAV-LNAV here.
//
// "rnav" — any RNAV or GPS-based approach (R or P), or RNP AR (H).
const PRECISION_TYPES = new Set(["I", "J", "H", "G", "R"]);
const RNAV_TYPES = new Set(["R", "P", "H"]);

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
