# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static-site trip planner for pilots of small GA aircraft. Given origin, destination, aircraft, cruise altitude, and fuel reserve, the routing engine picks intermediate fuel stops, applies hard filters (runway length, approach availability, tower status), and samples terrain along the great-circle path to flag low cruise clearances. Everything runs client-side in the browser; the FAA datasets are precomputed and committed.

## Commands

```sh
npm install
npm run dev              # vite dev server on http://localhost:5173
npm run build            # tsc -b && vite build → dist/
npm run lint             # tsc --noEmit (this repo has no ESLint)
npm test                 # vitest run (unit tests, *.test.ts colocated)
npm run test:watch       # vitest in watch mode
npm run test:e2e         # playwright (tests/e2e/, spawns dev server)

# Run a single test file or pattern
npx vitest run app/src/engine/plan.test.ts
npx vitest run -t "fewest stops"

# Validate aircraft/<slug>/performance.yaml files
node pipelines/validate_perf.mjs
```

The Swift data pipelines (`pipelines/swift/`) require macOS + Swift 6 and are not part of normal app development — GitHub Actions runs them on a schedule and commits the resulting JSON.

## Architecture

The app is one Vite project rooted at the repo root (not under `app/`):

- `vite.config.ts` aliases `@` → `app/src` and `@data` → `data/`. Datasets are imported as `?url` and fetched at runtime so JS startup doesn't block on megabytes of JSON.
- `app/src/data/` — runtime dataset loaders, aircraft registry, saved-trips localStorage helpers.
- `app/src/engine/` — pure TypeScript: filters, great-circle geometry, performance interpolation, hemispheric cruise altitude rules, magnetic variation grid, terrain-grid DEM sampler, obstacle proximity, k-shortest-paths routing, and the top-level `plan()` orchestrator. Most engine modules have colocated `*.test.ts` and are designed to be testable without React.
- `app/src/ui/` — React components (Tailwind). `App.tsx` is the single stateful coordinator: it owns datasets, filters, aircraft selection, current route(s), and the planning spinner; child components are mostly controlled inputs.
- `app/src/exports/` — GPX, FPL, and PDF exporters fed by a planned route.

Key flow: `App.tsx` calls `applyFilters(datasets, filters)` → injects origin/destination back into candidates → calls `plan({...})`, which builds a graph in `routing.ts` and runs k-shortest-paths with cost functions from `costFns.ts`. The returned `PlannedRoute[]` is then passed to `analyzeTerrain()` (which uses `TerrainGridDEMSampler` against the gzipped binary DEM grid) and to the obstacle scanner. The map (`MapView.tsx`) is MapLibre GL with a placeholder demo basemap; airports/routes/stops/state borders are GeoJSON layers managed imperatively.

Performance-sensitive UI detail: `handlePlan` in `App.tsx` uses `flushSync` + double-`requestAnimationFrame` + a `MIN_SPINNER_MS` floor to guarantee the spinner is painted before the synchronous planner blocks the main thread. Preserve this pattern when touching planning entry points.

## Data pipeline

Static datasets live in `data/` and are produced by:

- `pipelines/swift/` — SwiftNASR / SwiftCIFP / SwiftDOF, runs on `macos-latest` via `.github/workflows/data-refresh.yml` (weekly cron + manual dispatch). Outputs `airports.json`, `runways.json`, `approaches.json`, `obstacles.json` and commits back to `main`.
- `pipelines/dem_build.py` and `pipelines/magnetic_build.py` — produce the gzipped binary `terrain_grid.bin.gz` and `magnetic_grid.bin.gz`. Manual dispatch only.

Aircraft performance YAML lives under `aircraft/<slug>/performance.yaml` and is validated in CI by `pipelines/validate_perf.mjs`. The `/poh-extract` Claude Code skill (`.claude/skills/poh-extract/`) generates these files from a POH PDF placed in the aircraft directory.

## Deploy

Pushes to `main` trigger `.github/workflows/pages-deploy.yml`, which builds and publishes to GitHub Pages. `vite.config.ts` sets `base: "./"` so the built site works at any path.

## Conventions

- US-only scope for v1; weather and live fuel pricing are out of scope.
- Engine code is pure and framework-agnostic — keep React imports out of `app/src/engine/` and `app/src/exports/`.
- Tests are colocated next to source as `*.test.ts`; E2E tests are in `tests/e2e/` and run separately.
