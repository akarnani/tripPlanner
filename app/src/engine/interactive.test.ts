import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { geodesicCircle, greatCircleNM } from "./geo";
import type { DEMSampler } from "./terrain";
import {
  buildInteractiveRoute,
  interactiveRangeRings,
  recommendLegAltitude,
} from "./interactive";

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

describe("geodesicCircle", () => {
  test("returns a closed ring of the requested length", () => {
    const ring = geodesicCircle({ lat: 40, lon: -120 }, 100, 36);
    expect(ring.length).toBe(37); // 36 segments + closing point
    expect(ring[0].lat).toBeCloseTo(ring[ring.length - 1].lat, 6);
    expect(ring[0].lon).toBeCloseTo(ring[ring.length - 1].lon, 6);
  });

  test("every sample lies at the requested radius", () => {
    const center = { lat: 40, lon: -120 };
    const ring = geodesicCircle(center, 250, 24);
    for (const p of ring) {
      expect(greatCircleNM(center, p)).toBeCloseTo(250, 1);
    }
  });

  test("zero radius and tiny segment count produce an empty ring", () => {
    expect(geodesicCircle({ lat: 40, lon: -120 }, 0, 24)).toEqual([]);
    expect(geodesicCircle({ lat: 40, lon: -120 }, 100, 2)).toEqual([]);
  });
});

describe("interactiveRangeRings", () => {
  test("dashed ring exceeds solid ring by the reserve allotment", () => {
    const r = interactiveRangeRings({
      aircraft: aircraft(),
      altitude_ft: 8000,
      reserve_hr: 0.75,
      fuel_onboard_gal: 53,
    });
    expect(r.solid_nm).toBeGreaterThan(0);
    expect(r.dashed_nm).toBeGreaterThan(r.solid_nm);
    // At 7.6 GPH / 117 KTAS, 0.75 hr of reserve fuel ≈ 5.7 gal,
    // which is 5.7/7.6 × 117 ≈ 88 nm of dashed-only range.
    expect(r.dashed_nm - r.solid_nm).toBeCloseTo(88, 0);
  });

  test("scales with the fuel actually onboard", () => {
    const full = interactiveRangeRings({
      aircraft: aircraft(),
      altitude_ft: 8000,
      reserve_hr: 0.75,
      fuel_onboard_gal: 53,
    });
    const half = interactiveRangeRings({
      aircraft: aircraft(),
      altitude_ft: 8000,
      reserve_hr: 0.75,
      fuel_onboard_gal: 26.5,
    });
    expect(half.dashed_nm).toBeCloseTo(full.dashed_nm / 2, 0);
  });

  test("zero fuel makes both rings disappear", () => {
    const r = interactiveRangeRings({
      aircraft: aircraft(),
      altitude_ft: 8000,
      reserve_hr: 0.75,
      fuel_onboard_gal: 0,
    });
    expect(r.solid_nm).toBe(0);
    expect(r.dashed_nm).toBe(0);
  });
});

