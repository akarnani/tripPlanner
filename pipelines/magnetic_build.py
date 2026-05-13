"""Build a CONUS magnetic-variation grid from the World Magnetic Model.

Output: ``data/magnetic_grid.bin.gz`` — a gzipped binary grid of
float32 magnetic declination (degrees, positive = east) on a regular
1°×1° lat/lon mesh covering the contiguous US. The browser-side
``MagneticGrid`` decodes it and bilinearly interpolates variation to
convert true course → magnetic course for the hemispheric cruise-
altitude rule.

Source: NOAA WMM via ``pygeomag``. Refresh annually or whenever the
WMM coefficients update (the model is good for ~5 years per release).

File format (little-endian, same shape as terrain_grid.bin.gz):

    offset  size  type   meaning
       0     4    char   magic "MAG1"
       4     4    u32    lat_cells (rows; north-to-south)
       8     4    u32    lon_cells (columns; west-to-east)
      12     8    f64    lat_north_deg
      20     8    f64    lon_west_deg
      28     8    f64    lat_step_deg (positive)
      36     8    f64    lon_step_deg (positive)
      44   N×M×4  f32    magnetic declination, deg east

Usage::

    python pipelines/magnetic_build.py data
"""

import argparse
import datetime as dt
import gzip
import struct
import sys
from pathlib import Path
from typing import Iterable

import numpy as np
from pygeomag import GeoMag

CONUS_LAT_SOUTH = 24.0
CONUS_LAT_NORTH = 50.0
CONUS_LON_WEST = -125.0
CONUS_LON_EAST = -66.0
GRID_STEP_DEG = 1.0


def fractional_year(today: dt.date) -> float:
    start = dt.date(today.year, 1, 1)
    end = dt.date(today.year + 1, 1, 1)
    return today.year + (today - start).days / (end - start).days


def build_grid(year: float) -> tuple[np.ndarray, dict]:
    lat_cells = int(round((CONUS_LAT_NORTH - CONUS_LAT_SOUTH) / GRID_STEP_DEG)) + 1
    lon_cells = int(round((CONUS_LON_EAST - CONUS_LON_WEST) / GRID_STEP_DEG)) + 1

    gm = GeoMag()
    grid = np.zeros((lat_cells, lon_cells), dtype=np.float32)
    for i in range(lat_cells):
        lat = CONUS_LAT_NORTH - i * GRID_STEP_DEG
        for j in range(lon_cells):
            lon = CONUS_LON_WEST + j * GRID_STEP_DEG
            result = gm.calculate(glat=lat, glon=lon, alt=0, time=year)
            grid[i, j] = result.d

    header = {
        "lat_cells": lat_cells,
        "lon_cells": lon_cells,
        "lat_north_deg": CONUS_LAT_NORTH,
        "lon_west_deg": CONUS_LON_WEST,
        "lat_step_deg": GRID_STEP_DEG,
        "lon_step_deg": GRID_STEP_DEG,
    }
    return grid, header


def pack(grid: np.ndarray, header: dict) -> bytes:
    buf = bytearray()
    buf += b"MAG1"
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
    buf += grid.astype("<f4").tobytes(order="C")
    return bytes(buf)


def main(argv: Iterable[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_dir", type=Path, help="output directory (e.g. data)")
    parser.add_argument(
        "--year",
        type=float,
        default=None,
        help="decimal year for WMM evaluation (default: today)",
    )
    args = parser.parse_args(list(argv))
    args.out_dir.mkdir(parents=True, exist_ok=True)

    year = args.year if args.year is not None else fractional_year(dt.date.today())
    grid, header = build_grid(year)
    packed = pack(grid, header)
    out_path = args.out_dir / "magnetic_grid.bin.gz"
    with gzip.open(out_path, "wb", compresslevel=9) as fh:
        fh.write(packed)

    raw_kb = len(packed) / 1024
    gz_kb = out_path.stat().st_size / 1024
    print(
        f"wrote {out_path} ({raw_kb:.1f} KB raw, {gz_kb:.1f} KB gzipped, "
        f"{header['lat_cells']}×{header['lon_cells']} cells, year={year:.2f}, "
        f"range={grid.min():.1f}° to {grid.max():.1f}°)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
