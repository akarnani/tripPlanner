import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { TerrainGridDEMSampler } from "./terrainGrid";

const GRID_PATH = fileURLToPath(
  new URL("../../../data/terrain_grid.bin.gz", import.meta.url),
);

async function loadSampler(): Promise<TerrainGridDEMSampler> {
  const compressed = await readFile(GRID_PATH);
  const raw = gunzipSync(compressed);
  // Build a fake fetch returning the (still-gzipped) bytes that our
  // sampler decompresses with DecompressionStream.
  const sampler = new TerrainGridDEMSampler("file://terrain_grid.bin.gz");
  // @ts-expect-error: poke private state for a Node-side test without
  // standing up a fetch + DecompressionStream shim.
  sampler.grid = decodePublicShape(raw.buffer);
  return sampler;
}

// Mirror of the private decoder, copied for the test only.
function decodePublicShape(buf: ArrayBufferLike): unknown {
  const view = new DataView(buf as ArrayBuffer);
  const latCells = view.getUint32(4, true);
  const lonCells = view.getUint32(8, true);
  const latNorth = view.getFloat64(12, true);
  const lonWest = view.getFloat64(20, true);
  const latStep = view.getFloat64(28, true);
  const lonStep = view.getFloat64(36, true);
  const data = new Int16Array(buf, 44, latCells * lonCells);
  return {
    header: { latCells, lonCells, latNorth, lonWest, latStep, lonStep },
    data,
  };
}

describe("TerrainGridDEMSampler with the committed CONUS grid", () => {
  test("returns plausible elevations for well-known points", async () => {
    const s = await loadSampler();
    // Tolerances are wide because the 1/120° grid resampled from z8
    // Terrarium tiles doesn't always land on the exact peak pixel.
    expect(s.elevationFt({ lat: 39.737, lon: -104.984 })).toBeGreaterThan(5000);
    expect(s.elevationFt({ lat: 39.737, lon: -104.984 })).toBeLessThan(5800);
    // Mt Whitney area — well above 10,000 ft
    expect(s.elevationFt({ lat: 36.5786, lon: -118.292 })).toBeGreaterThan(
      10000,
    );
    // Las Vegas
    const lv = s.elevationFt({ lat: 36.114, lon: -115.173 })!;
    expect(lv).toBeGreaterThan(1500);
    expect(lv).toBeLessThan(3000);
    // KSEA is near sea level
    expect(s.elevationFt({ lat: 47.45, lon: -122.308 })).toBeLessThan(1000);
  });

  test("returns null outside CONUS bbox", async () => {
    const s = await loadSampler();
    expect(s.elevationFt({ lat: 60, lon: -150 })).toBeNull(); // Alaska
    expect(s.elevationFt({ lat: 20, lon: -90 })).toBeNull(); // Mexico
  });
});
