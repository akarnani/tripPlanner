import type { Aircraft, RunwayDistanceRow } from "@/data/aircraft";
import type { Airport } from "@/data/loaders";

/** Mode for weight handling in runway-fit calculations.
 *
 *  * `maxGross` uses the POH distance at the table's heaviest
 *    published weight (typically max gross). Conservative, doesn't
 *    require an actual-weight estimate.
 *  * `estimated` uses the aircraft's actual weight at the time of
 *    takeoff/landing, interpolating between the POH's published
 *    weight tiers. When the POH only publishes one weight tier
 *    (max gross only), `estimated` returns the same number as
 *    `maxGross` — the engine NEVER fabricates a correction the POH
 *    didn't publish.
 */
export type WeightAssumption = "maxGross" | "estimated";

/** ISA standard temperature in °C at a given pressure altitude. */
export function isaTempC(pressure_alt_ft: number): number {
  return 15 - (pressure_alt_ft / 1000) * 1.98;
}

/** Effective OAT for runway calculations given an ISA delta. */
export function oatFromIsaDelta(
  pressure_alt_ft: number,
  isa_delta_c: number,
): number {
  return isaTempC(pressure_alt_ft) + isa_delta_c;
}

/** Look up a POH runway distance at (weight, pressure_alt, temp).
 *  Returns the cell whose published axes are all the next value at
 *  or above the request — i.e. the next-higher published weight,
 *  the next-higher published pressure altitude, and the next-higher
 *  published temperature. This is the conservative reading a pilot
 *  would take off a POH chart by hand: never read a number "below"
 *  your actual conditions, since heavier / hotter / higher all
 *  lengthen takeoff and landing distance.
 *
 *  No interpolation, ever — the engine never invents a number the
 *  POH didn't print. Inputs above the table's heaviest / highest /
 *  hottest cell clamp to that corner (the POH is silent past the
 *  envelope; the corner is the closest published answer). Inputs
 *  below the smallest published value also clamp to the smallest
 *  cell — same rule, conservatively returns whatever the POH
 *  actually printed nearest the request. */
export function lookupRunwayDistance(
  table: readonly RunwayDistanceRow[],
  weight_lb: number,
  pressure_alt_ft: number,
  temp_c: number,
): { ground_roll_ft: number; total_50ft_ft: number } {
  if (table.length === 0) {
    throw new Error("lookupRunwayDistance: empty table");
  }
  const weights = uniqueAscending(table.map((r) => r.weight_lb));
  const w = nextHigherOrMax(weights, weight_lb);
  const subset = table.filter((r) => r.weight_lb === w);
  const alts = uniqueAscending(subset.map((r) => r.pressure_alt_ft));
  const temps = uniqueAscending(subset.map((r) => r.temp_c));
  const a = nextHigherOrMax(alts, pressure_alt_ft);
  const t = nextHigherOrMax(temps, temp_c);
  const row = subset.find(
    (r) => r.pressure_alt_ft === a && r.temp_c === t,
  );
  if (!row) {
    throw new Error(
      `lookupRunwayDistance: missing cell at weight=${w}, alt=${a}, temp=${t}`,
    );
  }
  return { ground_roll_ft: row.ground_roll_ft, total_50ft_ft: row.total_50ft_ft };
}

