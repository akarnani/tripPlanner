import airportsRaw from "@data/airports.json";
import runwaysRaw from "@data/runways.json";
import approachesRaw from "@data/approaches.json";
import obstaclesRaw from "@data/obstacles.json";

export interface Airport {
  id: string;
  lid: string;
  icao: string | null;
  name: string;
  city: string;
  state: string | null;
  lat: number;
  lon: number;
  elevation_ft: number | null;
  has_control_tower: boolean;
  public_use: boolean;
  runway_count: number;
  max_runway_ft: number | null;
  fuels: string[];
}

export interface Runway {
  airport_id: string;
  identification: string;
  length_ft: number | null;
  width_ft: number | null;
  is_paved: boolean;
}

export interface Approach {
  airport_id: string;
  identifier: string;
  runway_id: string | null;
  /** Single-character ARINC 424 code (I=ILS, R=RNAV, V=VOR, etc.). */
  approach_type: string;
  approach_type_label: string;
  is_precision: boolean;
  is_rnav: boolean;
  /** SBAS service level on RNAV procedures: "ALPV", "ALPV200", or
   *  "ALP". ALPV/ALPV200 indicate LPV-style vertical guidance. */
  sbas_service_level?: string | null;
  /** RNP / area-nav performance: "ALNAV/VNAV" indicates baro-VNAV
   *  vertical guidance. */
  required_nav_performance?: string | null;
}

export interface Obstacle {
  id: string;
  state: string | null;
  lat: number;
  lon: number;
  type: string;
  height_agl_ft: number;
  height_msl_ft: number;
}

export const airports = airportsRaw as Airport[];
export const runways = runwaysRaw as Runway[];
export const approaches = approachesRaw as Approach[];
export const obstacles = obstaclesRaw as Obstacle[];

export const hasApproachData = approaches.length > 0;
export const hasObstacleData = obstacles.length > 0;

export function airportByIdent(ident: string): Airport | undefined {
  const u = ident.toUpperCase();
  return airports.find((a) => a.icao === u || a.lid === u);
}

// "Precision" here means the operational outcome a pilot cares about
// during planning: an approach that publishes vertical guidance and
// reaches low minimums. That includes legally-precision approaches
// (ILS/J/G/M/W/Y, plus RNP AR by FAA practice) AND RNAV approaches
// whose published minimums include SBAS vertical (LPV / LPV200) or
// baro-VNAV (LNAV/VNAV). It excludes RNAV approaches that publish
// only LP or LNAV — those are non-precision in operation.
//
// Legal note: LPV is *not* a precision approach per ICAO / FAA — it's
// classified APV. The filter is named for what the pilot is asking,
// not for the regulatory category.
const STRICT_PRECISION_TYPES = new Set(["I", "J", "H", "G", "M", "W", "Y"]);
const RNAV_TYPES = new Set(["R", "P", "H"]);
const VERTICAL_SBAS = new Set(["ALPV", "ALPV200"]);
const VERTICAL_RNP = new Set(["ALNAV/VNAV"]);

function hasVerticalGuidance(a: Approach): boolean {
  if (STRICT_PRECISION_TYPES.has(a.approach_type)) return true;
  if (a.approach_type === "R") {
    if (a.sbas_service_level && VERTICAL_SBAS.has(a.sbas_service_level)) {
      return true;
    }
    if (
      a.required_nav_performance &&
      VERTICAL_RNP.has(a.required_nav_performance)
    ) {
      return true;
    }
  }
  return false;
}

function isRNAV(a: Approach): boolean {
  return RNAV_TYPES.has(a.approach_type);
}

/** Airport ids whose published approaches include at least one with
 *  vertical guidance — true precision or RNAV-LPV / RNAV-LNAV-VNAV. */
export const precisionApproachAirports: Set<string> = (() => {
  const s = new Set<string>();
  for (const a of approaches) if (hasVerticalGuidance(a)) s.add(a.airport_id);
  return s;
})();

/** Airport ids whose published approaches include at least one
 *  RNAV/GPS-based approach (regardless of vertical guidance). */
export const rnavApproachAirports: Set<string> = (() => {
  const s = new Set<string>();
  for (const a of approaches) if (isRNAV(a)) s.add(a.airport_id);
  return s;
})();
