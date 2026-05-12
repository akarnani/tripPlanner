import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import { buildGraph, kShortestPaths } from "./routing";
import type { Edge } from "./routing";

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

// Five airports laid out roughly west-to-east across the US. Distances
// between adjacent stations are ~300 nm; A↔E direct is ~1200 nm.
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
      max_leg_nm: 1500,
      tas_kt: 120,
      fuel_gph: 10,
    });
    const [best] = kShortestPaths(graph, () => 1, 1);
    expect(best.nodes).toEqual(["A", "E"]);
  });

  test("fewestStops chains stops when no direct leg fits", () => {
    const graph = buildGraph({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      max_leg_nm: 400,
      tas_kt: 120,
      fuel_gph: 10,
    });
    const [best] = kShortestPaths(graph, () => 1, 1);
    expect(best.nodes[0]).toBe("A");
    expect(best.nodes[best.nodes.length - 1]).toBe("E");
    expect(best.nodes.length).toBeGreaterThan(2);
    expect(best.nodes.length).toBeLessThanOrEqual(5);
  });

  test("returns up to K distinct alternatives", () => {
    const graph = buildGraph({
      airports: [A, B, C, D, E],
      origin: "A",
      destination: "E",
      max_leg_nm: 700,
      tas_kt: 120,
      fuel_gph: 10,
    });
    const paths = kShortestPaths(graph, () => 1, 3);
    expect(paths.length).toBeGreaterThan(1);
    const keys = paths.map((p) => p.nodes.join(">"));
    expect(new Set(keys).size).toBe(paths.length);
  });

  // Locks in the plan's "fuel data can be added later" promise: a mock
  // cheapestFuel cost function plugs into the router without touching it,
  // and routes via the cheap-fuel airport instead of the expensive one.
  test("mock cheapestFuel cost can be injected at runtime", () => {
    // A→E is 460 nm; max leg is 350 nm. Two parallel one-stop routes
    // exist via B (north) and C (south); B has expensive fuel.
    const origin = mkAirport("O", 40, -120);
    const dest = mkAirport("D", 40, -110);
    const north = mkAirport("N", 41, -115);
    const south = mkAirport("S", 39, -115);
    const graph = buildGraph({
      airports: [origin, dest, north, south],
      origin: "O",
      destination: "D",
      max_leg_nm: 350,
      tas_kt: 120,
      fuel_gph: 10,
    });
    const prices: Record<string, number> = { O: 6, N: 9, S: 5, D: 6 };
    const cheapestFuel = (e: Edge) => e.fuel_gal * (prices[e.to] ?? 6);
    const cheap = kShortestPaths(graph, cheapestFuel, 1)[0];
    expect(cheap.nodes).toContain("S");
    expect(cheap.nodes).not.toContain("N");
  });
});
