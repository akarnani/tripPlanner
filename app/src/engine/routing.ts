import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { greatCircleNM, type LatLon } from "./geo";
import { climbFromTo, cruiseAt } from "./performance";
import {
  hemisphericAltitude,
  initialTrueCourseDeg,
  magneticCourseDeg,
  type FlightRule,
} from "./hemispheric";
import type { DEMSampler } from "./terrain";
import { computeTerrainPenalty } from "./terrainPenalty";

/** East-positive magnetic variation in degrees at a point, or null if
 *  unavailable. v1 routes that fall outside the WMM grid silently use
 *  true course (variation = 0). */
export type VariationFn = (point: LatLon) => number | null;

export interface Edge {
  from: string; // airport id
  to: string;
  distance_nm: number;
  time_hr: number;
  fuel_gal: number;
  /** Initial true course on the great-circle path, degrees [0, 360). */
  true_course_deg: number;
  /** Magnetic course used by the hemispheric rule; equals true course
   *  when no variation data is available. */
  magnetic_course_deg: number;
  /** East-positive magnetic variation at the leg origin; null if the
   *  WMM grid didn't cover the point. */
  variation_deg: number | null;
  /** Hemispheric-valid cruise altitude actually flown on this leg. */
  cruise_alt_ft: number;
  /** TAS and burn used to compute time/fuel, at `cruise_alt_ft`. */
  tas_kt: number;
  fuel_gph: number;
  // Future numeric attributes (fuel_cost_$, weather penalty, etc.) attach
  // here without changing the routing engine.
  extra?: Record<string, number>;
}

export interface Path {
  nodes: string[]; // airport ids, origin first, destination last
  edges: Edge[];
  cost: number;
}

export interface BuildGraphInput {
  airports: readonly Airport[];
  origin: string;
  destination: string;
  aircraft: Aircraft;
  /** Pilot's chosen target altitude. Each leg flies the lowest legal
   *  hemispheric altitude at or above this for its own course. */
  targetAltFt: number;
  flightRule: FlightRule;
  reserveHr: number;
  /** Optional magnetic-variation provider. When omitted or returning
   *  null at the leg origin, true course is used in place of magnetic
   *  course for the hemispheric rule. */
  variation?: VariationFn;
  /** Optional hard cap on a single leg's flight time in hours. Edges
   *  exceeding this are dropped from the graph before any objective
   *  sees them, so every returned route respects the cap. */
  maxLegHr?: number;
  /** Fuel actually onboard at departure from `origin`, in gallons.
   *  Capped to the aircraft's usable capacity. Defaults to capacity
   *  (i.e. full tanks). Intermediate fuel stops imply a top-off, so
   *  this only affects edges leaving `origin`. */
  startingFuelGal?: number;
  /** Airports the user has explicitly excluded from being a stop.
   *  Edges entering one of these are dropped from the graph; origin
   *  and destination are exempt (the router never refuses to leave
   *  origin or arrive at destination even if the caller mistakenly
   *  includes them). */
  excludedAirportIds?: ReadonlySet<string>;
  /** Optional DEM sampler. When provided, each edge is scored for
   *  terrain that blocks a gradual departure climb or a standard
   *  1,000/3 nm arrival descent; the equivalent-time cost lands in
   *  `edge.extra.terrain_penalty_hr` for cost functions to consume. */
  dem?: DEMSampler;
}

export interface Graph {
  byId: Map<string, Airport>;
  origin: string;
  destination: string;
  /** Returns edges starting at `from` to other airports within range. */
  neighbors(from: string): Edge[];
}

/**
 * Builds a lazy graph over the filtered airports. Each potential edge
 * picks its own hemispheric-correct cruise altitude based on its
 * great-circle course and the pilot's flight rule + target altitude,
 * then computes time/fuel/range from the aircraft's perf table at
 * that altitude. So legs that head east may be at, say, 7,500 ft VFR
 * and the return legs at 8,500 ft.
 */
