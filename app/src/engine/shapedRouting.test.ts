import { describe, expect, it } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { buildGraph, type Graph } from "./routing";
import { planWithWaypoints } from "./plan";
import { greatCircleNM, polylineLengthNM } from "./geo";
import { hemisphericAltitude, initialTrueCourseDeg } from "./hemispheric";
import { navPointId, type NavPoint } from "@/data/loaders";

function mkAirport(id: string, lat: number, lon: number): Airport {
  return {
    id,
    lid: id,
    icao: id,
    name: id,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: 0,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: ["100LL"],
  };
}

function mkAircraft(capacity_gal: number): Aircraft {
  return {
    slug: "test",
    make: "T",
    model: "T",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: capacity_gal },
    cruise: [
      { altitude_ft: 0, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
      { altitude_ft: 18000, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
  };
}

// A due-west line so the hemispheric rule is unambiguous, with a shape
// point pulled well south of it.
const A = mkAirport("A", 45.0, -110.0);
const MID = mkAirport("MID", 45.0, -115.0);
const B = mkAirport("B", 45.0, -120.0);
const mkFix = (ident: string, lat: number, lon: number): NavPoint => ({
  id: navPointId("fix", ident),
  ident,
  kind: "fix",
  lat,
  lon,
});

const SOUTH = mkFix("SOUTH", 42.0, -115.0);

const base = {
  airports: [A, MID, B],
  origin: "A",
  destination: "B",
  aircraft: mkAircraft(400),
  targetAltFt: 8000,
  flightRule: "IFR" as const,
  reserveHr: 0.75,
};

describe("shape points in the routing graph", () => {
  it("bends an edge's ground track and lengthens it", () => {
    const plain = buildGraph(base);
    const shaped = buildGraph({ ...base, shapePoints: [SOUTH] });

    const plainAB = plain.neighbors("A").find((e) => e.to === "B")!;
    const shapedAB = shaped.neighbors("A").find((e) => e.to === "B")!;

    expect(plainAB.via).toBeUndefined();
    expect(shapedAB.via).toEqual([SOUTH]);
    expect(shapedAB.distance_nm).toBeGreaterThan(plainAB.distance_nm);
    // The detour is the polyline length, not the direct distance.
    expect(shapedAB.distance_nm).toBeCloseTo(
      greatCircleNM(A, SOUTH) + greatCircleNM(SOUTH, B),
      3,
    );
  });

  it("assigns a shape point only to the edge that spans it", () => {
    const g = buildGraph({ ...base, shapePoints: [SOUTH] });
    // MID sits at the same longitude as the shape point, so A→MID
    // spans it and MID→B does not.
    const aToMid = g.neighbors("A").find((e) => e.to === "MID")!;
    const midToB = g.neighbors("MID").find((e) => e.to === "B")!;
    expect(aToMid.via).toEqual([SOUTH]);
    expect(midToB.via).toBeUndefined();
  });

  it("takes the highest hemispheric level across a bent leg's segments", () => {
    // A southbound leg cruises even thousands under IFR. Bending it
    // through a point east of the line makes the first segment
    // southeast-bound -- course < 180, so odd thousands. The leg has to
    // fly the higher of the two to stay legal on both.
    const N = mkAirport("N", 45.0, -115.0);
    const S = mkAirport("S", 40.0, -115.0);
    const EAST = mkFix("EAST", 42.5, -110.0);
    const southbound = { ...base, airports: [N, S], origin: "N", destination: "S" };

    const plain = buildGraph(southbound).neighbors("N").find((e) => e.to === "S")!;
    const shaped = buildGraph({ ...southbound, shapePoints: [EAST] })
      .neighbors("N")
      .find((e) => e.to === "S")!;

    expect(plain.cruise_alt_ft).toBe(8000); // southbound IFR: even
    expect(shaped.cruise_alt_ft).toBe(9000); // one segment eastbound: odd

    // 9,000 is legal for the eastbound segment and illegal for the
    // southbound one -- odd and even thousands are disjoint, so a leg
    // bending across the 0/180 boundary has no compliant altitude at
    // all. The higher level is the safe choice for terrain, but the
    // app must say so rather than imply the leg is legal throughout.
    expect(plain.extra?.hemispheric_conflict).toBeUndefined();
    expect(shaped.extra?.hemispheric_conflict).toBe(1);
  });

  it("reports no conflict when a bend stays on one side of the boundary", () => {
    // Bending a westbound leg north-west keeps every segment westbound,
    // so one even level is legal the whole way.
    const NW = mkFix("NW", 47.0, -115.0);
    const shaped = buildGraph({ ...base, shapePoints: [NW] })
      .neighbors("A")
      .find((e) => e.to === "B")!;
    expect(shaped.via).toEqual([NW]);
    expect(shaped.extra?.hemispheric_conflict).toBeUndefined();
  });

  it("treats an empty shapePoints list as no shape points at all", () => {
    // Both sides here are the current implementation, so this pins the
    // two spellings to each other and nothing more. The behaviour an
    // unshaped edge is supposed to have — the pre-shape-points contract
    // — is pinned against first principles in the next test instead.
    const a = buildGraph(base).neighbors("A");
    const b = buildGraph({ ...base, shapePoints: [] }).neighbors("A");
    expect(b).toEqual(a);
  });

  it("leaves an unshaped edge a plain great circle at its own course's level", () => {
    const e = buildGraph(base).neighbors("A").find((x) => x.to === "B")!;
    // Absent, not an empty array: the map, the exporters and the
    // terrain sampler all branch on whether the key is there.
    expect("via" in e).toBe(false);
    expect(e.distance_nm).toBeCloseTo(greatCircleNM(A, B), 9);
    const course = initialTrueCourseDeg(A, B);
    expect(e.true_course_deg).toBeCloseTo(course, 9);
    expect(e.cruise_alt_ft).toBe(
      hemisphericAltitude(base.targetAltFt, course, base.flightRule),
    );
    expect(e.extra?.hemispheric_conflict).toBeUndefined();
  });
});

// Airports strung along the A→B line so their along-track fractions are
// exact and easy to read: f = -(lon + 110) / 10.
const F30 = mkAirport("F30", 45.0, -113.0); // f = 0.3
const F60 = mkAirport("F60", 45.0, -116.0); // f = 0.6
const F10 = mkAirport("F10", 45.0, -111.0); // f = 0.1
const F20 = mkAirport("F20", 45.0, -112.0); // f = 0.2

/** Every loop-free origin→destination path, as node-id lists. */
function simplePaths(graph: Graph, ids: readonly string[]): string[][] {
  const out: string[][] = [];
  const walk = (at: string, seen: string[]) => {
    if (at === graph.destination) {
      out.push(seen);
      return;
    }
    for (const id of ids) {
      if (seen.includes(id)) continue;
      if (!graph.neighbors(at).some((e) => e.to === id)) continue;
      walk(id, [...seen, id]);
    }
  };
  walk(graph.origin, [graph.origin]);
  return out;
}

/** How many legs of a path carry each shape point. */
function claimCounts(graph: Graph, path: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < path.length - 1; i++) {
    const edge = graph.neighbors(path[i]).find((e) => e.to === path[i + 1])!;
    for (const p of edge.via ?? []) {
      counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    }
  }
  return counts;
}

describe("a shape point rides exactly one leg", () => {
  // A→F60→F30→B doubles back: F30 sits behind F60 along the span axis,
  // and SOUTH (f = 0.5) falls in the stretch F60→F30 gives back. Both
  // A→F60 (claiming (0, 0.6]) and F30→B (claiming (0.3, 1]) want it, so
  // the pilot's fix would be flown twice, exported twice and counted
  // twice — the corridor admits candidates like F30 quite legitimately,
  // and nothing about Dijkstra keeps a path's fractions increasing.
  const nonMonotone = {
    ...base,
    airports: [A, F10, F20, F30, F60, B],
    shapePoints: [SOUTH],
  };

  it("refuses the edge that would hand the same point to two legs", () => {
    const g = buildGraph(nonMonotone);
    expect(g.neighbors("A").find((e) => e.to === "F60")!.via).toEqual([SOUTH]);
    expect(g.neighbors("F30").find((e) => e.to === "B")!.via).toEqual([SOUTH]);
    // The leg that un-flies SOUTH after A→F60 already flew it.
    expect(g.neighbors("F60").some((e) => e.to === "F30")).toBe(false);
  });

  it("still allows backtracking that gives back no pinned point", () => {
    // F20→F10 also runs backwards along the span axis, but over
    // (0.1, 0.2], which holds no shape point. A stop just behind
    // another one on a track that bends away is a legitimate fuel stop
    // and must survive — the rule is about double-flying a pin, not
    // about tidy monotone routes.
    const g = buildGraph(nonMonotone);
    expect(g.neighbors("F20").some((e) => e.to === "F10")).toBe(true);
    expect(g.neighbors("F20").find((e) => e.to === "F10")!.via).toBeUndefined();
  });

  it("holds for every route the graph can produce, not just the direct one", () => {
    const g = buildGraph(nonMonotone);
    const ids = nonMonotone.airports.map((a) => a.id);
    const paths = simplePaths(g, ids);
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      const counts = claimCounts(g, path);
      // Claimed at most once…
      for (const [id, n] of counts) {
        expect(n, `${id} flown ${n}× on ${path.join("→")}`).toBe(1);
      }
      // …and never skipped, which is the half the interval always got
      // right and must keep getting right.
      expect(counts.get(SOUTH.id), `SOUTH missing from ${path.join("→")}`).toBe(1);
    }
  });
});

