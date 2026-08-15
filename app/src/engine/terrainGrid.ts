import type { DEMSampler, TerrainBoundSampler } from "./terrain";
import { greatCircleNM, interpolateGreatCircle, type LatLon } from "./geo";
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

/** Coarse max-pooled overlay used to answer "how high can the ground
 *  possibly be along this leg" without touching the 42 MB fine grid. */
interface CoarseGrid {
  latCells: number;
  lonCells: number;
  /** Cells-per-side of the fine block each coarse cell summarises. */
  pool: number;
  /** Per-cell max, already dilated by one cell in every direction. */
  dilated: Int16Array;
}

const MAGIC = "DEM1";
const NO_DATA = -32768;

/**
 * Fine cells per coarse cell. The committed grid is 30″ (~0.5 nm), so
 * pooling 12× gives 0.1° cells — at most 6 nm on a side anywhere in
 * CONUS. The whole overlay is then 260 × 590 Int16 ≈ 300 KB, which
 * stays resident in L2 instead of streaming 42 MB through the cache on
 * every leg the router scores.
 */
const POOL = 12;

/**
 * Sample spacing when walking the coarse overlay, in nautical miles.
 *
 * Any point between two consecutive samples is within half this
 * distance (1.5 nm) of one of them, and the smallest coarse cell
 * dimension anywhere in the grid is ~3.9 nm (0.1° of longitude at
 * 49°N). So a path point can never be more than one coarse cell away
 * from a sampled cell — which is exactly the radius the one-cell
 * dilation covers. That is what makes the returned value a true upper
 * bound rather than a sampling estimate.
 */
const COARSE_SAMPLE_NM = 3;

/**
 * Distance between exact great-circle anchor points when walking the
 * coarse overlay. Between anchors the path is interpolated linearly in
 * lat/lon, which is far cheaper; see `maxTerrainAlongFt` for why 100 nm
 * keeps the linearisation error inside the dilation radius.
 */
const CHUNK_NM = 100;

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
export class TerrainGridDEMSampler implements DEMSampler, TerrainBoundSampler {
  private grid: Grid | null = null;
  private coarse: CoarseGrid | null = null;
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

  /**
   * Conservative upper bound on the highest terrain MSL along the great
   * circle from `a` to `b` — the returned value is never below the true
   * peak, so "bound + buffer fits under the ceiling" is a sound
   * clearance proof without any fine-grid work.
   *
   * Returns null when the grid isn't loaded or any part of the path
   * lies outside it. Callers gating on terrain must treat null as
   * "unknown", never as "clear": the grid is CONUS-only and ~500 of the
   * airports in the dataset (nearly all of Alaska) sit outside it.
   */
  maxTerrainAlongFt(a: LatLon, b: LatLon): number | null {
    const g = this.grid;
    const c = this.coarse;
    if (!g || !c) return null;
    const h = g.header;

    // Exact great-circle points are expensive — eight transcendentals
    // and an allocation each — so take them only every CHUNK_NM and
    // interpolate linearly in lat/lon between. A chord of length L
    // departs from the true great circle by at most ~L²/8R, which at
    // L = 100 nm is 0.36 nm. Added to the 1.5 nm worst-case gap between
    // samples that leaves 1.86 nm, still inside the ~3.9 nm one-cell
    // dilation radius — so the result stays a genuine upper bound.
    const dist = greatCircleNM(a, b);
    const chunks = Math.max(1, Math.ceil(dist / CHUNK_NM));
    const anchors = interpolateGreatCircle(a, b, chunks);
    const stepsPerChunk = Math.max(
      1,
      Math.ceil(dist / chunks / COARSE_SAMPLE_NM),
    );

    // Geographic extent of the fine grid. Checking lat/lon directly is
    // cheaper than deriving fine indices, and rejects a hair sooner at
    // the very edge — which is the fail-closed direction.
    const latSouth = h.latNorth - h.latCells * h.latStep;
    const lonEast = h.lonWest + h.lonCells * h.lonStep;
    const invLat = 1 / (h.latStep * c.pool);
    const invLon = 1 / (h.lonStep * c.pool);

    let peak = -Infinity;
    for (let s = 0; s < anchors.length - 1; s++) {
      const p = anchors[s];
      const q = anchors[s + 1];
      const dLat = q.lat - p.lat;
      const dLon = q.lon - p.lon;
      // Include the final anchor only on the last chunk, so shared
      // endpoints aren't sampled twice.
      const last = s === anchors.length - 2 ? stepsPerChunk : stepsPerChunk - 1;
      for (let k = 0; k <= last; k++) {
        const f = k / stepsPerChunk;
        const lat = p.lat + dLat * f;
        const lon = p.lon + dLon * f;
        if (lat > h.latNorth || lat < latSouth || lon < h.lonWest || lon > lonEast) {
          return null;
        }
        let ci = Math.floor((h.latNorth - lat) * invLat);
        let cj = Math.floor((lon - h.lonWest) * invLon);
        if (ci < 0) ci = 0;
        else if (ci >= c.latCells) ci = c.latCells - 1;
        if (cj < 0) cj = 0;
        else if (cj >= c.lonCells) cj = c.lonCells - 1;
        const v = c.dilated[ci * c.lonCells + cj];
        if (v > peak) peak = v;
      }
    }
    return peak === -Infinity ? null : peak;
  }

