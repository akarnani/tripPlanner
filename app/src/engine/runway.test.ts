import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import {
  aircraftSupportsRunwayCheck,
  classifyAirportRunwayFit,
  classifyRunwayFit,
  DEFAULT_RUNWAY_SETTINGS,
  filterByRunwayFit,
  isaTempC,
  lookupRunwayDistance,
  oatFromIsaDelta,
  perLegWeights,
  requiredLandingDistance,
  requiredTakeoffDistance,
} from "./runway";

// Tiny POH-style table at a single weight tier: 2 altitudes × 2
// temperatures = 4 cells, all anchored at 2,550 lb.
const TABLE = [
  { weight_lb: 2550, pressure_alt_ft: 0, temp_c: 0, ground_roll_ft: 800, total_50ft_ft: 1400 },
  { weight_lb: 2550, pressure_alt_ft: 0, temp_c: 20, ground_roll_ft: 900, total_50ft_ft: 1600 },
  { weight_lb: 2550, pressure_alt_ft: 4000, temp_c: 0, ground_roll_ft: 1000, total_50ft_ft: 1800 },
  { weight_lb: 2550, pressure_alt_ft: 4000, temp_c: 20, ground_roll_ft: 1200, total_50ft_ft: 2100 },
];

// Two-tier POH table for cross-weight interpolation tests.
// Heavier weight ↔ longer distances per cell, but the values are
// hand-picked (not a fictional formula) so the tests can verify
// the interpolator reads them as published.
const TIERED_TABLE = [
  // 2,550 lb tier
  { weight_lb: 2550, pressure_alt_ft: 0, temp_c: 0, ground_roll_ft: 800, total_50ft_ft: 1400 },
  { weight_lb: 2550, pressure_alt_ft: 0, temp_c: 20, ground_roll_ft: 900, total_50ft_ft: 1600 },
  { weight_lb: 2550, pressure_alt_ft: 4000, temp_c: 0, ground_roll_ft: 1000, total_50ft_ft: 1800 },
  { weight_lb: 2550, pressure_alt_ft: 4000, temp_c: 20, ground_roll_ft: 1200, total_50ft_ft: 2100 },
  // 2,200 lb tier (shorter distances as published)
  { weight_lb: 2200, pressure_alt_ft: 0, temp_c: 0, ground_roll_ft: 600, total_50ft_ft: 1100 },
  { weight_lb: 2200, pressure_alt_ft: 0, temp_c: 20, ground_roll_ft: 700, total_50ft_ft: 1300 },
  { weight_lb: 2200, pressure_alt_ft: 4000, temp_c: 0, ground_roll_ft: 750, total_50ft_ft: 1400 },
  { weight_lb: 2200, pressure_alt_ft: 4000, temp_c: 20, ground_roll_ft: 900, total_50ft_ft: 1650 },
];

