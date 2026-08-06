import { describe, expect, it } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { buildGraph } from "./routing";
import { planWithWaypoints } from "./plan";
import { greatCircleNM } from "./geo";
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

  it("leaves unshaped graphs byte-for-byte unchanged", () => {
    const a = buildGraph(base).neighbors("A");
    const b = buildGraph({ ...base, shapePoints: [] }).neighbors("A");
    expect(b).toEqual(a);
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
