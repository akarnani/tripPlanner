import { isNavPointId, type Airport, type NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import {
  buildGraph,
  kShortestPaths,
  type Edge,
  type EdgeRejection,
  type Path,
  type VariationFn,
} from "./routing";
import { costFnById } from "./costFns";
import { airportSellsCompatibleFuel } from "./filters";
import { hemisphericAltitude, type FlightRule } from "./hemispheric";
import { maxPublishedCruiseAltFt, usableRange } from "./performance";
import type { DEMSampler } from "./terrain";

export interface PlanInput {
  airports: readonly Airport[]; // already filtered
  origin: string; // airport id
  destination: string;
  aircraft: Aircraft;
  /** Pilot's chosen target altitude. Each leg flies the lowest legal
   *  hemispheric altitude at or above this for its own course. */
  targetAltFt: number;
  /** Optional hard ceiling. Legs round *down* to the highest legal
   *  level under it, and legs with nothing flyable underneath are
   *  dropped from the graph. null / undefined is the no-ceiling
   *  behaviour the app had before. */
  maxAltFt?: number | null;
  flightRule: FlightRule;
  reserveHr: number;
  variation?: VariationFn;
  /** Optional hard cap on a single leg's flight time in hours. */
  maxLegHr?: number;
  /** Fuel onboard at departure from origin, in gallons. Defaults to
   *  the aircraft's usable capacity (full tanks). Only affects the
   *  first leg; refuel stops imply a top-off. */
  startingFuelGal?: number;
  /** Airports the user has excluded from being a stop. */
  excludedAirportIds?: ReadonlySet<string>;
  /** Optional DEM sampler. When provided, candidate stops with terrain
   *  that blocks a gradual climb after takeoff or a standard 1,000/3 nm
   *  descent before landing are softly penalized in shortestTime. */
  dem?: DEMSampler;
  /** Cost-function ids to compute one route each. Default:
   *  ["totalTime"]. Duplicate routes (same node sequence) are returned
   *  once, keyed to the first objective that produced them. */
  objectives?: string[];
  /** Optional per-objective parameters, keyed by objective id. */
  params?: Record<string, Record<string, number>>;
  /** Ordered nav points this origin→destination span must be routed
   *  through. Shapes the ground track without adding stops. */
  shapePoints?: readonly NavPoint[];
  /** Called for each edge the altitude band rejects. A ceiling makes
   *  an empty result an ordinary answer, and an empty result with no
   *  explanation is a dead end — this is what lets the caller say
   *  which leg blocked the route and how high it needed to be. */
  onReject?: (r: EdgeRejection) => void;
  /** Optional progress callback for long searches (e.g. surfaced from
   *  a Web Worker). Invoked with a cumulative node-expansion count —
   *  across every objective (and, via `planWithWaypoints`, every
   *  sub-leg) — throttled to roughly every 500 expansions by the
   *  routing search, plus immediately whenever a route is found. */
  onProgress?: (p: { expanded: number; found: number }) => void;
}

export interface Leg extends Edge {
  fromAirport: Airport;
  toAirport: Airport;
}

export interface PlannedRoute {
  costFnId: string;
  cost: number;
  legs: Leg[];
  totals: {
    distance_nm: number;
    time_hr: number;
    fuel_gal: number;
    stops: number;
  };
}

const DEFAULT_OBJECTIVES = ["totalTime"];

export function plan(input: PlanInput): PlannedRoute[] {
  const {
    airports,
    origin,
    destination,
    aircraft,
    targetAltFt,
    flightRule,
    reserveHr,
    objectives = DEFAULT_OBJECTIVES,
    params,
  } = input;
  const graph = buildGraph({
    airports,
    origin,
    destination,
    aircraft,
    targetAltFt,
    maxAltFt: input.maxAltFt ?? null,
    flightRule,
    reserveHr,
    variation: input.variation,
    maxLegHr: input.maxLegHr,
    startingFuelGal: input.startingFuelGal,
    excludedAirportIds: input.excludedAirportIds,
    dem: input.dem,
    shapePoints: input.shapePoints,
    onReject: input.onReject,
  });
  // Practical full-tank cruise range at the chosen altitude. Used by
  // the built-in cost functions as the normalization constant for the
  // "unused range" penalty that biases the planner toward evenly-spaced
  // fuel stops. Computed once here so every objective sees the same
  // value; callers can still override via `params[id].maxLegNm`.
  const maxLegNm = usableRange({
    aircraft,
    altitude_ft: targetAltFt,
    reserve_hours: reserveHr,
  }).range_nm;

  // One Dijkstra per objective. We deliberately do *not* return Yen's
  // K-shortest within a single objective: on a sparse airport graph the
  // 2nd/3rd "different" paths almost always backtrack, which is useless
  // as a flight-planning alternative.
  // `kShortestPaths` reports expanded/found starting from zero on every
  // call; re-base each objective's numbers onto a running total so a
  // caller watching `onProgress` sees one monotonically increasing
  // series across the whole `plan()` call.
  const relayProgress = makeRelayProgress(input.onProgress);
  const seen = new Set<string>();
  const out: PlannedRoute[] = [];
  for (const id of objectives) {
    const def = costFnById(id);
    if (!def) continue;
    const costFn = def.build({ maxLegNm, ...(params?.[id] ?? {}) });
    const [best] = kShortestPaths(graph, costFn, 1, relayProgress?.onProgress);
    relayProgress?.advance();
    if (!best) continue;
    const key = best.nodes.join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toRoute(best, graph.byId, id));
  }
  return out;
}