function aircraft(extra: Partial<Aircraft> = {}): Aircraft {
  return {
    slug: "t",
    make: "T",
    model: "T",
    fuel: { type: "100LL", density_lb_per_gal: 6, usable_capacity_gal: 53 },
    cruise: [
      { altitude_ft: 0, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
      { altitude_ft: 8000, power_pct: 75, tas_kt: 120, fuel_gph: 10 },
    ],
    climb: { rate_fpm: 700, fuel_to_climb_gph: 10 },
    weights: { max_gross_lb: 2550 },
    takeoff: { distance_table: TABLE },
    landing: { distance_table: TABLE },
    ...extra,
  };
}

describe("isaTempC + oatFromIsaDelta", () => {
  test("sea level ISA is 15 °C", () => {
    expect(isaTempC(0)).toBe(15);
  });

  test("falls by 1.98 °C per 1,000 ft", () => {
    expect(isaTempC(5000)).toBeCloseTo(15 - 9.9, 5);
  });

  test("ISA + 15 returns standard + 15 °C", () => {
    expect(oatFromIsaDelta(0, 15)).toBe(30);
  });
});

describe("lookupRunwayDistance", () => {
  test("returns the cell value exactly at a grid point", () => {
    const r = lookupRunwayDistance(TABLE, 2550, 0, 0);
    expect(r.ground_roll_ft).toBe(800);
    expect(r.total_50ft_ft).toBe(1400);
  });

  test("rounds inputs UP to the next published cell on every axis", () => {
    // Midpoint of altitude and temp: lookup must return the
    // CORNER cell (next-higher alt + next-higher temp), not the
    // bilinear average. That's how a pilot reads a POH chart by
    // hand — never round down into more-favorable conditions than
    // you actually have.
    const r = lookupRunwayDistance(TABLE, 2550, 2000, 10);
    expect(r.ground_roll_ft).toBe(1200); // 4,000 ft × 20 °C cell
    expect(r.total_50ft_ft).toBe(2100);
  });

  test("clamps inputs above the table to the heaviest/highest/hottest cell", () => {
    const above = lookupRunwayDistance(TABLE, 2550, 10000, 50);
    const corner = lookupRunwayDistance(TABLE, 2550, 4000, 20);
    expect(above.ground_roll_ft).toBe(corner.ground_roll_ft);
    expect(above.total_50ft_ft).toBe(corner.total_50ft_ft);
  });

  test("single-tier table returns its only weight cell regardless of request", () => {
    // The only published cell is at 2,550 lb — we MUST return that
    // number verbatim. No scaling, no interpolation.
    const r = lookupRunwayDistance(TABLE, 1500, 0, 0);
    expect(r.ground_roll_ft).toBe(800);
    expect(r.total_50ft_ft).toBe(1400);
  });

  test("multi-tier table picks the next-higher published weight (no blend)", () => {
    // Between the 2,200 and 2,550 lb tiers: the lookup must return
    // the 2,550 lb cell (heavier = longer = conservative), NOT an
    // average. This is the verbatim-only rule.
    const r = lookupRunwayDistance(TIERED_TABLE, (2550 + 2200) / 2, 0, 0);
    expect(r.ground_roll_ft).toBe(800);  // 2,550 lb / SL / 0 °C
    expect(r.total_50ft_ft).toBe(1400);
  });

  test("multi-tier table returns the requested tier when it matches exactly", () => {
    const r = lookupRunwayDistance(TIERED_TABLE, 2200, 0, 0);
    expect(r.ground_roll_ft).toBe(600); // 2,200 tier cell
    expect(r.total_50ft_ft).toBe(1100);
  });

  test("multi-tier table clamps weights below the lightest tier", () => {
    // Asking for 1,500 lb in a table that only goes down to 2,200
    // should return the 2,200 tier (the lightest the POH publishes).
    const a = lookupRunwayDistance(TIERED_TABLE, 1500, 0, 0);
    const b = lookupRunwayDistance(TIERED_TABLE, 2200, 0, 0);
    expect(a.ground_roll_ft).toBe(b.ground_roll_ft);
  });
});

describe("requiredTakeoffDistance / requiredLandingDistance", () => {
  test("returns null when the aircraft lacks runway tables", () => {
    const bare = aircraft({ takeoff: undefined, landing: undefined });
    expect(
      requiredTakeoffDistance({
        aircraft: bare,
        pressure_alt_ft: 0,
        temp_c: 15,
        weight: "maxGross",
      }),
    ).toBeNull();
    expect(
      requiredLandingDistance({
        aircraft: bare,
        pressure_alt_ft: 0,
        temp_c: 15,
        weight: "maxGross",
      }),
    ).toBeNull();
  });

  test("maxGross mode ignores weight_lb and returns the POH cell", () => {
    const r = requiredTakeoffDistance({
      aircraft: aircraft(),
      pressure_alt_ft: 0,
      temp_c: 0,
      weight: "maxGross",
      weight_lb: 1000, // ignored
    })!;
    expect(r.total_50ft_ft).toBe(1400);
    expect(r.effective_weight_lb).toBe(2550);
  });

  test("single-tier POH: estimated mode returns the same value as maxGross (no fabricated scaling)", () => {
    const max = requiredLandingDistance({
      aircraft: aircraft(),
      pressure_alt_ft: 0,
      temp_c: 0,
      weight: "maxGross",
    })!;
    const est = requiredLandingDistance({
      aircraft: aircraft(),
      pressure_alt_ft: 0,
      temp_c: 0,
      weight: "estimated",
      weight_lb: 2000, // much lighter than gross
    })!;
    expect(est.total_50ft_ft).toBe(max.total_50ft_ft);
    expect(est.ground_roll_ft).toBe(max.ground_roll_ft);
  });

  test("multi-tier POH: estimated mode picks the next-higher published weight", () => {
    const ac = aircraft({
      takeoff: { distance_table: TIERED_TABLE },
    });
    // 2,300 lb is between 2,200 and 2,550 — the verbatim rule
    // requires the heavier (2,550) tier so we never read a number
    // shorter than the POH publishes for the actual weight.
    const lookup = requiredTakeoffDistance({
      aircraft: ac,
      pressure_alt_ft: 0,
      temp_c: 0,
      weight: "estimated",
      weight_lb: 2300,
    })!;
    expect(lookup.total_50ft_ft).toBe(1400);
    expect(lookup.effective_weight_lb).toBe(2550);
  });

  test("multi-tier POH: estimated at exactly a published tier returns that tier", () => {
    const ac = aircraft({
      takeoff: { distance_table: TIERED_TABLE },
    });
    const lookup = requiredTakeoffDistance({
      aircraft: ac,
      pressure_alt_ft: 0,
      temp_c: 0,
      weight: "estimated",
      weight_lb: 2200,
    })!;
    expect(lookup.total_50ft_ft).toBe(1100);
    expect(lookup.effective_weight_lb).toBe(2200);
  });
});

describe("perLegWeights", () => {
  test("returns null without a weights block", () => {
    const bare = aircraft({ weights: undefined });
    expect(
      perLegWeights({
        aircraft: bare,
        legFuelBurnGal: [10],
        legOriginRefuels: [true],
        startingFuelGal: 53,
      }),
    ).toBeNull();
  });

  test("starting fuel below capacity reduces the origin takeoff weight", () => {
    // 53 - 30 = 23 gal × 6 lb/gal = 138 lb under gross.
    const w = perLegWeights({
      aircraft: aircraft(),
      legFuelBurnGal: [10],
      legOriginRefuels: [true],
      startingFuelGal: 30,
    })!;
    expect(w[0].takeoff_lb).toBe(2550 - 138);
    expect(w[0].landing_lb).toBe(2550 - 138 - 60); // 10 gal burn
  });

  test("refuel stops reset takeoff weight to max gross; passes carry through", () => {
    const w = perLegWeights({
      aircraft: aircraft(),
      legFuelBurnGal: [10, 12, 8],
      // Origin refuels (no-op for first leg's logic, just here for
      // shape parity); stop 1 refuels; stop 2 is a pass-through.
      legOriginRefuels: [true, true, false],
      startingFuelGal: 53,
    })!;
    expect(w[0].takeoff_lb).toBe(2550); // start full at origin
    expect(w[0].landing_lb).toBe(2550 - 60);
    expect(w[1].takeoff_lb).toBe(2550); // refueled, back to gross
    expect(w[1].landing_lb).toBe(2550 - 72);
    expect(w[2].takeoff_lb).toBe(w[1].landing_lb); // pass-through
    expect(w[2].landing_lb).toBe(w[2].takeoff_lb - 48);
  });
});

function mkAirport(id: string, max_runway_ft: number, elev = 0): Airport {
  return {
    id,
    lid: id,
    icao: id,
    name: id,
    city: "",
    state: null,
    lat: 0,
    lon: 0,
    elevation_ft: elev,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft,
    fuels: [],
  };
}

describe("aircraftSupportsRunwayCheck", () => {
  test("requires weights + both takeoff and landing tables", () => {
    expect(aircraftSupportsRunwayCheck(aircraft())).toBe(true);
    expect(aircraftSupportsRunwayCheck(aircraft({ weights: undefined }))).toBe(
      false,
    );
    expect(aircraftSupportsRunwayCheck(aircraft({ takeoff: undefined }))).toBe(
      false,
    );
    expect(aircraftSupportsRunwayCheck(aircraft({ landing: undefined }))).toBe(
      false,
    );
  });
});

describe("classifyAirportRunwayFit", () => {
  test("returns null when the aircraft has no POH runway data", () => {
    expect(
      classifyAirportRunwayFit({
        aircraft: aircraft({ takeoff: undefined }),
        airport: mkAirport("X", 5000),
        settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true },
      }),
    ).toBeNull();
  });

  test("returns null when the runway check is disabled", () => {
    expect(
      classifyAirportRunwayFit({
        aircraft: aircraft(),
        airport: mkAirport("X", 5000),
        settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: false },
      }),
    ).toBeNull();
  });

  test("each phase reports its own status; worst rolls up for filters", () => {
    // SL/20 °C cell in the test TABLE is 900 ft ground roll for
    // takeoff (TABLE only has 0/20 °C; ISA+0 rounds up to 20). With
    // a 1,000 ft buffer takeoff needs ≥ 1,900 ft. A 1,500 ft runway
    // is short on takeoff but fine on landing (also 900 ft because
    // the test TABLE is the same for both). With a 600 ft runway
    // both phases would fail.
    const fitTakeoffShort = classifyAirportRunwayFit({
      aircraft: aircraft(),
      airport: mkAirport("X", 1500),
      settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true, isa_delta_c: 0 },
    });
    expect(fitTakeoffShort?.takeoff_status).toBe("insufficient");
    expect(fitTakeoffShort?.worst).toBe("insufficient");
  });

  test("an arrival-only concern does not bleed into the takeoff status", () => {
    // Build an aircraft whose landing tier requires longer runways
    // than its takeoff tier at the same conditions, so the same
    // airport can be ok-for-takeoff and tight-for-landing without
    // those statuses contaminating each other.
    const wideTakeoff = aircraft({
      landing: {
        distance_table: [
          { weight_lb: 2550, pressure_alt_ft: 0, temp_c: 0, ground_roll_ft: 1800, total_50ft_ft: 3000 },
          { weight_lb: 2550, pressure_alt_ft: 0, temp_c: 20, ground_roll_ft: 1900, total_50ft_ft: 3100 },
          { weight_lb: 2550, pressure_alt_ft: 4000, temp_c: 0, ground_roll_ft: 2100, total_50ft_ft: 3400 },
          { weight_lb: 2550, pressure_alt_ft: 4000, temp_c: 20, ground_roll_ft: 2300, total_50ft_ft: 3700 },
        ],
      },
    });
    // 3,500 ft runway is plenty for the 900 ft takeoff (status ok)
    // but only just past landing 1,900 ft + 1,000 ft buffer = 2,900
    // (status tight; available < 1,900 + 2·1000 = 3,900).
    const fit = classifyAirportRunwayFit({
      aircraft: wideTakeoff,
      airport: mkAirport("X", 3500),
      settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true, isa_delta_c: 0 },
    });
    expect(fit?.takeoff_status).toBe("ok");
    expect(fit?.landing_status).toBe("tight");
    expect(fit?.worst).toBe("tight");
  });
});

