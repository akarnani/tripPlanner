import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Airport } from "@/data/loaders";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { analyzeTerrain } from "./terrain";

async function sampler(): Promise<TerrainGridDEMSampler> {
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

function ap(
  id: string,
  lat: number,
  lon: number,
  elev: number,
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
    elevation_ft: elev,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

describe("terrain analysis with the real DEM grid", () => {
  test("KSEA→KBOI at 8000 ft hits Cascades terrain and recommends a higher altitude", async () => {
    const dem = await sampler();
    const kSEA = ap("KSEA", 47.4502, -122.3088, 433);
    const kBOI = ap("KBOI", 43.5644, -116.2228, 2871);
    const r = analyzeTerrain({
      legs: [{ from: kSEA, to: kBOI, fromIdent: "KSEA", toIdent: "KBOI" }],
      obstacles: [],
      cruiseAltFt: 8000,
      dem,
    });
    expect(r.warnings.length).toBeGreaterThan(0);
    // The Cascades top out around 8,000-10,000 ft along this great
    // circle; min-safe-alt should be at least ~10,000 ft.
    expect(r.minSafeAltFt).toBeGreaterThanOrEqual(10000);
  });

  test("KSEA→KPDX over the Puget lowlands clears at 6000 ft", async () => {
    const dem = await sampler();
    const kSEA = ap("KSEA", 47.4502, -122.3088, 433);
    const kPDX = ap("KPDX", 45.5887, -122.5975, 31);
    const r = analyzeTerrain({
      legs: [{ from: kSEA, to: kPDX, fromIdent: "KSEA", toIdent: "KPDX" }],
      obstacles: [],
      cruiseAltFt: 6000,
      dem,
    });
    expect(r.warnings).toHaveLength(0);
  });
});