describe("buildInteractiveRoute", () => {
  const A = ap("A", 40, -120);
  const B = ap("B", 40, -115); // ~230 nm east
  const C = ap("C", 40, -110); // ~460 nm east

  test("produces one leg per consecutive pair", () => {
    const { route } = buildInteractiveRoute({
      sequence: [A, B, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
    });
    expect(route.legs).toHaveLength(2);
    expect(route.legs[0].fromAirport.id).toBe("A");
    expect(route.legs[0].toAirport.id).toBe("B");
    expect(route.legs[1].fromAirport.id).toBe("B");
    expect(route.legs[1].toAirport.id).toBe("C");
    // Cost function tag identifies this as an interactive build —
    // the LegTable label keys off it.
    expect(route.costFnId).toBe("interactive");
  });

  test("startingFuelGal applies to every refuel — under-loading propagates", () => {
    // With only 20 gal as the configured load, both legs depart on
    // 20 gal. A→B (~230 nm) doesn't fit in that fuel budget, and
    // B→C (~230 nm) won't either because the refuel only brings
    // the tanks back to 20.
    const { feasibility } = buildInteractiveRoute({
      sequence: [A, B, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 20,
    });
    expect(feasibility[0]).toBe(false);
    expect(feasibility[1]).toBe(false);
  });

  test("intermediate stop selling compatible fuel tops off to the configured load", () => {
    const { stopRefuels, legStartFuelGal } = buildInteractiveRoute({
      sequence: [A, B, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
    });
    expect(stopRefuels).toEqual([true]);
    expect(legStartFuelGal[0]).toBeCloseTo(53, 5);
    expect(legStartFuelGal[1]).toBeCloseTo(53, 5);
  });

  test("refuel tops off to the configured starting-fuel cap, not aircraft capacity", () => {
    // Pilot has capacity 53 gal but is loading 30 gal everywhere
    // (e.g. for weight). After a refuel stop the tank should come
    // back to 30, not jump up to 53.
    const { legStartFuelGal } = buildInteractiveRoute({
      sequence: [A, B, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 30,
    });
    expect(legStartFuelGal[0]).toBeCloseTo(30, 5);
    expect(legStartFuelGal[1]).toBeCloseTo(30, 5);
  });

  test("intermediate stop without compatible fuel is a pass-through", () => {
    const dry = ap("DRY", 40, -115, 0, []); // same coords as B, no fuel
    const { stopRefuels, legStartFuelGal, route } = buildInteractiveRoute({
      sequence: [A, dry, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
    });
    expect(stopRefuels).toEqual([false]);
    // Pass-through: leg 1 starts at the fuel remaining after leg 0
    // (full 53 minus the leg-0 burn), not at full capacity.
    const burnedOnLeg0 = route.legs[0].fuel_gal;
    expect(legStartFuelGal[1]).toBeCloseTo(53 - burnedOnLeg0, 5);
    expect(legStartFuelGal[1]).toBeLessThan(53);
  });

  test("auto altitude bumps above terrain on the leg's great-circle path", () => {
    // Flat sea-level fields, but the path between them crosses a
    // simulated 9,000 ft ridge. The pilot's 6,500 ft target rounds
    // to 7,500 (eastbound VFR), which wouldn't clear the ridge with
    // the 2,000 ft buffer (would need 11,000 → 11,500). The
    // terrain-aware auto altitude must bump.
    const ridgeMsl = 9000;
    const dem: DEMSampler = {
      elevationFt: (p) => (p.lon > -118 && p.lon < -117 ? ridgeMsl : 0),
    };
    const { route } = buildInteractiveRoute({
      sequence: [A, C], // ~460 nm east; ridge sits in the middle
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
      dem,
    });
    // 9,000 + 2,000 buffer = 11,000 → next hemispheric (odd+500
    // eastbound) is 11,500, comfortably within the test aircraft's
    // 12,000 ft cruise ceiling.
    expect(route.legs[0].cruise_alt_ft).toBeGreaterThanOrEqual(11500);
  });

  test("auto altitude prefers a higher cruise on a long leg with no terrain", () => {
    // Aircraft with a clear high-altitude efficiency edge (nm/gal at
    // 12,000 ft is much better than at 2,000 ft) and a long enough
    // leg that climb fuel doesn't dominate. Without optimization,
    // the auto pick would just round the 6,500 ft target to 7,500;
    // with it, the engine climbs to 12,500 (next-higher hemispheric
    // odd+500) because the cruise row is so much more efficient.
    const efficient: Aircraft = {
      ...aircraft(),
      cruise: [
        { altitude_ft: 2000, power_pct: 75, tas_kt: 110, fuel_gph: 12 },
        { altitude_ft: 8000, power_pct: 65, tas_kt: 115, fuel_gph: 9 },
        { altitude_ft: 12000, power_pct: 55, tas_kt: 115, fuel_gph: 6.5 },
      ],
    };
    const O = ap("O", 40, -120);
    const D = ap("D", 40, -113); // ~322 nm east — plenty of cruise
    const { route } = buildInteractiveRoute({
      sequence: [O, D],
      aircraft: efficient,
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
    });
    // Auto picks one of the most efficient hemispheric levels — at
    // or above 11,500 (the highest east-VFR level inside the cruise
    // table; auto may also pick one above the top to pin to the
    // best-published cruise row).
    expect(route.legs[0].cruise_alt_ft).toBeGreaterThanOrEqual(11500);
  });

  test("auto altitude never exceeds the published cruise table top", () => {
    // POH-verbatim rule: the engine doesn't pick above the highest
    // published cruise row, even when the pilot's target altitude
    // is higher. Above the table the engine would have to clamp /
    // invent — we'd rather honestly cap at the published ceiling.
    const jetlike: Aircraft = {
      ...aircraft(),
      weights: { max_gross_lb: 6000 },
      cruise: [
        { altitude_ft: 24000, power_pct: 95, tas_kt: 276, fuel_gph: 68 },
        { altitude_ft: 26000, power_pct: 95, tas_kt: 279, fuel_gph: 62 },
        { altitude_ft: 28000, power_pct: 96, tas_kt: 280, fuel_gph: 61 },
      ],
      climb: { rate_fpm: 1500, fuel_to_climb_gph: 110 },
    };
    const O = ap("O", 40, -120);
    const D = ap("D", 40, -100); // ~920 nm
    const { route } = buildInteractiveRoute({
      sequence: [O, D],
      aircraft: jetlike,
      // Pilot asks for FL310 — but the POH only covers up to FL280.
      targetAltFt: 31000,
      flightRule: "IFR",
      reserveHr: 0.75,
      startingFuelGal: 296,
    });
    expect(route.legs[0].cruise_alt_ft).toBeLessThanOrEqual(28000);
  });

  test("auto altitude stays low on short legs where climb fuel dominates", () => {
    // Same efficiency edge at altitude, but with a realistic
    // climb-fuel rate (18 gph at full power, well above cruise
    // GPH). On a 60 nm leg the climb cost to 11,500 ft swamps the
    // cruise savings, so auto should stay at the hemispheric
    // default of 7,500 ft for a 6,500 ft target eastbound VFR.
    const efficient: Aircraft = {
      ...aircraft(),
      climb: { rate_fpm: 700, fuel_to_climb_gph: 18 },
      cruise: [
        { altitude_ft: 2000, power_pct: 75, tas_kt: 110, fuel_gph: 12 },
        { altitude_ft: 8000, power_pct: 65, tas_kt: 115, fuel_gph: 9 },
        { altitude_ft: 12000, power_pct: 55, tas_kt: 115, fuel_gph: 6.5 },
      ],
    };
    const O = ap("O", 40, -120);
    const D = ap("D", 40, -118.7); // ~60 nm east
    const { route } = buildInteractiveRoute({
      sequence: [O, D],
      aircraft: efficient,
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
    });
    expect(route.legs[0].cruise_alt_ft).toBe(7500);
  });

  test("explicit per-leg override beats the terrain-aware default", () => {
    const dem: DEMSampler = {
      elevationFt: (p) => (p.lon > -118 && p.lon < -117 ? 11000 : 0),
    };
    const { route } = buildInteractiveRoute({
      sequence: [A, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
      legAltitudes: [9500], // pilot insists, even though it's too low
      dem,
    });
    expect(route.legs[0].cruise_alt_ft).toBe(9500);
  });

  test("legAltitudes overrides the auto pick", () => {
    const { route } = buildInteractiveRoute({
      sequence: [A, B, C],
      aircraft: aircraft(),
      targetAltFt: 6500,
      flightRule: "VFR",
      reserveHr: 0.75,
      startingFuelGal: 53,
      legAltitudes: [9500, undefined], // first leg explicitly 9,500; second leg auto
    });
    expect(route.legs[0].cruise_alt_ft).toBe(9500);
    // Second leg auto-picked — just verify it's at or above the
    // 6,500 ft target and an eastbound-VFR-legal level (odd
    // thousands + 500). odd_thousand % 2000 === 1000.
    const auto = route.legs[1].cruise_alt_ft;
    expect(auto).toBeGreaterThanOrEqual(6500);
    expect((auto - 500) % 2000).toBe(1000);
  });
});

describe("recommendLegAltitude", () => {
  const A = ap("A", 40, -120);
  const B = ap("B", 40, -110);

  test("default rounds the target altitude to a hemispheric level", () => {
    const r = recommendLegAltitude({
      aircraft: aircraft(),
      from: A,
      to: B,
      targetAltFt: 6500,
      flightRule: "VFR",
    });
    // Eastbound (A→B) at VFR → odd thousands + 500. 6,500 is an
    // even+500 westbound altitude, so the rule bumps to 7,500.
    expect(r.defaultAltFt).toBe(7500);
  });

  test("flags a more efficient altitude when the cruise table favors high", () => {
    const r = recommendLegAltitude({
      aircraft: aircraft(),
      from: A,
      to: B,
      targetAltFt: 2500,
      flightRule: "VFR",
    });
    // nm/gal: 124/9.6=12.9 at 2k, 117/7.6=15.4 at 8k, 109/6.5=16.8 at 12k.
    // 12k is best — eastbound rounds to 13,500.
    expect(r.cheapestAltFt).toBeGreaterThan(r.defaultAltFt);
  });

  test("respects a minimum-safe floor when picking the cheapest", () => {
    const r = recommendLegAltitude({
      aircraft: aircraft(),
      from: A,
      to: B,
      targetAltFt: 2500,
      flightRule: "VFR",
      minSafeAltFt: 9000, // forces the cheapest pick to 12k tier, not 8k
    });
    expect(r.cheapestAltFt).toBeGreaterThanOrEqual(9000);
  });
});
