import { describe, expect, test, vi } from "vitest";
import type { TerrainAnalysis, TerrainWarning } from "./terrain";
import type { TerminalCorridorWarning } from "./terrainPenalty";
import { collectRouteIssues, type RouteIssue, type RunwayLegWarning } from "./routeIssues";

function terrainWarning(extra: Partial<TerrainWarning> = {}): TerrainWarning {
  return {
    legIndex: 0,
    fromIdent: "KGEG",
    toIdent: "KBOI",
    worst: {
      point: { lat: 47.6, lon: -117.4 },
      elevation_ft: 6240,
      source: "obstacle-1",
      source_label: "Mt. Spokane",
    },
    clearance_ft: 1240,
    cruise_alt_ft: 6500,
    ...extra,
  };
}

function analysis(extra: Partial<TerrainAnalysis> = {}): TerrainAnalysis {
  return {
    samples: [],
    warnings: [],
    perLeg: [],
    replanTargetFt: 6500,
    ...extra,
  };
}

function corridorWarning(
  extra: Partial<TerminalCorridorWarning> = {},
): TerminalCorridorWarning {
  return {
    ident: "KGEG",
    kind: "arrival",
    shortfall_ft: 480,
    aircraft_alt_ft: 2400,
    ...extra,
  };
}

function runwayWarning(extra: Partial<RunwayLegWarning> = {}): RunwayLegWarning {
  return {
    legIndex: 1,
    phase: "landing",
    ident: "KGEG",
    status: "insufficient",
    required_ft: 2050,
    available_ft: 2600,
    buffer_ft: 1000,
    weight_lb: 2550,
    pressure_alt_ft: 2556,
    temp_c: 15,
    ...extra,
  };
}

