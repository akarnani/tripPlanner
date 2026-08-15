import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { buildGraph, type EdgeRejection } from "./routing";

// Real airports, real committed DEM. These are the routes the feature
// exists for: a Sierra crossing that a 172 cannot legally fly direct.
const KSJC: Airport = mk("KSJC", 37.3626, -121.929, 62);
const KRNO: Airport = mk("KRNO", 39.4991, -119.768, 4415);
const KMSP: Airport = mk("KMSP", 44.882, -93.222, 841);
const KORD: Airport = mk("KORD", 41.9786, -87.9048, 672);

function mk(id: string, lat: number, lon: number, elev: number): Airport {
  return {
    id,
    lid: id,
    icao: id,
    name: id,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: elev,
    has_control_tower: true,
    public_use: true,
    runway_count: 2,
    max_runway_ft: 9000,
    fuels: ["100LL"],
  };
}

/** A C172S-shaped aircraft: cruise table tops out at 12,000 ft. */
const c172s: Aircraft = {
  slug: "c172s",
  make: "Cessna",
  model: "172S",
  fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 53 },
  cruise: [
    { altitude_ft: 2000, power_pct: 75, tas_kt: 124, fuel_gph: 9.6 },
    { altitude_ft: 8000, power_pct: 65, tas_kt: 117, fuel_gph: 7.6 },
    { altitude_ft: 12000, power_pct: 55, tas_kt: 108, fuel_gph: 6.1 },
  ],
  climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
};

let dem: TerrainGridDEMSampler;

beforeAll(async () => {
  const raw = gunzipSync(
    readFileSync(new URL("../../../data/terrain_grid.bin.gz", import.meta.url)),
  );
  const body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  globalThis.fetch = (async () =>
    new Response(body as ArrayBuffer, { status: 200 })) as typeof fetch;
  dem = new TerrainGridDEMSampler("stub://terrain");
  await dem.load();
}, 60_000);

function graph(
  airports: Airport[],
  origin: string,
  destination: string,
  targetAltFt: number,
  maxAltFt: number | null,
  onReject?: (r: EdgeRejection) => void,
) {
  return buildGraph({
    airports,
    origin,
    destination,
    aircraft: c172s,
    targetAltFt,
    maxAltFt,
    flightRule: "IFR",
    reserveHr: 0.75,
    dem,
    onReject,
  });
}

