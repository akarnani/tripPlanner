import airportsRaw from "@data/airports.json";
import runwaysRaw from "@data/runways.json";

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

export const airports = airportsRaw as Airport[];
export const runways = runwaysRaw as Runway[];

export function airportByIdent(ident: string): Airport | undefined {
  const u = ident.toUpperCase();
  return airports.find((a) => a.icao === u || a.lid === u);
}
