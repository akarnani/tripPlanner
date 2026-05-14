import airportsUrl from "@data/airports.json?url";
import runwaysUrl from "@data/runways.json?url";
import approachesUrl from "@data/approaches.json?url";
import obstaclesUrl from "@data/obstacles.json.gz?url";
import { maybeGunzip } from "./gz";

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

/**
 * Bundle of everything `loadDatasets()` produces. The app keeps the
 * latest snapshot in React state, so consumers read from props/state
 * — no module-level live bindings to debug.
 */
export interface Datasets {
  airports: Airport[];
  runways: Runway[];
  approaches: Approach[];
  obstacles: Obstacle[];
  hasApproachData: boolean;
  /** Airports with at least one published IAP (any type). */
  anyApproachAirports: Set<string>;
  /** Airports with at least one vertical-guidance approach
   *  (true precision OR LPV / LPV200 / LNAV-VNAV RNAV). */
  precisionApproachAirports: Set<string>;
  /** Airports with at least one RNAV/GPS-based approach. */
  rnavApproachAirports: Set<string>;
}

export const EMPTY_DATASETS: Datasets = {
  airports: [],
  runways: [],
  approaches: [],
  obstacles: [],
  hasApproachData: false,
  anyApproachAirports: new Set(),
  precisionApproachAirports: new Set(),
  rnavApproachAirports: new Set(),
};

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

function buildIndexes(
  airports: Airport[],
  approaches: Approach[],
): Pick<
  Datasets,
  "anyApproachAirports" | "precisionApproachAirports" | "rnavApproachAirports"
> {
  // CIFP and NASR identify airports differently. NASR's `id` is an
  // internal site code (e.g. "50001.*A"); SwiftCIFP emits the ICAO
  // (e.g. "KSEA"), occasionally the FAA LID for US airports without
  // an ICAO. Build a translation table so the indexes are keyed by
  // NASR id — the same key everything else in the app uses.
  const idByIdent = new Map<string, string>();
  for (const a of airports) {
    if (a.icao) idByIdent.set(a.icao, a.id);
    if (a.lid) idByIdent.set(a.lid, a.id);
  }
  const resolve = (cifpId: string): string | undefined => {
    // Direct lookup handles both ICAO ("KSEA") and pure-LID ("3W2")
    // shapes.
    const direct = idByIdent.get(cifpId);
    if (direct) return direct;
    // CIFP pads short FAA LIDs to four characters with a leading "K"
    // for the airport-identifier field, even though the airport
    // doesn't have a real ICAO assigned. Try the stripped LID before
    // giving up.
    if (cifpId.length === 4 && cifpId.startsWith("K")) {
      return idByIdent.get(cifpId.slice(1));
    }
    return undefined;
  };
  const any = new Set<string>();
  const prec = new Set<string>();
  const rn = new Set<string>();
  for (const a of approaches) {
    const id = resolve(a.airport_id);
    if (!id) continue;
    any.add(id);
    if (hasVerticalGuidance(a)) prec.add(id);
    if (isRNAV(a)) rn.add(id);
  }
  return {
    anyApproachAirports: any,
    precisionApproachAirports: prec,
    rnavApproachAirports: rn,
  };
}

let _loaded: Promise<Datasets> | null = null;

/** Idempotent. Returns the same Promise on every call so the network
 *  fetch happens at most once per app lifetime. */
export function loadDatasets(): Promise<Datasets> {
  if (_loaded) return _loaded;
  _loaded = (async () => {
    const [airports, runways, approaches, obstacles] = await Promise.all([
      fetch(airportsUrl).then((r) => r.json() as Promise<Airport[]>),
      fetch(runwaysUrl).then((r) => r.json() as Promise<Runway[]>),
      fetch(approachesUrl).then((r) => r.json() as Promise<Approach[]>),
      // obstacles.json gzips to ~5 MB from ~25 MB raw, well under
      // Cloudflare Pages' 25 MiB file cap and a meaningful wire
      // savings for everyone. Servers may or may not transparently
      // decompress before delivery; maybeGunzip handles both.
      fetch(obstaclesUrl)
        .then((r) => r.arrayBuffer())
        .then(maybeGunzip)
        .then((buf) => JSON.parse(new TextDecoder().decode(buf)) as Obstacle[]),
    ]);
    return {
      airports,
      runways,
      approaches,
      obstacles,
      hasApproachData: approaches.length > 0,
      ...buildIndexes(airports, approaches),
    };
  })();
  return _loaded;
}

export function airportByIdent(
  airports: readonly Airport[],
  ident: string,
): Airport | undefined {
  const u = ident.toUpperCase();
  return airports.find((a) => a.icao === u || a.lid === u);
}
