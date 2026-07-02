import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { rankInteractiveCandidates } from "./candidates";
import { greatCircleNM } from "./geo";
import { buildInteractiveLeg } from "./interactive";
import type { DEMSampler } from "./terrain";

// Same fixture shape as interactive.test.ts's `ap()` / `aircraft()`
// helpers, so this file reads like a sibling of that suite.
function ap(
  id: string,
  lat: number,
  lon: number,
  elev = 0,
  fuels: string[] = ["100LL"],
): Airport {
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
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels,
  };
}

function aircraft(): Aircraft {
  return {
    slug: "t",
    make: "T",
    model: "T",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 53 },
    cruise: [
      { altitude_ft: 2000, power_pct: 75, tas_kt: 124, fuel_gph: 9.6 },
      { altitude_ft: 8000, power_pct: 65, tas_kt: 117, fuel_gph: 7.6 },
      { altitude_ft: 12000, power_pct: 55, tas_kt: 109, fuel_gph: 6.5 },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
  };
}

const noVariation = () => null;

describe("rankInteractiveCandidates", () => {
  // Departure and destination on the same latitude, 460 nm apart;
  // candidates scattered along and off the direct course.
  const departure = ap("DEP", 40, -120);
  const destination = ap("DEST", 40, -110);

  test("excludes origin, destination, and excludeIds", () => {
    const onCourse = ap("MID", 40, -115); // ~230 nm along the direct course
    const out = rankInteractiveCandidates({
      airports: [departure, destination, onCourse],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    expect(out.map((c) => c.airport.id)).toEqual(["MID"]);

    const excluded = rankInteractiveCandidates({
      airports: [departure, destination, onCourse],
      departure,
      destination,
      excludeIds: new Set([onCourse.id]),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    expect(excluded).toEqual([]);
  });

  test("drops airports outside the dashed (no-reserve) range ring", () => {
    const near = ap("NEAR", 40, -118); // ~100 nm from departure
    const far = ap("FAR", 40, -80); // way beyond the dashed ring
    const out = rankInteractiveCandidates({
      airports: [departure, destination, near, far],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 150,
      rangeDashedNm: 200,
      variation: noVariation,
    });
    expect(out.map((c) => c.airport.id)).toEqual(["NEAR"]);
  });

  test("computes detourNm as d(dep→c) + d(c→dest) - d(dep→dest)", () => {
    const onCourse = ap("MID", 40, -115);
    const out = rankInteractiveCandidates({
      airports: [departure, destination, onCourse],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    const directNm = greatCircleNM(departure, destination);
    const expectedDetour =
      greatCircleNM(departure, onCourse) + greatCircleNM(onCourse, destination) - directNm;
    expect(out[0].detourNm).toBeCloseTo(expectedDetour, 5);
    // A point exactly on the great-circle course has ~zero detour.
    expect(out[0].detourNm).toBeCloseTo(0, 0);
  });

  test("sorts by detour ascending", () => {
    const onCourse = ap("ON", 40, -115); // near-zero detour
    const offCourse = ap("OFF", 42, -115); // north of the course, real detour
    const out = rankInteractiveCandidates({
      airports: [departure, destination, offCourse, onCourse],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    expect(out.map((c) => c.airport.id)).toEqual(["ON", "OFF"]);
    expect(out[0].detourNm).toBeLessThan(out[1].detourNm);
  });

  test("range status: in / past-reserve relative to the solid and dashed rings", () => {
    const inRange = ap("IN", 40, -118.5); // ~75 nm from departure
    const pastReserve = ap("PAST", 40, -114); // ~285 nm from departure
    const out = rankInteractiveCandidates({
      airports: [departure, destination, inRange, pastReserve],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 200,
      rangeDashedNm: 300,
      variation: noVariation,
    });
    const inC = out.find((c) => c.airport.id === "IN")!;
    const pastC = out.find((c) => c.airport.id === "PAST")!;
    expect(inC.rangeStatus).toBe("in");
    expect(inC.spareNm).toBeCloseTo(200 - inC.legDistNm, 5);
    expect(pastC.rangeStatus).toBe("past-reserve");
    expect(pastC.spareNm).toBeCloseTo(pastC.legDistNm - 200, 5);
  });

  test("sellsFuel reflects airportSellsCompatibleFuel for the aircraft's fuel type", () => {
    const wet = ap("WET", 40, -115, 0, ["100LL"]);
    const dry = ap("DRY", 40, -114, 0, []);
    const out = rankInteractiveCandidates({
      airports: [departure, destination, wet, dry],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    expect(out.find((c) => c.airport.id === "WET")!.sellsFuel).toBe(true);
    expect(out.find((c) => c.airport.id === "DRY")!.sellsFuel).toBe(false);
  });

  test("surfaces terrain shortfalls straight from buildInteractiveLeg's extras", () => {
    // Rather than reverse-engineer the corridor math to force a
    // specific nonzero shortfall (fragile), verify the wiring: the
    // candidate's shortfall fields must match what buildInteractiveLeg
    // itself computes for the same departure->candidate leg.
    const candidate = ap("C", 40, -115);
    const ridgeMsl = 9000;
    const dem: DEMSampler = {
      elevationFt: (p) => (p.lon > -118 && p.lon < -116 ? ridgeMsl : 0),
    };
    const legParams = {
      from: departure,
      to: candidate,
      aircraft: aircraft(),
      targetAltFt: 4000,
      flightRule: "VFR" as const,
      startingFuelGal: 53,
      reserveHr: 0.75,
      variation: noVariation,
      dem,
    };
    const expected = buildInteractiveLeg(legParams).leg;
    const out = rankInteractiveCandidates({
      airports: [departure, destination, candidate],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 4000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
      dem,
    });
    expect(out[0].departureShortfallFt).toBe(
      expected.extra?.terrain_departure_shortfall_ft ?? 0,
    );
    expect(out[0].arrivalShortfallFt).toBe(
      expected.extra?.terrain_arrival_shortfall_ft ?? 0,
    );
  });

  test("shortfall fields default to zero without a DEM", () => {
    const candidate = ap("C", 40, -115);
    const out = rankInteractiveCandidates({
      airports: [departure, destination, candidate],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    expect(out[0].arrivalShortfallFt).toBe(0);
    expect(out[0].departureShortfallFt).toBe(0);
  });

  test("defaults to limit 5 and honors a smaller explicit limit", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      ap(`P${i}`, 40 + i * 0.05, -119 + i * 0.3),
    );
    const defaultOut = rankInteractiveCandidates({
      airports: [departure, destination, ...many],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
    });
    expect(defaultOut).toHaveLength(5);

    const limited = rankInteractiveCandidates({
      airports: [departure, destination, ...many],
      departure,
      destination,
      excludeIds: new Set(),
      aircraft: aircraft(),
      targetAltFt: 8000,
      flightRule: "VFR",
      startingFuelGal: 53,
      reserveHr: 0.75,
      rangeSolidNm: 400,
      rangeDashedNm: 500,
      variation: noVariation,
      limit: 2,
    });
    expect(limited).toHaveLength(2);
  });
});
