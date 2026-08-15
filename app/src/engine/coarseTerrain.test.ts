import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { legTerrainPeakFt } from "./terrain";
import type { LatLon } from "./geo";

// The committed CONUS grid, loaded through the real sampler by stubbing
// fetch — same approach as terrainGrid.test.ts.
const GRID_PATH = new URL("../../../data/terrain_grid.bin.gz", import.meta.url);

let dem: TerrainGridDEMSampler;

beforeAll(async () => {
  const gz = readFileSync(GRID_PATH);
  const raw = gunzipSync(gz);
  const body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  globalThis.fetch = (async () =>
    new Response(body as ArrayBuffer, { status: 200 })) as typeof fetch;
  dem = new TerrainGridDEMSampler("stub://terrain");
  await dem.load();
}, 60_000);

/** Route pairs chosen to cross real terrain, plus flat and coastal cases. */
const ROUTES: Array<[string, LatLon, LatLon]> = [
  ["KSJC→KRNO (Sierra)", { lat: 37.3626, lon: -121.929 }, { lat: 39.4991, lon: -119.768 }],
  ["KDEN→KSLC (Rockies)", { lat: 39.8617, lon: -104.673 }, { lat: 40.7884, lon: -111.978 }],
  ["KSEA→KBOI (Cascades)", { lat: 47.4502, lon: -122.309 }, { lat: 43.5644, lon: -116.223 }],
  ["KTEX→KABQ (San Juans)", { lat: 37.9538, lon: -107.909 }, { lat: 35.0402, lon: -106.609 }],
  ["KMSP→KORD (flat)", { lat: 44.882, lon: -93.222 }, { lat: 41.9786, lon: -87.9048 }],
  ["KMIA→KTPA (coastal)", { lat: 25.7959, lon: -80.287 }, { lat: 27.9755, lon: -82.5332 }],
  ["KLAX→KSAN (coastal)", { lat: 33.9425, lon: -118.408 }, { lat: 32.7336, lon: -117.19 }],
];

describe("coarse terrain bound", () => {
  it("is never below the fine-grid peak on real routes", () => {
    for (const [name, a, b] of ROUTES) {
      const bound = dem.maxTerrainAlongFt(a, b);
      const { peakFt } = legTerrainPeakFt({ from: a, to: b, dem });
      expect(bound, `${name}: bound should be available inside CONUS`).not.toBeNull();
      expect(peakFt, `${name}: fine peak should be available inside CONUS`).not.toBeNull();
      expect(bound!, `${name}: bound ${bound} under fine peak ${peakFt}`).toBeGreaterThanOrEqual(
        peakFt!,
      );
    }
  });

  it("is never below the fine-grid peak across randomised CONUS legs", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20260806;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    // Stay inside the grid with margin: lat 24..50, lon -125..-66.
    const pt = (): LatLon => ({
      lat: 25 + rnd() * 24,
      lon: -124 + rnd() * 57,
    });

    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const a = pt();
      const b = pt();
      const bound = dem.maxTerrainAlongFt(a, b);
      if (bound === null) continue; // clipped the edge; not this test's job
      const { peakFt } = legTerrainPeakFt({ from: a, to: b, dem });
      if (peakFt === null) continue; // all-ocean leg
      expect(
        bound,
        `leg ${JSON.stringify(a)}→${JSON.stringify(b)}: bound ${bound} < fine peak ${peakFt}`,
      ).toBeGreaterThanOrEqual(peakFt);
      checked++;
    }
    // Guard against the assertions silently never running.
    expect(checked).toBeGreaterThan(100);
  });

  it("returns null when the leg leaves the grid", () => {
    // Anchorage → Fairbanks: entirely outside the CONUS grid.
    expect(
      dem.maxTerrainAlongFt({ lat: 61.174, lon: -149.996 }, { lat: 64.815, lon: -147.856 }),
    ).toBeNull();
    // Seattle → Anchorage: starts inside, leaves. Must fail closed.
    expect(
      dem.maxTerrainAlongFt({ lat: 47.4502, lon: -122.309 }, { lat: 61.174, lon: -149.996 }),
    ).toBeNull();
  });

  it("stays a useful bound rather than a trivially huge one", () => {
    // A flat-midwest leg must not be bounded by a mountain: the pooling
    // is only worth having if the bound tracks local terrain.
    const bound = dem.maxTerrainAlongFt(
      { lat: 44.882, lon: -93.222 },
      { lat: 41.9786, lon: -87.9048 },
    );
    expect(bound).not.toBeNull();
    expect(bound!).toBeLessThan(3000);
  });

  it("is faster than fine sampling on a long leg", () => {
    const a: LatLon = { lat: 47.4502, lon: -122.309 };
    const b: LatLon = { lat: 40.6413, lon: -73.7781 }; // KSEA→KJFK
    const N = 30;

    const t0 = performance.now();
    for (let i = 0; i < N; i++) dem.maxTerrainAlongFt(a, b);
    const coarseMs = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < N; i++) legTerrainPeakFt({ from: a, to: b, dem });
    const fineMs = performance.now() - t1;

    // Deliberately loose: this asserts the substrate is doing its job,
    // not a specific speedup number that would flake on shared CI.
    expect(coarseMs).toBeLessThan(fineMs);
  });
});