/** Wraps a `PlanInput.onProgress` so a sequence of independent search
 *  calls (one per objective in `plan()`, one per sub-leg in
 *  `planWithWaypoints()`) reports a single cumulative counter instead
 *  of resetting to zero at the start of each call. Call `advance()`
 *  once a search call has fully returned to fold its final numbers
 *  into the running base before the next call starts. */
function makeRelayProgress(
  onProgress: ((p: { expanded: number; found: number }) => void) | undefined,
): { onProgress: (p: { expanded: number; found: number }) => void; advance: () => void } | undefined {
  if (!onProgress) return undefined;
  let expandedBase = 0;
  let foundBase = 0;
  let lastExpanded = 0;
  let lastFound = 0;
  return {
    onProgress: (p) => {
      lastExpanded = p.expanded;
      lastFound = p.found;
      onProgress({ expanded: expandedBase + p.expanded, found: foundBase + p.found });
    },
    advance: () => {
      expandedBase += lastExpanded;
      foundBase += lastFound;
      lastExpanded = 0;
      lastFound = 0;
    },
  };
}

export interface PlanWithWaypointsInput extends PlanInput {
  /** Ordered list of ids the route MUST pass through, between origin
   *  and destination. Two kinds are accepted:
   *
   *  - **Airport ids** anchor a leg. A pinned airport is a refuel stop
   *    if it stocks fuel compatible with `aircraft.fuel.type`,
   *    otherwise a pass-through with fuel state carrying forward.
   *  - **Nav point ids** ("nav:SEA", "fix:HAROB") shape the ground
   *    track of whichever airport-anchored span they fall in, without
   *    becoming a stop. The planner still searches that span for fuel
   *    stops, so pinning a fix to dodge terrain doesn't force the leg
   *    to be flown non-stop.
   */
  waypoints: readonly string[];
  /** Positions for any nav point ids appearing in `waypoints`.
   *  Unresolvable ids are ignored rather than failing the plan — a
   *  saved trip referencing a fix that a later AIRAC cycle retired
   *  should still produce a route. */
  navPointsById?: ReadonlyMap<string, NavPoint>;
}

interface WaypointSpan {
  from: string;
  to: string;
  shapePoints: NavPoint[];
}

/**
 * Splits a mixed waypoint list into airport-anchored spans, attaching
 * each nav point to the span it falls inside.
 *
 * `[KSEA, fix:HAROB, KGEG, KBOI]` becomes KSEA→KGEG shaped through
 * HAROB, then KGEG→KBOI unshaped.
 */
export function splitWaypointSpans(
  origin: string,
  waypoints: readonly string[],
  destination: string,
  navPointsById?: ReadonlyMap<string, NavPoint>,
): WaypointSpan[] {
  const spans: WaypointSpan[] = [];
  let anchor = origin;
  let pending: NavPoint[] = [];
  for (const w of waypoints) {
    if (isNavPointId(w)) {
      const p = navPointsById?.get(w);
      if (p) pending.push(p);
      continue;
    }
    spans.push({ from: anchor, to: w, shapePoints: pending });
    anchor = w;
    pending = [];
  }
  spans.push({ from: anchor, to: destination, shapePoints: pending });
  return spans;
}