describe("shape points are flown in the order they were pinned", () => {
  // Pinned LATE-then-EARLY: a hairpin out to -117 and back to -113
  // before continuing. Projection order would fly EARLY first, which is
  // a different route from the one in the pilot's waypoint list — and
  // the one the GPX, the map and the corridor filter all show.
  const LATE = mkFix("LATE", 44.0, -117.0); // f = 0.7
  const EARLY = mkFix("EARLY", 46.0, -113.0); // f = 0.3
  const hairpin = { ...base, shapePoints: [LATE, EARLY] };

  it("keeps the pinned order on a single leg", () => {
    const e = buildGraph(hairpin).neighbors("A").find((x) => x.to === "B")!;
    expect(e.via).toEqual([LATE, EARLY]);
    expect(e.distance_nm).toBeCloseTo(polylineLengthNM([A, LATE, EARLY, B]), 9);
  });

  it("keeps the pinned order across a fuel stop in the middle", () => {
    // MID sits at f = 0.5, between the two pins' projections. Assigning
    // by projection alone would give EARLY to A→MID and LATE to MID→B
    // — flying them in the opposite order to the pin, on two different
    // legs, with nothing in the UI to say so.
    const g = buildGraph(hairpin);
    expect(g.neighbors("A").find((e) => e.to === "MID")!.via).toBeUndefined();
    expect(g.neighbors("MID").find((e) => e.to === "B")!.via).toEqual([
      LATE,
      EARLY,
    ]);
  });

  it("leaves pins that already run forward on the legs that span them", () => {
    // The common case, and the one the projection was there to serve:
    // pinned in track order, each pin still rides its own leg.
    const g = buildGraph({ ...base, shapePoints: [EARLY, LATE] });
    expect(g.neighbors("A").find((e) => e.to === "MID")!.via).toEqual([EARLY]);
    expect(g.neighbors("MID").find((e) => e.to === "B")!.via).toEqual([LATE]);
  });
});

