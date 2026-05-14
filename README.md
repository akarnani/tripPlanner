# Trip Planner

A trip planner for pilots of small general-aviation aircraft.

Given a start, destination, aircraft, cruise altitude, and fuel reserve, the
app picks intermediate fuel stops along the route. It supports hard filters
for runway length, instrument-approach availability, and tower status, and
samples terrain along the great-circle path to warn when cruise altitude
clears terrain by less than 2,000 ft.

The app is a static site that runs entirely in the browser. Airport, runway,
approach, obstacle, terrain, and magnetic-variation datasets are precomputed
by scheduled GitHub Actions and committed to the repo. The routing engine
and map render client-side.

US-only for v1. Weather and live fuel pricing are out of scope.

## Features

- Multi-leg fuel-stop planning with k-shortest-paths over a candidate
  airport graph, returning both "fewest stops" and "shortest time" routes.
- Hard filters: minimum runway length, paved surface, control tower,
  instrument approach availability (precision / LPV / LNAV-VNAV / any RNAV).
- Hemispheric cruise altitude selection per leg, with magnetic variation
  from a precomputed WMM grid.
- Aircraft performance from a YAML schema (`aircraft/<slug>/performance.yaml`)
  driving range and fuel-burn estimates.
- Terrain analysis along the great-circle path against a binary DEM grid,
  flagging legs with less than 2,000 ft of clearance and suggesting a
  minimum safe replan altitude.
- Obstacle proximity check against the FAA Daily Digital Obstacle File.
- Stop exclusion + replan, saved trips in localStorage, GPX / FPL / PDF
  export.

## Develop

```sh
npm install
npm run dev              # http://localhost:5173
npm run build            # → dist/
npm run lint             # tsc --noEmit
npm test                 # vitest unit tests
npm run test:e2e         # playwright (spawns dev server)
```

The Vite project root is the repo root (not `app/`). Source lives under
`app/src/` and is split into framework-free engine modules
(`app/src/engine/`), React UI (`app/src/ui/`), exporters
(`app/src/exports/`), and runtime data loaders (`app/src/data/`).

## Data pipelines

Static datasets in `data/` are produced by jobs that do not run on
ordinary commits:

- `pipelines/swift/` (SwiftNASR / SwiftCIFP / SwiftDOF) runs weekly on
  `macos-latest` via `.github/workflows/data-refresh.yml` and commits
  `airports.json`, `runways.json`, `approaches.json`, and
  `obstacles.json` back to `main`.
- `pipelines/dem_build.py` and `pipelines/magnetic_build.py` produce the
  gzipped binary `terrain_grid.bin.gz` and `magnetic_grid.bin.gz`
  (manual dispatch only).

Aircraft performance YAML is validated on every PR by
`pipelines/validate_perf.mjs`. To add an aircraft, drop a POH PDF at
`aircraft/<slug>/poh.pdf` and invoke the `/poh-extract` Claude Code
skill, or hand-author `performance.yaml` against the schema enforced by
the validator.

## Deploy

Pushing to `main` triggers `.github/workflows/pages-deploy.yml`, which
builds the site and publishes it to GitHub Pages. `vite.config.ts` sets
`base: "./"` so the built bundle works at any path.

## License

See `LICENSE`.
