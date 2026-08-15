import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Airport, NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { TerrainGridDEMSampler } from "./terrainGrid";
import { suggestDetours } from "./detours";
import { decideLegAltitude } from "./altitudeBand";
import { alongTrackFraction, greatCircleNM, polylineLengthNM } from "./geo";
import {
  hemisphericAltitudeAtOrBelow,
  initialTrueCourseDeg,
} from "./hemispheric";
import { legTerrainPeakFt, TERRAIN_BUFFER_FT } from "./terrain";

function ap(id: string, lat: number, lon: number, elev: number): Airport {
  return {
    id, lid: id, icao: id, name: id, city: "", state: null, lat, lon,
    elevation_ft: elev, has_control_tower: true, public_use: true,
    runway_count: 2, max_runway_ft: 9000, fuels: ["100LL"],
  };
}

/** Turbo-ish: published cruise up to 16,000 so the POH rule isn't what
 *  rejects the direct Sierra crossing — terrain has to be. */
const turbo: Aircraft = {
  slug: "turbo", make: "T", model: "T",
  fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 92 },
  cruise: [
    { altitude_ft: 2000, power_pct: 75, tas_kt: 163, fuel_gph: 16.4 },
    { altitude_ft: 16000, power_pct: 75, tas_kt: 186, fuel_gph: 16.4 },
  ],
  climb: { rate_fpm: 900, fuel_to_climb_gph: 18 },
};

const KSJC = ap("KSJC", 37.3626, -121.929, 62);
const KRNO = ap("KRNO", 39.4991, -119.768, 4415);

/** Sampling fine enough that the walk can't step over a DEM cell —
 *  matches what the altitude gate uses, so "peak" here means the same
 *  thing it means to the code under test. */
const FINE_NM = 0.25;

let dem: TerrainGridDEMSampler;
let realFixes: NavPoint[];

beforeAll(async () => {
  const raw = gunzipSync(
    readFileSync(new URL("../../../data/terrain_grid.bin.gz", import.meta.url)),
  );
  const body = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  globalThis.fetch = (async () =>
    new Response(body as ArrayBuffer, { status: 200 })) as typeof fetch;
  dem = new TerrainGridDEMSampler("stub://terrain");
  await dem.load();

  // The committed fix dataset, loaded straight off disk.
  const file = JSON.parse(
    readFileSync(new URL("../../../data/fixes.json", import.meta.url), "utf8"),
  ) as { fixes: Array<{ id: string; lat: number; lon: number }> };
  realFixes = file.fixes.map((f) => ({
    id: `fix:${f.id}`,
    ident: f.id,
    kind: "fix" as const,
    lat: f.lat,
    lon: f.lon,
  }));
}, 60_000);

/** Highest terrain along `from → p → to`, measured from the DEM without
 *  going anywhere near the code that picks detours. */
function shapedPeakFt(from: Airport, to: Airport, p: NavPoint): number {
  const { peakFt, offGrid } = legTerrainPeakFt({
    from, to, dem, via: [p], spacing_nm: FINE_NM,
  });
  expect(offGrid, `${p.ident}: DEM coverage gap`).toBe(false);
  expect(peakFt).not.toBeNull();
  return peakFt!;
}

function segmentCourses(from: Airport, to: Airport, p: NavPoint): number[] {
  return [initialTrueCourseDeg(from, p), initialTrueCourseDeg(p, to)];
}

/**
 * The altitude a bent leg is entitled to under a ceiling: the highest
 * legal cruising level below it that every segment accepts. Spelled out
 * from the cruising-level primitives on purpose — restating the
 * contract is an independent check; calling `decideLegAltitude` again
 * would only ask the suggester's own oracle whether it agreed with
 * itself.
 */
function ceilingAltFt(
  from: Airport,
  to: Airport,
  p: NavPoint,
  ceilingFt: number,
): number {
  const levels = segmentCourses(from, to, p).map((c) => {
    const a = hemisphericAltitudeAtOrBelow(ceilingFt, c, "IFR");
    expect(a, `no legal level under ${ceilingFt} on a ${c.toFixed(0)}° segment`)
      .not.toBeNull();
    return a!;
  });
  return Math.min(...levels);
}