describe("collectRouteIssues", () => {
  test("returns an empty array with no analysis, corridor, or runway warnings", () => {
    expect(
      collectRouteIssues({ terrain: null, targetAltFt: 6500, corridor: [], runway: [] }),
    ).toEqual([]);
  });

  test("terrain cruise warning maps to a caution issue with the mockup's exact copy", () => {
    const issues = collectRouteIssues({
      terrain: analysis({ warnings: [terrainWarning()] }),
      targetAltFt: 6500,
      corridor: [],
      runway: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      legIndex: 0,
      phase: "cruise",
      severity: "caution",
      ident: "KGEG→KBOI",
      message: "KGEG→KBOI at 6,500 ft clears Mt. Spokane by only 1,240 ft",
    });
  });

  test("zero or negative clearance escalates to danger with below-terrain copy", () => {
    const issues = collectRouteIssues({
      terrain: analysis({
        warnings: [terrainWarning({ clearance_ft: -1473, cruise_alt_ft: 7500 })],
      }),
      targetAltFt: 7500,
      corridor: [],
      runway: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("danger");
    expect(issues[0].message).toBe(
      "KGEG→KBOI at 7,500 ft is 1,473 ft BELOW Mt. Spokane — leg is not flyable at this altitude",
    );
  });

  test("attaches a replan action only when onReplanAt is given and replanTargetFt exceeds the current target", () => {
    const onReplanAt = vi.fn();
    const withHigherTarget = collectRouteIssues({
      terrain: analysis({ warnings: [terrainWarning()], replanTargetFt: 10500 }),
      targetAltFt: 6500,
      corridor: [],
      runway: [],
      onReplanAt,
    });
    expect(withHigherTarget[0].action?.label).toBe("Replan at 10,500 ft");
    withHigherTarget[0].action?.apply();
    expect(onReplanAt).toHaveBeenCalledWith(10500);

    const withoutCallback = collectRouteIssues({
      terrain: analysis({ warnings: [terrainWarning()], replanTargetFt: 10500 }),
      targetAltFt: 6500,
      corridor: [],
      runway: [],
    });
    expect(withoutCallback[0].action).toBeUndefined();

    const targetAlreadyHighEnough = collectRouteIssues({
      terrain: analysis({ warnings: [terrainWarning()], replanTargetFt: 6500 }),
      targetAltFt: 6500,
      corridor: [],
      runway: [],
      onReplanAt,
    });
    expect(targetAlreadyHighEnough[0].action).toBeUndefined();
  });

  test("corridor warnings map to departure/arrival phase, caution severity", () => {
    const issues = collectRouteIssues({
      terrain: null,
      targetAltFt: 6500,
      corridor: [
        corridorWarning({ ident: "KGEG", kind: "departure", shortfall_ft: 320 }),
        corridorWarning({ ident: "KBOI", kind: "arrival", shortfall_ft: 480 }),
      ],
      runway: [],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ phase: "departure", severity: "caution", ident: "KGEG" });
    expect(issues[0].message).toContain("standard climb profile");
    expect(issues[1]).toMatchObject({ phase: "arrival", severity: "caution", ident: "KBOI" });
    expect(issues[1].message).toContain("standard 1,000/3 nm descent profile");
  });

  test("corridor warnings default legIndex to array position without legIndexByIdent", () => {
    const issues = collectRouteIssues({
      terrain: null,
      targetAltFt: 6500,
      corridor: [corridorWarning({ ident: "A" }), corridorWarning({ ident: "B" })],
      runway: [],
    });
    expect(issues[0].legIndex).toBe(0);
    expect(issues[1].legIndex).toBe(1);
  });

  test("corridor warnings use legIndexByIdent when provided", () => {
    const issues = collectRouteIssues({
      terrain: null,
      targetAltFt: 6500,
      corridor: [corridorWarning({ ident: "KGEG", kind: "departure" })],
      runway: [],
      legIndexByIdent: (ident, kind) => (ident === "KGEG" && kind === "departure" ? 3 : -1),
    });
    expect(issues[0].legIndex).toBe(3);
  });

  test.each([
    ["tight" as const, "caution" as const, "tight"],
    ["insufficient" as const, "danger" as const, "short"],
  ])("runway status %s maps to severity %s with the mockup's copy", (status, severity, verdict) => {
    const issues = collectRouteIssues({
      terrain: null,
      targetAltFt: 6500,
      corridor: [],
      runway: [runwayWarning({ status, phase: "landing", ident: "KGEG" })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe(severity);
    expect(issues[0].message).toBe(
      `Arrival KGEG runway ${verdict}: 2,600 ft available vs 3,050 ft wanted`,
    );
    expect(issues[0].detail).toBe("POH cell: 2,556 ft × 15 °C × 2,550 lb");
  });

  test("runway status ok is dropped entirely", () => {
    const issues = collectRouteIssues({
      terrain: null,
      targetAltFt: 6500,
      corridor: [],
      runway: [runwayWarning({ status: "ok" })],
    });
    expect(issues).toEqual([]);
  });

  test("departure phase runway warning uses the Departure verb", () => {
    const issues = collectRouteIssues({
      terrain: null,
      targetAltFt: 6500,
      corridor: [],
      runway: [runwayWarning({ phase: "takeoff", status: "tight" })],
    });
    expect(issues[0].message).toMatch(/^Departure KGEG/);
  });

  test("sorts danger before caution, then legIndex ascending", () => {
    const issues = collectRouteIssues({
      terrain: analysis({
        warnings: [terrainWarning({ legIndex: 2 }), terrainWarning({ legIndex: 0 })],
      }),
      targetAltFt: 6500,
      corridor: [corridorWarning({ ident: "MID" })],
      runway: [
        runwayWarning({ legIndex: 1, status: "insufficient" }),
        runwayWarning({ legIndex: 4, status: "tight" }),
      ],
    });
    const sig = issues.map((i) => `${i.severity}:${i.legIndex}`);
    // Danger entries (runway insufficient) sort first regardless of
    // legIndex; within a severity band, legIndex ascends.
    expect(sig[0]).toBe("danger:1");
    const cautionLegIndexes = issues
      .filter((i) => i.severity === "caution")
      .map((i) => i.legIndex);
    expect(cautionLegIndexes).toEqual([...cautionLegIndexes].sort((a, b) => a - b));
  });

  test("table-driven: full RouteIssue shape sanity check", () => {
    const cases: Array<{
      name: string;
      build: () => RouteIssue[];
      expectPhase: RouteIssue["phase"];
      expectSeverity: RouteIssue["severity"];
    }> = [
      {
        name: "cruise",
        build: () =>
          collectRouteIssues({
            terrain: analysis({ warnings: [terrainWarning()] }),
            targetAltFt: 6500,
            corridor: [],
            runway: [],
          }),
        expectPhase: "cruise",
        expectSeverity: "caution",
      },
      {
        name: "departure corridor",
        build: () =>
          collectRouteIssues({
            terrain: null,
            targetAltFt: 6500,
            corridor: [corridorWarning({ kind: "departure" })],
            runway: [],
          }),
        expectPhase: "departure",
        expectSeverity: "caution",
      },
      {
        name: "arrival corridor",
        build: () =>
          collectRouteIssues({
            terrain: null,
            targetAltFt: 6500,
            corridor: [corridorWarning({ kind: "arrival" })],
            runway: [],
          }),
        expectPhase: "arrival",
        expectSeverity: "caution",
      },
      {
        name: "takeoff runway",
        build: () =>
          collectRouteIssues({
            terrain: null,
            targetAltFt: 6500,
            corridor: [],
            runway: [runwayWarning({ phase: "takeoff", status: "tight" })],
          }),
        expectPhase: "takeoff",
        expectSeverity: "caution",
      },
      {
        name: "landing runway",
        build: () =>
          collectRouteIssues({
            terrain: null,
            targetAltFt: 6500,
            corridor: [],
            runway: [runwayWarning({ phase: "landing", status: "insufficient" })],
          }),
        expectPhase: "landing",
        expectSeverity: "danger",
      },
    ];
    for (const c of cases) {
      const issues = c.build();
      expect(issues, c.name).toHaveLength(1);
      expect(issues[0].phase, c.name).toBe(c.expectPhase);
      expect(issues[0].severity, c.name).toBe(c.expectSeverity);
    }
  });
});
