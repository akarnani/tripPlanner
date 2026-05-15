import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { airportSellsCompatibleFuel } from "./filters";
import { greatCircleNM } from "./geo";
import { climbFromTo, cruiseAt } from "./performance";
import {
  hemisphericAltitude,
  initialTrueCourseDeg,
  magneticCourseDeg,
  type FlightRule,
} from "./hemispheric";
import type { Edge, VariationFn } from "./routing";
import { computeTerrainPenalty } from "./terrainPenalty";
import { legMinSafeCruiseAltFt, type DEMSampler } from "./terrain";
import type { Leg, PlannedRoute } from "./plan";

/** Per-leg cruise altitude override. `null` / `undefined` falls back
 *  to the hemispheric-correct rounding of the global target altitude. */
export type LegAltitudeOverride = number | null | undefined;

export interface BuildInteractiveLegInput {
  from: Airport;
  to: Airport;
  aircraft: Aircraft;
  /** Pilot-chosen cruise altitude floor (e.g. 6,500 ft VFR). The leg
   *  flies at the lowest hemispheric-legal level at or above this for
   *  its actual magnetic course. */
  targetAltFt: number;
  /** Optional per-leg override. When provided, that exact altitude is
   *  used regardless of the hemispheric rule — the pilot has said
   *  "this leg flies at X". */
  overrideAltFt?: LegAltitudeOverride;
  flightRule: FlightRule;
  /** Fuel onboard at takeoff for this leg, in gallons. The caller
   *  resets this to the aircraft's usable capacity at every refuel
   *  stop. */
  startingFuelGal: number;
  /** Pilot reserve in hours of cruise burn. The leg is flagged
   *  infeasible if it would burn into this margin. */
  reserveHr: number;
  variation?: VariationFn;
  dem?: DEMSampler;
}

export interface BuildInteractiveLegResult {
  leg: Leg;
  /** True when the leg can be flown with the supplied starting fuel
   *  while still landing with the full reserve. False when the burn
   *  exceeds the available fuel; the leg is still returned (so the
   *  UI can show what would have happened), but the caller should
   *  surface a warning rather than treat it as a valid plan. */
  feasible: boolean;
  /** Gallons short of holding the reserve. Positive when the leg
   *  is infeasible; zero when feasible. */
  fuel_short_gal: number;
}

/** Compute the per-leg numbers (distance, time, fuel, course,
 *  altitude, terrain penalty) for one interactive-mode leg. Mirrors
 *  the math in `routing.buildGraph` but is callable for a single
 *  user-chosen segment without standing up a routing graph. */
