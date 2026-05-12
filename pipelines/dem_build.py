"""Build a CONUS terrain elevation grid from Mapzen / AWS Open Terrain Tiles.

Output: ``data/terrain_grid.bin.gz`` — a gzipped binary grid of 16-bit
signed integer elevations (feet MSL) on a regular lat/lon mesh covering
the contiguous US. The browser-side ``TerrainGridDEMSampler`` decodes
this directly and uses it to power the per-leg terrain warning engine.

Source: Mapzen / AWS "Terrarium" PNG terrain tiles at
``https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png``.
These are pre-encoded global terrain tiles where each pixel stores
elevation in meters above –32768 in the standard "terrarium" encoding:
    elevation_m = (R * 256 + G + B / 256) - 32768

We download zoom-8 tiles covering CONUS (~1,000 tiles, ~30 MB raw) and
resample them onto a fixed lat/lon grid at 1/120° (~900 m) spacing.

File format
-----------

Little-endian throughout.

    offset  size  type   meaning
       0     4    char   magic "DEM1"
       4     4    u32    lat_cells (rows; north-to-south)
       8     4    u32    lon_cells (columns; west-to-east)
      12     8    f64    lat_north_deg (latitude of row 0)
      20     8    f64    lon_west_deg (longitude of column 0)
      28     8    f64    lat_step_deg (degrees of latitude per row, positive)
      36     8    f64    lon_step_deg (degrees of longitude per column)
      44   N×M×2  i16    elevation in feet MSL, row-major

Usage::

    python pipelines/dem_build.py data
"""

import argparse
import gzip
import math
import struct
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path
from typing import Iterable
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

CONUS_LAT_SOUTH = 24.0
CONUS_LAT_NORTH = 50.0
CONUS_LON_WEST = -125.0
CONUS_LON_EAST = -66.0

# 1/120° ≈ 30 arc-seconds ≈ ~900 m at CONUS latitudes.
GRID_STEP_DEG = 1.0 / 120.0

# Source zoom level. z=8 gives ~600 m pixel resolution at mid-CONUS
# latitudes, slightly finer than the output grid.
SOURCE_ZOOM = 8

TILE_URL = (
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
)
USER_AGENT = "trip-planner-dem-build/1.0"

METERS_PER_FOOT = 0.3048


def deg_to_tile(lat: float, lon: float, zoom: int) -> tuple[float, float]:
    n = 2**zoom
    lat_rad = math.radians(lat)
    x = (lon + 180.0) / 360.0 * n
    y = (
        (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi)
        / 2.0
        * n
    )
    return x, y


def required_tiles(zoom: int) -> list[tuple[int, int]]:
    x_min, y_max = deg_to_tile(CONUS_LAT_SOUTH, CONUS_LON_WEST, zoom)
    x_max, y_min = deg_to_tile(CONUS_LAT_NORTH, CONUS_LON_EAST, zoom)
    xs = range(int(math.floor(x_min)), int(math.ceil(x_max)) + 1)
    ys = range(int(math.floor(y_min)), int(math.ceil(y_max)) + 1)
    return [(x, y) for y in ys for x in xs]


def fetch_tile(x: int, y: int, zoom: int) -> np.ndarray:
    url = TILE_URL.format(z=zoom, x=x, y=y)
    req = Request(url, headers={"User-Agent": USER_AGENT})
    last_err: Exception | None = None
    for attempt in range(6):
        try:
            with urlopen(req, timeout=30) as resp:
                data = resp.read()
            img = Image.open(BytesIO(data)).convert("RGB")
            arr = np.asarray(img, dtype=np.int32)  # (256, 256, 3)
            # Terrarium: elevation_m = (R * 256 + G + B / 256) - 32768
            elev_m = (
                arr[:, :, 0] * 256
                + arr[:, :, 1]
                + arr[:, :, 2] / 256.0
                - 32768.0
            )
            return elev_m.astype(np.float32)
        except Exception as exc:
            last_err = exc
            # Backoff: 0.5, 1, 2, 4, 8, 16 s
            import time

            time.sleep(0.5 * (2**attempt))
    assert last_err is not None
    raise last_err


