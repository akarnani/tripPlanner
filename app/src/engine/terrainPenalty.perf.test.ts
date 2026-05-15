/* eslint-disable no-console */
import { describe, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Airport } from "@/data/loaders";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { computeTerrainPenalty } from "./terrainPenalty";
import { greatCircleNM } from "./geo";
import { initialTrueCourseDeg } from "./hemispheric";

async function loadSampler(): Promise<TerrainGridDEMSampler> {
  const buf = await readFile(
    fileURLToPath(new URL("../../../data/terrain_grid.bin.gz", import.meta.url)),
  );
  const raw = gunzipSync(buf);
  const s = new TerrainGridDEMSampler("file://terrain_grid.bin.gz");
  const view = new DataView(raw.buffer);
  const latCells = view.getUint32(4, true);
  const lonCells = view.getUint32(8, true);
  // @ts-expect-error access private state
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

// Skipped by default — manual benchmark. Run with:
//   npx vitest run app/src/engine/terrainPenalty.perf.test.ts \
//     --testNamePattern "synthetic"
describe.skip("PERF: terrain penalty hot loop", () => {
  test("synthetic 500-airport graph", async () => {
    const dem = await loadSampler();
    // Synthesize 500 airports scattered across CONUS.
    const airports: Airport[] = [];
    let id = 0;
    for (let lat = 32; lat <= 47; lat += 0.8) {
      for (let lon = -120; lon <= -75; lon += 2.0) {
        airports.push(ap(`A${id++}`, lat, lon, 1000));
        if (airports.length >= 500) break;
      }
      if (airports.length >= 500) break;
    }
    console.log(`Generated ${airports.length} airports`);
    // Build edges between every pair (worst case).
    const t0 = performance.now();
    let edges = 0;
    for (const from of airports) {
      for (const to of airports) {
        if (from === to) continue;
        // Mirror the routing.ts call pattern: the graph builder
        // already has distance_nm / true_course_deg for every edge,
        // so it passes them to skip the duplicate trig.
        const distance_nm = greatCircleNM(from, to);
        const true_course_deg = initialTrueCourseDeg(from, to);
        computeTerrainPenalty({
          from,
          to,
          cruise_alt_ft: 7500,
          climb_speed_kt: 78,
          climb_rate_fpm: 700,
          dem,
          distance_nm,
          true_course_deg,
        });
        edges++;
      }
    }
    const dt = performance.now() - t0;
    console.log(
      `Computed terrain penalty for ${edges} edges in ${dt.toFixed(1)} ms ` +
        `(${((dt * 1000) / edges).toFixed(2)} µs/edge)`,
    );
  });
});
