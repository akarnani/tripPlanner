import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import { toGPX } from "./gpx";
import { toFPL } from "./fpl";

function ap(id: string, lat: number, lon: number, icao: string | null): Airport {
  return {
    id,
    lid: id,
    icao,
    name: `${id} airport`,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: 100,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

function mkRoute(): PlannedRoute {
  const a = ap("A", 47.45, -122.31, "KSEA");
  const b = ap("B", 47.62, -117.53, "KGEG");
  const c = ap("C", 43.56, -116.22, "KBOI");
  return {
    costFnId: "fewestStops",
    cost: 2,
    legs: [
      {
        from: "A",
        to: "B",
        distance_nm: 224,
        time_hr: 1.9,
        fuel_gal: 18,
        course_deg: 90,
        cruise_alt_ft: 7500,
        tas_kt: 120,
        fuel_gph: 9,
        fromAirport: a,
        toAirport: b,
      },
      {
        from: "B",
        to: "C",
        distance_nm: 268,
        time_hr: 2.3,
        fuel_gal: 22,
        course_deg: 180,
        cruise_alt_ft: 6500,
        tas_kt: 117,
        fuel_gph: 7.6,
        fromAirport: b,
        toAirport: c,
      },
    ],
    totals: { distance_nm: 492, time_hr: 4.2, fuel_gal: 40, stops: 1 },
  };
}

describe("toGPX", () => {
  test("emits one <rtept> per airport in order with ICAO identifiers", () => {
    const gpx = toGPX(mkRoute(), "Test");
    expect(gpx).toMatch(/<gpx /);
    const matches = gpx.match(/<rtept /g) ?? [];
    expect(matches).toHaveLength(3);
    expect(gpx).toContain("<name>KSEA</name>");
    expect(gpx).toContain("<name>KGEG</name>");
    expect(gpx).toContain("<name>KBOI</name>");
    expect(gpx.indexOf("KSEA")).toBeLessThan(gpx.indexOf("KGEG"));
    expect(gpx.indexOf("KGEG")).toBeLessThan(gpx.indexOf("KBOI"));
  });
});

describe("toFPL", () => {
  test("emits a waypoint table and a route-point per airport", () => {
    const fpl = toFPL(mkRoute(), "Test");
    expect(fpl).toMatch(/<flight-plan /);
    const wpMatches = fpl.match(/<waypoint>/g) ?? [];
    expect(wpMatches).toHaveLength(3);
    const rpMatches = fpl.match(/<route-point>/g) ?? [];
    expect(rpMatches).toHaveLength(3);
    expect(fpl).toContain("<identifier>KSEA</identifier>");
    expect(fpl).toContain("<waypoint-identifier>KBOI</waypoint-identifier>");
  });

  test("falls back to FAA LID when ICAO is missing", () => {
    const a = ap("X1", 40, -120, null);
    const b = ap("X2", 41, -121, null);
    const route: PlannedRoute = {
      costFnId: "fewestStops",
      cost: 1,
      legs: [
        {
          from: "X1",
          to: "X2",
          distance_nm: 50,
          time_hr: 0.5,
          fuel_gal: 5,
          course_deg: 45,
          cruise_alt_ft: 3500,
          tas_kt: 120,
          fuel_gph: 9,
          fromAirport: a,
          toAirport: b,
        },
      ],
      totals: { distance_nm: 50, time_hr: 0.5, fuel_gal: 5, stops: 0 },
    };
    const fpl = toFPL(route);
    expect(fpl).toContain("<identifier>X1</identifier>");
    expect(fpl).toContain("<identifier>X2</identifier>");
  });
});
