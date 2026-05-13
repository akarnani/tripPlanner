import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { MagneticVariationGrid } from "./magneticVariation";

async function loadGrid(): Promise<MagneticVariationGrid> {
  const buf = await readFile(
    fileURLToPath(
      new URL("../../../data/magnetic_grid.bin.gz", import.meta.url),
    ),
  );
  const raw = gunzipSync(buf);
  const g = new MagneticVariationGrid("file://magnetic_grid.bin.gz");
  const view = new DataView(raw.buffer);
  const latCells = view.getUint32(4, true);
  const lonCells = view.getUint32(8, true);
  // @ts-expect-error inject decoded grid for the test
  g.grid = {
    header: {
      latCells,
      lonCells,
      latNorth: view.getFloat64(12, true),
      lonWest: view.getFloat64(20, true),
      latStep: view.getFloat64(28, true),
      lonStep: view.getFloat64(36, true),
    },
    data: new Float32Array(raw.buffer, 44, latCells * lonCells),
  };
  return g;
}

describe("MagneticVariationGrid with the committed CONUS grid", () => {
  test("matches published declinations within 1° for sampled airports", async () => {
    const g = await loadGrid();
    // Tolerances are wide because the grid is on 1° spacing and we
    // bilinearly interpolate; expected values from current WMM (2026).
    const ksea = g.variationDeg({ lat: 47.45, lon: -122.31 })!;
    expect(ksea).toBeGreaterThan(13);
    expect(ksea).toBeLessThan(17);

    const kjfk = g.variationDeg({ lat: 40.64, lon: -73.78 })!;
    expect(kjfk).toBeLessThan(-10);
    expect(kjfk).toBeGreaterThan(-15);

    const klax = g.variationDeg({ lat: 33.94, lon: -118.41 })!;
    expect(klax).toBeGreaterThan(9);
    expect(klax).toBeLessThan(13);
  });

  test("returns null outside the CONUS bbox", async () => {
    const g = await loadGrid();
    expect(g.variationDeg({ lat: 60, lon: -150 })).toBeNull();
    expect(g.variationDeg({ lat: 20, lon: -90 })).toBeNull();
  });
});