export function buildGraph(input: BuildGraphInput): Graph {
  const {
    airports,
    origin,
    destination,
    aircraft,
    targetAltFt,
    flightRule,
    reserveHr,
    variation,
    maxLegHr,
    startingFuelGal,
    excludedAirportIds,
    dem,
  } = input;
  const capacityGal = aircraft.fuel.usable_capacity_gal;
  const originFuelGal =
    startingFuelGal !== undefined
      ? Math.min(Math.max(startingFuelGal, 0), capacityGal)
      : capacityGal;
  const byId = new Map<string, Airport>();
  for (const a of airports) byId.set(a.id, a);
  if (!byId.has(origin)) throw new Error(`origin ${origin} not in airport set`);
  if (!byId.has(destination))
    throw new Error(`destination ${destination} not in airport set`);

  const cache = new Map<string, Edge[]>();

  function neighbors(fromId: string): Edge[] {
    const cached = cache.get(fromId);
    if (cached) return cached;
    const from = byId.get(fromId);
    if (!from) return [];
    const edges: Edge[] = [];
    const variation_deg = variation?.(from) ?? null;
    for (const to of airports) {
      if (to.id === from.id) continue;
      // Skip user-excluded airports unless they're the destination
      // (origin can never be a `to`, so it doesn't need a check).
      if (
        excludedAirportIds?.has(to.id) &&
        to.id !== destination
      ) {
        continue;
      }
      const distance_nm = greatCircleNM(from, to);
      const true_course_deg = initialTrueCourseDeg(from, to);
      const magnetic_course_deg =
        variation_deg !== null
          ? magneticCourseDeg(true_course_deg, variation_deg)
          : true_course_deg;
      const cruise_alt_ft = hemisphericAltitude(
        targetAltFt,
        magnetic_course_deg,
        flightRule,
      );
      const c = cruiseAt(aircraft, cruise_alt_ft);
      // Decompose the leg into climb + cruise. Climb time/fuel/distance
      // come from the aircraft's POH climb table when available, else
      // from the scalar climb rate + burn fallback. Climb is pro-rated
      // on legs too short to reach cruise altitude.
      const fromElev = from.elevation_ft ?? 0;
      const climb = climbFromTo(aircraft, fromElev, cruise_alt_ft);
      const climb_distance_nm = Math.min(climb.distance_nm, distance_nm);
      const climb_fraction =
        climb.distance_nm > 0 ? climb_distance_nm / climb.distance_nm : 0;
      const climb_time_hr = climb.time_hr * climb_fraction;
      const climb_fuel_gal = climb.fuel_gal * climb_fraction;
      const cruise_distance_nm = Math.max(0, distance_nm - climb_distance_nm);
      const cruise_time_hr = cruise_distance_nm / c.tas_kt;
      const cruise_fuel_gal = cruise_time_hr * c.fuel_gph;
      const time_hr = climb_time_hr + cruise_time_hr;
      const fuel_gal = climb_fuel_gal + cruise_fuel_gal;
      // Usable fuel after reserve. The first leg from origin departs
      // with whatever fuel the pilot loaded (origin-only); subsequent
      // legs assume a top-off to capacity at each fuel stop.
      const reserve_gal = reserveHr * c.fuel_gph;
      const tankGal = fromId === origin ? originFuelGal : capacityGal;
      if (fuel_gal + reserve_gal > tankGal) continue;
      if (maxLegHr !== undefined && time_hr > maxLegHr) continue;
      const extra: Record<string, number> = {};
      if (dem) {
        const penalty = computeTerrainPenalty({
          from,
          to,
          cruise_alt_ft,
          climb_speed_kt:
            climb.time_hr > 0
              ? climb.distance_nm / climb.time_hr
              : climbSpeedKt(aircraft, c.tas_kt),
          climb_rate_fpm: aircraft.climb.rate_fpm,
          dem,
          distance_nm,
          true_course_deg,
        });
        if (penalty.hr > 0) {
          extra.terrain_penalty_hr = penalty.hr;
          extra.terrain_departure_shortfall_ft = penalty.departure_shortfall_ft;
          extra.terrain_arrival_shortfall_ft = penalty.arrival_shortfall_ft;
        }
      }
      edges.push({
        from: from.id,
        to: to.id,
        distance_nm,
        time_hr,
        fuel_gal,
        true_course_deg,
        magnetic_course_deg,
        variation_deg,
        cruise_alt_ft,
        tas_kt: c.tas_kt,
        fuel_gph: c.fuel_gph,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      });
    }
    cache.set(fromId, edges);
    return edges;
  }

  return { byId, origin, destination, neighbors };
}

/** Best-guess climb groundspeed for terrain-clearance gradient math.
 *  Piston singles typically climb at Vy ≈ 0.65 × cruise TAS (e.g. 76 kt
 *  in a C172S that cruises 120). Using cruise TAS here makes the climb
 *  path look much shallower than reality and falsely penalizes
 *  departure terrain the aircraft can actually climb over. */
function climbSpeedKt(_aircraft: Aircraft, cruise_tas_kt: number): number {
  return Math.max(50, cruise_tas_kt * 0.65);
}

export type CostFn = (edge: Edge) => number;

/** Reported at most every ~500 node expansions, plus immediately
 *  whenever a new route is found. */
export type SearchProgress = { expanded: number; found: number };

