import { describe, expect, it } from "vitest";
import type { Aircraft } from "@/data/aircraft";
import {
  hemisphericAltitude,
  hemisphericAltitudeAtOrBelow,
} from "./hemispheric";
import { cruiseAtConservative, maxPublishedCruiseAltFt } from "./performance";

const EASTBOUND = 90;
const WESTBOUND = 270;

describe("hemisphericAltitudeAtOrBelow", () => {
  it("searches downward where hemisphericAltitude searches up", () => {
    // 8,000 westbound IFR is legal; eastbound it is not, and the
    // highest legal level under it is 7,000.
    expect(hemisphericAltitudeAtOrBelow(8000, WESTBOUND, "IFR")).toBe(8000);
    expect(hemisphericAltitudeAtOrBelow(8000, EASTBOUND, "IFR")).toBe(7000);
    // The upward version disagrees in exactly the opposite direction.
    expect(hemisphericAltitude(8000, EASTBOUND, "IFR")).toBe(9000);
  });

  it("keeps the VFR +500 offset below Class A", () => {
    // Eastbound VFR is odd+500 — 3500/5500/7500/9500 — so the highest
    // level under 9,000 is 7,500. Westbound VFR is even+500, giving
    // 8,500. This asymmetry is the whole reason a ceiling has to round
    // down per leg instead of being taken literally.
    expect(hemisphericAltitudeAtOrBelow(9000, EASTBOUND, "VFR")).toBe(7500);
    expect(hemisphericAltitudeAtOrBelow(9000, WESTBOUND, "VFR")).toBe(8500);
    expect(hemisphericAltitudeAtOrBelow(8500, WESTBOUND, "VFR")).toBe(8500);
    expect(hemisphericAltitudeAtOrBelow(8500, EASTBOUND, "VFR")).toBe(7500);
  });

  it("drops the +500 at and above the Class A floor", () => {
    // 18,000+ is positive control, so levels are straight thousands
    // regardless of the requested flight rule.
    expect(hemisphericAltitudeAtOrBelow(19500, EASTBOUND, "VFR")).toBe(19000);
    expect(hemisphericAltitudeAtOrBelow(19500, WESTBOUND, "VFR")).toBe(18000);
  });

  it("returns null when no legal level fits under the cap", () => {
    // Nothing legal between the 3,000 ft floor and a 3,500 ft westbound
    // cap: the lowest westbound IFR level is 4,000.
    expect(hemisphericAltitudeAtOrBelow(3500, WESTBOUND, "IFR")).toBeNull();
  });

  it("passes through below the floor, matching the upward version", () => {
    expect(hemisphericAltitudeAtOrBelow(2500, EASTBOUND, "IFR")).toBe(2500);
    expect(hemisphericAltitude(2500, EASTBOUND, "IFR")).toBe(2500);
  });

  it("never returns a level above the cap, across a wide sweep", () => {
    for (let cap = 3000; cap <= 24000; cap += 100) {
      for (const course of [0, 45, 90, 179, 180, 225, 270, 359]) {
        for (const rule of ["VFR", "IFR"] as const) {
          const got = hemisphericAltitudeAtOrBelow(cap, course, rule);
          if (got === null) continue;
          expect(got).toBeLessThanOrEqual(cap);
          // And it must be a level the upward search agrees is legal.
          expect(hemisphericAltitude(got, course, rule)).toBe(got);
        }
      }
    }
  });
});

function mkAircraft(): Aircraft {
  return {
    slug: "c172s-like",
    make: "C",
    model: "172S",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 53 },
    cruise: [
      { altitude_ft: 2000, power_pct: 75, tas_kt: 124, fuel_gph: 9.6 },
      { altitude_ft: 8000, power_pct: 65, tas_kt: 117, fuel_gph: 7.6 },
      { altitude_ft: 12000, power_pct: 55, tas_kt: 108, fuel_gph: 6.1 },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
  };
}

describe("POH cruise data as a feasibility input", () => {
  const ac = mkAircraft();

  it("reports the highest published cruise altitude", () => {
    expect(maxPublishedCruiseAltFt(ac)).toBe(12000);
  });

  it("refuses to answer above the published table", () => {
    // cruiseAt() would silently hand back the 12,000 ft row here, which
    // is how a planner ends up claiming a 172 works at FL180.
    expect(() => cruiseAtConservative(ac, 15000)).toThrow(/no cruise data above/);
  });

  it("uses published cells verbatim when the altitude lands on a row", () => {
    expect(cruiseAtConservative(ac, 8000)).toEqual({
      tas_kt: 117,
      fuel_gph: 7.6,
      power_pct: 65,
    });
  });

  it("takes the worst of the bracketing rows between them", () => {
    // Between 8,000 and 12,000: slowest TAS and highest burn, each from
    // a real published cell -- never an interpolated value.
    const got = cruiseAtConservative(ac, 10000);
    expect(got.tas_kt).toBe(108); // the 12,000 ft row's TAS
    expect(got.fuel_gph).toBe(7.6); // the 8,000 ft row's burn
    expect([108, 117]).toContain(got.tas_kt);
    expect([6.1, 7.6]).toContain(got.fuel_gph);
  });

  it("is never optimistic relative to either bracketing row", () => {
    for (let alt = 2000; alt <= 12000; alt += 250) {
      const got = cruiseAtConservative(ac, alt);
      // The pair of published rows this altitude sits between.
      let lo = ac.cruise[0];
      let hi = ac.cruise[ac.cruise.length - 1];
      for (let i = 0; i < ac.cruise.length - 1; i++) {
        if (alt >= ac.cruise[i].altitude_ft && alt <= ac.cruise[i + 1].altitude_ft) {
          lo = ac.cruise[i];
          hi = ac.cruise[i + 1];
          break;
        }
      }
      expect(got.tas_kt).toBeLessThanOrEqual(Math.max(lo.tas_kt, hi.tas_kt));
      expect(got.fuel_gph).toBeGreaterThanOrEqual(Math.min(lo.fuel_gph, hi.fuel_gph));
      // And always a value that actually appears in the table.
      expect(ac.cruise.map((r) => r.tas_kt)).toContain(got.tas_kt);
      expect(ac.cruise.map((r) => r.fuel_gph)).toContain(got.fuel_gph);
    }
  });
});
