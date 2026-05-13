import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import {
  buildGraph,
  kShortestPaths,
  type Edge,
  type Path,
  type VariationFn,
} from "./routing";
import { costFnById } from "./costFns";
import type { FlightRule } from "./hemispheric";

export interface PlanInput {
  airports: readonly Airport[]; // already filtered
  origin: string; // airport id
  destination: string;
  aircraft: Aircraft;
  /** Pilot's chosen target altitude. Each leg flies the lowest legal
   *  hemispheric altitude at or above this for its own course. */
  targetAltFt: number;
  flightRule: FlightRule;
  reserveHr: number;
  variation?: VariationFn;
  /** Optional hard cap on a single leg's flight time in hours. */
  maxLegHr?: number;
  /** Cost-function ids to compute one route each. Default:
   *  ["fewestStops", "shortestTime"]. Duplicate routes (same node
   *  sequence) are returned once, keyed to the first objective that
   *  produced them. */
  objectives?: string[];
  /** Optional per-objective parameters, keyed by objective id. */
  params?: Record<string, Record<string, number>>;
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

const DEFAULT_OBJECTIVES = ["fewestStops", "shortestTime"];

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
    flightRule,
    reserveHr,
    variation: input.variation,
    maxLegHr: input.maxLegHr,
  });
  // One Dijkstra per objective. We deliberately do *not* return Yen's
  // K-shortest within a single objective: on a sparse airport graph the
  // 2nd/3rd "different" paths almost always backtrack, which is useless
  // as a flight-planning alternative.
  const seen = new Set<string>();
  const out: PlannedRoute[] = [];
  for (const id of objectives) {
    const def = costFnById(id);
    if (!def) continue;
    const costFn = def.build(params?.[id] ?? {});
    const [best] = kShortestPaths(graph, costFn, 1);
    if (!best) continue;
    const key = best.nodes.join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toRoute(best, graph.byId, id));
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