describe("altitude ceiling against the real CONUS terrain grid", () => {
  // Terminal legs are exempt from the ceiling, so a two-airport graph
  // would never exercise the gate. Give the leg a non-terminal identity
  // by routing origin→KSJC→KRNO→destination through stand-ins.
  const WEST = mk("WEST", 37.0, -122.6, 20);
  const EAST = mk("EAST", 40.2, -119.0, 4000);
  const airports = [WEST, KSJC, KRNO, EAST];

  it("drops the Sierra crossing under a ceiling terrain won't fit beneath", () => {
    // KSJC→KRNO peaks at 10,289 ft, so it needs 12,289 ft with the
    // 2,000 ft buffer -> 13,000 ft eastbound IFR. Under a 12,000 ft
    // ceiling the highest legal eastbound level is 11,000.
    const rejections: EdgeRejection[] = [];
    const g = graph(airports, "WEST", "EAST", 6000, 12000, (r) =>
      rejections.push(r),
    );
    const edge = g.neighbors("KSJC").find((e) => e.to === "KRNO");
    expect(edge).toBeUndefined();

    const why = rejections.find((r) => r.from === "KSJC" && r.to === "KRNO");
    expect(why?.rejection).toBe("terrain");
    // And it says how high it would have to go, which is what makes the
    // failure actionable instead of a dead end.
    expect(why?.requiredAltFt).toBeGreaterThan(12000);
    expect(why?.requiredAltFt).toBeLessThan(13000);
  });

  it("still refuses at 13,000 ft, because a 172 has no numbers up there", () => {
    // The Sierra needs 13,000 ft eastbound. The C172S cruise table stops
    // at 12,000, so raising the ceiling doesn't help -- this aeroplane
    // cannot fly this leg direct at any legal altitude. Exactly the
    // conclusion the POH rule exists to force, instead of silently
    // reusing the 12,000 ft row's numbers at 13,000.
    const rejections: EdgeRejection[] = [];
    const g = graph(airports, "WEST", "EAST", 6000, 13000, (r) =>
      rejections.push(r),
    );
    expect(g.neighbors("KSJC").find((e) => e.to === "KRNO")).toBeUndefined();
    expect(
      rejections.find((r) => r.from === "KSJC" && r.to === "KRNO")?.rejection,
    ).toBe("above-poh-ceiling");
  });

  it("allows it for an aircraft whose POH does reach 13,000 ft", () => {
    const turbo: Aircraft = {
      ...c172s,
      slug: "turbo",
      cruise: [
        ...c172s.cruise,
        { altitude_ft: 16000, power_pct: 75, tas_kt: 186, fuel_gph: 16.4 },
      ],
      fuel: { ...c172s.fuel, usable_capacity_gal: 92 },
    };
    const g = buildGraph({
      airports,
      origin: "WEST",
      destination: "EAST",
      aircraft: turbo,
      targetAltFt: 6000,
      maxAltFt: 13000,
      flightRule: "IFR",
      reserveHr: 0.75,
      dem,
    });
    const edge = g.neighbors("KSJC").find((e) => e.to === "KRNO");
    expect(edge).toBeDefined();
    expect(edge!.cruise_alt_ft).toBe(13000);
  });

  it("keeps the leg when there is no ceiling at all", () => {
    const g = graph(airports, "WEST", "EAST", 6000, null);
    const edge = g.neighbors("KSJC").find((e) => e.to === "KRNO");
    expect(edge).toBeDefined();
    // No ceiling means the pre-existing round-up behaviour.
    expect(edge!.cruise_alt_ft).toBe(7000);
  });

  it("refuses a floor above the aircraft's published cruise table", () => {
    const rejections: EdgeRejection[] = [];
    const g = graph(airports, "WEST", "EAST", 14000, 16000, (r) =>
      rejections.push(r),
    );
    expect(g.neighbors("KSJC")).toHaveLength(0);
    expect(rejections.every((r) => r.rejection === "above-poh-ceiling")).toBe(true);
  });

  it("leaves flat-country legs alone under the same ceiling", () => {
    // The gate must bite only where terrain actually bites.
    const flat = [mk("W2", 45.5, -94.5, 1000), KMSP, KORD, mk("E2", 41.5, -86.5, 700)];
    const g = graph(flat, "W2", "E2", 6000, 8000);
    const edge = g.neighbors("KMSP").find((e) => e.to === "KORD");
    expect(edge).toBeDefined();
    // Eastbound IFR under an 8,000 ft ceiling: 7,000.
    expect(edge!.cruise_alt_ft).toBe(7000);
  });

  it("fails closed on a leg that leaves the DEM's coverage", () => {
    // Anchorage is outside the CONUS grid; clearance is unknowable, and
    // unknowable must not read as clear.
    const AK = mk("PANC", 61.174, -149.996, 152);
    const AK2 = mk("PAFA", 64.815, -147.856, 434);
    const rejections: EdgeRejection[] = [];
    const g = graph(
      [mk("W3", 60.0, -151.0, 100), AK, AK2, mk("E3", 65.5, -147.0, 500)],
      "W3",
      "E3",
      6000,
      10000,
      (r) => rejections.push(r),
    );
    expect(g.neighbors("PANC").find((e) => e.to === "PAFA")).toBeUndefined();
    expect(
      rejections.find((r) => r.from === "PANC" && r.to === "PAFA")?.rejection,
    ).toBe("terrain-unknown");
  });
});
