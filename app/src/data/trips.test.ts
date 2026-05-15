import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteTrip,
  listTrips,
  saveTrip,
  type SavedTrip,
} from "./trips";
import { DEFAULT_FILTERS } from "@/engine/filters";

function mkTrip(name: string, savedAt: string): SavedTrip {
  return {
    name,
    origin: "KSEA",
    destination: "KBOI",
    aircraftSlug: "cessna-172s",
    targetAltFt: 6500,
    reserveMin: 45,
    startingFuelGal: 53,
    flightRule: "VFR",
    capLegTime: false,
    maxLegHr: 2,
    filters: DEFAULT_FILTERS,
    excludedIds: [],
    savedAt,
  };
}

beforeEach(() => {
  // Each test gets a fresh in-memory localStorage so they don't
  // leak state across the suite.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  });
});

describe("trips localStorage CRUD", () => {
  test("listTrips returns [] when nothing is stored", () => {
    expect(listTrips()).toEqual([]);
  });

  test("saveTrip persists and is round-trippable via listTrips", () => {
    const trip = mkTrip("KSEA → KBOI", "2026-05-13T12:00:00Z");
    saveTrip(trip);
    const loaded = listTrips();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(trip);
  });

  test("saveTrip overwrites by name (case-sensitive)", () => {
    saveTrip(mkTrip("Pacific Northwest", "2026-05-10T00:00:00Z"));
    const updated = mkTrip("Pacific Northwest", "2026-05-13T12:00:00Z");
    updated.startingFuelGal = 30;
    saveTrip(updated);
    const all = listTrips();
    expect(all).toHaveLength(1);
    expect(all[0].startingFuelGal).toBe(30);
    expect(all[0].savedAt).toBe("2026-05-13T12:00:00Z");
  });

  test("listTrips sorts newest savedAt first", () => {
    saveTrip(mkTrip("a", "2026-05-10T00:00:00Z"));
    saveTrip(mkTrip("b", "2026-05-13T00:00:00Z"));
    saveTrip(mkTrip("c", "2026-05-12T00:00:00Z"));
    expect(listTrips().map((t) => t.name)).toEqual(["b", "c", "a"]);
  });

  test("deleteTrip removes the named trip and leaves others intact", () => {
    saveTrip(mkTrip("a", "2026-05-10T00:00:00Z"));
    saveTrip(mkTrip("b", "2026-05-13T00:00:00Z"));
    const remaining = deleteTrip("a");
    expect(remaining.map((t) => t.name)).toEqual(["b"]);
  });

  test("deleting a nonexistent name is a no-op", () => {
    saveTrip(mkTrip("a", "2026-05-10T00:00:00Z"));
    expect(deleteTrip("does-not-exist").map((t) => t.name)).toEqual(["a"]);
  });

  test("listTrips degrades to [] when storage holds garbage", () => {
    localStorage.setItem("trip-planner.trips.v1", "{not-json}");
    expect(listTrips()).toEqual([]);
  });

  test("interactive selections round-trip with the trip", () => {
    const trip: SavedTrip = {
      ...mkTrip("interactive", "2026-05-15T12:00:00Z"),
      planningMode: "interactive",
      interactiveStopIds: ["a1", "a2"],
      legAltitudes: [9500, null, 11500],
    };
    saveTrip(trip);
    const [loaded] = listTrips();
    expect(loaded.planningMode).toBe("interactive");
    expect(loaded.interactiveStopIds).toEqual(["a1", "a2"]);
    expect(loaded.legAltitudes).toEqual([9500, null, 11500]);
  });

  test("trips saved before interactive fields existed load as auto", () => {
    // Synthesize an old-shape blob directly into storage.
    const old = mkTrip("legacy", "2026-05-10T00:00:00Z");
    localStorage.setItem("trip-planner.trips.v1", JSON.stringify([old]));
    const [loaded] = listTrips();
    expect(loaded.planningMode).toBeUndefined();
    expect(loaded.interactiveStopIds).toBeUndefined();
    expect(loaded.legAltitudes).toBeUndefined();
  });
});
