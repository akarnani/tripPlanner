import { describe, expect, it } from "vitest";
import type { Airport, NavPoint } from "@/data/loaders";
import { navPointId } from "@/data/loaders";
import {
  fplWaypointType,
  navPointLabel,
  resolveWaypointIdent,
} from "./navPoints";
import { splitWaypointSpans } from "./plan";
import { alongTrackFraction, interpolatePolyline, polylineLengthNM } from "./geo";

function ap(lid: string, lat: number, lon: number): Airport {
  return {
    id: `${lid}-id`,
    lid,
    icao: `K${lid}`,
    name: lid,
    city: lid,
    state: "WA",
    lat,
    lon,
    elevation_ft: 500,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: ["100LL"],
  };
}

function nav(ident: string, lat: number, lon: number, type = "VORTAC"): NavPoint {
  return {
    id: navPointId("navaid", ident),
    ident,
    kind: "navaid",
    lat,
    lon,
    name: ident,
    type,
  };
}

function fix(ident: string, lat: number, lon: number): NavPoint {
  return { id: navPointId("fix", ident), ident, kind: "fix", lat, lon };
}

const KSEA = ap("SEA", 47.4502, -122.309);
const KBOI = ap("BOI", 43.5644, -116.223);
const KGEG = ap("GEG", 47.6199, -117.534);

describe("waypoint ident resolution", () => {
  const airports = [KSEA, KBOI, KGEG];

  it("prefers the airport on a collision but reports the navaid too", () => {
    // 479 of 1,165 real navaids share an ident with an airport.
    const byIdent = new Map([["BOI", [nav("BOI", 43.55, -116.19)]]]);
    const r = resolveWaypointIdent("BOI", airports, byIdent);
    expect(r?.kind).toBe("airport");
    expect(r?.airport?.lid).toBe("BOI");
    expect(r?.alsoNavPoint?.ident).toBe("BOI");
  });

  it("resolves a nav point when no airport claims the ident", () => {
    const byIdent = new Map([["HAROB", [fix("HAROB", 46.5, -120.5)]]]);
    const r = resolveWaypointIdent("HAROB", airports, byIdent);
    expect(r?.kind).toBe("navPoint");
    expect(r?.navPoint?.kind).toBe("fix");
  });

  it("picks the nearest of several same-ident navaids", () => {
    // 37 real NDB idents are shared, all two-letter.
    const far = nav("AA", 46.9, -96.8, "NDB");
    const close = nav("AA", 47.4, -122.2, "NDB");
    const byIdent = new Map([["AA", [far, close]]]);
    const r = resolveWaypointIdent("AA", airports, byIdent, [KSEA]);
    expect(r?.navPoint).toBe(close);
  });

  it("is case- and whitespace-insensitive, and rejects unknown idents", () => {
    const byIdent = new Map([["HAROB", [fix("HAROB", 46.5, -120.5)]]]);
    expect(resolveWaypointIdent("  harob ", airports, byIdent)?.kind).toBe("navPoint");
    expect(resolveWaypointIdent("ZZZZZ", airports, byIdent)).toBeUndefined();
    expect(resolveWaypointIdent("", airports, byIdent)).toBeUndefined();
  });
});

describe("nav point labelling and export types", () => {
  it("labels navaids with their facility type and fixes bare", () => {
    expect(navPointLabel(nav("SEA", 47.4, -122.3))).toBe("SEA VORTAC");
    expect(navPointLabel(fix("HAROB", 46.5, -120.5))).toBe("HAROB");
  });

  it("maps to the Garmin waypoint types a panel GPS will resolve", () => {
    expect(fplWaypointType(fix("HAROB", 46.5, -120.5))).toBe("INT");
    expect(fplWaypointType(nav("SEA", 47.4, -122.3, "VORTAC"))).toBe("VOR");
    expect(fplWaypointType(nav("SEA", 47.4, -122.3, "VOR/DME"))).toBe("VOR");
    expect(fplWaypointType(nav("AA", 46.9, -96.8, "NDB"))).toBe("NDB");
    expect(fplWaypointType(nav("AD", 46.9, -96.8, "NDB/DME"))).toBe("NDB");
  });
});

describe("splitWaypointSpans", () => {
  const HAROB = fix("HAROB", 46.5, -120.5);
  const byId = new Map([[HAROB.id, HAROB]]);

  it("gives a bare nav point its own single origin→destination span", () => {
    // The whole point of a shape point: it must NOT create a new leg.
    const spans = splitWaypointSpans("SEA-id", ["fix:HAROB"], "BOI-id", byId);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ from: "SEA-id", to: "BOI-id" });
    expect(spans[0].shapePoints).toEqual([HAROB]);
  });

  it("attaches a nav point to the span it precedes, not the one after", () => {
    const spans = splitWaypointSpans(
      "SEA-id",
      ["fix:HAROB", "GEG-id"],
      "BOI-id",
      byId,
    );
    expect(spans.map((s) => [s.from, s.to])).toEqual([
      ["SEA-id", "GEG-id"],
      ["GEG-id", "BOI-id"],
    ]);
    expect(spans[0].shapePoints).toEqual([HAROB]);
    expect(spans[1].shapePoints).toEqual([]);
  });

  it("keeps pinned airports as anchors with no shape points", () => {
    const spans = splitWaypointSpans("SEA-id", ["GEG-id"], "BOI-id", byId);
    expect(spans).toHaveLength(2);
    expect(spans.every((s) => s.shapePoints.length === 0)).toBe(true);
  });

  it("drops nav ids it cannot resolve rather than failing the plan", () => {
    // A saved trip may name a fix a later AIRAC cycle retired.
    const spans = splitWaypointSpans("SEA-id", ["fix:GONE"], "BOI-id", byId);
    expect(spans).toHaveLength(1);
    expect(spans[0].shapePoints).toEqual([]);
  });
});

describe("polyline geometry", () => {
  it("measures a bent track as longer than the direct great circle", () => {
    const direct = polylineLengthNM([KSEA, KBOI]);
    const bent = polylineLengthNM([KSEA, { lat: 46.5, lon: -120.5 }, KBOI]);
    expect(bent).toBeGreaterThan(direct);
  });

  it("samples through the bend, not across it", () => {
    const via = { lat: 44.5, lon: -119.0 }; // well south of the direct line
    const path = interpolatePolyline([KSEA, via, KBOI], 10);
    const minToVia = Math.min(
      ...path.map((p) => Math.hypot(p.lat - via.lat, p.lon - via.lon)),
    );
    // Some sample must land essentially on the shape point.
    expect(minToVia).toBeLessThan(0.2);
    // And the track must actually dip south of both endpoints.
    expect(Math.min(...path.map((p) => p.lat))).toBeLessThan(KBOI.lat);
  });

  it("drops zero-length segments from a duplicated vertex", () => {
    const path = interpolatePolyline([KSEA, KSEA, KBOI], 50);
    expect(path.length).toBeGreaterThan(1);
    expect(path.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))).toBe(true);
  });

  it("orders shape points along the track", () => {
    const near = alongTrackFraction(KSEA, KBOI, { lat: 47.0, lon: -121.5 });
    const far = alongTrackFraction(KSEA, KBOI, { lat: 44.5, lon: -117.5 });
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(far);
    expect(far).toBeLessThan(1);
    // Endpoints anchor the scale.
    expect(alongTrackFraction(KSEA, KBOI, KSEA)).toBeCloseTo(0, 6);
    expect(alongTrackFraction(KSEA, KBOI, KBOI)).toBeCloseTo(1, 6);
  });
});
