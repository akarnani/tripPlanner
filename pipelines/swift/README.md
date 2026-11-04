# Swift data pipelines

Builds `data/airports.json`, `data/runways.json` (and eventually
`approaches.json` and `obstacles.json`) from FAA source distributions
using the RISCfuture SwiftNASR / SwiftCIFP / SwiftDOF libraries.

The libraries require Swift 6.3+. They declare a macOS 26 minimum, but
that only applies on Apple platforms, and they build on Linux too, so
CI runs this on `ubuntu-24.04` in the `swift:6.3-noble` container. The Action commits the output
JSON back to `main` so the static site never sees Swift.

## Local run

On macOS with Xcode 26.4+ (Swift 6.3), run it directly. Anywhere with
Docker, prefix the commands with
`docker run --rm -v "$PWD/../..":/w -w /w/pipelines/swift swift:6.3-noble`.

```sh
cd pipelines/swift
swift run pipeline-nasr ./distribution.zip ../../data
```

The argument may be an unzipped distribution directory, a distribution
zip, or a path that doesn't exist yet — in which case the pipeline
downloads the current FAA NASR cycle into it.

CI passes a directory, because the runway Pavement Classification field
has to be blanked before parsing: SwiftNASR can't read the PCR-era value
the FAA began shipping with the cycle effective 2026-09-03, and it drops
the entire runway record when it fails. See
`.github/scripts/patch_apt_pavement.py`. A zip run skips that step and
loses the affected runways, which is fine for a spot check but not for
the data the app ships.