/** Plans an origin→destination route that must pass through a fixed
 *  ordered sequence of intermediate waypoints. Each consecutive pair
 *  (origin→w1, w1→w2, …, wN→destination) is independently routed via
 *  `plan()`; the per-objective routes are then stitched together so
 *  the caller still sees one PlannedRoute per cost function over the
 *  full trip. */
export function planWithWaypoints(input: PlanWithWaypointsInput): PlannedRoute[] {
  const { waypoints } = input;
  if (waypoints.length === 0) return plan(input);

  const spans = splitWaypointSpans(
    input.origin,
    waypoints,
    input.destination,
    input.navPointsById,
  );
  // A list of nothing but nav points collapses to a single shaped span
  // from origin to destination — no extra legs, which is exactly the
  // difference between a shape point and a stop.
  if (spans.length === 1 && spans[0].shapePoints.length === 0) {
    return plan(input);
  }
  const byId = new Map<string, Airport>(input.airports.map((a) => [a.id, a]));
  const fullTanks = input.aircraft.fuel.usable_capacity_gal;
  let startFuel = Math.min(input.startingFuelGal ?? fullTanks, fullTanks);
  // Same re-basing trick as plan()'s per-objective loop, one level up:
  // each sub-leg's plan() call reports its own expanded/found from
  // zero, so relay them onto one cumulative series for the caller.
  const relayProgress = makeRelayProgress(input.onProgress);

  const subResults: PlannedRoute[][] = [];
  for (let i = 0; i < spans.length; i++) {
    const subRoutes = plan({
      ...input,
      origin: spans[i].from,
      destination: spans[i].to,
      startingFuelGal: startFuel,
      shapePoints: spans[i].shapePoints,
      onProgress: relayProgress?.onProgress,
    });
    relayProgress?.advance();
    if (subRoutes.length === 0) return [];
    subResults.push(subRoutes);

    // Update fuel state for the next sub-leg's starting fuel based on
    // whether this waypoint can actually refuel us. The destination
    // (last leg) doesn't need this calculation.
    if (i < spans.length - 1) {
      const arrival = byId.get(spans[i].to);
      const refuels =
        !!arrival && airportSellsCompatibleFuel(arrival, input.aircraft.fuel.type);
      if (refuels) {
        startFuel = fullTanks;
      } else {
        // Pass-through: arrival fuel = (fuel at start of last leg) − (last leg burn).
        // The last leg starts with full tanks if the sub-route had any
        // internal refuel stops, otherwise with this sub-leg's startFuel.
        const sub = subRoutes[0];
        const last = sub.legs[sub.legs.length - 1];
        const lastStart = sub.legs.length > 1 ? fullTanks : startFuel;
        startFuel = Math.max(0, lastStart - last.fuel_gal);
      }
    }
  }

  return stitchSubRoutes(subResults);
}

/** Builds one PlannedRoute per objective by concatenating the matching
 *  same-objective sub-routes; if a sub-leg lacks a particular
 *  objective (k-shortest dedupe), falls back to its first route. */
function stitchSubRoutes(subs: PlannedRoute[][]): PlannedRoute[] {
  const objectives = subs[0].map((r) => r.costFnId);
  const out: PlannedRoute[] = [];
  const seen = new Set<string>();
  for (const objId of objectives) {
    const picks = subs.map((sub) => sub.find((r) => r.costFnId === objId) ?? sub[0]);
    const legs = picks.flatMap((r) => r.legs);
    const key = [
      legs[0]?.fromAirport.id,
      ...legs.map((l) => l.toAirport.id),
    ].join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    const totals = legs.reduce(
      (acc, l) => ({
        distance_nm: acc.distance_nm + l.distance_nm,
        time_hr: acc.time_hr + l.time_hr,
        fuel_gal: acc.fuel_gal + l.fuel_gal,
        stops: acc.stops,
      }),
      { distance_nm: 0, time_hr: 0, fuel_gal: 0, stops: legs.length - 1 },
    );
    out.push({
      costFnId: objId,
      cost: picks.reduce((s, r) => s + r.cost, 0),
      legs,
      totals,
    });
  }
  return out;
}