export function buildInteractiveLeg(
  input: BuildInteractiveLegInput,
): BuildInteractiveLegResult {
  const {
    from,
    to,
    aircraft,
    targetAltFt,
    overrideAltFt,
    flightRule,
    startingFuelGal,
    reserveHr,
    variation,
    dem,
  } = input;
  const distance_nm = greatCircleNM(from, to);
  const true_course_deg = initialTrueCourseDeg(from, to);
  const variation_deg = variation?.(from) ?? null;
  const magnetic_course_deg =
    variation_deg !== null
      ? magneticCourseDeg(true_course_deg, variation_deg)
      : true_course_deg;
  // "Auto" altitude: round the pilot's target to a hemispheric-legal
  // level, then bump it up if terrain on this leg requires more
  // clearance. The bump uses the standard 2,000 ft buffer so a leg
  // crossing the Rockies doesn't quietly cruise at 6,500 ft when
  // the great-circle path tops 12,000 ft. The pilot can still
  // override with an explicit `overrideAltFt`.
  const defaultAlt = hemisphericAltitude(
    targetAltFt,
    magnetic_course_deg,
    flightRule,
  );
  const terrainFloor = dem
    ? legMinSafeCruiseAltFt({
        from,
        to,
        flightRule,
        variation,
        dem,
      })
    : 0;
  const cruise_alt_ft =
    overrideAltFt !== null && overrideAltFt !== undefined
      ? overrideAltFt
      : Math.max(defaultAlt, terrainFloor);

  const c = cruiseAt(aircraft, cruise_alt_ft);
  const fromElev = from.elevation_ft ?? 0;
  const climb = climbFromTo(aircraft, fromElev, cruise_alt_ft);
  const climb_distance_nm = Math.min(climb.distance_nm, distance_nm);
  const climb_fraction =
    climb.distance_nm > 0 ? climb_distance_nm / climb.distance_nm : 0;
  const climb_time_hr = climb.time_hr * climb_fraction;
  const climb_fuel_gal = climb.fuel_gal * climb_fraction;
  const cruise_distance_nm = Math.max(0, distance_nm - climb_distance_nm);
  const cruise_time_hr = cruise_distance_nm / c.tas_kt;
  const cruise_fuel_gal = cruise_time_hr * c.fuel_gph;
  const time_hr = climb_time_hr + cruise_time_hr;
  const fuel_gal = climb_fuel_gal + cruise_fuel_gal;
  const reserve_gal = reserveHr * c.fuel_gph;
  const fuel_short_gal = Math.max(0, fuel_gal + reserve_gal - startingFuelGal);

  const extra: Record<string, number> = {};
  if (dem) {
    const penalty = computeTerrainPenalty({
      from,
      to,
      cruise_alt_ft,
      climb_speed_kt:
        climb.time_hr > 0 ? climb.distance_nm / climb.time_hr : c.tas_kt * 0.65,
      climb_rate_fpm: aircraft.climb.rate_fpm,
      dem,
      distance_nm,
      true_course_deg,
    });
    if (penalty.hr > 0) {
      extra.terrain_penalty_hr = penalty.hr;
      extra.terrain_departure_shortfall_ft = penalty.departure_shortfall_ft;
      extra.terrain_arrival_shortfall_ft = penalty.arrival_shortfall_ft;
    }
  }

  const edge: Edge = {
    from: from.id,
    to: to.id,
    distance_nm,
    time_hr,
    fuel_gal,
    true_course_deg,
    magnetic_course_deg,
    variation_deg,
    cruise_alt_ft,
    tas_kt: c.tas_kt,
    fuel_gph: c.fuel_gph,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  return {
    leg: { ...edge, fromAirport: from, toAirport: to },
    feasible: fuel_short_gal <= 0,
    fuel_short_gal,
  };
}

export interface BuildInteractiveRouteInput {
  /** Ordered sequence of airports the route visits, origin first and
   *  destination last. Length must be ≥ 2. */
  sequence: readonly Airport[];
  aircraft: Aircraft;
  targetAltFt: number;
  flightRule: FlightRule;
  reserveHr: number;
  /** Fuel onboard at departure from `sequence[0]`. Subsequent legs
   *  assume a refuel top-off at every intermediate stop. */
  startingFuelGal: number;
  /** Per-leg altitude overrides indexed by leg position (0 = origin →
   *  first stop). Missing or null entries fall back to the
   *  hemispheric-correct rounding of `targetAltFt`. */
  legAltitudes?: readonly LegAltitudeOverride[];
  variation?: VariationFn;
  dem?: DEMSampler;
}

export interface BuildInteractiveRouteResult {
  route: PlannedRoute;
  /** Per-leg fuel-feasibility flags, parallel to `route.legs`. A
   *  `false` entry means the planned leg burns into the reserve; the
   *  UI should surface this as a warning. */
  feasibility: boolean[];
  /** For each stop in `sequence.slice(1, -1)` (i.e. excluding origin
   *  and destination), whether the airport sells compatible fuel.
   *  False entries are "pass-through" stops — the next leg starts on
   *  whatever fuel remains rather than a full tank. The UI surfaces
   *  these as warnings. */
  stopRefuels: boolean[];
  /** Fuel onboard at takeoff for each leg in `route.legs`. Element
   *  `i` is the gallons available departing `legs[i].fromAirport`. */
  legStartFuelGal: number[];
}

/** Build a `PlannedRoute` directly from an ordered sequence of
 *  airports without going through the routing graph. Used by the
 *  interactive-planning UI where the user picks each stop by hand.
 *
 *  Each intermediate stop is treated as a refuel if it sells the
 *  aircraft's fuel type, otherwise as a pass-through — fuel state
 *  carries through to the next leg. The first leg uses
 *  `startingFuelGal`; refuel stops also top off to that same value
 *  (capped at usable capacity), since a pilot who departs partially
 *  loaded for weight reasons typically wants to keep that loading
 *  consistent at every fuel stop. To always-refuel-to-full, set
 *  `startingFuelGal` to usable capacity. */
export function buildInteractiveRoute(
  input: BuildInteractiveRouteInput,
): BuildInteractiveRouteResult {
  const { sequence, aircraft, startingFuelGal } = input;
  if (sequence.length < 2) {
    throw new Error("buildInteractiveRoute needs at least origin + destination");
  }
  const capacity = aircraft.fuel.usable_capacity_gal;
  const fuelType = aircraft.fuel.type;
  const refuelCapGal = Math.min(Math.max(startingFuelGal, 0), capacity);
  const legs: Leg[] = [];
  const feasibility: boolean[] = [];
  const legStartFuelGal: number[] = [];
  const stopRefuels: boolean[] = [];
  let fuelOnboard = refuelCapGal;
  for (let i = 0; i < sequence.length - 1; i++) {
    legStartFuelGal.push(fuelOnboard);
    const r = buildInteractiveLeg({
      from: sequence[i],
      to: sequence[i + 1],
      aircraft,
      targetAltFt: input.targetAltFt,
      overrideAltFt: input.legAltitudes?.[i],
      flightRule: input.flightRule,
      startingFuelGal: fuelOnboard,
      reserveHr: input.reserveHr,
      variation: input.variation,
      dem: input.dem,
    });
    legs.push(r.leg);
    feasibility.push(r.feasible);
    // Propagate fuel to the next leg. Refuel stops top off to the
    // pilot's configured starting-fuel level (consistent loading
    // strategy); pass-through stops burn through. The destination
    // is the last airport and never feeds another leg, so we skip
    // the refuel/pass-through bookkeeping for it.
    if (i < sequence.length - 2) {
      const arrival = sequence[i + 1];
      const refuels = airportSellsCompatibleFuel(arrival, fuelType);
      stopRefuels.push(refuels);
      fuelOnboard = refuels
        ? refuelCapGal
        : Math.max(0, fuelOnboard - r.leg.fuel_gal);
    }
  }
  const totals = legs.reduce(
    (acc, l) => ({
      distance_nm: acc.distance_nm + l.distance_nm,
      time_hr: acc.time_hr + l.time_hr,
      fuel_gal: acc.fuel_gal + l.fuel_gal,
      stops: acc.stops,
    }),
    { distance_nm: 0, time_hr: 0, fuel_gal: 0, stops: legs.length - 1 },
  );
  return {
    route: { costFnId: "interactive", cost: totals.time_hr, legs, totals },
    feasibility,
    stopRefuels,
    legStartFuelGal,
  };
}

export interface RangeRingNm {
  /** Range with the configured reserve still onboard at landing. */
  solid_nm: number;
  /** Range if every drop of fuel is burned (no reserve). */
  dashed_nm: number;
}

/** Compute the inner (with-reserve) and outer (no-reserve) ranges
 *  for an interactive-mode range ring centered on a departure point.
 *  Both rings are scaled to the available fuel — when the airplane
 *  is short of a full tank (the first leg from the pilot's chosen
 *  starting-fuel state), both rings shrink proportionally. */
export function interactiveRangeRings(input: {
  aircraft: Aircraft;
  altitude_ft: number;
  reserve_hr: number;
  fuel_onboard_gal: number;
}): RangeRingNm {
  const { aircraft, altitude_ft, reserve_hr, fuel_onboard_gal } = input;
  const cruise = cruiseAt(aircraft, altitude_ft);
  if (cruise.fuel_gph <= 0 || cruise.tas_kt <= 0 || fuel_onboard_gal <= 0) {
    return { solid_nm: 0, dashed_nm: 0 };
  }
  const reserve_gal = Math.max(0, reserve_hr * cruise.fuel_gph);
  const solid_burnable = Math.max(0, fuel_onboard_gal - reserve_gal);
  const dashed_burnable = fuel_onboard_gal;
  return {
    solid_nm: (solid_burnable / cruise.fuel_gph) * cruise.tas_kt,
    dashed_nm: (dashed_burnable / cruise.fuel_gph) * cruise.tas_kt,
  };
}

/** Recommend a cruise altitude for a leg, honoring the hemispheric
 *  rule and the aircraft's own cruise table. Returns the candidate
 *  altitudes that are (a) the legal default per the hemispheric rule
 *  applied to the pilot's target altitude, (b) the most fuel-efficient
 *  legal altitude across the aircraft's published cruise rows, and
 *  (c) the lowest legal altitude that still clears any minimum-safe
 *  floor. The UI shows whichever differ from the current selection
 *  as suggestions on hover. */
export interface AltitudeRecommendation {
  defaultAltFt: number;
  cheapestAltFt: number;
  minSafeAltFt: number | null;
}

export function recommendLegAltitude(input: {
  aircraft: Aircraft;
  from: Airport;
  to: Airport;
  targetAltFt: number;
  flightRule: FlightRule;
  variation?: VariationFn;
  /** Optional terrain-driven floor (cruise must be at or above this
   *  to clear the terrain corridor with the standard buffer). When
   *  provided, the cheapest recommendation is constrained by it. */
  minSafeAltFt?: number | null;
}): AltitudeRecommendation {
  const { aircraft, from, to, targetAltFt, flightRule, variation, minSafeAltFt } =
    input;
  const trueCourse = initialTrueCourseDeg(from, to);
  const varDeg = variation?.(from) ?? null;
  const magCourse =
    varDeg !== null ? magneticCourseDeg(trueCourse, varDeg) : trueCourse;
  const defaultAlt = hemisphericAltitude(targetAltFt, magCourse, flightRule);
  // Scan the aircraft's cruise rows. Each row is a published altitude
  // with its own TAS + GPH, so the nm-per-gallon is a single fairly
  // reliable knob for "most efficient at this altitude". We snap each
  // candidate to the nearest hemispheric-legal level for the leg's
  // magnetic course so a recommendation is always actually flyable.
  let bestAlt = defaultAlt;
  let bestNmPerGal = -Infinity;
  const floor = minSafeAltFt ?? -Infinity;
  for (const row of aircraft.cruise) {
    const candidate = hemisphericAltitude(row.altitude_ft, magCourse, flightRule);
    if (candidate < floor) continue;
    const nmPerGal = row.tas_kt / row.fuel_gph;
    if (nmPerGal > bestNmPerGal) {
      bestNmPerGal = nmPerGal;
      bestAlt = candidate;
    }
  }
  return {
    defaultAltFt: defaultAlt,
    cheapestAltFt: bestAlt,
    minSafeAltFt: minSafeAltFt ?? null,
  };
}
