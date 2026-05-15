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
import { airportSellsCompatibleFuel } from "./filters";
import type { FlightRule } from "./hemispheric";
import type { DEMSampler } from "./terrain";

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
    startingFuelGal: input.startingFuelGal,
    excludedAirportIds: input.excludedAirportIds,
    dem: input.dem,
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

export interface PlanWithWaypointsInput extends PlanInput {
  /** Ordered list of airport ids the route MUST pass through, between
   *  origin and destination. Each pinned waypoint is a refuel stop if
   *  it stocks fuel compatible with `aircraft.fuel.type`, otherwise
   *  it's a pass-through and fuel state carries through to the next
   *  sub-leg. */
  waypoints: readonly string[];
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

  const sequence = [input.origin, ...waypoints, input.destination];
  const byId = new Map<string, Airport>(input.airports.map((a) => [a.id, a]));
  const fullTanks = input.aircraft.fuel.usable_capacity_gal;
  let startFuel = Math.min(input.startingFuelGal ?? fullTanks, fullTanks);

  const subResults: PlannedRoute[][] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const subRoutes = plan({
      ...input,
      origin: sequence[i],
      destination: sequence[i + 1],
      startingFuelGal: startFuel,
    });
    if (subRoutes.length === 0) return [];
    subResults.push(subRoutes);

    // Update fuel state for the next sub-leg's starting fuel based on
    // whether this waypoint can actually refuel us. The destination
    // (last leg) doesn't need this calculation.
    if (i < sequence.length - 2) {
      const arrival = byId.get(sequence[i + 1]);
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
