import airportsUrl from "@data/airports.json?url";
import runwaysUrl from "@data/runways.json?url";
import approachesUrl from "@data/approaches.json?url";
import obstaclesUrl from "@data/obstacles.json?url";

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

// Live module bindings — populated by loadDatasets(). Consumers see
// the latest values via ES-module live-binding semantics. The app
// should not render data-dependent UI until `whenLoaded` resolves.
export let airports: Airport[] = [];
export let runways: Runway[] = [];
export let approaches: Approach[] = [];
export let obstacles: Obstacle[] = [];
export let hasApproachData = false;

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

/** Airports with at least one published approach procedure (any
 *  type — ILS, RNAV, LOC, VOR, LDA, BC, NDB, etc.). */
export let anyApproachAirports: Set<string> = new Set();
/** Airports with at least one vertical-guidance approach (precision
 *  or LPV / LPV200 / LNAV-VNAV RNAV). See note in `filters.ts` on the
 *  legal-vs-operational distinction. */
export let precisionApproachAirports: Set<string> = new Set();
/** Airports with at least one RNAV/GPS-based approach. */
export let rnavApproachAirports: Set<string> = new Set();

let _loaded: Promise<void> | null = null;

/** Idempotent. Returns the same Promise on every call so the
 *  network fetch happens at most once per app lifetime. */
export function loadDatasets(): Promise<void> {
  if (_loaded) return _loaded;
  _loaded = (async () => {
    const [a, r, ap, ob] = await Promise.all([
      fetch(airportsUrl).then((r) => r.json() as Promise<Airport[]>),
      fetch(runwaysUrl).then((r) => r.json() as Promise<Runway[]>),
      fetch(approachesUrl).then((r) => r.json() as Promise<Approach[]>),
      fetch(obstaclesUrl).then((r) => r.json() as Promise<Obstacle[]>),
    ]);
    airports = a;
    runways = r;
    approaches = ap;
    obstacles = ob;
    hasApproachData = approaches.length > 0;
    rebuildApproachIndexes();
  })();
  return _loaded;
}

function rebuildApproachIndexes(): void {
  const any = new Set<string>();
  const prec = new Set<string>();
  const rn = new Set<string>();
  for (const a of approaches) {
    any.add(a.airport_id);
    if (hasVerticalGuidance(a)) prec.add(a.airport_id);
    if (isRNAV(a)) rn.add(a.airport_id);
  }
  anyApproachAirports = any;
  precisionApproachAirports = prec;
  rnavApproachAirports = rn;
}

export function airportByIdent(ident: string): Airport | undefined {
  const u = ident.toUpperCase();
  return airports.find((a) => a.icao === u || a.lid === u);
}
