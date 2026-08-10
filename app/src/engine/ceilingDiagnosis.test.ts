import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { diagnoseCeiling, planWithWaypoints } from "./plan";

function ap(id: string, lat: number, lon: number, elev: number): Airport {
  return {
    id, lid: id, icao: id, name: id, city: "", state: null, lat, lon,
    elevation_ft: elev, has_control_tower: true, public_use: true,
    runway_count: 2, max_runway_ft: 9000, fuels: ["100LL"],
  };
}

const turbo: Aircraft = {
  slug: "turbo", make: "T", model: "T",
  fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 92 },
  cruise: [
    { altitude_ft: 2000, power_pct: 75, tas_kt: 163, fuel_gph: 16.4 },
    { altitude_ft: 20000, power_pct: 75, tas_kt: 193, fuel_gph: 16.4 },
  ],
  climb: { rate_fpm: 900, fuel_to_climb_gph: 18 },
};

const KSJC = ap("KSJC", 37.3626, -121.929, 62);
const KRNO = ap("KRNO", 39.4991, -119.768, 4415);
const WEST = ap("WEST", 37.0, -122.6, 20);
const EAST = ap("EAST", 40.2, -119.0, 4000);

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

const base = () => ({
  airports: [WEST, KSJC, KRNO, EAST],
  origin: "WEST",
  destination: "EAST",
  aircraft: turbo,
  targetAltFt: 6000,
  flightRule: "IFR" as const,
  reserveHr: 0.75,
  dem,
  waypoints: [] as string[],
});

describe("lowest workable ceiling", () => {
  it("finds the level that admits a route, and it really does", () => {
    // The Sierra leg needs 13,000 ft eastbound IFR. Asked at 11,000,
    // the search must land exactly on 13,000 -- not 12,000 (illegal
    // eastbound) and not 14,000 (higher than necessary).
    const d = diagnoseCeiling({ ...base(), maxAltFt: 11000 });
    expect(d.lowestWorkableFt).toBe(13000);

    // Independent confirmation, not trusting the search: planning at
    // the answer succeeds and planning one legal level below fails.
    expect(planWithWaypoints({ ...base(), maxAltFt: 13000 }).length).toBeGreaterThan(0);
    expect(planWithWaypoints({ ...base(), maxAltFt: 12000 })).toHaveLength(0);
  });

  it("names the blocking leg and the altitude it needed", () => {
    const d = diagnoseCeiling({ ...base(), maxAltFt: 11000 });
    expect(d.blocker).not.toBeNull();
    expect(d.blocker!.from === "KSJC" || d.blocker!.to === "KRNO").toBe(true);
    expect(d.blocker!.requiredAltFt).toBeGreaterThan(11000);
  });

  it("converges in a handful of plans, not a linear scan", () => {
    // Searching legal levels rather than 500 ft steps is what keeps
    // this cheap enough to run on demand.
    const d = diagnoseCeiling({ ...base(), maxAltFt: 11000 });
    expect(d.attempts).toBeLessThanOrEqual(8);
  });

  it("reports no workable ceiling when the aircraft can't get high enough", () => {
    const lowCeilingAircraft: Aircraft = {
      ...turbo,
      slug: "low",
      cruise: [
        { altitude_ft: 2000, power_pct: 75, tas_kt: 124, fuel_gph: 9.6 },
        { altitude_ft: 9000, power_pct: 65, tas_kt: 117, fuel_gph: 7.6 },
      ],
    };
    const d = diagnoseCeiling({
      ...base(),
      aircraft: lowCeilingAircraft,
      maxAltFt: 8000,
    });
    // The Sierra needs 13,000; this aeroplane publishes nothing above
    // 9,000, so no ceiling rescues the route.
    expect(d.lowestWorkableFt).toBeNull();
  });

  it("still explains itself when there is no ceiling set", () => {
    const d = diagnoseCeiling({ ...base(), maxAltFt: null });
    expect(d.lowestWorkableFt).toBeNull();
    expect(d.attempts).toBe(1);
  });
});
