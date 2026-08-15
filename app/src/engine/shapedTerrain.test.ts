import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { LatLon } from "./geo";
import { buildGraph } from "./routing";
import {
  analyzeTerrain,
  legMinSafeCruiseAltFt,
  type DEMSampler,
} from "./terrain";
import { navPointId, type NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";

function ap(id: string, lat: number, lon: number, elev = 0): Airport {
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
    fuels: ["100LL"],
  };
}

const aircraft: Aircraft = {
  slug: "test",
  make: "T",
  model: "T",
  fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 400 },
  cruise: [
    { altitude_ft: 0, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
    { altitude_ft: 18000, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
  ],
  climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
};

/** Flat ground everywhere, so the only thing under test is which
 *  course the hemispheric rule is taken from. */
function flatDEM(elevation_ft: number): DEMSampler {
  return { elevationFt: () => elevation_ft };
}

// A due-west leg (course 270 — westbound, even thousands under IFR)
// bent through a point far to the south-east, so its first segment runs
// south-east (course < 180 — eastbound, odd thousands) and its second
// runs back north-west. The two halves want disjoint sets of levels.
const WEST_FROM = ap("EAST", 40, -110);
const WEST_TO = ap("WEST", 40, -120);
const BEND: NavPoint = {
  id: navPointId("fix", "BEND"),
  ident: "BEND",
  kind: "fix",
  lat: 35,
  lon: -105,
};

// 3,500 ft of terrain + the 2,000 ft buffer = 5,500 ft to clear.
// Westbound that rounds to 6,000; eastbound to 7,000. Only a rule that
// looks at both segments can say 7,000.
const dem = flatDEM(3500);
const WESTBOUND_ONLY_FT = 6000;
const BOTH_SEGMENTS_FT = 7000;

describe("hemispheric parity on a leg bent across the 0/180 boundary", () => {
  test("legMinSafeCruiseAltFt takes the highest level any segment wants", () => {
    const straight = legMinSafeCruiseAltFt({
      from: WEST_FROM,
      to: WEST_TO,
      flightRule: "IFR",
      dem,
    });
    expect(straight).toBe(WESTBOUND_ONLY_FT);

    const bent = legMinSafeCruiseAltFt({
      from: WEST_FROM,
      to: WEST_TO,
      flightRule: "IFR",
      dem,
      via: [BEND],
    });
    expect(bent).toBe(BOTH_SEGMENTS_FT);
  });

  test("analyzeTerrain's min-safe and replan target agree with it", () => {
    const r = analyzeTerrain({
      legs: [
        {
          from: WEST_FROM,
          to: WEST_TO,
          fromIdent: "EAST",
          toIdent: "WEST",
          // Below the 2,000 ft buffer over 3,500 ft of ground, so the
          // leg warns and the replan target is driven by this leg.
          cruise_alt_ft: 5000,
          via: [BEND],
        },
      ],
      obstacles: [],
      flightRule: "IFR",
      dem,
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.perLeg[0].minSafeAltFt).toBe(BOTH_SEGMENTS_FT);
    expect(r.replanTargetFt).toBe(BOTH_SEGMENTS_FT);
  });

  test("the analyser names the same level the router does", () => {
    // The two have to agree, because the analyser's number is what the
    // "Replan at N ft" button sends to the router. Ask the router for
    // the bare terrain floor (3,500 + 2,000) on this leg and it flies
    // 7,000: the eastbound segment can't take 6,000. Parity from the
    // endpoint course would have the analyser answer 6,000 — a level
    // the router will not fly on this leg at any target.
    const TERRAIN_FLOOR_FT = 5500;
    const edge = buildGraph({
      airports: [WEST_FROM, WEST_TO],
      origin: "EAST",
      destination: "WEST",
      aircraft,
      targetAltFt: TERRAIN_FLOOR_FT,
      flightRule: "IFR",
      reserveHr: 0.75,
      shapePoints: [BEND],
    })
      .neighbors("EAST")
      .find((e) => e.to === "WEST")!;
    expect(edge.via).toEqual([BEND]);
    expect(edge.cruise_alt_ft).toBe(BOTH_SEGMENTS_FT);
    expect(edge.extra?.hemispheric_conflict).toBe(1);

    expect(
      legMinSafeCruiseAltFt({
        from: WEST_FROM,
        to: WEST_TO,
        flightRule: "IFR",
        dem,
        via: [BEND],
      }),
    ).toBe(edge.cruise_alt_ft);
  });

  test("an unbent leg still takes parity from its own course", () => {
    // The straight case has one segment, so nothing changes for it —
    // guard against "fix the bent leg, break every other leg".
    const east = analyzeTerrain({
      legs: [
        {
          from: WEST_TO,
          to: WEST_FROM,
          fromIdent: "WEST",
          toIdent: "EAST",
          cruise_alt_ft: 5000,
        },
      ],
      obstacles: [],
      flightRule: "IFR",
      dem,
    });
    expect(east.perLeg[0].minSafeAltFt).toBe(BOTH_SEGMENTS_FT); // eastbound: odd
    const west = analyzeTerrain({
      legs: [
        {
          from: WEST_FROM,
          to: WEST_TO,
          fromIdent: "EAST",
          toIdent: "WEST",
          cruise_alt_ft: 5000,
        },
      ],
      obstacles: [],
      flightRule: "IFR",
      dem,
    });
    expect(west.perLeg[0].minSafeAltFt).toBe(WESTBOUND_ONLY_FT); // westbound: even
  });

  test("magnetic variation is applied to every segment, not just the first", () => {
    // 20° east variation swings the bent segment's magnetic course from
    // ~146° (odd) to ~126° (still odd) and the westbound one from ~309°
    // to ~289° (still even) — parity survives, so the answer must not
    // move. A variation applied to only one segment would.
    const variation = (_p: LatLon) => 20;
    const bent = legMinSafeCruiseAltFt({
      from: WEST_FROM,
      to: WEST_TO,
      flightRule: "IFR",
      dem,
      via: [BEND],
      variation,
    });
    expect(bent).toBe(BOTH_SEGMENTS_FT);
  });
});
