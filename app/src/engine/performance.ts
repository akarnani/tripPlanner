import type { Aircraft, CruiseRow } from "@/data/aircraft";

export interface CruiseAtAltitude {
  tas_kt: number;
  fuel_gph: number;
  power_pct: number;
}

/**
 * Linear interpolation of cruise TAS and fuel burn at an arbitrary altitude.
 * Altitudes below the lowest row use the lowest row; above the highest row,
 * the highest row. The perf table must be non-empty.
 */
export function cruiseAt(
  aircraft: Aircraft,
  altitude_ft: number,
): CruiseAtAltitude {
  const rows = aircraft.cruise;
  if (rows.length === 0) {
    throw new Error(`aircraft ${aircraft.slug} has no cruise rows`);
  }
  if (altitude_ft <= rows[0].altitude_ft) return pick(rows[0]);
  const last = rows[rows.length - 1];
  if (altitude_ft >= last.altitude_ft) return pick(last);
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (altitude_ft >= a.altitude_ft && altitude_ft <= b.altitude_ft) {
      const t = (altitude_ft - a.altitude_ft) / (b.altitude_ft - a.altitude_ft);
      return {
        tas_kt: lerp(a.tas_kt, b.tas_kt, t),
        fuel_gph: lerp(a.fuel_gph, b.fuel_gph, t),
        power_pct: lerp(a.power_pct, b.power_pct, t),
      };
    }
  }
  throw new Error("unreachable: altitude not bracketed");
}

function pick(r: CruiseRow): CruiseAtAltitude {
  return { tas_kt: r.tas_kt, fuel_gph: r.fuel_gph, power_pct: r.power_pct };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface RangeInput {
  aircraft: Aircraft;
  altitude_ft: number;
  /** Reserve fuel kept aside, expressed as hours of cruise burn. */
  reserve_hours: number;
}

export interface RangeOutput {
  tas_kt: number;
  fuel_gph: number;
  usable_gal: number;
  reserve_gal: number;
  burnable_gal: number;
  endurance_hr: number;
  range_nm: number;
}

/**
 * Usable range at a chosen cruise altitude after holding the requested fuel
 * reserve. Climb fuel is approximated as part of cruise time for v1 — the
 * separate climb model lands when the routing engine handles segmented legs.
 */
export function usableRange(input: RangeInput): RangeOutput {
  const { aircraft, altitude_ft, reserve_hours } = input;
  const cruise = cruiseAt(aircraft, altitude_ft);
  const usable_gal = aircraft.fuel.usable_capacity_gal;
  const reserve_gal = reserve_hours * cruise.fuel_gph;
  const burnable_gal = Math.max(usable_gal - reserve_gal, 0);
  const endurance_hr = burnable_gal / cruise.fuel_gph;
  const range_nm = endurance_hr * cruise.tas_kt;
  return {
    tas_kt: cruise.tas_kt,
    fuel_gph: cruise.fuel_gph,
    usable_gal,
    reserve_gal,
    burnable_gal,
    endurance_hr,
    range_nm,
  };
}
