import type { Airport, Datasets } from "@/data/loaders";

export type TowerMode = "any" | "required" | "forbidden";

/**
 * `off` — no filter, all airports are eligible regardless of approach.
 * `any` — must have at least one published IAP (ILS, RNAV, LOC, VOR,
 *         LDA, BC, NDB, etc.).
 * `precision` — must have a vertical-guidance approach. That's a true
 *         precision approach (ILS, GLS, MLS, RNP AR) OR an RNAV
 *         procedure with LPV / LPV200 / LNAV-VNAV minimums. NOTE that
 *         LPV is legally APV, not precision; the filter is named for
 *         the operational outcome the pilot is asking about.
 * `rnav` — must have a GNSS-based approach (RNAV, GPS, or RNP).
 */
export type ApproachRequirement = "off" | "any" | "precision" | "rnav";

export interface HardFilters {
  minRunwayFt: number;
  tower: TowerMode;
  approach: ApproachRequirement;
}

export const DEFAULT_FILTERS: HardFilters = {
  minRunwayFt: 0,
  tower: "any",
  approach: "off",
};

function approachOK(
  airportId: string,
  requirement: ApproachRequirement,
  d: Datasets,
): boolean {
  if (requirement === "off") return true;
  // If CIFP data hasn't shipped yet, don't filter — treat as best-effort.
  if (!d.hasApproachData) return true;
  switch (requirement) {
    case "any":
      return d.anyApproachAirports.has(airportId);
    case "precision":
      return d.precisionApproachAirports.has(airportId);
    case "rnav":
      return d.rnavApproachAirports.has(airportId);
  }
}

export function applyFilters(
  datasets: Datasets,
  f: HardFilters,
): Airport[] {
  return datasets.airports.filter((a) => {
    if (!a.public_use) return false;
    if ((a.max_runway_ft ?? 0) < f.minRunwayFt) return false;
    if (f.tower === "required" && !a.has_control_tower) return false;
    if (f.tower === "forbidden" && a.has_control_tower) return false;
    if (!approachOK(a.id, f.approach, datasets)) return false;
    return true;
  });
}
