import { describe, expect, test } from "vitest";
import { DEFAULT_FILTERS, type HardFilters } from "@/engine/filters";
import { DEFAULT_RUNWAY_SETTINGS, type RunwaySettings } from "@/engine/runway";
import { describePlanDiff, snapshotsEqual, type PlanSnapshot } from "./planSnapshot";

function snapshot(extra: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    origin: "KSEA",
    destination: "KBOI",
    aircraftSlug: "c172s",
    targetAltFt: 6500,
    reserveMin: 45,
    startingFuelGal: 53,
    flightRule: "VFR",
    capLegTime: false,
    maxLegHr: 2,
    filters: DEFAULT_FILTERS,
    runwaySettings: DEFAULT_RUNWAY_SETTINGS,
    pinnedStopIds: [],
    excludedIds: [],
    ...extra,
  };
}

describe("snapshotsEqual", () => {
  test("identical snapshots are equal", () => {
    expect(snapshotsEqual(snapshot(), snapshot())).toBe(true);
  });

  test("differs when any scalar field changes", () => {
    expect(snapshotsEqual(snapshot(), snapshot({ targetAltFt: 8500 }))).toBe(false);
  });

  test("filters/runwaySettings compare by value, independent of key order", () => {
    const filtersA: HardFilters = { ...DEFAULT_FILTERS, minRunwayFt: 3000 };
    const filtersB: HardFilters = {
      approach: filtersA.approach,
      requireFuel: filtersA.requireFuel,
      tower: filtersA.tower,
      minRunwayFt: filtersA.minRunwayFt,
    };
    expect(
      snapshotsEqual(snapshot({ filters: filtersA }), snapshot({ filters: filtersB })),
    ).toBe(true);
  });

  test("differs when runwaySettings changes", () => {
    const changed: RunwaySettings = { ...DEFAULT_RUNWAY_SETTINGS, enabled: true };
    expect(
      snapshotsEqual(snapshot(), snapshot({ runwaySettings: changed })),
    ).toBe(false);
  });

  test("pinned/excluded id arrays compare positionally", () => {
    expect(
      snapshotsEqual(
        snapshot({ pinnedStopIds: ["A", "B"] }),
        snapshot({ pinnedStopIds: ["A", "B"] }),
      ),
    ).toBe(true);
    expect(
      snapshotsEqual(
        snapshot({ pinnedStopIds: ["A", "B"] }),
        snapshot({ pinnedStopIds: ["B", "A"] }),
      ),
    ).toBe(false);
  });
});

describe("describePlanDiff", () => {
  test("no differences returns an empty list", () => {
    expect(describePlanDiff(snapshot(), snapshot())).toEqual([]);
  });

  test("altitude change is reported with toLocaleString formatting", () => {
    const diffs = describePlanDiff(snapshot(), snapshot({ targetAltFt: 8500 }));
    expect(diffs).toContain("altitude 6,500 → 8,500 ft");
  });

  test("aircraft change is reported by slug", () => {
    const diffs = describePlanDiff(
      snapshot(),
      snapshot({ aircraftSlug: "pa28-181" }),
    );
    expect(diffs).toContain("aircraft c172s → pa28-181");
  });

  test("reserve, starting fuel, and flight rule changes are reported", () => {
    expect(describePlanDiff(snapshot(), snapshot({ reserveMin: 60 }))).toContain(
      "reserve 45 → 60 min",
    );
    expect(
      describePlanDiff(snapshot(), snapshot({ startingFuelGal: 40 })),
    ).toContain("starting fuel 53 → 40 gal");
    expect(
      describePlanDiff(snapshot(), snapshot({ flightRule: "IFR" })),
    ).toContain("flight rule VFR → IFR");
  });

  test("origin and destination changes are reported independently", () => {
    const diffs = describePlanDiff(
      snapshot(),
      snapshot({ origin: "KPDX", destination: "KGEG" }),
    );
    expect(diffs).toContain("origin KSEA → KPDX");
    expect(diffs).toContain("destination KBOI → KGEG");
  });

  test("leg-time cap toggle reported over the hour value when both change", () => {
    const diffs = describePlanDiff(
      snapshot({ capLegTime: false, maxLegHr: 2 }),
      snapshot({ capLegTime: true, maxLegHr: 3 }),
    );
    expect(diffs).toContain("leg-time cap off → on");
    expect(diffs).not.toContain("leg-time cap 2 → 3 hr");
  });

  test("leg-time cap hour change reported when the toggle itself is unchanged", () => {
    const diffs = describePlanDiff(
      snapshot({ capLegTime: true, maxLegHr: 2 }),
      snapshot({ capLegTime: true, maxLegHr: 3 }),
    );
    expect(diffs).toContain("leg-time cap 2 → 3 hr");
  });

  test("filters changed / runway check settings changed are reported by name", () => {
    const diffs = describePlanDiff(
      snapshot(),
      snapshot({
        filters: { ...DEFAULT_FILTERS, minRunwayFt: 3000 },
        runwaySettings: { ...DEFAULT_RUNWAY_SETTINGS, enabled: true },
      }),
    );
    expect(diffs).toContain("filters changed");
    expect(diffs).toContain("runway check settings changed");
  });

  test("pinned stops changed / excluded airports changed are reported by name", () => {
    const diffs = describePlanDiff(
      snapshot(),
      snapshot({ pinnedStopIds: ["A"], excludedIds: ["B"] }),
    );
    expect(diffs).toContain("pinned stops changed");
    expect(diffs).toContain("excluded airports changed");
  });

  test("most significant diffs come first: altitude, then aircraft, then reserve", () => {
    const diffs = describePlanDiff(
      snapshot(),
      snapshot({ targetAltFt: 8500, aircraftSlug: "pa28-181", reserveMin: 60 }),
    );
    expect(diffs.slice(0, 3)).toEqual([
      "altitude 6,500 → 8,500 ft",
      "aircraft c172s → pa28-181",
      "reserve 45 → 60 min",
    ]);
  });

  test("filters/runway/pinned/excluded diffs are ordered after the scalar fields", () => {
    const diffs = describePlanDiff(
      snapshot(),
      snapshot({
        targetAltFt: 8500,
        filters: { ...DEFAULT_FILTERS, minRunwayFt: 3000 },
        pinnedStopIds: ["A"],
      }),
    );
    expect(diffs).toEqual([
      "altitude 6,500 → 8,500 ft",
      "filters changed",
      "pinned stops changed",
    ]);
  });
});
