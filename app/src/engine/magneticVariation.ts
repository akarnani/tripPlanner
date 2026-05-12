import type { LatLon } from "./geo";

interface GridHeader {
  latCells: number;
  lonCells: number;
  latNorth: number;
  lonWest: number;
  latStep: number;
  lonStep: number;
}

interface Grid {
  header: GridHeader;
  data: Float32Array;
}

const MAGIC = "MAG1";

/**
 * Magnetic declination provider, fed by the committed CONUS WMM grid.
 * Returns east-positive variation in degrees (so subtracting from true
 * course gives magnetic course). Returns null outside CONUS — callers
 * should fall back to the true course in that case.
 */
export class MagneticVariationGrid {
  private grid: Grid | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly url: string) {}

  ready(): boolean {
    return this.grid !== null;
  }

  async load(): Promise<void> {
    if (this.grid) return;
    if (!this.loading) this.loading = this.fetchAndDecode();
    return this.loading;
  }

  /** East-positive declination at the point, in degrees. Null if out of grid. */
  variationDeg(point: LatLon): number | null {
    const g = this.grid;
    if (!g) return null;
    const { header } = g;
    const fi = (header.latNorth - point.lat) / header.latStep;
    const fj = (point.lon - header.lonWest) / header.lonStep;
    if (
      fi < 0 ||
      fi > header.latCells - 1 ||
      fj < 0 ||
      fj > header.lonCells - 1
    ) {
      return null;
    }
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const i1 = Math.min(i0 + 1, header.latCells - 1);
    const j1 = Math.min(j0 + 1, header.lonCells - 1);
    const di = fi - i0;
    const dj = fj - j0;
    const n = header.lonCells;
    const v00 = g.data[i0 * n + j0];
    const v01 = g.data[i0 * n + j1];
    const v10 = g.data[i1 * n + j0];
    const v11 = g.data[i1 * n + j1];
    return (
      v00 * (1 - di) * (1 - dj) +
      v01 * (1 - di) * dj +
      v10 * di * (1 - dj) +
      v11 * di * dj
    );
  }

  private async fetchAndDecode(): Promise<void> {
    const resp = await fetch(this.url);
    if (!resp.ok) {
      throw new Error(
        `magnetic grid fetch failed: ${resp.status} ${resp.statusText}`,
      );
    }
    const compressed = await resp.arrayBuffer();
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([compressed]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    this.grid = decode(buf);
  }
}

function decode(buf: ArrayBuffer): Grid {
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== MAGIC) throw new Error(`magnetic grid: bad magic ${magic}`);
  const latCells = view.getUint32(4, true);
  const lonCells = view.getUint32(8, true);
  const latNorth = view.getFloat64(12, true);
  const lonWest = view.getFloat64(20, true);
  const latStep = view.getFloat64(28, true);
  const lonStep = view.getFloat64(36, true);
  const expected = 44 + latCells * lonCells * 4;
  if (buf.byteLength !== expected) {
    throw new Error(
      `magnetic grid: size ${buf.byteLength}, expected ${expected}`,
    );
  }
  const data = new Float32Array(buf, 44, latCells * lonCells);
  return {
    header: { latCells, lonCells, latNorth, lonWest, latStep, lonStep },
    data,
  };
}
