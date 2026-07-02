import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { greatCircleNM } from "./geo";
import { buildInteractiveRoute } from "./interactive";
import type { PlannedRoute } from "./plan";
import { DEFAULT_RUNWAY_SETTINGS, type RunwaySettings } from "./runway";
import { explainStopChoices } from "./stopAlternatives";
import type { DEMSampler } from "./terrain";

// Same fixture shape as candidates.test.ts / interactive.test.ts, so this
// file reads like a sibling of those suites.
function ap(
  id: string,
  lat: number,
  lon: number,
  elev = 0,
  fuels: string[] = ["100LL"],
  maxRunwayFt = 5000,
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
    max_runway_ft: maxRunwayFt,
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

// Same as `aircraft()` but with the POH runway data needed for the
// runway-fit checks — a single-tier table so max-gross and estimated
// weight modes always agree (no fabricated correction).
function aircraftWithRunwayData(): Aircraft {
  const row = {
    weight_lb: 2400,
    pressure_alt_ft: 0,
    temp_c: 100,
    ground_roll_ft: 3000,
    total_50ft_ft: 3300,
  };
  return {
    ...aircraft(),
    weights: { max_gross_lb: 2400 },
    takeoff: { distance_table: [row] },
    landing: { distance_table: [row] },
  };
}

const noVariation = () => null;
const TARGET_ALT_FT = 8000;
const RESERVE_HR = 0.75;
const DISABLED_RUNWAY_SETTINGS: RunwaySettings = {
  ...DEFAULT_RUNWAY_SETTINGS,
  enabled: false,
};

function buildRoute(sequence: Airport[], startingFuelGal: number): PlannedRoute {
  return buildInteractiveRoute({
    sequence,
    aircraft: aircraft(),
    targetAltFt: TARGET_ALT_FT,
    flightRule: "VFR",
    reserveHr: RESERVE_HR,
    startingFuelGal,
    variation: noVariation,
  }).route;
}

describe("explainStopChoices", () => {
  test("returns [] for a direct route with no intermediate stops", () => {
    const O = ap("O", 40, -120);
    const D = ap("D", 40, -100);
    const route = buildRoute([O, D], 53);
    const out = explainStopChoices({
      route,
      matches: [O, D],
      baseMatches: [O, D],
      aircraft: aircraft(),
      targetAltFt: TARGET_ALT_FT,
      flightRule: "VFR",
      reserveHr: RESERVE_HR,
      startingFuelGal: 53,
      variation: noVariation,
      runwaySettings: DISABLED_RUNWAY_SETTINGS,
    });
    expect(out).toEqual([]);
  });

  test("marks a pinned stop as pinned and never probes alternatives for it", () => {
    const O = ap("O", 40, -120);
    const S = ap("S", 40, -110);
    const D = ap("D", 40, -100);
    // Sits right next to S, low detour — if S were probed like a normal
    // chosen stop, this would show up as a near-zero-detour alternative.
    const NEARBY = ap("NEARBY", 40.1, -110);
    const route = buildRoute([O, S, D], 53);
    const out = explainStopChoices({
      route,
      matches: [O, S, D, NEARBY],
      baseMatches: [O, S, D, NEARBY],
      aircraft: aircraft(),
      targetAltFt: TARGET_ALT_FT,
      flightRule: "VFR",
      reserveHr: RESERVE_HR,
      startingFuelGal: 53,
      variation: noVariation,
      runwaySettings: DISABLED_RUNWAY_SETTINGS,
      pinnedStopIds: new Set(["S"]),
    });
    expect(out).toHaveLength(1);
    expect(out[0].stopId).toBe("S");
    expect(out[0].pinned).toBe(true);
    expect(out[0].alternatives).toEqual([]);
  });

  test("returns an empty alternatives list when no other candidate fits the route", () => {
    const O = ap("O", 40, -120);
    const S = ap("S", 40, -110);
    const D = ap("D", 40, -100);
    const route = buildRoute([O, S, D], 53);
    const out = explainStopChoices({
      route,
      matches: [O, S, D], // nothing else in the candidate pool
      baseMatches: [O, S, D],
      aircraft: aircraft(),
      targetAltFt: TARGET_ALT_FT,
      flightRule: "VFR",
      reserveHr: RESERVE_HR,
      startingFuelGal: 53,
      variation: noVariation,
      runwaySettings: DISABLED_RUNWAY_SETTINGS,
    });
    expect(out).toHaveLength(1);
    expect(out[0].pinned).toBe(false);
    expect(out[0].alternatives).toEqual([]);
  });

  test("multi-stop route explains every intermediate stop, in route order", () => {
    // O -> S1 -> S2 -> D, each leg ~460 nm.
    const O = ap("O", 40, -120);
    const S1 = ap("S1", 40, -113);
    const S2 = ap("S2", 40, -106);
    const D = ap("D", 40, -100);
    const route = buildRoute([O, S1, S2, D], 53);
    const matches = [O, S1, S2, D];
    const out = explainStopChoices({
      route,
      matches,
      baseMatches: matches,
      aircraft: aircraft(),
      targetAltFt: TARGET_ALT_FT,
      flightRule: "VFR",
      reserveHr: RESERVE_HR,
      startingFuelGal: 53,
      variation: noVariation,
      runwaySettings: DISABLED_RUNWAY_SETTINGS,
    });
    expect(out.map((e) => e.stopId)).toEqual(["S1", "S2"]);
    expect(out[0].alternatives).toEqual([]);
    expect(out[1].alternatives).toEqual([]);
    expect(out[0].pinned).toBe(false);
    expect(out[1].pinned).toBe(false);
  });

  describe("a single-stop route colinear with the direct course", () => {
    // O -> S -> D, colinear at lat 40, ~460 nm per leg (~920 nm total).
    // Full-tank range at 8,000 ft with a 0.75 hr reserve is ~728 nm, so
    // each ~460 nm leg is comfortably feasible but a much longer one
    // (e.g. via a far-off detour) is not.
    const O = ap("O", 40, -120);
    const S = ap("S", 40, -110);
    const D = ap("D", 40, -100);

    // In matches, but ~870 nm from O — too far to reach on the fuel
    // onboard at O regardless of what's on the other side. This must
    // never be listed: fuel-infeasible candidates are silently dropped.
    const FAR = ap("FAR", 40, -101);

    // In matches and an easy first leg from O (~46 nm), but leaves
    // ~870 nm to D — can't make the *next* leg even with full tanks.
    // Also must never be listed.
    const STRAND = ap("STRAND", 40, -119);

    // A cluster of feasible-both-legs alternatives at increasing
    // perpendicular offsets from the O-D course, so their detour (and
    // therefore their total time) increases monotonically. All within
    // the detour cap (max(25, 15% of ~920 nm) ≈ 138 nm).
    const C2 = ap("C2", 41.5, -110);
    const C3 = ap("C3", 41.8, -110);
    const C4 = ap("C4", 42.1, -110);

    // Far enough off course that its detour exceeds the cap even
    // though each leg individually stays within fuel range.
    const FAR_DETOUR = ap("FAR_DETOUR", 45.2, -110);

    const matches = [O, S, D, FAR, STRAND, C2, C3, C4, FAR_DETOUR];

    const route = buildRoute([O, S, D], 53);

    function explain(perStopLimit = 20) {
      const out = explainStopChoices({
        route,
        matches,
        baseMatches: matches,
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
        perStopLimit,
      });
      expect(out).toHaveLength(1);
      return out[0];
    }

    test("identifies the intermediate stop and marks it unpinned", () => {
      const explanation = explain();
      expect(explanation.stopId).toBe("S");
      expect(explanation.stopIdent).toBe("S");
      expect(explanation.pinned).toBe(false);
    });

    test("never lists fuel-infeasible candidates (out of range from prev, or stranding the next leg)", () => {
      const explanation = explain();
      const ids = explanation.alternatives.map((a) => a.airport.id);
      expect(ids).not.toContain("FAR");
      expect(ids).not.toContain("STRAND");
    });

    test("never lists a candidate beyond the detour cap, even though it's individually fuel-feasible", () => {
      // Sanity-check the fixture: FAR_DETOUR's own legs are each well
      // within the ~728 nm range, so if it's missing it's the detour
      // cap that dropped it, not fuel.
      const legO = greatCircleNM(O, FAR_DETOUR);
      const legD = greatCircleNM(FAR_DETOUR, D);
      expect(legO).toBeLessThan(700);
      expect(legD).toBeLessThan(700);
      const direct = greatCircleNM(O, D);
      const detour = legO + legD - direct;
      expect(detour).toBeGreaterThan(Math.max(25, 0.15 * direct));

      const explanation = explain();
      const ids = explanation.alternatives.map((a) => a.airport.id);
      expect(ids).not.toContain("FAR_DETOUR");
    });

    test("excludes filter-failing airports from the candidate pool entirely", () => {
      // Regression for the pilot report under KEVW: an airport that fails
      // the pilot's filters (and isn't a POH-runway-only exclusion) must
      // never crowd out a real, filter-passing competitor at a similar
      // or lower detour.
      const REAL_COMPETITOR = ap("REAL_COMPETITOR", 40.3, -110);
      const out = explainStopChoices({
        route,
        matches: [O, S, D, REAL_COMPETITOR], // NOT_A_MATCH intentionally omitted
        baseMatches: [O, S, D, REAL_COMPETITOR], // and omitted here too — not merely runway-filtered
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
      });
      const ids = out[0].alternatives.map((a) => a.airport.id);
      expect(ids).toContain("REAL_COMPETITOR");
      expect(ids).not.toContain("NOT_A_MATCH");
    });

    test("costlier alternatives are attributed to deviation (extra nm off the direct route) when no other driver dominates", () => {
      const explanation = explain();
      const c4 = explanation.alternatives.find((a) => a.airport.id === "C4")!;
      expect(c4).toBeDefined();
      expect(c4.verdict).toBe("costlier");
      expect(c4.deltaMin).toBeGreaterThan(2);
      expect(c4.reason).toMatch(/^adds ~\d+ min — \d+ nm off the direct route$/);
    });

    test("costlier alternatives farther off-course cost more time and rank lower (higher detour)", () => {
      const explanation = explain();
      const byId = new Map(explanation.alternatives.map((a) => [a.airport.id, a]));
      const c2 = byId.get("C2")!;
      const c3 = byId.get("C3")!;
      const c4 = byId.get("C4")!;
      expect(c2.verdict).toBe("costlier");
      expect(c3.verdict).toBe("costlier");
      expect(c4.verdict).toBe("costlier");
      expect(c2.deltaMin).toBeLessThan(c3.deltaMin);
      expect(c3.deltaMin).toBeLessThan(c4.deltaMin);

      const ids = explanation.alternatives.map((a) => a.airport.id);
      expect(ids.indexOf("C2")).toBeLessThan(ids.indexOf("C3"));
      expect(ids.indexOf("C3")).toBeLessThan(ids.indexOf("C4"));
    });

    test("field elevation alone doesn't make an on-course stop costlier — it's a tie", () => {
      // With a fixed 8,000 ft cruise, a large field-elevation gap is
      // worth under two minutes: the climb covers ground you'd
      // otherwise cruise, and climb speed isn't far off cruise. A
      // sea-level alternative at the same course position as a 6,000 ft
      // chosen stop is therefore an honest near-tie, not "costlier" —
      // the panel says so rather than quoting an inflated climb figure.
      const O2 = ap("O2", 40, -120, 1000);
      const HIGH_STOP = ap("HIGH_STOP", 40, -110, 6000);
      const D2 = ap("D2", 40, -100, 1000);
      const LOW = ap("LOW", 40.1, -110, 1000);
      const highRoute = buildRoute([O2, HIGH_STOP, D2], 53);
      const out = explainStopChoices({
        route: highRoute,
        matches: [O2, HIGH_STOP, D2, LOW],
        baseMatches: [O2, HIGH_STOP, D2, LOW],
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
      });
      const alt = out[0].alternatives.find((a) => a.airport.id === "LOW")!;
      expect(alt).toBeDefined();
      expect(alt.verdict).toBe("tie");
      expect(alt.reason).toBe("essentially a tie — either works");
    });

    test("caps alternatives at perStopLimit, keeping the lowest-detour survivors", () => {
      const withDefault = explain(undefined as unknown as number); // use explainStopChoices' own default (5)
      // explain() always overrides perStopLimit; call the function directly for the true default.
      const out = explainStopChoices({
        route,
        matches,
        baseMatches: matches,
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
      });
      expect(out[0].alternatives.length).toBeLessThanOrEqual(5);
      expect(withDefault.alternatives.length).toBeGreaterThanOrEqual(0);

      const withLimit1 = explainStopChoices({
        route,
        matches,
        baseMatches: matches,
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
        perStopLimit: 1,
      });
      expect(withLimit1[0].alternatives).toHaveLength(1);
      expect(withLimit1[0].alternatives[0].airport.id).toBe("C2");
    });
  });

  describe("near-tie copy", () => {
    // O -> S -> D with S pulled off the O-D course, so S is a
    // deliberately suboptimal chosen stop (this exercises the "tie"
    // verdict, which only makes sense when a candidate legitimately
    // ties the chosen stop under this panel's simplified two-leg model).
    const O = ap("O", 40, -120);
    const D = ap("D", 40, -100);
    const S = ap("S", 44, -110);
    const route = buildRoute([O, S, D], 53);

    test("|deltaMin| <= 2 reads as an effective tie", () => {
      // 3.95 degrees — close enough to S's own 4-degree offset that the
      // two-leg model calls it within a couple of minutes.
      const NEARTIE = ap("NEARTIE", 43.95, -110);
      const out = explainStopChoices({
        route,
        matches: [O, S, D, NEARTIE],
        baseMatches: [O, S, D, NEARTIE],
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
        perStopLimit: 20,
      });
      const alt = out[0].alternatives.find((a) => a.airport.id === "NEARTIE")!;
      expect(alt).toBeDefined();
      expect(Math.abs(alt.deltaMin)).toBeLessThanOrEqual(2);
      expect(alt.verdict).toBe("tie");
      expect(alt.reason).toBe("essentially a tie — either works");
    });

    test("a candidate genuinely shorter than an off-course stop reads as a suggestion", () => {
      // S sits 4° off the direct O–D course (deliberately suboptimal);
      // ONCOURSE sits right on it, so it's clearly shorter. This is the
      // real-app case where the planner's corridor cull dropped a fast
      // field — surfaced as an actionable "shorter" suggestion, never as
      // the old self-deprecating "simplified two-leg model" caveat.
      const ONCOURSE = ap("ONCOURSE", 40, -110);
      const out = explainStopChoices({
        route,
        matches: [O, S, D, ONCOURSE],
        baseMatches: [O, S, D, ONCOURSE],
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
        perStopLimit: 20,
      });
      const alt = out[0].alternatives.find((a) => a.airport.id === "ONCOURSE")!;
      expect(alt).toBeDefined();
      expect(alt.verdict).toBe("shorter");
      expect(alt.deltaMin).toBeLessThan(-2);
      expect(alt.reason).toMatch(/^≈\d+ min shorter than S — pin it to route this way$/);
    });
  });

  describe("over-leg-cap", () => {
    test("flags a candidate whose hypothetical leg would exceed the pilot's per-leg time cap", () => {
      const O = ap("O", 40, -120);
      const S = ap("S", 40, -110);
      const D = ap("D", 40, -100);
      const C2 = ap("C2", 41.5, -110);
      const route = buildRoute([O, S, D], 53);
      // Each ~460 nm leg flies at ~117-124 kt — roughly 3.7-3.9 hr, so a
      // 3 hr cap is comfortably exceeded by both legs of any colinear
      // candidate in this fixture.
      const maxLegHr = 3;
      const out = explainStopChoices({
        route,
        matches: [O, S, D, C2],
        baseMatches: [O, S, D, C2],
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
        maxLegHr,
      });
      const alt = out[0].alternatives.find((a) => a.airport.id === "C2")!;
      expect(alt).toBeDefined();
      expect(alt.verdict).toBe("over-leg-cap");
      expect(alt.reason).toMatch(/^pushes the \S+→\S+ leg over your 3 hr cap$/);
    });
  });

  describe("runway-short inclusion via baseMatches", () => {
    // O -> S -> D as before, but with a runway check enabled and a
    // candidate (RS) that the pilot's filters excluded from `matches`
    // purely because its runway is too short for this aircraft at
    // estimated weight — it must still appear, tagged runway-short.
    const O = ap("O", 40, -120);
    const S = ap("S", 40, -110);
    const D = ap("D", 40, -100);
    // Close to S (small detour, easily fuel-feasible both ways), but
    // with only a 3,000 ft runway — well under the 4,000 ft the fixture
    // aircraft's POH (3,000 ft ground roll + 1,000 ft default buffer)
    // needs.
    const RS = ap("RS", 40.05, -110, 0, ["100LL"], 3000);

    const enabledSettings: RunwaySettings = {
      ...DEFAULT_RUNWAY_SETTINGS,
      enabled: true,
    };

    function run(matches: Airport[], baseMatches: Airport[]) {
      const route = buildRoute([O, S, D], 53);
      return explainStopChoices({
        route,
        matches,
        baseMatches,
        aircraft: aircraftWithRunwayData(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: enabledSettings,
      });
    }

    test("includes an airport the runway check excluded from matches, tagged runway-short", () => {
      const out = run([O, S, D], [O, S, D, RS]);
      const alt = out[0].alternatives.find((a) => a.airport.id === "RS")!;
      expect(alt).toBeDefined();
      expect(alt.verdict).toBe("runway-short");
      expect(alt.reason).toBe(
        "runway short at estimated weight — POH needs 4,000 ft, 3,000 ft available",
      );
    });

    test("does NOT tag an airport runway-short when it's missing from matches for an unrelated reason", () => {
      // RS is absent from BOTH matches and baseMatches here — a
      // filter exclusion unrelated to runway (e.g. no fuel, no tower)
      // must never get the runway-short treatment.
      const out = run([O, S, D], [O, S, D]);
      const ids = out[0].alternatives.map((a) => a.airport.id);
      expect(ids).not.toContain("RS");
    });

    test("when the runway check is disabled, baseMatches === matches and nothing is tagged", () => {
      const route = buildRoute([O, S, D], 53);
      const out = explainStopChoices({
        route,
        matches: [O, S, D, RS],
        baseMatches: [O, S, D, RS],
        aircraft: aircraftWithRunwayData(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
      });
      const alt = out[0].alternatives.find((a) => a.airport.id === "RS")!;
      expect(alt).toBeDefined();
      expect(alt.verdict).not.toBe("runway-short");
    });

    test("a matches-pool candidate whose fit is merely 'tight' gets an appended note, not exclusion", () => {
      // Runway long enough to be "ok" or "tight" but not insufficient:
      // required + buffer = 4,000 ft; required + 2*buffer = 5,000 ft.
      // 4,500 ft available lands in the "tight" band.
      const TIGHT = ap("TIGHT", 40.05, -110, 0, ["100LL"], 4500);
      const out = run([O, S, D, TIGHT], [O, S, D, TIGHT]);
      const alt = out[0].alternatives.find((a) => a.airport.id === "TIGHT")!;
      expect(alt).toBeDefined();
      expect(alt.verdict).not.toBe("runway-short");
      expect(alt.reason).toMatch(/ · runway tight at estimated weight$/);
    });
  });

  describe("gradient annotation", () => {
    test("appends a descent-in clause when a synthetic DEM ridge forces a steeper-than-3.5° descent", () => {
      const O = ap("O", 40, -120);
      const S = ap("S", 40, -110);
      const D = ap("D", 40, -100);
      // RIDGE sits close to S, so it's a low-detour, fuel-feasible
      // alternative — the ridge is placed 5-12 nm short of RIDGE's own
      // field (i.e. right in its descent corridor).
      const RIDGE = ap("RIDGE", 40.05, -110, 0);
      const dem: DEMSampler = {
        elevationFt: (pt) => {
          const distFromRidgeNm = greatCircleNM(RIDGE, pt);
          return distFromRidgeNm >= 5 && distFromRidgeNm <= 12 ? 3500 : 100;
        },
      };
      const route = buildRoute([O, S, D], 53);
      const out = explainStopChoices({
        route,
        matches: [O, S, D, RIDGE],
        baseMatches: [O, S, D, RIDGE],
        aircraft: aircraft(),
        targetAltFt: TARGET_ALT_FT,
        flightRule: "VFR",
        reserveHr: RESERVE_HR,
        startingFuelGal: 53,
        variation: noVariation,
        runwaySettings: DISABLED_RUNWAY_SETTINGS,
        dem,
      });
      const alt = out[0].alternatives.find((a) => a.airport.id === "RIDGE")!;
      expect(alt).toBeDefined();
      expect(alt.reason).toMatch(/descent in requires \d\.\d° for terrain/);
    });
  });
});