function uniqueAscending(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Picks the smallest published value greater than or equal to `v`.
 *  When `v` is below the smallest published value, returns that
 *  smallest published value (the POH didn't print anything for
 *  conditions cooler/lighter/lower than that). When `v` is above
 *  the largest published value, returns the largest — the chart
 *  doesn't extend further and we won't extrapolate. */
function nextHigherOrMax(sortedAscending: readonly number[], v: number): number {
  for (const candidate of sortedAscending) {
    if (candidate >= v) return candidate;
  }
  return sortedAscending[sortedAscending.length - 1];
}

export interface RunwayDistanceInput {
  aircraft: Aircraft;
  /** Field pressure altitude in feet (approximate with field
   *  elevation when actual altimeter setting is unknown). */
  pressure_alt_ft: number;
  /** Outside-air temperature in °C the runway check should assume.
   *  Pass `oatFromIsaDelta(pressure_alt_ft, +15)` to evaluate at
   *  ISA + 15 °C, the default "slightly worse than standard" margin
   *  most pilots use for planning. */
  temp_c: number;
  /** Aircraft weight at takeoff or landing. Ignored when `weight`
   *  is `"maxGross"`. */
  weight_lb?: number;
  /** Whether to use the POH chart as-is (`maxGross`) or scale to
   *  the actual weight. */
  weight: WeightAssumption;
}

export interface RunwayDistanceResult {
  ground_roll_ft: number;
  total_50ft_ft: number;
  /** Reference weight the POH chart was extracted at, in pounds.
   *  Useful for surfacing in tooltips ("computed at 2,550 lb"). */
  reference_weight_lb: number;
  /** Weight actually used for the calculation, in pounds. Equals
   *  `reference_weight_lb` in `maxGross` mode. */
  effective_weight_lb: number;
}

function lookupDistance(
  table: readonly RunwayDistanceRow[],
  ref_lb: number,
  input: RunwayDistanceInput,
): RunwayDistanceResult {
  // In maxGross mode the heaviest published tier defines the
  // distance. In estimated mode we use the actual weight; the
  // lookup picks the next-higher published weight (never a lighter
  // one), so when the POH only publishes one tier both modes
  // return that same cell — no fabricated correction.
  const lookupWeight =
    input.weight === "estimated" && input.weight_lb !== undefined
      ? input.weight_lb
      : ref_lb;
  const base = lookupRunwayDistance(
    table,
    lookupWeight,
    input.pressure_alt_ft,
    input.temp_c,
  );
  // The cell the lookup actually returned, on the weight axis —
  // useful for surfacing in tooltips ("computed at 2,400 lb, the
  // next-higher POH tier above your estimated 2,300 lb").
  const weights = [...new Set(table.map((r) => r.weight_lb))].sort(
    (a, b) => a - b,
  );
  let effective = weights[weights.length - 1];
  for (const w of weights) {
    if (w >= lookupWeight) {
      effective = w;
      break;
    }
  }
  return {
    ground_roll_ft: base.ground_roll_ft,
    total_50ft_ft: base.total_50ft_ft,
    reference_weight_lb: ref_lb,
    effective_weight_lb: effective,
  };
}

/** Required takeoff distance (ground roll + over-50' total) at the
 *  given field and temperature. Returns `null` when the aircraft has
 *  no takeoff table or no weights block — callers treat that as
 *  "runway check not available". */
export function requiredTakeoffDistance(
  input: RunwayDistanceInput,
): RunwayDistanceResult | null {
  const { aircraft } = input;
  if (!aircraft.takeoff || !aircraft.weights) return null;
  return lookupDistance(
    aircraft.takeoff.distance_table,
    aircraft.weights.max_gross_lb,
    input,
  );
}

/** Required landing distance. Same semantics as `requiredTakeoffDistance`
 *  but uses `max_landing_lb` as the table's reference when set
 *  (falls back to `max_gross_lb`). */
export function requiredLandingDistance(
  input: RunwayDistanceInput,
): RunwayDistanceResult | null {
  const { aircraft } = input;
  if (!aircraft.landing || !aircraft.weights) return null;
  const ref =
    aircraft.weights.max_landing_lb ?? aircraft.weights.max_gross_lb;
  return lookupDistance(aircraft.landing.distance_table, ref, input);
}

/** Convert a fuel mass in gallons to pounds using the aircraft's
 *  configured fuel density. */
export function fuelGalToLb(aircraft: Aircraft, gal: number): number {
  return gal * aircraft.fuel.density_lb_per_gal;
}

export interface PerLegWeights {
  /** Pounds at takeoff for the leg (origin → destination). */
  takeoff_lb: number;
  /** Pounds at landing — `takeoff_lb` minus the leg's fuel burn. */
  landing_lb: number;
}

/** Compute per-leg takeoff and landing weights for a sequence of
 *  legs, given the refuel-at-fueling-stops assumption the planner
 *  uses: every leg that departs from a fuel-bearing field is assumed
 *  to be at max gross at takeoff (the pilot tops off and any payload
 *  is implicit). Legs departing a pass-through stop keep the
 *  previous leg's landing weight as their takeoff weight.
 *
 *  For the very first leg (departing origin), if `startingFuelGal`
 *  is less than the aircraft's usable capacity, the takeoff weight
 *  is reduced by the fuel-short amount — matching the user's
 *  request that the configured starting fuel should drive the
 *  origin's takeoff weight. */
export function perLegWeights(input: {
  aircraft: Aircraft;
  /** One entry per leg: gallons consumed during the leg. */
  legFuelBurnGal: readonly number[];
  /** One entry per leg: true if the leg's *origin* refuels (= takeoff
   *  weight resets to max gross). The first leg's entry corresponds
   *  to the trip origin; subsequent entries correspond to the
   *  intermediate stops. The destination doesn't have an entry
   *  here because no leg departs from it. */
  legOriginRefuels: readonly boolean[];
  /** Fuel onboard at the trip origin (gallons). Caps at the
   *  aircraft's usable capacity; reduces the origin takeoff weight
   *  by the fuel-short amount. */
  startingFuelGal: number;
}): PerLegWeights[] | null {
  const { aircraft, legFuelBurnGal, legOriginRefuels, startingFuelGal } = input;
  if (!aircraft.weights) return null;
  const gross = aircraft.weights.max_gross_lb;
  const capacityGal = aircraft.fuel.usable_capacity_gal;
  const out: PerLegWeights[] = [];
  let weight = gross;
  for (let i = 0; i < legFuelBurnGal.length; i++) {
    if (i === 0) {
      // Origin: max gross minus the fuel-short delta if the pilot
      // departed with less than capacity.
      const startGal = Math.min(Math.max(startingFuelGal, 0), capacityGal);
      weight = gross - fuelGalToLb(aircraft, capacityGal - startGal);
    } else if (legOriginRefuels[i]) {
      // Refuel stop: back to max gross at takeoff.
      weight = gross;
    }
    // Else: pass-through. Takeoff weight = previous landing weight.
    const takeoff = weight;
    const landing = takeoff - fuelGalToLb(aircraft, legFuelBurnGal[i]);
    out.push({ takeoff_lb: takeoff, landing_lb: landing });
    weight = landing;
  }
  return out;
}

export interface RunwayFitInput {
  required_ft: number;
  available_ft: number;
  /** Buffer added to `required_ft` before checking against
   *  `available_ft`. Tunes how conservative the fit check is. */
  buffer_ft: number;
}

export type RunwayFitStatus = "ok" | "tight" | "insufficient";

/** Classify whether the available runway is comfortable, tight, or
 *  insufficient against the required distance + buffer.
 *
 *  * `ok` — runway exceeds required + buffer with room to spare.
 *  * `tight` — runway is between (required + buffer) and (required +
 *    2 × buffer). Don't drop the airport, but warn the pilot.
 *  * `insufficient` — runway is shorter than required + buffer. The
 *    airport should be filtered out unless the pilot overrides. */
export function classifyRunwayFit(input: RunwayFitInput): RunwayFitStatus {
  const { required_ft, available_ft, buffer_ft } = input;
  const min = required_ft + buffer_ft;
  if (available_ft < min) return "insufficient";
  if (available_ft < min + buffer_ft) return "tight";
  return "ok";
}

export interface RunwaySettings {
  /** Master toggle. When false, every helper here returns "no info"
   *  and the filter is a no-op. */
  enabled: boolean;
  /** Margin in feet added to the POH required distance before
   *  classifying the airport as fitting / tight / insufficient. */
  buffer_ft: number;
  /** Weight assumption — see `WeightAssumption`. */
  weight: WeightAssumption;
  /** Temperature assumed for the runway calculation, expressed as
   *  degrees above ISA at field pressure altitude. Default +15 °C
   *  gives a small margin for hotter-than-standard summer days. */
  isa_delta_c: number;
}

export const DEFAULT_RUNWAY_SETTINGS: RunwaySettings = {
  enabled: false,
  buffer_ft: 1000,
  weight: "estimated",
  isa_delta_c: 15,
};

/** Whether a runway-fit check is even possible for this aircraft.
 *  False when the aircraft's performance.yaml lacks the runway
 *  data — the filter then defaults to letting all airports through
 *  (the UI surfaces "no POH data" rather than silently dropping the
 *  aircraft's whole world). */
export function aircraftSupportsRunwayCheck(aircraft: Aircraft): boolean {
  return (
    !!aircraft.weights &&
    !!aircraft.takeoff?.distance_table?.length &&
    !!aircraft.landing?.distance_table?.length
  );
}

/** Decide whether an airport can be used by the aircraft, given the
 *  runway settings and the assumed weights at takeoff (departing the
 *  airport) and landing (arriving at the airport).
 *
 *  When the aircraft lacks POH runway data, the function returns
 *  `null` — callers treat that as "no info, allow through".
 *
 *  Otherwise it returns the per-phase fit status (`ok` / `tight` /
 *  `insufficient`) plus a `worst` field that's the worse of the
 *  two. Callers that want the worse-of-both (e.g. the airport
 *  filter that drops insufficient airports) use `worst`; per-leg
 *  warning callers use `takeoff_status` / `landing_status` so the
 *  "Arrival" warning only fires on actual landing concerns. */
export function classifyAirportRunwayFit(input: {
  aircraft: Aircraft;
  airport: Pick<Airport, "max_runway_ft" | "elevation_ft">;
  settings: RunwaySettings;
  takeoff_weight_lb?: number;
  landing_weight_lb?: number;
}): {
  worst: RunwayFitStatus;
  takeoff_status: RunwayFitStatus;
  landing_status: RunwayFitStatus;
  takeoff_required_ft: number;
  landing_required_ft: number;
  available_ft: number;
} | null {
  const { aircraft, airport, settings } = input;
  if (!aircraftSupportsRunwayCheck(aircraft)) return null;
  if (!settings.enabled) return null;
  const elev = airport.elevation_ft ?? 0;
  const oat = oatFromIsaDelta(elev, settings.isa_delta_c);
  const t = requiredTakeoffDistance({
    aircraft,
    pressure_alt_ft: elev,
    temp_c: oat,
    weight: settings.weight,
    weight_lb: input.takeoff_weight_lb,
  });
  const l = requiredLandingDistance({
    aircraft,
    pressure_alt_ft: elev,
    temp_c: oat,
    weight: settings.weight,
    weight_lb: input.landing_weight_lb,
  });
  if (!t || !l) return null;
  const available = airport.max_runway_ft ?? 0;
  // Compare ground roll (not the over-50' obstacle total). Ground
  // roll is what's physically needed to get airborne / stopped on
  // the surface; the over-50' total bakes in a 50 ft climb-out /
  // approach that's an obstacle-clearance concern, not a runway-
  // length one. The buffer covers the margin pilots want above the
  // ground-roll number.
  const takeoff_status = classifyRunwayFit({
    required_ft: t.ground_roll_ft,
    available_ft: available,
    buffer_ft: settings.buffer_ft,
  });
  const landing_status = classifyRunwayFit({
    required_ft: l.ground_roll_ft,
    available_ft: available,
    buffer_ft: settings.buffer_ft,
  });
  const order: Record<RunwayFitStatus, number> = {
    ok: 0,
    tight: 1,
    insufficient: 2,
  };
  const worst: RunwayFitStatus =
    order[takeoff_status] >= order[landing_status]
      ? takeoff_status
      : landing_status;
  return {
    worst,
    takeoff_status,
    landing_status,
    takeoff_required_ft: t.ground_roll_ft,
    landing_required_ft: l.ground_roll_ft,
    available_ft: available,
  };
}

/** Filter a candidate airport set down to those that can accommodate
 *  the aircraft at max gross with the configured runway settings.
 *  Origin and destination are always preserved (the pilot's intent
 *  wins over the conservative filter — they may have access to a
 *  performance shortcut the planner doesn't know about). Airports
 *  with `insufficient` status are dropped; `tight` and `ok` are
 *  kept and the per-leg warnings layer flags the tight cases. */
export function filterByRunwayFit(input: {
  airports: readonly Airport[];
  aircraft: Aircraft;
  settings: RunwaySettings;
  exemptIds?: ReadonlySet<string>;
}): Airport[] {
  const { airports, aircraft, settings, exemptIds } = input;
  if (!settings.enabled || !aircraftSupportsRunwayCheck(aircraft)) {
    return airports.slice();
  }
  return airports.filter((a) => {
    if (exemptIds?.has(a.id)) return true;
    const fit = classifyAirportRunwayFit({
      aircraft,
      airport: a,
      settings,
      // Conservative for the up-front filter: use max gross. Per-leg
      // refinement using actual estimated weights happens later in
      // the warning layer.
      takeoff_weight_lb: aircraft.weights?.max_gross_lb,
      landing_weight_lb:
        aircraft.weights?.max_landing_lb ?? aircraft.weights?.max_gross_lb,
    });
    return !fit || fit.worst !== "insufficient";
  });
}