interface DijkstraOptions {
  bannedEdges?: Set<string>; // "from→to" keys
  bannedNodes?: Set<string>;
  /** Called once per node popped off the frontier (i.e. per node
   *  "expanded"). Callers throttle; this fires unconditionally. */
  onExpand?: () => void;
}

function edgeKey(e: Edge): string {
  return `${e.from}${e.to}`;
}

function dijkstra(
  graph: Graph,
  start: string,
  end: string,
  cost: CostFn,
  opts: DijkstraOptions = {},
): Path | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, { edge: Edge; from: string }>();
  const visited = new Set<string>();
  dist.set(start, 0);

  // Simple O(n^2) selection is fine for a few hundred candidate airports;
  // upgrade to a binary heap if profiling shows it's hot.
  while (true) {
    let u: string | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (visited.has(node)) continue;
      if (d < best) {
        best = d;
        u = node;
      }
    }
    if (u === null) return null;
    if (u === end) break;
    visited.add(u);
    opts.onExpand?.();

    for (const edge of graph.neighbors(u)) {
      if (opts.bannedNodes?.has(edge.to)) continue;
      if (opts.bannedEdges?.has(edgeKey(edge))) continue;
      const w = cost(edge);
      if (!Number.isFinite(w)) continue;
      const alt = best + w;
      const cur = dist.get(edge.to);
      if (cur === undefined || alt < cur) {
        dist.set(edge.to, alt);
        prev.set(edge.to, { edge, from: u });
      }
    }
  }

  if (!dist.has(end)) return null;
  const nodes: string[] = [end];
  const edges: Edge[] = [];
  let cur: string = end;
  while (cur !== start) {
    const step = prev.get(cur);
    if (!step) return null;
    edges.unshift(step.edge);
    cur = step.from;
    nodes.unshift(cur);
  }
  return { nodes, edges, cost: dist.get(end)! };
}

function pathKey(p: Path): string {
  return p.nodes.join("");
}

const PROGRESS_EXPANSION_INTERVAL = 500;

/**
 * Yen's K-shortest-paths. Returns up to K distinct loop-free paths from
 * the origin to the destination, sorted by ascending cost.
 *
 * `onProgress`, when given, is invoked with a running node-expansion
 * count (across every Dijkstra call this search performs, main + spurs)
 * throttled to roughly every 500 expansions, plus immediately whenever
 * a route is added to the result set.
 */
export function kShortestPaths(
  graph: Graph,
  cost: CostFn,
  K: number,
  onProgress?: (p: SearchProgress) => void,
): Path[] {
  let expanded = 0;
  let found = 0;
  let lastReported = 0;
  const onExpand = onProgress
    ? () => {
        expanded++;
        if (expanded - lastReported >= PROGRESS_EXPANSION_INTERVAL) {
          lastReported = expanded;
          onProgress({ expanded, found });
        }
      }
    : undefined;
  const reportFound = () => onProgress?.({ expanded, found });

  const first = dijkstra(graph, graph.origin, graph.destination, cost, {
    onExpand,
  });
  if (!first) return [];
  found++;
  reportFound();
  const A: Path[] = [first];
  const B: Path[] = [];
  const seen = new Set<string>([pathKey(first)]);

  for (let k = 1; k < K; k++) {
    const prev = A[k - 1];
    for (let i = 0; i < prev.nodes.length - 1; i++) {
      const spurNode = prev.nodes[i];
      const rootPath = prev.nodes.slice(0, i + 1);
      const bannedEdges = new Set<string>();
      const bannedNodes = new Set<string>(rootPath.slice(0, -1));

      for (const p of A) {
        if (
          p.nodes.length > i &&
          p.nodes.slice(0, i + 1).every((n, idx) => n === rootPath[idx])
        ) {
          const e = p.edges[i];
          if (e) bannedEdges.add(edgeKey(e));
        }
      }

      const spurPath = dijkstra(graph, spurNode, graph.destination, cost, {
        bannedEdges,
        bannedNodes,
        onExpand,
      });
      if (!spurPath) continue;

      const rootEdges = prev.edges.slice(0, i);
      const rootCost = rootEdges.reduce((s, e) => s + cost(e), 0);
      const candidate: Path = {
        nodes: [...rootPath, ...spurPath.nodes.slice(1)],
        edges: [...rootEdges, ...spurPath.edges],
        cost: rootCost + spurPath.cost,
      };
      const key = pathKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      B.push(candidate);
    }
    if (B.length === 0) break;
    B.sort((a, b) => a.cost - b.cost);
    A.push(B.shift()!);
    found++;
    reportFound();
  }
  return A;
}
