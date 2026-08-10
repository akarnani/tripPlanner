import type { Airport, NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import {
  alongTrackFraction,
  greatCircleNM,
  polylineLengthNM,
  type LatLon,
} from "./geo";
import { climbFromTo, cruiseAt } from "./performance";
import {
  hemisphericAltitude,
  initialTrueCourseDeg,
  magneticCourseDeg,
  type FlightRule,
} from "./hemispheric";
import type { DEMSampler } from "./terrain";
import { computeTerrainPenalty } from "./terrainPenalty";
import {
  decideLegAltitude,
  type AltitudeBand,
  type LegAltitudeRejection,
} from "./altitudeBand";

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
  /** Cruise altitude flown on this leg.
   *
   *  On an unshaped leg this is the lowest hemispheric-legal level at
   *  or above the target for its course.
   *
   *  On a leg shaped through nav points it is the highest of the levels
   *  its segments individually want. Note what that does *not* mean:
   *  odd and even thousands are disjoint, so when a bent leg crosses
   *  the 0/180 course boundary there is no single altitude that
   *  complies on both sides, and the chosen one is non-compliant on the
   *  segments of opposite parity. Taking the maximum is the
   *  conservative choice for terrain, not a legal one — the conflict is
   *  reported via `extra.hemispheric_conflict` so the pilot decides
   *  rather than the app quietly asserting compliance. */
  cruise_alt_ft: number;
  /** Ordered nav-point positions the leg is routed through. Absent (or
   *  empty) means the leg is a plain great circle. When present, the
   *  leg's ground track is [from, ...via, to] and `distance_nm` is that
   *  polyline's length — every consumer that samples the track (terrain,
   *  obstacles, profile, map) must follow the polyline, not the direct
   *  great circle, or the app will analyse a path it isn't drawing. */
  via?: NavPoint[];
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
  /** Optional ceiling on top of `targetAltFt`. With one set, legs round
   *  *down* to the highest legal level under it and are dropped from the
   *  graph outright when terrain, the POH cruise table, or the
   *  cruising-level rules leave nothing flyable — the same
   *  drop-before-any-objective-sees-it treatment the fuel and
   *  maxLegHr constraints already get. */
  maxAltFt?: number | null;
  flightRule: FlightRule;
  reserveHr: number;
  /** Called for each edge the altitude band rejects. Lets a failed
   *  search explain which leg blocked it rather than returning a bare
   *  empty result. */
  onReject?: (r: EdgeRejection) => void;
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
  /** Nav points the whole origin→destination span must be routed
   *  through, in the order the pilot pinned them — that order is the
   *  order they are flown, even where it doubles back. They shape the
   *  ground track without becoming stops: each is assigned to whichever
   *  edge spans its along-track position, so the planner is still free
   *  to pick fuel stops inside a shaped span. Bending the track this
   *  way is how a pilot steers a leg around terrain the direct great
   *  circle would cross. */
  shapePoints?: readonly NavPoint[];
}

