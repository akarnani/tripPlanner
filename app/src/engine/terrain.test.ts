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
      legs: [{ from, to, fromIdent: "A", toIdent: "B" }],
      obstacles: [],
      cruiseAltFt: 5000,
    });
    expect(r.warnings).toHaveLength(0);
    expect(r.minSafeAltFt).toBe(2500); // 500 + 2000 → next 500 ft
  });

  test("warns when an obstacle in corridor pushes clearance below buffer", () => {
    const from = ap("A", 40, -120, 0);
    const to = ap("B", 40, -119, 0);
    // Obstacle right on the great-circle path, 4500 ft MSL
    const obs = obstacle("O1", 40, -119.5, 4500);
    const r = analyzeTerrain({
      legs: [{ from, to, fromIdent: "A", toIdent: "B" }],
      obstacles: [obs],
      cruiseAltFt: 5000, // only 500 ft clearance
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].clearance_ft).toBeLessThan(TERRAIN_BUFFER_FT);
    expect(r.warnings[0].worst.source).toBe("O1");
    expect(r.minSafeAltFt).toBe(6500); // 4500 + 2000 → 6500
  });

  test("ignores obstacles outside the corridor", () => {
    const from = ap("A", 40, -120, 0);
    const to = ap("B", 40, -119, 0);
    // Obstacle 20 NM north of the path
    const obs = obstacle("O1", 40.33, -119.5, 4500);
    const r = analyzeTerrain({
      legs: [{ from, to, fromIdent: "A", toIdent: "B" }],
      obstacles: [obs],
      cruiseAltFt: 5000,
    });
    expect(r.warnings).toHaveLength(0);
  });
});
