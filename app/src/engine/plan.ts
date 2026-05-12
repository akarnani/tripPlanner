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
  costFnId: string;
  costFnParams?: Record<string, number>;
  K?: number;
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

export function plan(input: PlanInput): PlannedRoute[] {
  const {
    airports,
    origin,
    destination,
    aircraft,
    targetAltFt,
    flightRule,
    reserveHr,
    costFnId,
    costFnParams,
    K = 3,
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
  });
  const def = costFnById(costFnId);
  if (!def) throw new Error(`unknown cost function: ${costFnId}`);
  const costFn = def.build(costFnParams ?? {});
  const paths = kShortestPaths(graph, costFn, K);
  return paths.map((p) => toRoute(p, graph.byId, costFnId));
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
