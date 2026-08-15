import { describe, expect, it } from "vitest";
import type { Aircraft } from "@/data/aircraft";
import { decideLegAltitude, type AltitudeBand } from "./altitudeBand";
import type { DEMSampler, TerrainBoundSampler } from "./terrain";

const ac: Aircraft = {
  slug: "test",
  make: "T",
  model: "T",
  fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 53 },
  cruise: [
    { altitude_ft: 2000, power_pct: 75, tas_kt: 124, fuel_gph: 9.6 },
    { altitude_ft: 12000, power_pct: 55, tas_kt: 108, fuel_gph: 6.1 },
  ],
  climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
};

const FROM = { lat: 45, lon: -110, elevation_ft: 1000 };
const TO = { lat: 45, lon: -115, elevation_ft: 1000 };
const WESTBOUND = [270];

/** DEM reporting one flat elevation everywhere. */
function flatDEM(ft: number): DEMSampler & TerrainBoundSampler {
  return {
    elevationFt: () => ft,
    maxTerrainAlongFt: () => ft,
  };
}

/** DEM with no coverage — the Alaska case. */
const blindDEM: DEMSampler & TerrainBoundSampler = {
  elevationFt: () => null,
  maxTerrainAlongFt: () => null,
};

const band = (minFt: number, maxFt: number | null): AltitudeBand => ({
  minFt,
  maxFt,
});

describe("altitude band gate", () => {
  it("without a ceiling behaves exactly as before — rounds up", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(7500, null),
      flightRule: "IFR",
      aircraft: ac,
    });
    expect(d.altFt).toBe(8000); // westbound IFR, next even above 7,500
    expect(d.rejection).toBeUndefined();
  });

  it("with a ceiling rounds DOWN to a legal level", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 9000),
      flightRule: "IFR",
      aircraft: ac,
    });
    // Westbound IFR under 9,000 is 8,000 — not the 9,000 the pilot
    // typed, which is an eastbound level.
    expect(d.altFt).toBe(8000);
  });

  it("rejects when no legal level fits between floor and ceiling", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(7000, 7500),
      flightRule: "IFR",
      aircraft: ac,
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("no-legal-level");
  });

  it("refuses a floor above the aircraft's published cruise table", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(16000, 18000),
      flightRule: "IFR",
      aircraft: ac,
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("above-poh-ceiling");
  });

  it("rejects terrain that rises into the buffer, and says what it needs", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
      dem: flatDEM(7000), // 7,000 + 2,000 buffer = 9,000 > 8,000
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("terrain");
    expect(d.requiredAltFt).toBe(9000);
  });

  it("accepts terrain that clears the buffer", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
      dem: flatDEM(5000), // 5,000 + 2,000 = 7,000 <= 8,000
    });
    expect(d.altFt).toBe(8000);
    expect(d.rejection).toBeUndefined();
  });

  it("fails CLOSED where the DEM has no coverage", () => {
    // ~500 airports in the dataset sit outside the CONUS grid, nearly
    // all Alaskan. "No data" must never read as "clear".
    const d = decideLegAltitude({
      from: { lat: 61.2, lon: -150, elevation_ft: 100 },
      to: { lat: 64.8, lon: -147.9, elevation_ft: 400 },
      segmentCoursesDeg: [0],
      band: band(4000, 9000),
      flightRule: "IFR",
      aircraft: ac,
      dem: blindDEM,
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("terrain-unknown");
  });

  it("rejects a ceiling at or under an endpoint's field elevation", () => {
    // KTEX sits at 9,078 ft; an 8,500 ft cap is arithmetic, not routing.
    const d = decideLegAltitude({
      from: { ...FROM, elevation_ft: 9078 },
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("field-elevation");
    expect(d.requiredAltFt).toBe(11078);
  });

  it("lets a terminal leg above the ceiling only when its field forces it", () => {
    const d = decideLegAltitude({
      from: { ...FROM, elevation_ft: 9078 },
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
      terminalLeg: true,
    });
    // A 9,078 ft field cannot be served under an 8,500 ft cap by any
    // amount of rerouting, so the leg is allowed up -- and says so.
    expect(d.altFt).toBe(12000);
    expect(d.exceededCeiling).toBe(true);
  });

  it("still gates a terminal leg whose field elevation is not the problem", () => {
    // The bug this replaced: a blanket terminal exemption switched the
    // ceiling off for every nonstop and one-stop route, because those
    // routes consist entirely of terminal legs.
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
      dem: flatDEM(7000),
      terminalLeg: true,
    });
    expect(d.altFt).toBeNull();
    expect(d.rejection).toBe("terrain");
  });

  it("holds a terminal leg to the ceiling when terrain permits", () => {
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
      dem: flatDEM(3000),
      terminalLeg: true,
    });
    expect(d.altFt).toBe(8000);
    expect(d.exceededCeiling).toBeUndefined();
  });

  it("takes the lowest level every segment of a bent leg accepts", () => {
    // Eastbound wants odd, westbound even; under a 9,000 ceiling the
    // only altitude both halves can be offered is the lower of 9,000
    // and 8,000.
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: [90, 270],
      band: band(4000, 9000),
      flightRule: "IFR",
      aircraft: ac,
    });
    expect(d.altFt).toBe(8000);
  });

  it("uses the coarse bound to clear a leg without exact sampling", () => {
    let exactCalls = 0;
    const dem: DEMSampler & TerrainBoundSampler = {
      elevationFt: () => {
        exactCalls++;
        return 1000;
      },
      maxTerrainAlongFt: () => 3000, // 3,000 + 2,000 = 5,000 <= 8,000
    };
    const d = decideLegAltitude({
      from: FROM,
      to: TO,
      segmentCoursesDeg: WESTBOUND,
      band: band(4000, 8000),
      flightRule: "IFR",
      aircraft: ac,
      dem,
    });
    expect(d.altFt).toBe(8000);
    expect(exactCalls).toBe(0); // the whole point of the overlay
  });
});
