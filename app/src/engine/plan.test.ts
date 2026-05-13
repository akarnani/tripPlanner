import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { plan } from "./plan";

function ap(id: string, lat: number, lon: number): Airport {
  return {
    id,
    lid: id,
    icao: id,
    name: id,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: 0,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

function aircraft(): Aircraft {
  return {
    slug: "t",
    make: "T",
    model: "T",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 200 },
    cruise: [
      { altitude_ft: 0, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
      { altitude_ft: 18000, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
  };
}

describe("plan() alternatives are useful, not arbitrary k-shortest paths", () => {
  test("returns one route per objective, deduped when objectives agree", () => {
    // Five colinear airports A→B→C→D→E. With 1500-nm range, the
    // direct A→E is optimal under both fewestStops AND shortestTime,
    // so plan() returns a single deduped route.
    const A = ap("A", 40, -120);
    const B = ap("B", 40, -115);
    const C = ap("C", 40, -110);
    const D = ap("D", 40, -105);
    const E = ap("E", 40, -100);
    const result = plan({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    expect(result).toHaveLength(1);
    expect(result[0].legs).toHaveLength(1);
    expect(result[0].costFnId).toBe("fewestStops");
  });

  test("never returns a backtracking 'alternative' on a sparse graph", () => {
    // Same colinear graph. Whatever objectives we request, no
    // returned route should have a leg whose course is opposite
    // the overall direction of travel.
    const A = ap("A", 40, -120);
    const B = ap("B", 40, -115);
    const C = ap("C", 40, -110);
    const D = ap("D", 40, -105);
    const E = ap("E", 40, -100);
    const result = plan({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      objectives: ["fewestStops", "shortestTime"],
    });
    // Every returned route's total distance must be at most ~1.05× the
    // direct great-circle distance — a backtracking k-shortest path
    // would blow well past that.
    const A_to_E_nm = 920; // ≈ great-circle
    for (const r of result) {
      expect(r.totals.distance_nm).toBeLessThan(A_to_E_nm * 1.1);
    }
  });

  test("maxLegHr drops edges that exceed the cap for every objective", () => {
    // A→E at 120 KTAS is ~7.7 hours direct. With maxLegHr = 4, the
    // direct edge must disappear and every objective must produce a
    // multi-stop route (or none at all).
    const A = ap("A", 40, -120);
    const B = ap("B", 40, -115);
    const C = ap("C", 40, -110);
    const D = ap("D", 40, -105);
    const E = ap("E", 40, -100);
    const result = plan({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      maxLegHr: 4,
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect(r.legs.length).toBeGreaterThan(1);
      for (const leg of r.legs) {
        expect(leg.time_hr).toBeLessThanOrEqual(4);
      }
    }
  });

  test("fewestStops tiebreaks on time when stops are equal", () => {
    // Origin and destination with two parallel one-stop options.
    // Direct O→D (920 nm) is out of range, so the fewest-stops floor
    // is two legs. M is on the straight line; S detours ~120 nm north
    // and produces a longer total path. The tiebreak should pick M.
    const O = ap("O", 40, -120);
    const D = ap("D", 40, -100);
    const M = ap("M", 40, -110); // on the great-circle path
    const S = ap("S", 42, -110); // detours ~120 nm north
    const result = plan({
      airports: [O, D, M, S],
      origin: "O",
      destination: "D",
      aircraft: aircraft(), // 200 gal cap = 2280 nm range; both 2-hop legs fit
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      // Force the fewest-stops floor up to 2 by capping legs.
      maxLegHr: 5,
      objectives: ["fewestStops"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].legs).toHaveLength(2);
    // Tiebreak picks the on-line waypoint M over the northern detour S.
    expect(result[0].legs[0].toAirport.id).toBe("M");
  });

  test("each returned route is unique by node sequence", () => {
    const A = ap("A", 40, -120);
    const B = ap("B", 40, -115);
    const C = ap("C", 40, -110);
    const result = plan({
      airports: [A, B, C],
      origin: "A",
      destination: "C",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      objectives: ["fewestStops", "shortestTime"],
    });
    const keys = new Set(result.map((r) => r.legs.map((l) => l.to).join(">")));
    expect(keys.size).toBe(result.length);
  });
});