describe("filterByRunwayFit", () => {
  test("is a no-op when disabled or aircraft lacks data", () => {
    const aps = [mkAirport("A", 1000), mkAirport("B", 5000)];
    expect(
      filterByRunwayFit({
        airports: aps,
        aircraft: aircraft(),
        settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: false },
      }),
    ).toHaveLength(2);
    expect(
      filterByRunwayFit({
        airports: aps,
        aircraft: aircraft({ takeoff: undefined }),
        settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true },
      }),
    ).toHaveLength(2);
  });

  test("drops airports whose runway is below required + buffer", () => {
    const small = mkAirport("S", 1500);
    const big = mkAirport("B", 5000);
    const out = filterByRunwayFit({
      airports: [small, big],
      aircraft: aircraft(),
      settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true, isa_delta_c: 0 },
    });
    expect(out.map((a) => a.id)).toEqual(["B"]);
  });

  test("exempt ids are kept even when their runway would otherwise be dropped", () => {
    const small = mkAirport("S", 1500);
    const out = filterByRunwayFit({
      airports: [small],
      aircraft: aircraft(),
      settings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true, isa_delta_c: 0 },
      exemptIds: new Set(["S"]),
    });
    expect(out.map((a) => a.id)).toEqual(["S"]);
  });
});

describe("classifyRunwayFit", () => {
  test("plenty of runway → ok", () => {
    expect(
      classifyRunwayFit({
        required_ft: 1500,
        available_ft: 5000,
        buffer_ft: 1000,
      }),
    ).toBe("ok");
  });

  test("between (required + buffer) and (required + 2·buffer) → tight", () => {
    expect(
      classifyRunwayFit({
        required_ft: 1500,
        available_ft: 3000, // 1500 + 1500 = 1.5 buffers
        buffer_ft: 1000,
      }),
    ).toBe("tight");
  });

  test("below required + buffer → insufficient", () => {
    expect(
      classifyRunwayFit({
        required_ft: 1500,
        available_ft: 2400,
        buffer_ft: 1000,
      }),
    ).toBe("insufficient");
  });
});
