# Swift data pipelines

Builds `data/airports.json`, `data/runways.json` (and eventually
`approaches.json` and `obstacles.json`) from FAA source distributions
using the RISCfuture SwiftNASR / SwiftCIFP / SwiftDOF libraries.

The libraries require Swift 6.0+ and Apple platforms, so this runs on
`macos-latest` GitHub Actions runners. The Action commits the output
JSON back to `main` so the static site never sees Swift.

## Local run (macOS)

```sh
cd pipelines/swift
swift run pipeline-nasr ./distribution.zip ../../data
```

If the zip doesn't exist yet, the pipeline downloads the current FAA
NASR distribution into it.
