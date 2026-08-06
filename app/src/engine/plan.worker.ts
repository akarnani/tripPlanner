// Module worker: runs `planWithWaypoints` off the main thread so a slow
// search doesn't freeze the UI. No React imports — engine purity holds
// here too (see CLAUDE.md).
//
// This file relies on the DOM lib (already in tsconfig.app.json) rather
// than the `webworker` lib: adding `/// <reference lib="webworker" />`
// alongside an existing `DOM` lib conflicts (both declare globals like
// `self`). `self.postMessage`/`self.onmessage` typecheck fine against
// `Window`'s overloads and behave correctly at runtime inside a worker.
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import type { FlightRule } from "./hemispheric";
import { planWithWaypoints, type PlannedRoute } from "./plan";
import type { NavPoint } from "@/data/loaders";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { MagneticVariationGrid } from "./magneticVariation";
import terrainGridUrl from "@data/terrain_grid.bin.gz?url";
import magneticGridUrl from "@data/magnetic_grid.bin.gz?url";

/** Mirrors `usePlanner`'s `PlanRequest`, minus anything that can't cross
 *  `postMessage` (no aircraft-registry lookups, no DEM sampler, no
 *  variation function — those are resolved/constructed worker-side). */
export interface PlanWorkerParams {
  candidates: Airport[];
  originId: string;
  destinationId: string;
  aircraft: Aircraft;
  targetAltFt: number;
  maxAltFt?: number | null;
  flightRule: FlightRule;
  reserveHr: number;
  maxLegHr?: number;
  startingFuelGal: number;
  excludedAirportIds: string[];
  waypoints: string[];
  /** Positions for any nav point ids in `waypoints`. Passed across the
   *  worker boundary as a plain array (Maps clone fine, but keeping the
   *  message shape flat matches the rest of PlanWorkerParams). */
  navPoints: NavPoint[];
}

export interface PlanWorkerRequest {
  type: "plan";
  id: number;
  params: PlanWorkerParams;
}

export type PlanWorkerResponse =
  | { type: "progress"; id: number; expanded: number; found: number }
  | {
      type: "result";
      id: number;
      routes: PlannedRoute[];
      /** False when the terrain grid wasn't available and the search
       *  ran terrain-blind — the UI surfaces this to the pilot. */
      demUsed: boolean;
    }
  | { type: "error"; id: number; message: string };

// Constructed once per worker instance, mirroring App.tsx's module-level
// singletons. Loads kick off immediately so they're usually already
// warm by the time the first "plan" message arrives.
const demSampler = new TerrainGridDEMSampler(terrainGridUrl);
const magGrid = new MagneticVariationGrid(magneticGridUrl);
const variationFn = (p: { lat: number; lon: number }) => magGrid.variationDeg(p);

// Non-fatal: on failure we plan without DEM / with true-course-only
// variation, exactly like App's graceful degradation (`demReady`) —
// but LOUDLY, and the result message carries `demUsed` so the UI can
// tell the pilot the search ran terrain-blind. A silent failure here
// is dangerous: terrain warnings still render (the main thread has
// its own sampler) while stop selection quietly ignores terrain.
//
// load() does not cache rejections, so calling this per plan request
// (not just once at module init) means one transient fetch failure
// costs at most one terrain-blind plan — the next Replan retries.
function loadGrids(): Promise<unknown> {
  return Promise.all([
    demSampler.load().catch((e) => {
      console.warn(
        "plan worker: terrain grid failed to load — routing without terrain costs:",
        e,
      );
    }),
    magGrid.load().catch((e) => {
      console.warn(
        "plan worker: magnetic grid failed to load — using true courses:",
        e,
      );
    }),
  ]);
}
// Kick the fetches off immediately so they're usually warm before the
// first "plan" message arrives.
loadGrids();

// Post progress at most ~4/second — routing.ts's own throttle (every
// ~500 node expansions) fires at a rate that depends on search speed,
// not wall-clock time, so we still need a time-based cap here.
const PROGRESS_INTERVAL_MS = 250;

// Tracks the newest request id seen so a superseded "plan" message
// (received while still awaiting the grid loads, or in principle any
// stray earlier message) never posts progress/result/error.
let latestId = -1;

self.onmessage = async (event: MessageEvent<PlanWorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "plan") return;
  const { id, params } = msg;
  latestId = id;

  await loadGrids();
  if (id !== latestId) return; // superseded while the grids were loading

  let lastPostedAt = 0;
  try {
    const routes = planWithWaypoints({
      airports: params.candidates,
      origin: params.originId,
      destination: params.destinationId,
      aircraft: params.aircraft,
      targetAltFt: params.targetAltFt,
      maxAltFt: params.maxAltFt ?? null,
      flightRule: params.flightRule,
      reserveHr: params.reserveHr,
      maxLegHr: params.maxLegHr,
      startingFuelGal: params.startingFuelGal,
      excludedAirportIds: new Set(params.excludedAirportIds),
      waypoints: params.waypoints,
      navPointsById: new Map(params.navPoints.map((p) => [p.id, p])),
      dem: demSampler.ready() ? demSampler : undefined,
      variation: variationFn,
      onProgress: (p) => {
        if (id !== latestId) return;
        const now = performance.now();
        if (now - lastPostedAt < PROGRESS_INTERVAL_MS) return;
        lastPostedAt = now;
        const response: PlanWorkerResponse = {
          type: "progress",
          id,
          expanded: p.expanded,
          found: p.found,
        };
        self.postMessage(response);
      },
    });
    if (id !== latestId) return;
    const response: PlanWorkerResponse = {
      type: "result",
      id,
      routes,
      demUsed: demSampler.ready(),
    };
    self.postMessage(response);
  } catch (e) {
    if (id !== latestId) return;
    const response: PlanWorkerResponse = {
      type: "error",
      id,
      message: e instanceof Error ? e.message : String(e),
    };
    self.postMessage(response);
  }
};
