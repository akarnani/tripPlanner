"""Build a terrain raster-DEM PMTiles archive from USGS 3DEP source data.

Usage:
    python pipelines/dem_build.py <3dep-source-dir> <out>/terrain.pmtiles

Outline of the pipeline (deferred — runs on the data-refresh workflow
once the GDAL/rio-tiler toolchain is installed there):

1. Mosaic the 3DEP GeoTIFFs covering the contiguous US into a single
   COG using `gdal_merge` / `gdalwarp`.
2. Reproject to Web Mercator (EPSG:3857).
3. Generate raster tiles z6–z12 with Mapbox's terrain-RGB encoding
   (elevation = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)).
4. Pack the resulting tiles into a `.pmtiles` archive using the
   `pmtiles` CLI.

Once the archive is built and committed under `data/terrain.pmtiles`,
the runtime swaps in a `DEMSampler` implementation that reads it
directly in the browser via the `pmtiles` package.

This stub is intentionally a no-op so the rest of the build pipeline
won't break — the JS engine already falls back to the null sampler.
"""

import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: dem_build.py <3dep-source-dir> <out.pmtiles>", file=sys.stderr)
        return 2
    print(
        "dem_build.py is a placeholder — see the docstring for the GDAL "
        "pipeline that needs to be wired up before terrain.pmtiles can be "
        "produced.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
