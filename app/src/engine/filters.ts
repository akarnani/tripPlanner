import type { Airport, Datasets } from "@/data/loaders";
import type { FuelType } from "@/data/aircraft";
import { greatCircleNM } from "./geo";
import { initialTrueCourseDeg } from "./hemispheric";

const EARTH_NM = 3440.065;

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

/**
 * Drop airports more than `maxCrossTrackNM` from the great-circle line
 * between origin and destination, and airports whose along-track
 * position is well before origin or well past destination. Origin and
 * destination themselves are always kept.
 *
 * Without this filter the routing graph considers every airport in the
 * dataset (~5,000 in CONUS), giving N² edges — for a long
 * cross-country that's tens of millions of edges and several seconds
 * of work *before* any objective sees the graph, even though stops in
 * Florida are nonsensical for a Bay-Area-to-Wisconsin flight.
 *
 * The corridor is a fixed lateral width (default 100 nm) rather than
 * a detour-budget percentage, so it doesn't balloon on transcontinental
 * routes where even a small percentage of 2,500 nm covers most of CONUS.
 */
export function airportsInRouteCorridor(
  airports: readonly Airport[],
  origin: Airport,
  destination: Airport,
  maxCrossTrackNM = 100,
  alongTrackPaddingNM = 50,
): Airport[] {
  const direct = greatCircleNM(origin, destination);
  if (direct === 0) return airports.slice();
  const bearing_od_rad = (initialTrueCourseDeg(origin, destination) * Math.PI) / 180;
  const sin_bod = Math.sin(bearing_od_rad);
  const cos_bod = Math.cos(bearing_od_rad);

  return airports.filter((a) => {
    if (a.id === origin.id || a.id === destination.id) return true;
    const d_op = greatCircleNM(origin, a);
    if (d_op === 0) return true;
    const bearing_op_rad = (initialTrueCourseDeg(origin, a) * Math.PI) / 180;
    const sin_bop = Math.sin(bearing_op_rad);
    const cos_bop = Math.cos(bearing_op_rad);
    // Standard spherical cross-track + along-track decomposition. The
    // angle is computed via the sine of the bearing delta — for the
    // distances and CTDs we're working with, the small-angle terms
    // dominate, and any error is well below the corridor width.
    const sin_bearing_delta = sin_bop * cos_bod - cos_bop * sin_bod;
    const d_op_rad = d_op / EARTH_NM;
    const ctd_rad = Math.asin(Math.sin(d_op_rad) * sin_bearing_delta);
    const ctd_nm = Math.abs(ctd_rad) * EARTH_NM;
    if (ctd_nm > maxCrossTrackNM) return false;
    const along_rad = Math.acos(
      Math.cos(d_op_rad) / Math.max(1e-9, Math.cos(ctd_rad)),
    );
    const along_nm = along_rad * EARTH_NM;
    return along_nm >= -alongTrackPaddingNM &&
           along_nm <= direct + alongTrackPaddingNM;
  });
}
