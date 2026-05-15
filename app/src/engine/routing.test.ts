import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { buildGraph, kShortestPaths, type Edge } from "./routing";
import type { DEMSampler } from "./terrain";
import { greatCircleNM, pointAtFraction } from "./geo";

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
    fuels: [],
  };
}

// Aircraft with a flat enough perf table that range doesn't change much
// between hemispheric altitudes (so the graph topology in tests doesn't
// depend on the altitude rounding).
function mkAircraft(rangeKt: number, gph: number, capacity_gal: number): Aircraft {
  return {
    slug: "test",
    make: "T",
    model: "T",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: capacity_gal },
    cruise: [
      { altitude_ft: 0, power_pct: 75, tas_kt: rangeKt, fuel_gph: gph },
      { altitude_ft: 18000, power_pct: 75, tas_kt: rangeKt, fuel_gph: gph },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
  };
}

// Five airports laid out roughly west-to-east across the US.
const A = mkAirport("A", 40, -120);
const B = mkAirport("B", 40, -115);
const C = mkAirport("C", 40, -110);
const D = mkAirport("D", 40, -105);
const E = mkAirport("E", 40, -100);

describe("buildGraph + kShortestPaths", () => {
  test("fewestStops picks the direct leg when range allows", () => {
    const graph = buildGraph({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      aircraft: mkAircraft(120, 10, 150), // ~1500 nm range
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    const [best] = kShortestPaths(graph, () => 1, 1);
    expect(best.nodes).toEqual(["A", "E"]);
  });

  test("fewestStops chains stops when no direct leg fits", () => {
    const graph = buildGraph({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      aircraft: mkAircraft(120, 10, 40), // ~400 nm range
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    const [best] = kShortestPaths(graph, () => 1, 1);
    expect(best.nodes[0]).toBe("A");
    expect(best.nodes[best.nodes.length - 1]).toBe("E");
    expect(best.nodes.length).toBeGreaterThan(2);
    expect(best.nodes.length).toBeLessThanOrEqual(5);
  });

  test("each edge carries hemispheric-correct cruise altitude", () => {
    // A→E eastbound great-circle course → VFR target 6500 stays at 6500
    const graph = buildGraph({
      airports: [A, E],
      origin: "A",
      destination: "E",
      aircraft: mkAircraft(120, 10, 200),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    const [path] = kShortestPaths(graph, () => 1, 1);
    expect(path.edges[0].cruise_alt_ft).toBe(7500);
    // No variation provider — magnetic course equals true course.
    expect(path.edges[0].variation_deg).toBeNull();
    expect(path.edges[0].magnetic_course_deg).toBe(
      path.edges[0].true_course_deg,
    );
    // Great-circle initial true course bends slightly north of due east
    // (~83°) at mid-latitudes; just confirm we're in the east half.
    expect(path.edges[0].true_course_deg).toBeGreaterThanOrEqual(0);
    expect(path.edges[0].true_course_deg).toBeLessThan(180);
  });

  test("variation provider flips altitude when course straddles N/S", () => {
    // A great-circle course of true 005° with 15°E variation gives
    // magnetic 350°, flipping the leg from eastbound (odd thousands)
    // to westbound (even thousands). This is the exact case the
    // magnetic-course refactor was meant to handle.
    const south = mkAirport("S", 35, -120);
    const north = mkAirport("N", 45, -119.13); // ~true 005° great-circle
    const noVar = buildGraph({
      airports: [south, north],
      origin: "S",
      destination: "N",
      aircraft: mkAircraft(120, 10, 200),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    const withVar = buildGraph({
      airports: [south, north],
      origin: "S",
      destination: "N",
      aircraft: mkAircraft(120, 10, 200),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      variation: () => 15,
    });
    const [noVarPath] = kShortestPaths(noVar, () => 1, 1);
    const [withVarPath] = kShortestPaths(withVar, () => 1, 1);
    expect(noVarPath.edges[0].cruise_alt_ft).toBe(7500); // east VFR
    expect(withVarPath.edges[0].cruise_alt_ft).toBe(6500); // west VFR
    expect(withVarPath.edges[0].variation_deg).toBe(15);
    expect(withVarPath.edges[0].magnetic_course_deg).toBeLessThan(360);
    expect(withVarPath.edges[0].magnetic_course_deg).toBeGreaterThan(180);
  });

  test("westbound legs round to even+500 for VFR", () => {
    const graph = buildGraph({
      airports: [A, E],
      origin: "E",
      destination: "A",
      aircraft: mkAircraft(120, 10, 200),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    const [path] = kShortestPaths(graph, () => 1, 1);
    // Course is roughly westbound (~276°); target 6500 → next legal
    // westbound VFR altitude 6500.
    expect(path.edges[0].cruise_alt_ft).toBe(6500);
    expect(path.edges[0].true_course_deg).toBeGreaterThanOrEqual(180);
    expect(path.edges[0].true_course_deg).toBeLessThan(360);
  });

  test("DEM sampler routes around a stop with high terrain on approach", () => {
    // Two candidate intermediate stops at ~equal distance from origin
    // and destination. A 6,000 ft mountain sits 10 nm before NORTH on
    // the approach corridor; SOUTH is in flat terrain. With no DEM the
    // router is indifferent (picks whichever wins on greatCircle ties);
    // with the DEM the terrain penalty on edges into NORTH should push
    // shortestTime onto the SOUTH path.
    const origin = mkAirport("O", 40, -120);
    const dest = mkAirport("D", 40, -110);
    const north = mkAirport("N", 41, -115);
    const south = mkAirport("S", 39, -115);
    // Force the planner to stop somewhere — direct must exceed range.
    const aircraft = mkAircraft(120, 10, 35); // ~350 nm range
    const peak = pointAtFraction(
      north,
      origin,
      10 / greatCircleNM(north, origin),
    );
    const dem: DEMSampler = {
      elevationFt: (p) => (greatCircleNM(peak, p) <= 1 ? 6000 : 0),
    };
    const graphWith = buildGraph({
      airports: [origin, dest, north, south],
      origin: "O",
      destination: "D",
      aircraft,
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      dem,
    });
    const cost = (e: Edge) => e.time_hr + (e.extra?.terrain_penalty_hr ?? 0);
    const [pickedWith] = kShortestPaths(graphWith, cost, 1);
    expect(pickedWith.nodes).toContain("S");
    expect(pickedWith.nodes).not.toContain("N");
    // Sanity: at least one edge into N must carry a terrain penalty.
    const intoNorth = graphWith
      .neighbors("O")
      .find((e) => e.to === "N");
    expect(intoNorth?.extra?.terrain_penalty_hr ?? 0).toBeGreaterThan(0);
  });

  test("mock cheapestFuel cost can be injected at runtime", () => {
    const origin = mkAirport("O", 40, -120);
    const dest = mkAirport("D", 40, -110);
    const north = mkAirport("N", 41, -115);
    const south = mkAirport("S", 39, -115);
    const graph = buildGraph({
      airports: [origin, dest, north, south],
      origin: "O",
      destination: "D",
      aircraft: mkAircraft(120, 10, 35), // ~350 nm range
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
    });
    const prices: Record<string, number> = { O: 6, N: 9, S: 5, D: 6 };
    const cheapestFuel = (e: Edge) => e.fuel_gal * (prices[e.to] ?? 6);
    const cheap = kShortestPaths(graph, cheapestFuel, 1)[0];
    expect(cheap.nodes).toContain("S");
    expect(cheap.nodes).not.toContain("N");
  });
});
