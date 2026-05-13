import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { greatCircleNM, type LatLon } from "./geo";
import { cruiseAt } from "./performance";
import {
  hemisphericAltitude,
  initialTrueCourseDeg,
  magneticCourseDeg,
  type FlightRule,
} from "./hemispheric";

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
  } = input;
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
      // Usable range at this leg's altitude after the requested reserve.
      const reserve_gal = reserveHr * c.fuel_gph;
      const burnable_gal = Math.max(
        aircraft.fuel.usable_capacity_gal - reserve_gal,
        0,
      );
      const range_nm = (burnable_gal / c.fuel_gph) * c.tas_kt;
      if (distance_nm > range_nm) continue;
      const time_hr = distance_nm / c.tas_kt;
      if (maxLegHr !== undefined && time_hr > maxLegHr) continue;
      edges.push({
        from: from.id,
        to: to.id,
        distance_nm,
        time_hr,
        fuel_gal: time_hr * c.fuel_gph,
        true_course_deg,
        magnetic_course_deg,
        variation_deg,
        cruise_alt_ft,
        tas_kt: c.tas_kt,
        fuel_gph: c.fuel_gph,
      });
    }
    cache.set(fromId, edges);
    return edges;
  }

  return { byId, origin, destination, neighbors };
}

export type CostFn = (edge: Edge) => number;

interface DijkstraOptions {
  bannedEdges?: Set<string>; // "from→to" keys
  bannedNodes?: Set<string>;
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

/**
 * Yen's K-shortest-paths. Returns up to K distinct loop-free paths from
 * the origin to the destination, sorted by ascending cost.
 */
export function kShortestPaths(graph: Graph, cost: CostFn, K: number): Path[] {
  const first = dijkstra(graph, graph.origin, graph.destination, cost);
  if (!first) return [];
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
  }
  return A;
}
