import { describe, expect, test } from "vitest";
import type { Aircraft } from "@/data/aircraft";
import { climbFromTo, cruiseAt, usableRange } from "./performance";

const sample: Aircraft = {
  slug: "test-172",
  make: "Cessna",
  model: "172S",
  fuel: { type: "100LL", density_lb_per_gal: 6.0, usable_capacity_gal: 50 },
  cruise: [
    { altitude_ft: 2000, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
    { altitude_ft: 8000, power_pct: 65, tas_kt: 110, fuel_gph: 8 },
  ],
  climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
};

const sampleWithTable: Aircraft = {
  ...sample,
  climb: {
    rate_fpm: 700,
    fuel_to_climb_gph: 10,
    table: [
      { altitude_ft: 0, time_min: 0, fuel_gal: 0, distance_nm: 0 },
      { altitude_ft: 2000, time_min: 2, fuel_gal: 0.4, distance_nm: 3 },
      { altitude_ft: 8000, time_min: 11, fuel_gal: 2.1, distance_nm: 17 },
    ],
  },
};

describe("cruiseAt", () => {
  test("returns first row at or below min altitude", () => {
    expect(cruiseAt(sample, 0)).toMatchObject({ tas_kt: 120, fuel_gph: 10 });
    expect(cruiseAt(sample, 2000)).toMatchObject({ tas_kt: 120, fuel_gph: 10 });
  });

  test("returns last row at or above max altitude", () => {
    expect(cruiseAt(sample, 8000)).toMatchObject({ tas_kt: 110, fuel_gph: 8 });
    expect(cruiseAt(sample, 12000)).toMatchObject({ tas_kt: 110, fuel_gph: 8 });
  });

  test("linearly interpolates between rows", () => {
    const c = cruiseAt(sample, 5000); // halfway
    expect(c.tas_kt).toBeCloseTo(115, 5);
    expect(c.fuel_gph).toBeCloseTo(9, 5);
  });
});

describe("climbFromTo", () => {
  test("returns zero for level or descent segments", () => {
    expect(climbFromTo(sample, 5000, 5000)).toEqual({
      time_hr: 0,
      fuel_gal: 0,
      distance_nm: 0,
    });
    expect(climbFromTo(sample, 8000, 4000)).toEqual({
      time_hr: 0,
      fuel_gal: 0,
      distance_nm: 0,
    });
  });

  test("falls back to scalar rate when no climb table is present", () => {
    // 0 → 7000 ft at 700 fpm = 10 min = 1/6 hr.
    // Fuel = 10/60 × 10 gph = 1.667 gal.
    const r = climbFromTo(sample, 0, 7000);
    expect(r.time_hr).toBeCloseTo(10 / 60, 5);
    expect(r.fuel_gal).toBeCloseTo(10 / 60 * 10, 5);
    // Distance assumes 70% of cruise TAS at 7000 ft (interpolated).
    const cruiseTas = cruiseAt(sample, 7000).tas_kt;
    expect(r.distance_nm).toBeCloseTo((10 / 60) * cruiseTas * 0.7, 4);
  });

  test("uses the cumulative table when present and subtracts endpoints", () => {
    // 2000 → 8000 ft = (11min, 2.1gal, 17nm) − (2min, 0.4gal, 3nm)
    //                = (9min, 1.7gal, 14nm).
    const r = climbFromTo(sampleWithTable, 2000, 8000);
    expect(r.time_hr).toBeCloseTo(9 / 60, 5);
    expect(r.fuel_gal).toBeCloseTo(1.7, 5);
    expect(r.distance_nm).toBeCloseTo(14, 5);
  });

  test("table values interpolate linearly between rows", () => {
    // 0 → 1000 ft (halfway between 0 and 2000): half of 2-min row.
    const r = climbFromTo(sampleWithTable, 0, 1000);
    expect(r.time_hr).toBeCloseTo(1 / 60, 5);
    expect(r.fuel_gal).toBeCloseTo(0.2, 5);
    expect(r.distance_nm).toBeCloseTo(1.5, 5);
  });

  test("clamps requests above the table's top altitude", () => {
    // Anything above 8000 returns the 8000-ft cumulative values.
    const r = climbFromTo(sampleWithTable, 0, 12000);
    expect(r.time_hr).toBeCloseTo(11 / 60, 5);
    expect(r.fuel_gal).toBeCloseTo(2.1, 5);
  });

  test("climb fuel saved at higher altitudes is small on short legs and bigger on long legs", () => {
    // This is the documented motivation for the climb decomposition:
    // the user's reported "altitude barely affects fuel" symptom is
    // because climb burn was being ignored. With climb costed properly,
    // higher altitudes still help on long legs but the per-leg gain
    // shrinks on short legs.
    const lowAlt = 2000;
    const highAlt = 8000;
    const climbHigh = climbFromTo(sampleWithTable, 0, highAlt);
    const climbLow = climbFromTo(sampleWithTable, 0, lowAlt);
    const climbDelta = climbHigh.fuel_gal - climbLow.fuel_gal;
    expect(climbDelta).toBeGreaterThan(0); // climbing higher costs more
    // Per-hour cruise savings at 8000 vs 2000: (10 - 8) = 2 gph.
    // Climb extra: 1.7 gal. So break-even time ≈ 0.85 hr ≈ 100 nm.
    // Below that, lower altitude wins on fuel. Sanity check.
    expect(climbDelta / 2).toBeCloseTo(0.85, 1);
  });
});

describe("usableRange", () => {
  test("subtracts reserve and computes endurance and range", () => {
    const r = usableRange({
      aircraft: sample,
      altitude_ft: 2000,
      reserve_hours: 0.75, // 45 min
    });
    expect(r.reserve_gal).toBeCloseTo(7.5, 5);
    expect(r.burnable_gal).toBeCloseTo(42.5, 5);
    expect(r.endurance_hr).toBeCloseTo(4.25, 5);
    expect(r.range_nm).toBeCloseTo(510, 5);
  });

  test("clamps burnable at zero when reserve exceeds capacity", () => {
    const r = usableRange({
      aircraft: sample,
      altitude_ft: 2000,
      reserve_hours: 10, // 100 gal reserve > 50 gal capacity
    });
    expect(r.burnable_gal).toBe(0);
    expect(r.range_nm).toBe(0);
  });
});
