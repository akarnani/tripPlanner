import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Airport } from "@/data/loaders";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { computeTerrainPenalty } from "./terrainPenalty";

async function loadSampler(): Promise<TerrainGridDEMSampler> {
  const buf = await readFile(
    fileURLToPath(
      new URL("../../../data/terrain_grid.bin.gz", import.meta.url),
    ),
  );
  const raw = gunzipSync(buf);
  const s = new TerrainGridDEMSampler("file://terrain_grid.bin.gz");
  const view = new DataView(raw.buffer);
  const latCells = view.getUint32(4, true);
  const lonCells = view.getUint32(8, true);
  // @ts-expect-error access private state for the test
  s.grid = {
    header: {
      latCells,
      lonCells,
      latNorth: view.getFloat64(12, true),
      lonWest: view.getFloat64(20, true),
      latStep: view.getFloat64(28, true),
      lonStep: view.getFloat64(36, true),
    },
    data: new Int16Array(raw.buffer, 44, latCells * lonCells),
  };
  return s;
}

function ap(id: string, lat: number, lon: number, elev: number): Airport {
  return {
    id,
    lid: id,
    icao: id,
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

describe("terrain penalty with the real DEM grid", () => {
  test("KPAO → KSVR penalizes the Stansbury / Oquirrh ranges on the descent corridor", async () => {
    // South Valley Regional (KSVR) sits in the Salt Lake Valley with
    // 10,000 ft+ peaks immediately west: the Oquirrh foothills inside
    // ~10 nm and the Stansbury range right at ~30 nm. A 1,000 ft / 3
    // nm descent into KSVR from a westbound arrival can't be flown
    // through them, and at any cruise altitude below the Stansbury
    // peaks the leg itself has cruise-altitude clearance issues. Both
    // regimes should produce a non-trivial arrival shortfall.
    const dem = await loadSampler();
    const kPAO = ap("KPAO", 37.4611, -122.115, 7);
    const kSVR = ap("KSVR", 40.6195, -111.9929, 4606);
    const high = computeTerrainPenalty({
      from: kPAO,
      to: kSVR,
      cruise_alt_ft: 11500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(high.arrival_shortfall_ft).toBeGreaterThan(500);
    expect(high.hr).toBeGreaterThan(0);
    // At a lower cruise altitude (below the Stansbury peaks at ~10,300
    // ft), terrain pokes above cruise and the arrival shortfall grows.
    const low = computeTerrainPenalty({
      from: kPAO,
      to: kSVR,
      cruise_alt_ft: 9500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(low.arrival_shortfall_ft).toBeGreaterThan(high.arrival_shortfall_ft);
    expect(low.arrival_shortfall_ft).toBeGreaterThan(1000);
  });
});
