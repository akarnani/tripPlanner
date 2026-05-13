import { describe, expect, test } from "vitest";
import type { Aircraft } from "@/data/aircraft";
import { cruiseAt, usableRange } from "./performance";

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
