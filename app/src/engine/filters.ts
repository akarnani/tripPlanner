import type { Airport, Datasets } from "@/data/loaders";
import type { FuelType } from "@/data/aircraft";

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
  /** When true, only consider airports whose NASR fuel list contains a
   *  code compatible with the selected aircraft's fuel type. Default
   *  on — landing at a fuel-less field defeats the point of a fuel
   *  stop. Origin/destination are exempted upstream in App.tsx. */
  requireFuel: boolean;
}

export const DEFAULT_FILTERS: HardFilters = {
  minRunwayFt: 0,
  tower: "any",
  approach: "off",
  requireFuel: true,
};

/** NASR fuel codes that satisfy each aircraft fuel type. Intentionally
 *  strict: UL94 / UL91 / MOGAS-as-100LL substitutes depend on per-
 *  airframe STC eligibility that NASR can't tell us about, so we don't
 *  count them. */
function compatibleFuelCodes(type: FuelType): readonly string[] {
  switch (type) {
    case "100LL":
      // 100LL is the canonical avgas. NASR also lists "100" (leaded
      // high-octane avgas, now rare) which any 100LL engine accepts.
      return ["100LL", "100"];
    case "Jet-A":
      // FAA codes for Jet-A / Jet-A1 with various additive packages,
      // plus Jet-B (J) and JP-8 (J8). The "+10" suffix indicates a
      // +10°C freeze-point additive — same base fuel.
      return ["A", "A1", "A+", "A1+", "A++", "A++10", "J", "J8", "J8+10"];
    case "MoGas":
      return ["MOGAS"];
  }
}

function fuelOK(airport: Airport, type: FuelType): boolean {
  const codes = compatibleFuelCodes(type);
  for (const f of airport.fuels) if (codes.includes(f)) return true;
  return false;
}

/** Public alias for the fuel-compatibility check. Used by the routing
 *  layer to decide whether a pinned stop is a refuel stop or a
 *  pass-through. */
export function airportSellsCompatibleFuel(
  airport: Airport,
  type: FuelType,
): boolean {
  return fuelOK(airport, type);
}

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
  aircraftFuelType?: FuelType,
): Airport[] {
  return datasets.airports.filter((a) => {
    if (!a.public_use) return false;
    if ((a.max_runway_ft ?? 0) < f.minRunwayFt) return false;
    if (f.tower === "required" && !a.has_control_tower) return false;
    if (f.tower === "forbidden" && a.has_control_tower) return false;
    if (!approachOK(a.id, f.approach, datasets)) return false;
    if (f.requireFuel && aircraftFuelType && !fuelOK(a, aircraftFuelType)) {
      return false;
    }
    return true;
  });
}
