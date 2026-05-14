import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { plan, planWithWaypoints } from "./plan";

function ap(
  id: string,
  lat: number,
  lon: number,
  fuels: string[] = [],
): Airport {
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
    fuels,
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

  test("startingFuelGal caps the first leg only; later legs assume top-off", () => {
    // Aircraft with 200-gal usable capacity, 120 KTAS, 10 GPH.
    // Full-tank range ≈ (200 - 7.5) × 12 = 2,310 nm.
    // With only 30 gal at the origin, the first leg can cover
    // (30 - 7.5) × 12 ≈ 270 nm. After a top-off mid-route the next
    // leg gets the full 2,310-nm budget again.
    const O = ap("O", 40, -120);
    const M = ap("M", 40, -116); // ~184 nm east of O — fits the 270-nm cap
    const D = ap("D", 40, -100); // ~920 nm from O — doesn't fit on starting fuel
    const result = plan({
      airports: [O, M, D],
      origin: "O",
      destination: "D",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 30,
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      // Must stop somewhere; direct O→D would exceed startingFuel range.
      expect(r.legs.length).toBeGreaterThan(1);
      expect(r.legs[0].fromAirport.id).toBe("O");
      expect(r.legs[0].toAirport.id).toBe("M");
    }
  });

  test("excludedAirportIds drops the named airport from every objective", () => {
    // O→E needs a stop. Without exclusions, the planner picks the
    // on-line waypoints (M is the closest to the great circle).
    // Excluding M should force the planner through D instead.
    const O = ap("O", 40, -120);
    const M = ap("M", 40, -110);
    const D = ap("D", 41, -110); // detour ~60 nm north of the GC line
    const E = ap("E", 40, -100);
    const cap = plan({
      airports: [O, M, D, E],
      origin: "O",
      destination: "E",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      maxLegHr: 5,
    });
    expect(cap.length).toBeGreaterThan(0);
    expect(cap[0].legs.some((l) => l.toAirport.id === "M")).toBe(true);

    const excluded = plan({
      airports: [O, M, D, E],
      origin: "O",
      destination: "E",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      maxLegHr: 5,
      excludedAirportIds: new Set(["M"]),
    });
    expect(excluded.length).toBeGreaterThan(0);
    for (const r of excluded) {
      for (const leg of r.legs) {
        expect(leg.toAirport.id).not.toBe("M");
      }
    }
  });

  test("excluding the destination is ignored (route still terminates there)", () => {
    const O = ap("O", 40, -120);
    const M = ap("M", 40, -110);
    const E = ap("E", 40, -100);
    const result = plan({
      airports: [O, M, E],
      origin: "O",
      destination: "E",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      maxLegHr: 5,
      excludedAirportIds: new Set(["E"]),
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect(r.legs[r.legs.length - 1].toAirport.id).toBe("E");
    }
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

describe("planWithWaypoints forces the route through pinned stops", () => {
  test("empty waypoints behaves identically to plan()", () => {
    const A = ap("A", 40, -120);
    const B = ap("B", 40, -110);
    const C = ap("C", 40, -100);
    const args = {
      airports: [A, B, C],
      origin: "A",
      destination: "C",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR" as const,
      reserveHr: 0.75,
    };
    const base = plan(args);
    const wrapped = planWithWaypoints({ ...args, waypoints: [] });
    expect(wrapped.map((r) => r.legs.map((l) => l.to).join(">"))).toEqual(
      base.map((r) => r.legs.map((l) => l.to).join(">")),
    );
  });

  test("a single fuel-bearing waypoint becomes a refuel stop", () => {
    // O→D direct is in range, but pinning M forces a stop. M has fuel,
    // so the second sub-leg starts from full tanks.
    const O = ap("O", 40, -120);
    const M = ap("M", 40, -110, ["100LL"]);
    const D = ap("D", 40, -100);
    const result = planWithWaypoints({
      airports: [O, M, D],
      origin: "O",
      destination: "D",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      waypoints: ["M"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      const ids = [r.legs[0].fromAirport.id, ...r.legs.map((l) => l.toAirport.id)];
      expect(ids).toContain("M");
      expect(ids[0]).toBe("O");
      expect(ids[ids.length - 1]).toBe("D");
    }
  });

  test("a fuel-less waypoint is a pass-through; fuel state carries through", () => {
    // Start at O with only 30 gal — enough for ~270 nm. Pin M (no fuel)
    // at 184 nm out. Without carry-through (i.e. if we naively reset
    // to full tanks at M), the planner would happily fly M→D directly
    // even though we arrived at M with ~15 gal. With carry-through,
    // the second sub-leg sees a tiny starting fuel and must detour
    // through the only fuel-bearing field, F, to reach D.
    const O = ap("O", 40, -120);
    const M = ap("M", 40, -118); // ~92 nm east, no fuel
    const F = ap("F", 40, -116, ["100LL"]); // ~184 nm east, fuel
    const D = ap("D", 40, -100); // ~920 nm from O
    const result = planWithWaypoints({
      airports: [O, M, F, D],
      origin: "O",
      destination: "D",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 30,
      waypoints: ["M"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      const ids = [r.legs[0].fromAirport.id, ...r.legs.map((l) => l.toAirport.id)];
      expect(ids).toContain("M");
      // F must show up after M as the actual refuel stop.
      const mIdx = ids.indexOf("M");
      const fIdx = ids.indexOf("F");
      expect(fIdx).toBeGreaterThan(mIdx);
    }
  });

  test("returns no route when a sub-leg is infeasible", () => {
    // Pin a waypoint far enough that the first sub-leg has no edge
    // meeting the max-leg cap and no intermediate airport on the way.
    // plan() returns [] for that sub-leg, and the wrapper surfaces an
    // empty overall result rather than a partial route.
    const O = ap("O", 40, -120);
    const W = ap("W", 40, -80, ["100LL"]); // ~1840 nm from O
    const D = ap("D", 40, -70);
    const result = planWithWaypoints({
      airports: [O, W, D],
      origin: "O",
      destination: "D",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      maxLegHr: 2, // ~240 nm at 120 KTAS; O→W can't meet this with no stop
      waypoints: ["W"],
    });
    expect(result).toEqual([]);
  });

  test("totals are the sum of sub-leg totals", () => {
    const O = ap("O", 40, -120);
    const M = ap("M", 40, -110, ["100LL"]);
    const D = ap("D", 40, -100);
    const result = planWithWaypoints({
      airports: [O, M, D],
      origin: "O",
      destination: "D",
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      waypoints: ["M"],
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      const summed = r.legs.reduce(
        (acc, l) => ({
          d: acc.d + l.distance_nm,
          t: acc.t + l.time_hr,
          f: acc.f + l.fuel_gal,
        }),
        { d: 0, t: 0, f: 0 },
      );
      expect(r.totals.distance_nm).toBeCloseTo(summed.d, 5);
      expect(r.totals.time_hr).toBeCloseTo(summed.t, 5);
      expect(r.totals.fuel_gal).toBeCloseTo(summed.f, 5);
      expect(r.totals.stops).toBe(r.legs.length - 1);
    }
  });
});
