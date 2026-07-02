import type { Aircraft } from "@/data/aircraft";
import { cruiseAt } from "./performance";

/** Fuel remaining on landing for each leg of a route (gallons).
 *
 *  Mirrors `perLegWeights` (runway.ts) propagation exactly, just in
 *  fuel units instead of weight:
 *   - The trip departs with `min(startingFuelGal, usable_capacity_gal)`
 *     onboard — starting fuel can never exceed the tanks, and a pilot
 *     who requests less than full tanks flies the origin leg on that
 *     lesser amount (`legOriginRefuels[0]` is a no-op here, same as in
 *     `perLegWeights` — the origin's own "refuel" flag doesn't apply
 *     since there's nothing to top off before the first leg departs).
 *   - Every leg *after* the first whose origin sells compatible fuel
 *     (`legOriginRefuels[i] === true`) is assumed topped off to the
 *     aircraft's full usable capacity before that leg's takeoff — the
 *     pilot doesn't get to run tanks down and still receive a full
 *     load, whether or not `startingFuelGal` requested less than that.
 *   - Legs departing a pass-through stop (`legOriginRefuels[i] ===
 *     false`) carry over whatever fuel was left on landing from the
 *     previous leg. */
export function perLegArrivalFuel(input: {
  aircraft: Aircraft;
  /** One entry per leg: gallons consumed during the leg. */
  legFuelBurnGal: readonly number[];
  /** One entry per leg: true if the leg's *origin* refuels (tops off
   *  to capacity). Same semantics as `perLegWeights`'s field of the
   *  same name — index 0 corresponds to the trip origin and is
   *  ignored (see above). */
  legOriginRefuels: readonly boolean[];
  /** Fuel onboard at the trip origin, in gallons. Clamped to the
   *  aircraft's usable capacity. */
  startingFuelGal: number;
}): number[] {
  const { aircraft, legFuelBurnGal, legOriginRefuels, startingFuelGal } = input;
  const capacityGal = aircraft.fuel.usable_capacity_gal;
  const out: number[] = [];
  let fuelOnboard = Math.min(Math.max(startingFuelGal, 0), capacityGal);
  for (let i = 0; i < legFuelBurnGal.length; i++) {
    if (i > 0 && legOriginRefuels[i]) {
      // Refuel stop: top off to full usable capacity before takeoff.
      fuelOnboard = capacityGal;
    }
    // Else (i === 0, or a pass-through stop): takeoff fuel is
    // whatever's already onboard.
    const arrival = fuelOnboard - legFuelBurnGal[i];
    out.push(arrival);
    fuelOnboard = arrival;
  }
  return out;
}

/** Cruise fuel burn (gallons/hour) at the given altitude. Delegates to
 *  `performance.cruiseAt`, which interpolates *between* the aircraft's
 *  published cruise rows — never beyond them — so this stays
 *  POH-verbatim. */
export function cruiseBurnGph(aircraft: Aircraft, altitude_ft: number): number {
  return cruiseAt(aircraft, altitude_ft).fuel_gph;
}

/** Reserve fuel, in gallons, for the given altitude and reserve time. */
export function reserveFuelGal(input: {
  aircraft: Aircraft;
  altitude_ft: number;
  reserve_min: number;
}): number {
  const gph = cruiseBurnGph(input.aircraft, input.altitude_ft);
  return gph * (input.reserve_min / 60);
}
