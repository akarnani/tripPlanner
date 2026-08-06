import { describe, expect, test } from "vitest";
import type { Airport } from "@/data/loaders";
import type { LatLon } from "./geo";
import { greatCircleNM, pointAtFraction } from "./geo";
import type { DEMSampler } from "./terrain";
import {
  ARRIVAL_FLOOR_AGL_FT,
  ARRIVAL_MIN_PER_KFT,
  CORRIDOR_SAMPLE_NM,
  DEPARTURE_MIN_PER_KFT,
  MAX_CORRIDOR_NM,
  TERMINAL_BUFFER_FT,
  computeTerrainPenalty,
} from "./terrainPenalty";

function mkAirport(
  id: string,
  lat: number,
  lon: number,
  elevation_ft = 0,
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
    elevation_ft,
    has_control_tower: false,
    public_use: true,
    runway_count: 1,
    max_runway_ft: 5000,
    fuels: [],
  };
}

const flatDem: DEMSampler = { elevationFt: () => 0 };
const nullDem: DEMSampler = { elevationFt: () => null };

/** DEM that returns a constant high elevation within a great-circle
 *  distance window of an anchor point. Outside the window, sea level. */
function peakAroundPoint(
  anchor: LatLon,
  height_ft: number,
  radius_nm: number,
): DEMSampler {
  return {
    elevationFt: (p) => (greatCircleNM(anchor, p) <= radius_nm ? height_ft : 0),
  };
}

const FROM = mkAirport("FROM", 40, -120);
const TO = mkAirport("TO", 40, -118); // ~92 nm east

