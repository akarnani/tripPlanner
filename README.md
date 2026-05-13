# Trip Planner

A trip planner for pilots of small general-aviation aircraft.

Given a start, destination, aircraft, cruise altitude, and fuel reserve, the
app picks intermediate fuel stops along the route. It supports hard filters
for runway length, instrument-approach availability, and tower status, and
samples terrain along the great-circle path to warn when cruise altitude
clears terrain by less than 2,000 ft.

The app is a static site that runs entirely in the browser. Airport, runway,
approach, and obstacle datasets are precomputed by scheduled GitHub Actions
and committed to the repo. The routing engine and map render client-side.

US-only for v1. Weather and live fuel pricing are out of scope.

## Status

Phase 1 (scaffolding) complete: Vite + React + TypeScript + Tailwind +
MapLibre running with a placeholder demo basemap. Subsequent phases add the
NASR airport pipeline, performance schema, routing engine, CIFP/DOF
pipelines, terrain warnings, exports, and the `/poh-extract` Claude Code
skill. See `/root/.claude/plans/i-want-to-make-magical-ocean.md` for the
full plan.

## Develop

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/
npm run lint     # tsc --noEmit
npm test         # vitest
```

## Deploy

Pushing to `main` triggers `.github/workflows/pages-deploy.yml`, which
builds the site and publishes it to GitHub Pages.

## License

See `LICENSE`.
