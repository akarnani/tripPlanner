import { describe, expect, test } from "vitest";
import type { Airport, Obstacle } from "@/data/loaders";
import { analyzeTerrain, TERRAIN_BUFFER_FT } from "./terrain";

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

function obstacle(id: string, lat: number, lon: number, msl: number): Obstacle {
  return {
    id,
    state: null,
    lat,
    lon,
    type: "TOWER",
    height_agl_ft: 500,
    height_msl_ft: msl,
  };
}

describe("analyzeTerrain", () => {
  test("no warnings when cruise altitude clears every sample by 2000 ft", () => {
    const from = ap("A", 40, -120, 500);
    const to = ap("B", 40, -119, 500);
    const r = analyzeTerrain({
      legs: [{ from, to, fromIdent: "A", toIdent: "B", cruise_alt_ft: 5500 }],
      obstacles: [],
      flightRule: "VFR",
    });
    expect(r.warnings).toHaveLength(0);
    // 500 ft + 2000 = 2500 ft, below the 3000 ft floor so returned as-is.
    expect(r.perLeg[0].minSafeAltFt).toBe(2500);
    expect(r.replanTargetFt).toBe(2500);
  });

  test("warns when an obstacle in corridor pushes clearance below buffer", () => {
    const from = ap("A", 40, -120, 0);
    const to = ap("B", 40, -119, 0);
    const obs = obstacle("O1", 40, -119.5, 4500);
    const r = analyzeTerrain({
      legs: [{ from, to, fromIdent: "A", toIdent: "B", cruise_alt_ft: 5500 }],
      obstacles: [obs],
      flightRule: "VFR",
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].clearance_ft).toBeLessThan(TERRAIN_BUFFER_FT);
    expect(r.warnings[0].worst.source).toBe("O1");
    // 4500 + 2000 = 6500 ft; eastbound (course ≈ 90°) VFR → next is 7500
    expect(r.perLeg[0].minSafeAltFt).toBe(7500);
  });

  test("min-safe altitude respects hemispheric rule for direction", () => {
    const e = ap("E", 40, -110, 3000);
    const w = ap("W", 40, -120, 3000);
    // Same terrain (3000 ft + 2000 buffer = 5000 ft) but opposite directions.
    const east = analyzeTerrain({
      legs: [{ from: w, to: e, fromIdent: "W", toIdent: "E", cruise_alt_ft: 7500 }],
      obstacles: [],
      flightRule: "VFR",
    });
    const west = analyzeTerrain({
      legs: [{ from: e, to: w, fromIdent: "E", toIdent: "W", cruise_alt_ft: 6500 }],
      obstacles: [],
      flightRule: "VFR",
    });
    expect(east.perLeg[0].minSafeAltFt).toBe(5500); // east VFR
    expect(west.perLeg[0].minSafeAltFt).toBe(6500); // west VFR
  });

  test("ignores obstacles outside the corridor", () => {
    const from = ap("A", 40, -120, 0);
    const to = ap("B", 40, -119, 0);
    const obs = obstacle("O1", 40.33, -119.5, 4500); // 20 NM north
    const r = analyzeTerrain({
      legs: [{ from, to, fromIdent: "A", toIdent: "B", cruise_alt_ft: 5500 }],
      obstacles: [obs],
      flightRule: "VFR",
    });
    expect(r.warnings).toHaveLength(0);
  });
});