describe("computeTerrainPenalty", () => {
  test("flat terrain produces zero penalty", () => {
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: flatDem,
    });
    expect(r.hr).toBe(0);
    expect(r.departure_shortfall_ft).toBe(0);
    expect(r.arrival_shortfall_ft).toBe(0);
  });

  test("DEM returning null everywhere produces zero penalty", () => {
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: nullDem,
    });
    expect(r.hr).toBe(0);
  });

  test("a peak just outside the descent corridor does not penalize", () => {
    // 30 nm corridor max; place a peak 50 nm out from the arrival airport
    // along the leg's reverse direction (well past the descent window).
    const farPoint = pointAtFraction(
      TO,
      FROM,
      50 / greatCircleNM(TO, FROM),
    );
    const dem = peakAroundPoint(farPoint, 12000, 0.5);
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.arrival_shortfall_ft).toBe(0);
  });

  test("a peak just inside the descent corridor produces an arrival penalty", () => {
    // Place a 5,000 ft peak ~10 nm before the arrival airport along the
    // leg. At 10 nm out the standard descent path expects to be at
    // airport_elev + 10 * 1000/3 ≈ 3,333 ft, less the 500 ft buffer
    // → the descent path must clear ~2,833 ft. A 5,000 ft mountain at
    // that position is clearly above it, so we expect a positive
    // shortfall and a measurable penalty.
    const blocker = pointAtFraction(
      TO,
      FROM,
      10 / greatCircleNM(TO, FROM),
    );
    const dem = peakAroundPoint(blocker, 5000, CORRIDOR_SAMPLE_NM);
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.arrival_shortfall_ft).toBeGreaterThan(1000);
    // Penalty translates ft of shortfall into hours via
    // (ft/1000) * (min/60).
    const expectedHr =
      (r.arrival_shortfall_ft / 1000) * (ARRIVAL_MIN_PER_KFT / 60) +
      (r.departure_shortfall_ft / 1000) * (DEPARTURE_MIN_PER_KFT / 60);
    expect(r.hr).toBeCloseTo(expectedHr, 6);
    expect(r.hr).toBeGreaterThan(0);
  });

  test("a peak just inside the climb corridor produces a departure penalty", () => {
    // 700 fpm at 120 kt → 350 ft/nm climb gradient. At 5 nm out, the
    // climb path expects ~1,750 ft. A 4,000 ft peak there is well above.
    const blocker = pointAtFraction(
      FROM,
      TO,
      5 / greatCircleNM(FROM, TO),
    );
    const dem = peakAroundPoint(blocker, 4000, CORRIDOR_SAMPLE_NM);
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.departure_shortfall_ft).toBeGreaterThan(1000);
    expect(r.arrival_shortfall_ft).toBe(0);
  });

  test("arrival cost-per-foot is heavier than departure cost-per-foot", () => {
    // Identical 4,000 ft peak, identically placed 5 nm from each
    // endpoint. The shortfall magnitudes won't be exactly equal because
    // the climb gradient (~350 ft/nm at 700 fpm / 120 kt) differs from
    // the standard descent gradient (333 ft/nm), but the per-foot
    // time penalty ratio should match the configured constants.
    const arrivalSpot = pointAtFraction(TO, FROM, 5 / greatCircleNM(TO, FROM));
    const departureSpot = pointAtFraction(
      FROM,
      TO,
      5 / greatCircleNM(FROM, TO),
    );
    const arrivalOnly = peakAroundPoint(arrivalSpot, 4000, CORRIDOR_SAMPLE_NM);
    const departureOnly = peakAroundPoint(
      departureSpot,
      4000,
      CORRIDOR_SAMPLE_NM,
    );
    const a = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: arrivalOnly,
    });
    const d = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: departureOnly,
    });
    expect(a.arrival_shortfall_ft).toBeGreaterThan(0);
    expect(d.departure_shortfall_ft).toBeGreaterThan(0);
    const arrivalPerFt = a.hr / a.arrival_shortfall_ft;
    const departurePerFt = d.hr / d.departure_shortfall_ft;
    expect(arrivalPerFt / departurePerFt).toBeCloseTo(
      ARRIVAL_MIN_PER_KFT / DEPARTURE_MIN_PER_KFT,
      6,
    );
  });

  test("cruise altitude below airport elevation produces zero penalty", () => {
    // Defensive: an upstream caller can't normally produce this, but if
    // they did, we shouldn't synthesize a corridor.
    const high = mkAirport("HIGH", 40, -118, 10000);
    const r = computeTerrainPenalty({
      from: FROM,
      to: high,
      cruise_alt_ft: 5000,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: peakAroundPoint(high, 20000, 5),
    });
    expect(r.arrival_shortfall_ft).toBe(0);
  });

  test("very short legs don't crash and don't sample past the other endpoint", () => {
    const close = mkAirport("CLOSE", 40, -119.9); // ~4.6 nm
    const r = computeTerrainPenalty({
      from: FROM,
      to: close,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: flatDem,
    });
    expect(r.hr).toBe(0);
  });

  test("buffer is enforced — terrain at exactly the required altitude is still a shortfall", () => {
    // At 10 nm out on a 1000/3 descent, required_alt = 0 + 3333. A
    // terrain spike of exactly 3333 still pierces the buffer by 500.
    const blocker = pointAtFraction(
      TO,
      FROM,
      10 / greatCircleNM(TO, FROM),
    );
    const dem = peakAroundPoint(blocker, 3333, CORRIDOR_SAMPLE_NM);
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.arrival_shortfall_ft).toBeGreaterThanOrEqual(TERMINAL_BUFFER_FT - 50);
  });

  test("terrain above cruise altitude inside the corridor produces a shortfall", () => {
    // Past the TOD point of the standard descent slope, the aircraft is
    // at cruise altitude. Terrain that pokes above cruise inside the
    // arrival corridor means the leg can't actually be flown at the
    // chosen altitude — the descent isn't even the bottleneck. This is
    // the case the pre-fix corridor cap missed (it stopped sampling at
    // TOD, where the slope intersects cruise).
    // Cruise 6,500 → TOD on the 1000/3 slope is at 19.5 nm. Place an
    // 8,000 ft peak at 25 nm out, well past TOD but inside the 30-nm
    // corridor.
    const blocker = pointAtFraction(
      TO,
      FROM,
      25 / greatCircleNM(TO, FROM),
    );
    const dem = peakAroundPoint(blocker, 8000, CORRIDOR_SAMPLE_NM);
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    // limit at d=25 = min(6500, 0 + 25*333) − 500 = min(6500, 8325) − 500
    //             = 6500 − 500 = 6000.
    // shortfall = 8000 − 6000 = 2000.
    expect(r.arrival_shortfall_ft).toBeGreaterThan(1500);
  });

  test("low terrain inside pattern altitude near the arrival airport is not flagged", () => {
    // Mountain-elevation field (KRKS-like, 6,800 ft) with surrounding
    // hills at 7,000 ft (~200 ft AGL). The aircraft would enter the
    // pattern at ~7,800 ft, well above the hills, so this should *not*
    // produce an arrival warning. Without the pattern-altitude floor,
    // the descent slope projects the aircraft to field elevation at
    // d=0 and the buffer drives the limit below the field, so any
    // hill above field elevation would generate a shortfall.
    const high = mkAirport("HIGH", 40, -118, 6800);
    const dem: DEMSampler = {
      // 200 ft AGL hill 2 nm in on the approach corridor.
      elevationFt: (p) => {
        const hill = pointAtFraction(high, FROM, 2 / greatCircleNM(high, FROM));
        return greatCircleNM(hill, p) <= CORRIDOR_SAMPLE_NM ? 7000 : 6800;
      },
    };
    const r = computeTerrainPenalty({
      from: FROM,
      to: high,
      cruise_alt_ft: 10500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.arrival_shortfall_ft).toBe(0);
  });

  test("terrain that pokes above pattern altitude near arrival still flags", () => {
    // Same field but with a hill at field + 1,200 ft (above pattern
    // altitude). The aircraft can't be at the pattern altitude floor
    // without clipping it — the warning must fire.
    const high = mkAirport("HIGH", 40, -118, 6800);
    const dem: DEMSampler = {
      elevationFt: (p) => {
        const hill = pointAtFraction(high, FROM, 2 / greatCircleNM(high, FROM));
        return greatCircleNM(hill, p) <= CORRIDOR_SAMPLE_NM
          ? 6800 + ARRIVAL_FLOOR_AGL_FT + 200
          : 6800;
      },
    };
    const r = computeTerrainPenalty({
      from: FROM,
      to: high,
      cruise_alt_ft: 10500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    // Pattern floor (6,800 + 1,000 = 7,800) - 500 ft buffer = 7,300.
    // Hill at 7,800 + 200 = 8,000. Shortfall ≈ 700 ft.
    expect(r.arrival_shortfall_ft).toBeGreaterThan(500);
  });

  test("departure corridor is unaffected by the arrival-side pattern floor", () => {
    // 200 ft AGL hill 2 nm out on departure from a high field. Climb
    // gradient 350 ft/nm at 700 fpm / 78 kt → at 2 nm the climb path
    // expects ~700 AGL, buffer drops the limit to ~200 AGL → a hill
    // at 200 AGL still needs to be cleared, so it produces a small
    // departure shortfall. Confirms that the pattern-altitude floor
    // applies *only* to the arrival corridor.
    const high = mkAirport("HIGH", 40, -120, 6800);
    const far = mkAirport("FAR", 40, -118, 0);
    const dem: DEMSampler = {
      elevationFt: (p) => {
        const hill = pointAtFraction(high, far, 2 / greatCircleNM(high, far));
        return greatCircleNM(hill, p) <= CORRIDOR_SAMPLE_NM ? 7000 : 0;
      },
    };
    const r = computeTerrainPenalty({
      from: high,
      to: far,
      cruise_alt_ft: 10500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.departure_shortfall_ft).toBeGreaterThan(0);
  });

  test("an empty via list is not a shape", () => {
    const args = {
      from: FROM,
      to: TO,
      cruise_alt_ft: 6500,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem: peakAroundPoint(
        pointAtFraction(TO, FROM, 10 / greatCircleNM(TO, FROM)),
        5000,
        CORRIDOR_SAMPLE_NM,
      ),
    };
    expect(computeTerrainPenalty({ ...args, via: [] })).toEqual(
      computeTerrainPenalty(args),
    );
  });

  test("corridor never exceeds MAX_CORRIDOR_NM even with very high cruise altitudes", () => {
    // Cruise alt 30,000 would otherwise stretch the descent corridor
    // to (30000-0) / (1000/3) = 90 nm. The cap should clip it. A peak
    // 50 nm out should be ignored.
    const peak = pointAtFraction(TO, FROM, 50 / greatCircleNM(TO, FROM));
    const dem = peakAroundPoint(peak, 20000, 0.5);
    expect(MAX_CORRIDOR_NM).toBeLessThan(50);
    const r = computeTerrainPenalty({
      from: FROM,
      to: TO,
      cruise_alt_ft: 30000,
      climb_speed_kt: 78,
      climb_rate_fpm: 700,
      dem,
    });
    expect(r.arrival_shortfall_ft).toBe(0);
  });
});

describe("computeTerrainPenalty on a leg shaped through nav points", () => {
  // A bend ~40 nm south of the direct FROM→TO line. Both of its
  // segments are ~62 nm, comfortably longer than the 30 nm corridors,
  // so each corridor lives on one segment of the bent track.
  const BEND: LatLon = { lat: 39.3, lon: -119 };
  const base = {
    from: FROM,
    to: TO,
    cruise_alt_ft: 6500,
    climb_speed_kt: 78,
    climb_rate_fpm: 700,
  };

  test("the departure corridor climbs out along the bend", () => {
    // 4,000 ft peak 5 nm out along the bent track, where a 350 ft/nm
    // climb has only reached ~1,750 ft. It blocks the leg that turns
    // toward it and no other.
    const blocker = pointAtFraction(FROM, BEND, 5 / greatCircleNM(FROM, BEND));
    const dem = peakAroundPoint(blocker, 4000, CORRIDOR_SAMPLE_NM);
    expect(
      computeTerrainPenalty({ ...base, dem, via: [BEND] })
        .departure_shortfall_ft,
    ).toBeGreaterThan(1000);
    expect(computeTerrainPenalty({ ...base, dem }).departure_shortfall_ft).toBe(
      0,
    );
  });

  test("the arrival corridor descends in on the final segment", () => {
    const blocker = pointAtFraction(TO, BEND, 10 / greatCircleNM(TO, BEND));
    const dem = peakAroundPoint(blocker, 5000, CORRIDOR_SAMPLE_NM);
    expect(
      computeTerrainPenalty({ ...base, dem, via: [BEND] }).arrival_shortfall_ft,
    ).toBeGreaterThan(1000);
    expect(computeTerrainPenalty({ ...base, dem }).arrival_shortfall_ft).toBe(0);
  });

  test("terrain the bend steers around stops being charged for", () => {
    // The reason a pilot shapes a leg at all: a mountain 10 nm off the
    // arrival end of the direct line. Scoring the direct course would
    // keep charging the detour for the very terrain it exists to miss,
    // and the router would then reject its own shaped route.
    const blocker = pointAtFraction(TO, FROM, 10 / greatCircleNM(TO, FROM));
    const dem = peakAroundPoint(blocker, 5000, CORRIDOR_SAMPLE_NM);
    expect(
      computeTerrainPenalty({ ...base, dem }).arrival_shortfall_ft,
    ).toBeGreaterThan(1000);
    const shaped = computeTerrainPenalty({ ...base, dem, via: [BEND] });
    expect(shaped.arrival_shortfall_ft).toBe(0);
    expect(shaped.hr).toBe(0);
  });

  test("a corridor that outlives its first segment turns with the track", () => {
    // Bend only 10 nm out of FROM, so the 30 nm departure corridor has
    // to cross the nav point and carry on down the next segment — a
    // ~42° turn, which puts the straight-ahead sample 7 nm from where
    // the aircraft actually is at 20 nm out.
    const southeast = mkAirport("SE", 38.5, -117.5);
    const bend = pointAtFraction(
      FROM,
      southeast,
      10 / greatCircleNM(FROM, southeast),
    );
    const blocker = pointAtFraction(bend, TO, 10 / greatCircleNM(bend, TO));
    const dem = peakAroundPoint(blocker, 9000, CORRIDOR_SAMPLE_NM);
    expect(
      computeTerrainPenalty({ ...base, dem, via: [bend] })
        .departure_shortfall_ft,
    ).toBeGreaterThan(1000);
    expect(computeTerrainPenalty({ ...base, dem }).departure_shortfall_ft).toBe(
      0,
    );
  });

  test("a via point on the direct line leaves both corridors untouched", () => {
    // Shaping through a point that's already on the great circle is a
    // no-op geometrically, so it has to be a no-op numerically: same
    // corridor length, same samples, same shortfalls.
    const onLine = pointAtFraction(FROM, TO, 0.5);
    const dem = peakAroundPoint(
      pointAtFraction(TO, FROM, 10 / greatCircleNM(TO, FROM)),
      5000,
      CORRIDOR_SAMPLE_NM,
    );
    const shaped = computeTerrainPenalty({ ...base, dem, via: [onLine] });
    const direct = computeTerrainPenalty({ ...base, dem });
    expect(shaped.departure_shortfall_ft).toBeCloseTo(
      direct.departure_shortfall_ft,
      6,
    );
    expect(shaped.arrival_shortfall_ft).toBeCloseTo(
      direct.arrival_shortfall_ft,
      6,
    );
    expect(shaped.hr).toBeCloseTo(direct.hr, 9);
  });
});