def build_grid(zoom: int, workers: int) -> tuple[np.ndarray, dict]:
    lat_cells = int(round((CONUS_LAT_NORTH - CONUS_LAT_SOUTH) / GRID_STEP_DEG))
    lon_cells = int(round((CONUS_LON_EAST - CONUS_LON_WEST) / GRID_STEP_DEG))

    # Output grid: row 0 = north, last row = south.
    out = np.full((lat_cells, lon_cells), fill_value=-1, dtype=np.int16)

    # Pre-compute each grid cell's source pixel coordinates in tile space.
    lats = CONUS_LAT_NORTH - np.arange(lat_cells) * GRID_STEP_DEG
    lons = CONUS_LON_WEST + np.arange(lon_cells) * GRID_STEP_DEG
    n = 2**zoom
    lat_rad = np.deg2rad(lats)
    y_pix_per_tile = (
        (1.0 - np.log(np.tan(lat_rad) + 1.0 / np.cos(lat_rad)) / np.pi)
        / 2.0
        * n
    )  # shape (lat_cells,)
    x_pix_per_tile = (lons + 180.0) / 360.0 * n  # shape (lon_cells,)
    # Tile indices + within-tile pixel offsets
    grid_tile_y = np.floor(y_pix_per_tile).astype(np.int32)
    grid_pix_y = np.floor((y_pix_per_tile - grid_tile_y) * 256).astype(np.int32)
    grid_tile_x = np.floor(x_pix_per_tile).astype(np.int32)
    grid_pix_x = np.floor((x_pix_per_tile - grid_tile_x) * 256).astype(np.int32)
    # Clamp to [0, 255]
    np.clip(grid_pix_y, 0, 255, out=grid_pix_y)
    np.clip(grid_pix_x, 0, 255, out=grid_pix_x)

    tiles = required_tiles(zoom)
    print(f"fetching {len(tiles)} z{zoom} tiles…", file=sys.stderr)

    # Group output rows by source tile_y for streaming.
    # For each tile (tx, ty), fetch once, then fill any grid cells whose
    # source pixel falls inside it.
    tile_to_cells: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for i in range(lat_cells):
        ty = int(grid_tile_y[i])
        for j in range(lon_cells):
            tx = int(grid_tile_x[j])
            tile_to_cells.setdefault((tx, ty), []).append((i, j))

    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(fetch_tile, tx, ty, zoom): (tx, ty)
            for (tx, ty) in tile_to_cells.keys()
        }
        for fut in as_completed(futures):
            tx, ty = futures[fut]
            try:
                tile = fut.result()
            except Exception as exc:
                print(f"  tile {tx},{ty} failed: {exc}", file=sys.stderr)
                continue
            for i, j in tile_to_cells[(tx, ty)]:
                py = int(grid_pix_y[i])
                px = int(grid_pix_x[j])
                elev_m = tile[py, px]
                if elev_m <= -1000:  # ocean / no-data sentinel
                    out[i, j] = -32768
                else:
                    out[i, j] = int(round(elev_m / METERS_PER_FOOT))
            completed += 1
            if completed % 50 == 0:
                print(
                    f"  {completed}/{len(tile_to_cells)} tiles done",
                    file=sys.stderr,
                )

    header = {
        "lat_cells": lat_cells,
        "lon_cells": lon_cells,
        "lat_north_deg": CONUS_LAT_NORTH,
        "lon_west_deg": CONUS_LON_WEST,
        "lat_step_deg": GRID_STEP_DEG,
        "lon_step_deg": GRID_STEP_DEG,
    }
    return out, header


def pack(grid: np.ndarray, header: dict) -> bytes:
    buf = bytearray()
    buf += b"DEM1"
    buf += struct.pack(
        "<IIdddd",
        header["lat_cells"],
        header["lon_cells"],
        header["lat_north_deg"],
        header["lon_west_deg"],
        header["lat_step_deg"],
        header["lon_step_deg"],
    )
    assert len(buf) == 44, len(buf)
    buf += grid.astype("<i2").tobytes(order="C")
    return bytes(buf)


def main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", type=Path, help="output directory (e.g. data)")
    parser.add_argument(
        "--workers", type=int, default=8, help="concurrent tile downloads"
    )
    parser.add_argument(
        "--zoom",
        type=int,
        default=SOURCE_ZOOM,
        help="Terrarium tile zoom level to source from",
    )
    args = parser.parse_args(list(argv))
    args.out_dir.mkdir(parents=True, exist_ok=True)

    grid, header = build_grid(args.zoom, args.workers)
    packed = pack(grid, header)
    out_path = args.out_dir / "terrain_grid.bin.gz"
    with gzip.open(out_path, "wb", compresslevel=9) as fh:
        fh.write(packed)

    raw_mb = len(packed) / 1024 / 1024
    gz_mb = out_path.stat().st_size / 1024 / 1024
    print(
        f"wrote {out_path} ({raw_mb:.1f} MB raw, {gz_mb:.1f} MB gzipped, "
        f"{header['lat_cells']}×{header['lon_cells']} cells)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
