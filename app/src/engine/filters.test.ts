import { describe, expect, test } from "vitest";
import type { Airport, Datasets } from "@/data/loaders";
import { applyFilters, DEFAULT_FILTERS } from "./filters";

function ap(id: string, fuels: string[], opts: Partial<Airport> = {}): Airport {
  return {
    id,
    lid: id,
    icao: id,
    name: id,
    city: "",
    state: null,
    lat: 0,
    lon: 0,
    elevation_ft: 0,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels,
    ...opts,
  };
}

function datasets(airports: Airport[]): Datasets {
  return {
    airports,
    runways: [],
    approaches: [],
    obstacles: [],
    hasApproachData: false,
    anyApproachAirports: new Set(),
    precisionApproachAirports: new Set(),
    rnavApproachAirports: new Set(),
  };
}

describe("applyFilters fuel matching", () => {
  const airports = [
    ap("AVGAS", ["100LL"]),
    ap("AVGAS-100", ["100"]),
    ap("JETA", ["A", "A1"]),
    ap("JETA-PLUS", ["A++10"]),
    ap("MOGAS", ["MOGAS"]),
    ap("UL", ["UL94", "UL91"]),
    ap("DRY", []),
  ];
  const d = datasets(airports);

  test("100LL aircraft matches 100LL and 100, not UL94/UL91 or jet fuels", () => {
    const out = applyFilters(d, DEFAULT_FILTERS, "100LL");
    const ids = new Set(out.map((a) => a.id));
    expect(ids).toEqual(new Set(["AVGAS", "AVGAS-100"]));
  });

  test("Jet-A aircraft matches A / A1 / A++10 variants", () => {
    const out = applyFilters(d, DEFAULT_FILTERS, "Jet-A");
    const ids = new Set(out.map((a) => a.id));
    expect(ids).toEqual(new Set(["JETA", "JETA-PLUS"]));
  });

  test("MoGas aircraft matches MOGAS only, not UL fuels", () => {
    const out = applyFilters(d, DEFAULT_FILTERS, "MoGas");
    const ids = new Set(out.map((a) => a.id));
    expect(ids).toEqual(new Set(["MOGAS"]));
  });

  test("requireFuel=false ignores fuel availability", () => {
    const out = applyFilters(
      d,
      { ...DEFAULT_FILTERS, requireFuel: false },
      "100LL",
    );
    expect(out.length).toBe(airports.length);
  });

  test("requireFuel without an aircraft type is a no-op", () => {
    // Defensive: if the caller forgets to pass the aircraft type, we
    // don't filter — better than silently dropping every airport.
    const out = applyFilters(d, DEFAULT_FILTERS);
    expect(out.length).toBe(airports.length);
  });
});