describe("detour suggestions against the real terrain grid and fix set", () => {
  const band = { minFt: 6000, maxFt: 11000 };

  it("the direct Sierra crossing is infeasible at the ceiling", () => {
    // Establishes the premise: KSJC→KRNO peaks at 10,289 ft, needing
    // 12,289 with the buffer. Nothing legal under 11,000 clears it.
    const d = decideLegAltitude({
      from: KSJC,
      to: KRNO,
      segmentCoursesDeg: [38],
      band,
      flightRule: "IFR",
      aircraft: turbo,
      dem,
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("terrain");
  });

  it("finds real published fixes that make it work, cheapest first", () => {
    const got = suggestDetours({
      from: KSJC,
      to: KRNO,
      navPoints: realFixes,
      band,
      flightRule: "IFR",
      aircraft: turbo,
      dem,
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(3);

    // Every suggestion must actually be flyable, and that is checked
    // against the DEM and the cruising-level rules directly — not by
    // asking `decideLegAltitude` again, which is the same oracle the
    // suggester consulted and would agree with itself no matter how
    // wrong it was.
    for (const s of got) {
      const label = s.navPoint.ident;
      expect(s.altFt, `${label} below the floor`).toBeGreaterThanOrEqual(6000);
      expect(s.altFt, `${label} altitude`).toBe(
        ceilingAltFt(KSJC, KRNO, s.navPoint, band.maxFt),
      );
      // And it clears the ground along the track it would actually fly.
      const peak = shapedPeakFt(KSJC, KRNO, s.navPoint);
      expect(peak + TERRAIN_BUFFER_FT, `${label} clearance`).toBeLessThanOrEqual(
        s.altFt,
      );
      // The quoted price is the polyline, not a guess.
      const direct = greatCircleNM(KSJC, KRNO);
      expect(s.addedNm, `${label} addedNm`).toBeCloseTo(
        polylineLengthNM([KSJC, s.navPoint, KRNO]) - direct,
        6,
      );
    }

    // Cheapest first.
    const added = got.map((s) => s.addedNm);
    expect([...added].sort((a, b) => a - b)).toEqual(added);
  });

  it("offers nothing when the direct leg already works", () => {
    // A ceiling high enough for the Sierra. The leg has no problem, so
    // there is nothing to route around — and a list of "fixes" under a
    // route that planned fine reads as a warning about a route that is
    // fine. Plenty of these fixes would be perfectly flyable; that is
    // exactly why the emptiness has to be deliberate.
    const roomy = { minFt: 6000, maxFt: 13000 };
    const direct = decideLegAltitude({
      from: KSJC,
      to: KRNO,
      segmentCoursesDeg: [38],
      band: roomy,
      flightRule: "IFR",
      aircraft: turbo,
      dem,
    });
    expect(direct.altFt).toBe(13000);

    expect(
      suggestDetours({
        from: KSJC,
        to: KRNO,
        navPoints: realFixes,
        band: roomy,
        flightRule: "IFR",
        aircraft: turbo,
        dem,
        limit: 3,
      }),
    ).toEqual([]);
  });

  it("rejects a detour that costs more than it is worth", () => {
    // The negative control, and the case that motivated the cost cap.
    // KFAT→KBIH is 74 nm of Sierra; the terrain only really relents if
    // you go 150 nm south into the Mojave and come back up the Owens
    // Valley. This fix stands in for that: a genuine, verified, huge
    // altitude win at a price no pilot would pay.
    const KFAT = ap("KFAT", 36.7762, -119.718, 336);
    const KBIH = ap("KBIH", 37.3731, -118.364, 4124);
    const MOJVE: NavPoint = {
      id: "fix:MOJVE",
      ident: "MOJVE",
      kind: "fix",
      lat: 34.9,
      lon: -117.5,
    };
    const direct = greatCircleNM(KFAT, KBIH);

    // Premise 1: the direct leg is blocked, so a detour is wanted at all.
    const directDecision = decideLegAltitude({
      from: KFAT, to: KBIH, segmentCoursesDeg: [initialTrueCourseDeg(KFAT, KBIH)],
      band, flightRule: "IFR", aircraft: turbo, dem,
    });
    expect(directDecision.altFt).toBeNull();
    expect(directDecision.rejection).toBe("terrain");

    // Premise 2: MOJVE really would fix it. Measured off the DEM, not
    // assumed — without this the test could "pass" on a fix that was
    // dropped as unflyable, and prove nothing whatever about cost. The
    // bent track needs over 4,000 ft less than the direct one, and what
    // it needs fits under the ceiling.
    const VIA_ALT_FT = ceilingAltFt(KFAT, KBIH, MOJVE, band.maxFt);
    const viaPeak = shapedPeakFt(KFAT, KBIH, MOJVE);
    expect(viaPeak + TERRAIN_BUFFER_FT).toBeLessThanOrEqual(VIA_ALT_FT);
    expect(directDecision.requiredAltFt!).toBeGreaterThan(
      viaPeak + TERRAIN_BUFFER_FT + 4000,
    );

    // Premise 3: it isn't skipped for projecting off the ends either.
    const f = alongTrackFraction(KFAT, KBIH, MOJVE);
    expect(f).toBeGreaterThan(0.05);
    expect(f).toBeLessThan(0.95);

    // And the price: +230-odd nm on a 74 nm leg — more than three times
    // the trip again, to save 4,000 ft of climb.
    const addedNm = polylineLengthNM([KFAT, MOJVE, KBIH]) - direct;
    expect(addedNm).toBeGreaterThan(3 * direct);

    // So: flyable, mid-leg, a real terrain win — and still not offered.
    const got = suggestDetours({
      from: KFAT, to: KBIH, navPoints: [MOJVE, ...realFixes],
      band, flightRule: "IFR", aircraft: turbo, dem,
    });
    expect(got.map((s) => s.navPoint.ident)).not.toContain("MOJVE");

    // Nothing but the price kept it out: raise the budget past it and
    // back it comes, at the altitude the terrain says it should be.
    const indulgent = suggestDetours({
      from: KFAT, to: KBIH, navPoints: [MOJVE],
      band, flightRule: "IFR", aircraft: turbo, dem,
      maxAddedFraction: 10,
      maxAddedNm: 1000,
    });
    expect(indulgent).toHaveLength(1);
    expect(indulgent[0].navPoint.ident).toBe("MOJVE");
    expect(indulgent[0].altFt).toBe(VIA_ALT_FT);
    expect(indulgent[0].addedNm).toBeCloseTo(addedNm, 6);
  });
});
