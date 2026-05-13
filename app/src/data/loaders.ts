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

/** Map from airport id → set of approach-type characters. Empty when no
 *  CIFP data is loaded; consumers should check `hasApproachData` first. */
export const approachIndex: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const a of approaches) {
    let s = m.get(a.airport_id);
    if (!s) {
      s = new Set();
      m.set(a.airport_id, s);
    }
    s.add(a.approach_type);
  }
  return m;
})();