function toRoute(
  path: Path,
  byId: Map<string, Airport>,
  costFnId: string,
): PlannedRoute {
  const legs: Leg[] = path.edges.map((e) => ({
    ...e,
    fromAirport: byId.get(e.from)!,
    toAirport: byId.get(e.to)!,
  }));
  const totals = legs.reduce(
    (acc, l) => ({
      distance_nm: acc.distance_nm + l.distance_nm,
      time_hr: acc.time_hr + l.time_hr,
      fuel_gal: acc.fuel_gal + l.fuel_gal,
      stops: acc.stops,
    }),
    { distance_nm: 0, time_hr: 0, fuel_gal: 0, stops: legs.length - 1 },
  );
  return { costFnId, cost: path.cost, legs, totals };
}

/** Why a ceilinged plan came back empty, and what would fix it. */
export interface CeilingDiagnosis {
  /** Lowest ceiling at which a route exists, or null if none does at
   *  any legal level the aircraft can reach. */
  lowestWorkableFt: number | null;
  /** The single leg that blocked the requested ceiling, and the
   *  altitude it needed — the cheap answer, taken from the rejections
   *  the failed search already produced. */
  blocker: EdgeRejection | null;
  /** Ceilings actually tried, for cost transparency in tests. */
  attempts: number;
}

/**
 * Finds the lowest ceiling that admits a route, by binary search over
 * legal cruising levels.
 *
 * Searching *levels* rather than 500 ft steps matters: the answer is
 * shown to a pilot as an altitude to fly, so every candidate has to be
 * one they may legally cruise at. It also collapses the search space —
 * there are a couple of dozen levels between the floor and a piston's
 * service ceiling, so this converges in four or five plans rather than
 * scanning hundreds of feet at a time.
 *
 * Feasibility is monotone in the ceiling — raising it only ever adds
 * edges to the graph, never removes them — which is what makes a binary
 * search valid here rather than merely convenient.
 *
 * Returns the blocking leg from the *requested* ceiling either way, so
 * a failure still explains itself even when no ceiling works.
 */
export function diagnoseCeiling(
  input: PlanWithWaypointsInput,
): CeilingDiagnosis {
  const requested = input.maxAltFt;
  const rejections: EdgeRejection[] = [];
  const runAt = (maxAltFt: number | null, collect = false) =>
    planWithWaypoints({
      ...input,
      maxAltFt,
      onProgress: undefined,
      onReject: collect ? (r) => rejections.push(r) : undefined,
    }).length > 0;

  // Re-run the requested ceiling once to capture why it failed. The
  // caller has already had the empty result; this is about the reason.
  runAt(requested ?? null, true);
  const blocker = pickBlocker(rejections);

  if (requested == null) return { lowestWorkableFt: null, blocker, attempts: 1 };

  const levels = legalLevelsAbove(
    requested,
    maxPublishedCruiseAltFt(input.aircraft),
    input.flightRule,
  );
  let attempts = 1;
  if (levels.length === 0 || !runAt(levels[levels.length - 1])) {
    // Even the aircraft's published ceiling doesn't help: no amount of
    // altitude fixes this route.
    return { lowestWorkableFt: null, blocker, attempts: attempts + 1 };
  }
  attempts++;

  let lo = 0;
  let hi = levels.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    attempts++;
    if (runAt(levels[mid])) hi = mid;
    else lo = mid + 1;
  }
  return { lowestWorkableFt: levels[lo], blocker, attempts };
}

/** The rejection worth reporting: the one demanding the most altitude,
 *  since clearing it is the binding constraint. */
function pickBlocker(rejections: readonly EdgeRejection[]): EdgeRejection | null {
  let best: EdgeRejection | null = null;
  for (const r of rejections) {
    if (r.requiredAltFt === undefined) continue;
    if (!best || r.requiredAltFt > best.requiredAltFt!) best = r;
  }
  return best ?? rejections[0] ?? null;
}

/** Legal cruising levels strictly above `aboveFt`, up to `ceilingFt`,
 *  ascending. Both course parities are included: a multi-leg route can
 *  need either, and the search only has to bracket the answer. */
function legalLevelsAbove(
  aboveFt: number,
  ceilingFt: number,
  rule: FlightRule,
): number[] {
  const out: number[] = [];
  for (const course of [90, 270]) {
    for (let k = 0; k < 30; k++) {
      const alt = hemisphericAltitude(aboveFt + 1 + k * 1000, course, rule);
      if (alt > ceilingFt) break;
      if (alt > aboveFt && !out.includes(alt)) out.push(alt);
    }
  }
  return out.sort((a, b) => a - b);
}
