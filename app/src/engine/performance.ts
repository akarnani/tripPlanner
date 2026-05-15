import type { Aircraft, ClimbRow, CruiseRow } from "@/data/aircraft";

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
 * Time, fuel, and ground distance to climb from `from_ft` to `to_ft`.
 *
 * When the aircraft has a POH-derived `climb.table` (cumulative from
 * sea level), the segment is `table[to] − table[from]` with linear
 * interpolation. Without a table, falls back to the scalar
 * `rate_fpm` and `fuel_to_climb_gph` and assumes climb groundspeed is
 * roughly 70 % of cruise TAS at the target altitude. Returns zeros if
 * `to_ft <= from_ft`, so callers don't need to special-case descents.
 */
export function climbFromTo(
  aircraft: Aircraft,
  from_ft: number,
  to_ft: number,
): ClimbSegment {
  if (to_ft <= from_ft) {
    return { time_hr: 0, fuel_gal: 0, distance_nm: 0 };
  }
  const table = aircraft.climb.table;
  if (table && table.length >= 2) {
    const lo = table[0].altitude_ft;
    const hi = table[table.length - 1].altitude_ft;
    const a = interpClimbRow(table, Math.max(from_ft, lo));
    const b = interpClimbRow(table, Math.min(to_ft, hi));
    return {
      time_hr: Math.max(0, (b.time_min - a.time_min) / 60),
      fuel_gal: Math.max(0, b.fuel_gal - a.fuel_gal),
      distance_nm: Math.max(0, b.distance_nm - a.distance_nm),
    };
  }
  const time_hr = (to_ft - from_ft) / aircraft.climb.rate_fpm / 60;
  const fuel_gal = time_hr * aircraft.climb.fuel_to_climb_gph;
  const climb_speed_kt = cruiseAt(aircraft, to_ft).tas_kt * 0.7;
  return { time_hr, fuel_gal, distance_nm: time_hr * climb_speed_kt };
}

export interface ClimbSegment {
  time_hr: number;
  fuel_gal: number;
  distance_nm: number;
}

function interpClimbRow(table: ClimbRow[], altitude_ft: number): ClimbRow {
  if (altitude_ft <= table[0].altitude_ft) return table[0];
  const last = table[table.length - 1];
  if (altitude_ft >= last.altitude_ft) return last;
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (altitude_ft >= a.altitude_ft && altitude_ft <= b.altitude_ft) {
      const t = (altitude_ft - a.altitude_ft) / (b.altitude_ft - a.altitude_ft);
      return {
        altitude_ft,
        time_min: lerp(a.time_min, b.time_min, t),
        fuel_gal: lerp(a.fuel_gal, b.fuel_gal, t),
        distance_nm: lerp(a.distance_nm, b.distance_nm, t),
      };
    }
  }
  throw new Error("unreachable: climb altitude not bracketed");
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
