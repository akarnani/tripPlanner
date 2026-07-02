import { describe, expect, test } from "vitest";
import type { Aircraft } from "@/data/aircraft";
import { cruiseBurnGph, perLegArrivalFuel, reserveFuelGal } from "./fuel";

// Same fixture shape as runway.test.ts's `aircraft()` helper, so the
// fuel-propagation tests below read like siblings of `perLegWeights`'s.
function aircraft(extra: Partial<Aircraft> = {}): Aircraft {
  return {
    slug: "t",
    make: "T",
    model: "T",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 53 },
    cruise: [
      { altitude_ft: 0, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
      { altitude_ft: 8000, power_pct: 75, tas_kt: 120, fuel_gph: 8 },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
    weights: { max_gross_lb: 2550 },
    ...extra,
  };
}

describe("perLegArrivalFuel", () => {
  test("starting fuel below capacity carries straight through to arrival", () => {
    // Mirrors runway.test.ts's "starting fuel below capacity reduces
    // the origin takeoff weight" — here the origin simply departs on
    // the requested 30 gal (no capacity top-off) and lands with the
    // burn subtracted.
    const arr = perLegArrivalFuel({
      aircraft: aircraft(),
      legFuelBurnGal: [10],
      legOriginRefuels: [true],
      startingFuelGal: 30,
    });
    expect(arr).toEqual([20]);
  });

  test("starting fuel above capacity clamps to usable capacity", () => {
    const arr = perLegArrivalFuel({
      aircraft: aircraft(),
      legFuelBurnGal: [10],
      legOriginRefuels: [true],
      startingFuelGal: 999,
    });
    expect(arr).toEqual([43]); // 53 - 10
  });

  test("negative starting fuel clamps to zero", () => {
    const arr = perLegArrivalFuel({
      aircraft: aircraft(),
      legFuelBurnGal: [10],
      legOriginRefuels: [true],
      startingFuelGal: -5,
    });
    expect(arr).toEqual([-10]); // clamped start (0) minus the burn
  });

  test("refuel stops reset to full capacity; pass-through stops carry the remainder", () => {
    // Mirrors runway.test.ts's "refuel stops reset takeoff weight to
    // max gross; passes carry through" test, one-for-one in fuel
    // units: stop 1 refuels (back to 53 gal), stop 2 is a pass-through
    // (keeps whatever's left after stop 1's leg).
    const arr = perLegArrivalFuel({
      aircraft: aircraft(),
      legFuelBurnGal: [10, 12, 8],
      legOriginRefuels: [true, true, false],
      startingFuelGal: 53,
    });
    expect(arr[0]).toBeCloseTo(53 - 10, 5); // 43
    expect(arr[1]).toBeCloseTo(53 - 12, 5); // refueled to 53, then burns 12 -> 41
    expect(arr[2]).toBeCloseTo(arr[1] - 8, 5); // pass-through carries 41, burns 8 -> 33
  });

  test("origin's own legOriginRefuels entry is a no-op (nothing to top off before departure)", () => {
    // Index 0 corresponds to the trip origin, which never "refuels"
    // before its own first leg — same shape-parity no-op documented
    // on perLegWeights's legOriginRefuels.
    const withTrue = perLegArrivalFuel({
      aircraft: aircraft(),
      legFuelBurnGal: [10],
      legOriginRefuels: [true],
      startingFuelGal: 30,
    });
    const withFalse = perLegArrivalFuel({
      aircraft: aircraft(),
      legFuelBurnGal: [10],
      legOriginRefuels: [false],
      startingFuelGal: 30,
    });
    expect(withTrue).toEqual(withFalse);
  });

  test("empty leg list returns an empty array", () => {
    expect(
      perLegArrivalFuel({
        aircraft: aircraft(),
        legFuelBurnGal: [],
        legOriginRefuels: [],
        startingFuelGal: 53,
      }),
    ).toEqual([]);
  });
});

describe("cruiseBurnGph", () => {
  test("returns the published GPH at a table altitude", () => {
    expect(cruiseBurnGph(aircraft(), 0)).toBe(10);
    expect(cruiseBurnGph(aircraft(), 8000)).toBe(8);
  });

  test("interpolates between published rows (POH-verbatim, no fabricated points)", () => {
    // Midway between 0 ft (10 gph) and 8,000 ft (8 gph) rows.
    expect(cruiseBurnGph(aircraft(), 4000)).toBeCloseTo(9, 5);
  });

  test("clamps above the top published row", () => {
    expect(cruiseBurnGph(aircraft(), 20000)).toBe(8);
  });
});

describe("reserveFuelGal", () => {
  test("45 minutes of reserve at 10 gph is 7.5 gal", () => {
    expect(
      reserveFuelGal({ aircraft: aircraft(), altitude_ft: 0, reserve_min: 45 }),
    ).toBeCloseTo(7.5, 5);
  });

  test("zero reserve minutes is zero gallons", () => {
    expect(
      reserveFuelGal({ aircraft: aircraft(), altitude_ft: 8000, reserve_min: 0 }),
    ).toBe(0);
  });
});
