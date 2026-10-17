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

### Basemap (optional)

The map uses MapTiler's Outdoor v2 style when a key is configured, and
falls back to MapLibre's public demo tiles otherwise — local dev and
the Playwright suite work without credentials. To use MapTiler locally,
create `.env.local` with:

```
VITE_MAPTILER_KEY=your-maptiler-key
```

For deployed builds, set `VITE_MAPTILER_KEY` as a GitHub Actions
repository **variable** (Settings → Secrets and variables → Actions →
Variables); the deploy and preview workflows pass it to `npm run build`.
The value is baked into the published JS bundle, so lock the key to the
site's origins in the MapTiler dashboard — the production domain plus
`*.workers.dev` under your account's workers.dev subdomain (staging and
every PR preview live there).

## Data pipelines

Static datasets in `data/` are produced by jobs that do not run on
ordinary commits:

- `pipelines/swift/` (SwiftNASR / SwiftCIFP / SwiftDOF) runs weekly on
  `macos-latest` via `.github/workflows/data-refresh.yml` and commits
  `airports.json`, `runways.json`, `approaches.json`, and
  `obstacles.json.gz` back to `main`.
- `pipelines/dem_build.py` and `pipelines/magnetic_build.py` produce the
  gzipped binary `terrain_grid.bin.gz` and `magnetic_grid.bin.gz`
  (manual dispatch only).

Aircraft performance YAML is validated on every PR by
`pipelines/validate_perf.mjs`. To add an aircraft, drop a POH PDF at
`aircraft/<slug>/poh.pdf` and invoke the `/poh-extract` Claude Code
skill, or hand-author `performance.yaml` against the schema enforced by
the validator.

## Deploy

The site runs as a Cloudflare Worker with static assets
(`wrangler.jsonc`). The Vite build in `dist/` is served straight from
Cloudflare's asset layer; only `/api/*` requests run the Worker script
in `worker/index.ts` (today just `/api/health`, which reports the
environment and Worker version id).

| Environment | Worker | Deployed by |
| --- | --- | --- |
| Production | `tripplanner` | `deploy.yml`, after manual approval |
| Staging | `tripplanner-staging` | `deploy.yml`, every push to `main` |
| PR preview | preview version of `tripplanner-staging` | `preview.yml`, every same-repo PR |

- **Staging → production.** Each push to `main` (and each successful
  dataset refresh, whose bot commits don't trigger workflows on their
  own) runs lint + unit tests, deploys staging, then waits on the
  `production` GitHub environment. Approve the pending deployment in
  the Actions run to promote that same commit to production.
- **PR previews** are uploaded with `wrangler versions upload
  --preview-alias pr-<n>`, so each PR gets a stable URL
  (`pr-<n>-tripplanner-staging.<subdomain>.workers.dev`) shown as the
  PR's "View deployment" link. Uploading a preview doesn't change what
  staging serves. Previews share staging's bindings.

Run the production build under the Workers runtime locally with
`npm run preview:worker` (builds, then `wrangler dev`).

### One-time setup

1. Cloudflare API token with **Workers Scripts: Edit** (account) — and
   **Workers Routes / Zone: Edit** on the zone once a custom domain is
   attached. Add it as the `CLOUDFLARE_API_TOKEN` repository secret,
   and the account id as `CLOUDFLARE_ACCOUNT_ID`.
2. GitHub environments: create `staging`, `preview`, and `production`;
   on `production`, add yourself under **Required reviewers** and limit
   deployment branches to `main`.
3. `VITE_MAPTILER_KEY` repository variable (see "Basemap" above).
4. After the first production deploy, move the custom domain from the
   old Pages project to the `tripplanner` Worker (Workers → Settings →
   Domains & Routes), then disconnect the Pages project's git
   integration so it stops building.

`vite.config.ts` sets `base: "./"` so the built bundle works at any
path, which keeps preview subdomains and any custom domain happy
without per-environment build tweaks.

## License

See `LICENSE`.
