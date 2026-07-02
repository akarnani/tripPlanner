import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import type { PlannedRoute } from "./plan";
import type { DEMSampler } from "./terrain";
import { buildRouteProfile } from "./routeProfile";

function ap(id: string, lat: number, lon: number, elev: number): Airport {
  return {
    id,
    lid: id,
    icao: null,
    name: id,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: elev,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

const aircraft = {
  slug: "test",
  model: "test",
  fuel: { type: "100LL", usable_capacity_gal: 50 },
  climb: { rate_fpm: 500, fuel_to_climb_gph: 10 },
  cruise: [
    { altitude_ft: 2000, tas_kt: 120, fuel_gph: 10 },
    { altitude_ft: 12000, tas_kt: 120, fuel_gph: 10 },
  ],
} as unknown as Aircraft;

const flatDem: DEMSampler = { elevationFt: () => 100 };

function routeOf(seq: Airport[], cruiseAltFt: number): PlannedRoute {
  const legs = [];
  for (let i = 0; i < seq.length - 1; i++) {
    legs.push({
      fromAirport: seq[i],
      toAirport: seq[i + 1],
      cruise_alt_ft: cruiseAltFt,
    });
  }
  return { legs } as unknown as PlannedRoute;
}

describe("buildRouteProfile", () => {
  const a = ap("A", 40, -110, 100);
  const b = ap("B", 40, -107, 200);
  const c = ap("C", 40, -104, 100);

  test("concatenates legs onto one cumulative axis with airport ticks", () => {
    const p = buildRouteProfile({
      route: routeOf([a, b, c], 6500),
      aircraft,
      dem: flatDem,
    });
    expect(p.airports.map((x) => x.ident)).toEqual(["A", "B", "C"]);
    expect(p.airports[0].distNm).toBe(0);
    expect(p.airports[2].distNm).toBeCloseTo(p.totalNm, 6);
    // Monotonically increasing cumulative distance, one shared sample
    // at each stop (no duplicate at the joint).
    for (let i = 1; i < p.points.length; i++) {
      expect(p.points[i].distNm).toBeGreaterThan(p.points[i - 1].distNm);
    }
    // Leg indices tag each sample.
    expect(p.points[0].legIndex).toBe(0);
    expect(p.points[p.points.length - 1].legIndex).toBe(1);
    // Segment boundaries line up with the airport ticks.
    expect(p.segments[1].startNm).toBeCloseTo(p.airports[1].distNm, 6);
    expect(p.segments[1].endNm).toBeCloseTo(p.totalNm, 6);
    // Normal (non-"tent") legs reach the requested cruise altitude, and
    // each segment's elevations mirror its airports' field elevations.
    expect(p.segments[0].topAltFt).toBe(6500);
    expect(p.segments[0].startElevFt).toBe(a.elevation_ft);
    expect(p.segments[0].endElevFt).toBe(b.elevation_ft);
    expect(p.segments[1].topAltFt).toBe(6500);
    expect(p.segments[1].startElevFt).toBe(b.elevation_ft);
    expect(p.segments[1].endElevFt).toBe(c.elevation_ft);
    // Per-leg gradient info (standard vs terrain-required) passes
    // through onto each segment untouched.
    for (const seg of p.segments) {
      expect(seg.climb.stdFtPerNm).toBeGreaterThan(0);
      expect(seg.climb.reqFtPerNm).toBeGreaterThanOrEqual(
        seg.climb.stdFtPerNm,
      );
      expect(seg.descent.stdFtPerNm).toBeCloseTo(1000 / 3, 6);
      expect(seg.descent.reqFtPerNm).toBeGreaterThanOrEqual(
        seg.descent.stdFtPerNm,
      );
      // Flat terrain in this fixture never forces anything steeper.
      expect(seg.climb.reqFtPerNm).toBeCloseTo(seg.climb.stdFtPerNm, 6);
      expect(seg.descent.reqFtPerNm).toBeCloseTo(seg.descent.stdFtPerNm, 6);
      // Raw terrain demand passes through and is zero over flat ground.
      expect(seg.climb.terrainReqFtPerNm).toBe(0);
      expect(seg.descent.terrainReqFtPerNm).toBe(0);
    }
  });

  test("short tent leg's topAltFt is the clipped apex, not requested cruise", () => {
    // ~34 nm leg with a 12,000 ft cruise request: too short to reach
    // cruise, so the ramps meet below it (mirrors legProfile.test.ts).
    const near = ap("E", 40, -110, 100);
    const nearTo = ap("F", 40, -109.25, 100);
    const p = buildRouteProfile({
      route: routeOf([near, nearTo], 12000),
      aircraft,
      dem: flatDem,
    });
    expect(p.segments[0].topAltFt).toBeLessThan(12000);
    expect(p.segments[0].topAltFt).toBeGreaterThan(100);
  });

  test("points carry lat/lon for viewport windowing", () => {
    const p = buildRouteProfile({
      route: routeOf([a, c], 6500),
      aircraft,
      dem: flatDem,
    });
    expect(p.points[0].lon).toBeCloseTo(-110, 5);
    expect(p.points[p.points.length - 1].lon).toBeCloseTo(-104, 5);
  });
});