  private async fetchAndDecode(): Promise<void> {
    const resp = await fetch(this.url);
    if (!resp.ok) {
      throw new Error(`DEM grid fetch failed: ${resp.status} ${resp.statusText}`);
    }
    const body = await resp.arrayBuffer();
    const grid = decode(await maybeGunzip(body));
    // Build the overlay before publishing `grid`, so `ready()` never
    // reports true while `maxTerrainAlongFt` would still return null.
    this.coarse = buildCoarse(grid);
    this.grid = grid;
  }
}

/**
 * Max-pools the fine grid `POOL`× in each axis, then dilates by one
 * cell so a single lookup already answers "the highest ground in this
 * cell or any cell touching it".
 *
 * No-data cells (ocean, and anything the source DEM left unfilled) pool
 * as 0 rather than propagating the sentinel. That matches how the fine
 * sampler is consumed — `legMinSafeCruiseAltFt` skips null samples
 * entirely — so a leg over water is bounded by its field elevations,
 * not by a spurious −32768.
 */
function buildCoarse(grid: Grid): CoarseGrid {
  const { latCells, lonCells } = grid.header;
  const cLat = Math.ceil(latCells / POOL);
  const cLon = Math.ceil(lonCells / POOL);
  const pooled = new Int16Array(cLat * cLon);

  for (let i = 0; i < latCells; i++) {
    const ci = Math.floor(i / POOL) * cLon;
    const rowBase = i * lonCells;
    for (let j = 0; j < lonCells; j++) {
      const v = grid.data[rowBase + j];
      if (v === NO_DATA) continue;
      const k = ci + Math.floor(j / POOL);
      if (v > pooled[k]) pooled[k] = v;
    }
  }

  const dilated = new Int16Array(cLat * cLon);
  for (let i = 0; i < cLat; i++) {
    const iLo = Math.max(0, i - 1);
    const iHi = Math.min(cLat - 1, i + 1);
    for (let j = 0; j < cLon; j++) {
      const jLo = Math.max(0, j - 1);
      const jHi = Math.min(cLon - 1, j + 1);
      let m = pooled[i * cLon + j];
      for (let ii = iLo; ii <= iHi; ii++) {
        for (let jj = jLo; jj <= jHi; jj++) {
          const v = pooled[ii * cLon + jj];
          if (v > m) m = v;
        }
      }
      dilated[i * cLon + j] = m;
    }
  }

  return { latCells: cLat, lonCells: cLon, pool: POOL, dilated };
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
