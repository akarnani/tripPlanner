import { describe, expect, test } from "vitest";
import { EMPTY_DATASETS, type Airport, type Datasets } from "@/data/loaders";
import {
  airportsInRouteCorridor,
  applyFilters,
  DEFAULT_FILTERS,
} from "./filters";

function geoAp(id: string, lat: number, lon: number): Airport {
  return {
    id,
    lid: id,
    icao: id,
    name: id,
    city: "",
    state: null,
    lat,
    lon,
    elevation_ft: 0,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

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
  // Spread the empty bundle so adding a Datasets field doesn't break
  // every fixture that only cares about airports.
  return { ...EMPTY_DATASETS, airports };
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

describe("airportsInRouteCorridor", () => {
  // Roughly KPAO and KOSH coordinates for a realistic SF→Wisconsin leg.
  const origin = geoAp("PAO", 37.4611, -122.115);
  const destination = geoAp("OSH", 43.9844, -88.557);

  test("origin and destination always pass", () => {
    const out = airportsInRouteCorridor([origin, destination], origin, destination);
    expect(out.map((a) => a.id).sort()).toEqual(["OSH", "PAO"]);
  });

  test("an airport directly on the great-circle midpoint passes", () => {
    // Pick a point near the great-circle midpoint by interpolating
    // lat/lon naively — close enough for a CTD ~ a few nm test.
    const mid = geoAp(
      "MID",
      (origin.lat + destination.lat) / 2,
      (origin.lon + destination.lon) / 2,
    );
    const out = airportsInRouteCorridor([mid], origin, destination);
    expect(out).toHaveLength(1);
  });

  test("an airport far perpendicular to the route is filtered out", () => {
    // Stick an airport in Florida (well south of the SF→OSH great circle).
    const floor = geoAp("MIA", 25.8, -80.3);
    const out = airportsInRouteCorridor([floor], origin, destination, 100);
    expect(out).toHaveLength(0);
  });

  test("an airport well past the destination is filtered out", () => {
    // East of OSH by ~5 degrees, on roughly the same latitude. Cross-track
    // is small but along-track is well past direct, so it should drop.
    const past = geoAp("PAST", 43.5, -78);
    const out = airportsInRouteCorridor(
      [past],
      origin,
      destination,
      100,
      50,
    );
    expect(out).toHaveLength(0);
  });

  test("a wider CTD threshold can only re-admit, never drop, an airport", () => {
    // Sweep a strip of airports south of the midpoint at increasing
    // distances and confirm that a 200-nm-wide corridor is a superset
    // of a 50-nm-wide one.
    const probes = [-100, -90, -80, -70, -60, -50, -40, -30, -20, -10].map(
      (deltaLat, i) =>
        geoAp(`P${i}`, (origin.lat + destination.lat) / 2 + deltaLat / 60, -105),
    );
    const tight = airportsInRouteCorridor(probes, origin, destination, 50);
    const loose = airportsInRouteCorridor(probes, origin, destination, 200);
    expect(loose.length).toBeGreaterThanOrEqual(tight.length);
    const tightIds = new Set(tight.map((a) => a.id));
    for (const a of tight) expect(tightIds.has(a.id)).toBe(true);
    const looseIds = new Set(loose.map((a) => a.id));
    for (const a of tight) expect(looseIds.has(a.id)).toBe(true);
  });
});