describe("planning through shape points", () => {
  const navPointsById = new Map<string, NavPoint>([[SOUTH.id, SOUTH]]);

  it("does not turn a shape point into a stop", () => {
    const routes = planWithWaypoints({
      ...base,
      waypoints: ["fix:SOUTH"],
      navPointsById,
    });
    expect(routes).toHaveLength(1);
    // One leg A→B, shaped -- not two legs A→SOUTH→B.
    expect(routes[0].legs).toHaveLength(1);
    expect(routes[0].totals.stops).toBe(0);
    expect(routes[0].legs[0].via).toEqual([SOUTH]);
  });

  it("still finds a fuel stop inside a shaped span when range demands one", () => {
    // Tank sized so the bent A→B track (~566 nm) is out of range but
    // the bent A→MID half (~463 nm) is reachable: the planner has to
    // insert MID rather than give up or straighten the track.
    const shortRange = { ...base, aircraft: mkAircraft(52) };
    const routes = planWithWaypoints({
      ...shortRange,
      waypoints: ["fix:SOUTH"],
      navPointsById,
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].legs.map((l) => l.toAirport.id)).toEqual(["MID", "B"]);
    // The shape point rides on the leg that spans it, and only that one.
    expect(routes[0].legs[0].via).toEqual([SOUTH]);
    expect(routes[0].legs[1].via).toBeUndefined();
  });

  it("ignores a nav id with no known position", () => {
    const routes = planWithWaypoints({
      ...base,
      waypoints: ["fix:RETIRED"],
      navPointsById,
    });
    expect(routes).toHaveLength(1);
    expect(routes[0].legs[0].via).toBeUndefined();
  });
});
