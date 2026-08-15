import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { greatCircleNM, interpolateGreatCircle, type LatLon } from "./geo";
import { SAMPLE_SPACING_NM, type DEMSampler } from "./terrain";
import { buildLegProfile } from "./legProfile";

function ap(id: string, lat: number, lon: number, elev: number): Airport {
  return {
    id,
    lid: id,
    icao: null,
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
    fuels: [],
  };
}

// Minimal aircraft: 100 nm to climb 10,000 ft via the fallback rate
// model keeps the numbers easy to reason about.
const aircraft = {
  slug: "test",
  model: "test",
  fuel: { type: "100LL", usable_capacity_gal: 50 },
  climb: { rate_fpm: 500, fuel_to_climb_gph: 10 },
  cruise: [
    { altitude_ft: 2000, tas_kt: 120, fuel_gph: 10 },
    { altitude_ft: 12000, tas_kt: 120, fuel_gph: 10 },
  ],
} as unknown as Aircraft;

const flatDem: DEMSampler = { elevationFt: () => 100 };

describe("buildLegProfile", () => {
  // ~240 nm east-west leg at 40°N.
  const from = ap("A", 40, -110, 100);
  const to = ap("B", 40, -105, 100);

  test("flat terrain: climb, level cruise, standard descent, no spans", () => {
    const p = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: flatDem,
    });
    expect(p.topOfClimbNm).toBeGreaterThan(0);
    expect(p.topOfDescentNm).toBeLessThan(p.distanceNm);
    expect(p.topOfClimbNm).toBeLessThan(p.topOfDescentNm);
    // Descent distance = (6500 − 100) / (1000/3) ≈ 19.2 nm.
    expect(p.distanceNm - p.topOfDescentNm).toBeCloseTo(19.2, 0);
    const mid = p.points[Math.floor(p.points.length / 2)];
    expect(mid.profileFt).toBe(6500);
    expect(p.points[0].profileFt).toBe(100);
    expect(p.points[p.points.length - 1].profileFt).toBe(100);
    expect(p.spans).toEqual([]);
    // Flat terrain never forces anything steeper than standard.
    expect(p.climb.reqFtPerNm).toBeCloseTo(p.climb.stdFtPerNm, 6);
    expect(p.descent.reqFtPerNm).toBeCloseTo(p.descent.stdFtPerNm, 6);
    expect(p.descent.stdFtPerNm).toBeCloseTo(1000 / 3, 6);
    // Flat / field-level ground is not an obstacle, so terrain demands
    // nothing — the tier logic must read zero here (no false caution).
    expect(p.climb.terrainReqFtPerNm).toBe(0);
    expect(p.descent.terrainReqFtPerNm).toBe(0);
  });

  test("a ridge in the descent corridor forces a steeper required gradient and a later TOD", () => {
    // First establish distanceNm on flat terrain so the ridge can be
    // placed a known distance from the arrival field.
    const flat = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: flatDem,
    });
    const ridgeElevFt = 3500;
    const ridgeDem: DEMSampler = {
      elevationFt: (pt) => {
        const distFromArrivalNm =
          flat.distanceNm - ((pt.lon + 110) / 5) * flat.distanceNm;
        return distFromArrivalNm >= 5 && distFromArrivalNm <= 12
          ? ridgeElevFt
          : 100;
      },
    };
    const p = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: ridgeDem,
    });
    expect(p.descent.reqFtPerNm).toBeGreaterThan(p.descent.stdFtPerNm * 1.1);
    // Raw terrain demand is exposed (unclamped) for the tier logic.
    expect(p.descent.terrainReqFtPerNm).toBeGreaterThan(p.descent.stdFtPerNm);
    // Standard-gradient TOD (for comparison) — steeper required gradient
    // means a shorter descent distance, so the actual topOfDescentNm must
    // land LATER (closer to the arrival field / larger nm value).
    const stdDescentDistNm =
      (p.cruiseAltFt - (to.elevation_ft ?? 0)) / p.descent.stdFtPerNm;
    const stdTopOfDescentNm = p.distanceNm - stdDescentDistNm;
    expect(p.topOfDescentNm).toBeGreaterThan(stdTopOfDescentNm);
    // The drawn profile clears the ridge by the TERPS 40:1 ramped
    // clearance (48 ft/nm from the arrival field, capped at 2,000).
    const ridgePts = p.points.filter(
      (pt) => pt.terrainFt !== null && pt.terrainFt >= ridgeElevFt - 1,
    );
    expect(ridgePts.length).toBeGreaterThan(0);
    for (const pt of ridgePts) {
      const distFromArrival = p.distanceNm - pt.distNm;
      const roc = Math.min(2000, 48 * distFromArrival);
      expect(pt.profileFt - (pt.terrainFt as number)).toBeGreaterThanOrEqual(
        roc - 5,
      );
    }
  });

  test("a ridge in the climb corridor forces a steeper required gradient and an earlier TOC", () => {
    const flat = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: flatDem,
    });
    const ridgeElevFt = 3500;
    const ridgeDem: DEMSampler = {
      elevationFt: (pt) => {
        const distFromDepartureNm = ((pt.lon + 110) / 5) * flat.distanceNm;
        return distFromDepartureNm >= 1 && distFromDepartureNm <= 3
          ? ridgeElevFt
          : 100;
      },
    };
    const p = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: ridgeDem,
    });
    expect(p.climb.reqFtPerNm).toBeGreaterThan(p.climb.stdFtPerNm * 1.1);
    expect(p.climb.terrainReqFtPerNm).toBeGreaterThan(p.climb.stdFtPerNm);
    // Standard-gradient TOC (for comparison) — steeper required gradient
    // means the aircraft reaches cruise in less distance, so the actual
    // topOfClimbNm must land EARLIER (smaller nm value, closer to
    // departure) than the standard-gradient climb would.
    const stdClimbDistNm =
      (p.cruiseAltFt - (from.elevation_ft ?? 0)) / p.climb.stdFtPerNm;
    expect(p.topOfClimbNm).toBeLessThan(stdClimbDistNm);
    const ridgePts = p.points.filter(
      (pt) => pt.terrainFt !== null && pt.terrainFt >= ridgeElevFt - 1,
    );
    expect(ridgePts.length).toBeGreaterThan(0);
    for (const pt of ridgePts) {
      // The drawn path clears the ridge by the TERPS 40:1 ramped
      // clearance (48 ft/nm, capped at 2,000) — smaller close to the
      // departure field than the old fixed 500 ft. This ridge is 1–3 nm
      // out, so expect ~48–144 ft.
      const roc = Math.min(2000, 48 * pt.distNm);
      expect(pt.profileFt - (pt.terrainFt as number)).toBeGreaterThanOrEqual(
        roc - 5,
      );
    }
  });

  test("gentle rolling terrain near the field doesn't manufacture a steep demand (near-field artifact)", () => {
    // Regression: departing 9V5 (flat Nebraska plains) once read a
    // 542 ft/nm "terrain needs a steeper climb" alert because the fixed
    // 500 ft buffer, divided by the ~1 nm distance to terrain barely
    // above the field, blew up. With the ramped clearance, terrain that
    // wanders a few hundred feet around a low field must demand well
    // under a normal climb.
    const field = ap("LOW", 40, -110, 3800);
    const rollingDem: DEMSampler = {
      elevationFt: (pt) => {
        // ±150 ft rolling terrain around the 3,800 ft field.
        const f = (pt.lon + 110) / 5;
        return 3800 + Math.round(150 * Math.sin(f * 40));
      },
    };
    const p = buildLegProfile({
      from: field,
      to: ap("LOW2", 40, -105, 3600),
      cruiseAltFt: 12000,
      aircraft,
      dem: rollingDem,
    });
    // The aircraft's own climb here is ~357 ft/nm; the terrain demand
    // must be comfortably below it (no false alert).
    expect(p.climb.terrainReqFtPerNm).toBeLessThan(p.climb.stdFtPerNm);
    expect(p.climb.terrainReqFtPerNm).toBeLessThan(200);
  });

  test("a ridge inside the cruise segment yields caution then danger spans", () => {
    // Ridge between 40% and 60% of the leg: 5,500 ft (1,000 ft
    // clearance → caution at the 2,000 ft cruise buffer); a hard core
    // between 48–52% at 7,000 ft (above the 6,500 ft path → danger).
    const ridgeDem: DEMSampler = {
      elevationFt: (pt) => {
        const frac = (pt.lon + 110) / 5;
        if (frac > 0.48 && frac < 0.52) return 7000;
        if (frac > 0.4 && frac < 0.6) return 5500;
        return 100;
      },
    };
    const p = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: ridgeDem,
    });
    const kinds = p.spans.map((s) => s.kind);
    expect(kinds).toContain("caution");
    expect(kinds).toContain("danger");
    const danger = p.spans.find((s) => s.kind === "danger")!;
    expect(danger.startNm).toBeGreaterThan(p.distanceNm * 0.4);
    expect(danger.endNm).toBeLessThan(p.distanceNm * 0.6);
  });

  test("terminal corridors use the 500 ft buffer, not 2,000 ft", () => {
    // 1,200 ft clearance everywhere: below the cruise buffer (caution
    // mid-leg) but fine inside climb/descent (> 500 ft) — so spans
    // must not extend to the leg ends.
    const dem: DEMSampler = { elevationFt: () => 5300 };
    const highFrom = ap("C", 40, -110, 5300);
    const highTo = ap("D", 40, -105, 5300);
    const p = buildLegProfile({
      from: highFrom,
      to: highTo,
      cruiseAltFt: 6500,
      aircraft,
      dem,
    });
    expect(p.spans).toHaveLength(1);
    expect(p.spans[0].kind).toBe("caution");
    expect(p.spans[0].startNm).toBeGreaterThan(0);
    expect(p.spans[0].endNm).toBeLessThan(p.distanceNm);
  });

  test("a shaped leg is sampled along the bend, on polyline distances", () => {
    // The bend drags the track ~90 nm south of the direct line, into an
    // 8,000 ft wall that lives entirely below 39°N. The direct line
    // never sees it; the flown track hits it head-on.
    const bend: LatLon = { lat: 38.5, lon: -107.5 };
    const southernWall: DEMSampler = {
      elevationFt: (pt) => (pt.lat < 39 ? 8000 : 100),
    };
    const direct = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: southernWall,
    });
    const shaped = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: southernWall,
      via: [bend],
    });
    expect(direct.points.every((pt) => pt.terrainFt === 100)).toBe(true);
    expect(direct.spans).toEqual([]);
    expect(shaped.points.some((pt) => pt.terrainFt === 8000)).toBe(true);
    expect(shaped.spans.some((s) => s.kind === "danger")).toBe(true);
    // The nav point itself is a vertex of the sampled track.
    expect(Math.min(...shaped.points.map((pt) => pt.lat))).toBeCloseTo(
      bend.lat,
      6,
    );
    // The x-axis is the polyline — the same length routing.ts records as
    // the leg's distance_nm — and it runs monotonically to that value.
    expect(shaped.distanceNm).toBeCloseTo(
      greatCircleNM(from, bend) + greatCircleNM(bend, to),
      6,
    );
    expect(shaped.distanceNm).toBeGreaterThan(direct.distanceNm + 50);
    for (let i = 1; i < shaped.points.length; i++) {
      expect(shaped.points[i].distNm).toBeGreaterThan(
        shaped.points[i - 1].distNm,
      );
    }
    expect(shaped.points[shaped.points.length - 1].distNm).toBe(
      shaped.distanceNm,
    );
    // Phase boundaries are distances along that track: the descent still
    // starts 19.2 nm of flying before the field, not 19.2 nm before the
    // point where the direct line would have ended.
    expect(shaped.distanceNm - shaped.topOfDescentNm).toBeCloseTo(19.2, 0);
  });

  test("an unshaped leg is sampled exactly as before", () => {
    const p = buildLegProfile({
      from,
      to,
      cruiseAltFt: 6500,
      aircraft,
      dem: flatDem,
    });
    // An empty via list is not a shape — same path, same numbers.
    expect(
      buildLegProfile({
        from,
        to,
        cruiseAltFt: 6500,
        aircraft,
        dem: flatDem,
        via: [],
      }),
    ).toEqual(p);
    // Pre-conversion sampling, spelled out: N+1 points evenly spaced
    // along the great circle, each at its own fraction of the direct
    // distance. Every chart in the app is drawn on these, so drift here
    // would be a silent regression rather than a visible one.
    const distanceNm = greatCircleNM(from, to);
    const segments = Math.max(1, Math.ceil(distanceNm / SAMPLE_SPACING_NM));
    const path = interpolateGreatCircle(from, to, segments);
    expect(p.distanceNm).toBe(distanceNm);
    expect(p.points).toHaveLength(path.length);
    p.points.forEach((pt, i) => {
      expect(pt.lat).toBeCloseTo(path[i].lat, 9);
      expect(pt.lon).toBeCloseTo(path[i].lon, 9);
      expect(pt.distNm).toBeCloseTo((i / segments) * distanceNm, 9);
    });
  });

  test("short leg clips into a tent profile below the requested cruise", () => {
    // ~34 nm leg with a 12,000 ft cruise request: climb needs ~80 nm,
    // so the ramps must meet below cruise.
    const near = ap("E", 40, -110, 100);
    const nearTo = ap("F", 40, -109.25, 100);
    const p = buildLegProfile({
      from: near,
      to: nearTo,
      cruiseAltFt: 12000,
      aircraft,
      dem: flatDem,
    });
    expect(p.topOfClimbNm).toBeCloseTo(p.topOfDescentNm, 5);
    const apex = Math.max(...p.points.map((x) => x.profileFt));
    expect(apex).toBeLessThan(12000);
    expect(apex).toBeGreaterThan(100);
  });
});
