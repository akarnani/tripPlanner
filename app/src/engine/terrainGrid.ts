import type { DEMSampler } from "./terrain";
import type { LatLon } from "./geo";
import { maybeGunzip } from "@/data/gz";

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
  data: Int16Array;
}

const MAGIC = "DEM1";
const NO_DATA = -32768;

/**
 * Loads `terrain_grid.bin.gz` once and exposes a DEMSampler that returns
 * elevation in feet MSL at any point inside the grid. Outside the grid
 * (or where the source was ocean / no-data), returns null so the engine
 * falls back to airport-elevation + obstacle data only.
 *
 * The grid is fetched lazily on first call to `load()`; planning code
 * should await `load()` before invoking `analyzeTerrain`, otherwise the
 * sampler returns null everywhere.
 */
export class TerrainGridDEMSampler implements DEMSampler {
  private grid: Grid | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly url: string) {}

  ready(): boolean {
    return this.grid !== null;
  }

  async load(): Promise<void> {
    if (this.grid) return;
    if (!this.loading) {
      // Don't cache a rejected attempt: clearing `loading` on failure
      // lets a later load() retry the fetch. Otherwise one transient
      // network hiccup pins this instance terrain-blind for life —
      // and a planner that awaits load() per request keeps silently
      // getting the same stale rejection.
      this.loading = this.fetchAndDecode().catch((e) => {
        this.loading = null;
        throw e;
      });
    }
    return this.loading;
  }

  elevationFt(point: LatLon): number | null {
    const g = this.grid;
    if (!g) return null;
    const { header } = g;
    const i = Math.round((header.latNorth - point.lat) / header.latStep);
    const j = Math.round((point.lon - header.lonWest) / header.lonStep);
    if (i < 0 || i >= header.latCells || j < 0 || j >= header.lonCells) {
      return null;
    }
    const v = g.data[i * header.lonCells + j];
    if (v === NO_DATA) return null;
    return v;
  }

  private async fetchAndDecode(): Promise<void> {
    const resp = await fetch(this.url);
    if (!resp.ok) {
      throw new Error(`DEM grid fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const body = await resp.arrayBuffer();
    this.grid = decode(await maybeGunzip(body));
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
  if (magic !== MAGIC) throw new Error(`terrain grid: bad magic ${magic}`);
  const latCells = view.getUint32(4, true);
  const lonCells = view.getUint32(8, true);
  const latNorth = view.getFloat64(12, true);
  const lonWest = view.getFloat64(20, true);
  const latStep = view.getFloat64(28, true);
  const lonStep = view.getFloat64(36, true);
  const expected = 44 + latCells * lonCells * 2;
  if (buf.byteLength !== expected) {
    throw new Error(
      `terrain grid: size ${buf.byteLength}, expected ${expected}`,
    );
  }
  const data = new Int16Array(buf, 44, latCells * lonCells);
  return {
    header: { latCells, lonCells, latNorth, lonWest, latStep, lonStep },
    data,
  };
}