export interface EdgeRejection {
  from: string;
  to: string;
  rejection: LegAltitudeRejection;
  /** Lowest altitude that would have worked, when that is knowable. */
  requiredAltFt?: number;
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
    shapePoints,
    onReject,
  } = input;
  const band: AltitudeBand = {
    minFt: targetAltFt,
    maxFt: input.maxAltFt ?? null,
  };
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

  const originAp = byId.get(origin)!;
  const destAp = byId.get(destination)!;

  // Shape points get a position on the span's own origin→destination
  // axis once, up front. Each edge then claims the ones whose position
  // falls inside its own span, which is what lets the planner insert
  // fuel stops into a shaped leg without the caller having to say which
  // side of the nav point they go.
  //
  // The list is deliberately NOT sorted by that position. `waypoints`
  // is an ordered list: the pilot said fly X then Y, and a Y that
  // projects behind X is a hairpin they asked for, not a mistake to be
  // tidied up. Sorting would quietly fly the other one first — a
  // different track from the pinned one, drawn on the map and written
  // into the GPX under the pilot's own waypoint list. Pinned order
  // wins; the projection is only ever used to decide *which leg*
  // carries a point, never in what order it is flown.
  //
  // What the position does need is monotonicity, so it is the running
  // maximum rather than the raw projection. That keeps the claim
  // intervals below in pinned order: a hairpin's second pin rides the
  // same leg as its first instead of being handed to an earlier leg
  // and flown out of order. Pins that already run forward along the
  // span — the overwhelmingly common case — are unaffected, because
  // for them the running maximum *is* the projection.
  const shaped: Array<{ point: NavPoint; f: number }> = [];
  if (shapePoints && shapePoints.length > 0) {
    let maxSoFar = 0;
    for (const p of shapePoints) {
      // Clamp into (0, 1]. A shape point that projects behind the
      // origin or past the destination still has to be flown, and the
      // half-open test below would otherwise drop it on the floor.
      const raw = alongTrackFraction(originAp, destAp, p);
      const f = Math.min(1, Math.max(Number.EPSILON, raw));
      maxSoFar = Math.max(maxSoFar, f);
      shaped.push({ point: p, f: maxSoFar });
    }
  }

  /**
   * Shape points lying between two airports, in the order the pilot
   * pinned them — or null when the edge must not be offered at all.
   *
   * The interval is half-open — `(fFrom, fTo]` — and that matters more
   * than it looks. For any path the fractions start at 0 (origin) and
   * end at 1 (destination), so for every position x in (0, 1] some
   * consecutive pair straddles it: no route can quietly avoid a pinned
   * point. A closed or open-open test would drop a point that lands
   * abeam a fuel stop, and dropping it lets the optimiser route around
   * the terrain the pilot was steering clear of.
   *
   * The converse — claimed *at most* once — does not come free. Nothing
   * makes a path's fractions increase: the corridor admits candidate
   * stops behind the origin and past the destination, and Dijkstra will
   * happily route A→C→D→B with D behind C. Two legs then overlap, a
   * pinned fix rides both, and it is flown twice, exported twice in the
   * GPX, and counted twice in the totals.
   *
   * So the one edge that can cause it is refused. A duplicate needs
   * some leg to give back ground it had already covered *across* a
   * pinned point (formally: claimed twice ⟹ some consecutive pair has
   * fTo < f ≤ fFrom), which is this edge. Refusing it is not a loss:
   * it is the edge that flies past the pilot's fix and then turns
   * around behind it. Backtracking that clears no pinned point — a
   * stop just behind the origin on a track that bends south, say — is
   * still allowed.
   */
  function viaBetween(from: Airport, to: Airport): NavPoint[] | null {
    if (shaped.length === 0) return [];
    const fFrom = alongTrackFraction(originAp, destAp, from);
    const fTo = alongTrackFraction(originAp, destAp, to);
    if (fTo <= fFrom) {
      return shaped.some((s) => s.f > fTo && s.f <= fFrom) ? null : [];
    }
    return shaped.filter((s) => s.f > fFrom && s.f <= fTo).map((s) => s.point);
  }

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
      const via = viaBetween(from, to);
      // Null means the edge would double-fly a pinned point; it is not
      // an altitude rejection, so there is nothing useful to tell the
      // pilot about it — drop it the way the fuel and maxLegHr caps do.
      if (via === null) continue;
      const track: LatLon[] = via.length > 0 ? [from, ...via, to] : [from, to];
      const distance_nm =
        via.length > 0 ? polylineLengthNM(track) : greatCircleNM(from, to);
      // Course reported for the leg is its initial course, matching the
      // unshaped case.
      //
      // The altitude is the highest level any segment individually
      // wants. On a bent leg that can be a compromise rather than a
      // solution: the eastbound half wants odd thousands and the
      // westbound half even, and those sets never intersect, so no
      // single altitude is legal on both. Flying the higher one is the
      // safe direction for terrain; the disagreement is recorded below
      // so it reaches the pilot instead of being papered over.
      //
      // KNOWN LIMITATION: this rule is not idempotent on a conflicted
      // leg. Feed its own output back as `targetAltFt` and it climbs a
      // level each time (7,000 -> 8,000 -> 9,000 ...), because whichever
      // segment has the other parity always rounds up again. That
      // matters because `replanTargetFt` is what the "Replan at N ft"
      // button sends, so replanning a bent conflicted leg lands 1,000 ft
      // above the label and clicking again climbs again. It is bounded
      // by the aircraft's cruise table and only reachable on a leg that
      // is already flagged `hemispheric_conflict`, but it is wrong.
      // Fixing it means choosing a fixed point -- flying the floor when
      // the floor is already legal for some segment -- which lowers the
      // altitude on exactly the legs with the least parity slack, so it
      // wants its own change with its own terrain testing rather than
      // riding along here.
      const true_course_deg = initialTrueCourseDeg(track[0], track[1]);
      const magnetic_course_deg =
        variation_deg !== null
          ? magneticCourseDeg(true_course_deg, variation_deg)
          : true_course_deg;
      const segmentCourses: number[] = [];
      for (let s = 0; s < track.length - 1; s++) {
        const segTrue = initialTrueCourseDeg(track[s], track[s + 1]);
        segmentCourses.push(
          variation_deg !== null
            ? magneticCourseDeg(segTrue, variation_deg)
            : segTrue,
        );
      }
      // Legs touching origin or destination get a narrow relaxation --
      // only where the airport's own elevation makes the band
      // impossible. Not a blanket exemption: a nonstop route's single
      // leg touches both ends, so exempting terminal legs outright
      // would disable the ceiling for most flights entirely.
      const terminal = fromId === origin || to.id === destination;
      const decision = decideLegAltitude({
        from,
        to,
        segmentCoursesDeg: segmentCourses,
        band,
        flightRule,
        aircraft,
        dem,
        via: via.length > 0 ? via : undefined,
        terminalLeg: terminal,
      });
      if (decision.altFt === null) {
        // Record why, so a failed search can tell the pilot which leg
        // blocked it and how high it would have to go — "no route found"
        // on its own is a dead end when refusing is the normal outcome.
        if (decision.requiredAltFt !== undefined) {
          onReject?.({
            from: fromId,
            to: to.id,
            rejection: decision.rejection!,
            requiredAltFt: decision.requiredAltFt,
          });
        } else {
          onReject?.({ from: fromId, to: to.id, rejection: decision.rejection! });
        }
        continue;
      }
      const cruise_alt_ft = decision.altFt;
      // A segment is non-compliant when the lowest level it accepts at
      // or above the chosen altitude isn't the chosen altitude itself.
      const hemisphericConflict = segmentCourses.some(
        (course) =>
          hemisphericAltitude(cruise_alt_ft, course, flightRule) !==
          cruise_alt_ft,
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
      if (hemisphericConflict) extra.hemispheric_conflict = 1;
      // A terminal leg that had to go above the pilot's ceiling because
      // its own field elevation left no choice. Relaxing the gate there
      // is defensible; doing it silently is not.
      if (decision.exceededCeiling) extra.ceiling_exceeded = 1;
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
          // `distance_nm` and `true_course_deg` are already the shaped
          // track's, so the corridors need `via` too or they'd score a
          // 30 nm climb-out down the direct course at a leg length that
          // only the bent track has.
          via: via.length > 0 ? via : undefined,
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
        ...(via.length > 0 ? { via } : {}),
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
