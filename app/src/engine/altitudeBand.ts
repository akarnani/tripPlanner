import type { Aircraft } from "@/data/aircraft";
import type { LatLon } from "./geo";
import {
  hemisphericAltitude,
  hemisphericAltitudeAtOrBelow,
  type FlightRule,
} from "./hemispheric";
import { maxPublishedCruiseAltFt } from "./performance";
import {
  TERRAIN_BUFFER_FT,
  hasTerrainBound,
  legTerrainPeakFt,
  type DEMSampler,
} from "./terrain";

/**
 * The altitudes a pilot is willing to cruise at.
 *
 * `minFt` is the existing target altitude renamed — the engine has
 * always treated it as a floor, rounding up to the next legal level.
 * `maxFt` is new, and it is the whole feature: a hard ceiling for
 * pilots who can't or won't climb higher. Icing, an oxygen
 * requirement, a solid layer above, an unpressurised cabin, a
 * turbocharger they'd rather not lean on — the reasons vary and the
 * planner doesn't need to know which one applies.
 *
 * `maxFt: null` means no ceiling, which is exactly the behaviour
 * before this existed. "Hold exactly 9,000" is the degenerate band
 * `{ minFt: 9000, maxFt: 9000 }`.
 */
export interface AltitudeBand {
  minFt: number;
  maxFt: number | null;
}

export type LegAltitudeRejection =
  /** No hemispheric-legal cruising level fits inside the band. */
  | "no-legal-level"
  /** Terrain (plus the clearance buffer) rises above the ceiling. */
  | "terrain"
  /** The DEM has no coverage for part of the leg, so clearance can't
   *  be established. Distinct from "terrain" because the honest answer
   *  is "unknown", and unknown must not read as clear. */
  | "terrain-unknown"
  /** The band's ceiling is at or below an endpoint's field elevation. */
  | "field-elevation"
  /** Above the aircraft's highest published cruise altitude. */
  | "above-poh-ceiling";

export interface LegAltitudeDecision {
  /** Altitude to fly, or null when the leg is infeasible in the band. */
  altFt: number | null;
  rejection?: LegAltitudeRejection;
  /** For a terrain rejection, the lowest altitude that *would* clear —
   *  what the caller reports as "this leg needs 10,300 ft". */
  requiredAltFt?: number;
}

export interface LegAltitudeInput {
  from: LatLon & { elevation_ft?: number | null };
  to: LatLon & { elevation_ft?: number | null };
  /** Magnetic courses of each segment of the leg's ground track. A
   *  plain leg has one; a leg shaped through nav points has several. */
  segmentCoursesDeg: readonly number[];
  band: AltitudeBand;
  flightRule: FlightRule;
  aircraft: Aircraft;
  dem?: DEMSampler;
  via?: readonly LatLon[];
  bufferFt?: number;
  /** Terminal legs may be exempted from the ceiling — a field at 9,078
   *  ft cannot be served by an 8,500 ft cap, and refusing outright
   *  makes the mode useless in the mountain west. The leg still gets
   *  its ordinary terrain warning post-plan, so the exemption relaxes
   *  the gate without hiding the hazard. */
  exemptFromCeiling?: boolean;
}

/**
 * Chooses a leg's cruise altitude inside the band, or explains why the
 * leg can't be flown in it.
 *
 * Order matters: the cheap arithmetic checks run before any DEM
 * sampling, and the coarse terrain bound runs before exact sampling.
 * This is called per candidate edge during graph construction, so the
 * common case — plenty of clearance, or obviously none — must not pay
 * for a full-resolution terrain walk.
 */
export function decideLegAltitude(
  input: LegAltitudeInput,
): LegAltitudeDecision {
  const { band, flightRule, aircraft, segmentCoursesDeg } = input;
  const buffer = input.bufferFt ?? TERRAIN_BUFFER_FT;
  const ceiling = input.exemptFromCeiling ? null : band.maxFt;

  // The POH limit is not a preference and the terminal-leg exemption
  // doesn't reach it: exempting a leg from the pilot's ceiling is a
  // routing choice, but no exemption makes an aeroplane cruise above
  // the highest altitude its manufacturer published numbers for.
  const pohCeiling = maxPublishedCruiseAltFt(aircraft);
  if (band.minFt > pohCeiling) {
    return { altFt: null, rejection: "above-poh-ceiling" };
  }

  // No ceiling: the pre-existing behaviour, verbatim. Highest of the
  // per-segment levels, because a bent leg's segments can disagree.
  if (ceiling === null) {
    let alt = 0;
    for (const c of segmentCoursesDeg) {
      const a = hemisphericAltitude(band.minFt, c, flightRule);
      if (a > alt) alt = a;
    }
    return alt > pohCeiling
      ? { altFt: null, rejection: "above-poh-ceiling" }
      : { altFt: alt };
  }

  // Highest legal level under the ceiling that every segment accepts.
  // Segments of opposite parity can't share one, so take the lowest of
  // the per-segment answers and require it to still clear the floor.
  let alt: number | null = null;
  for (const c of segmentCoursesDeg) {
    const a = hemisphericAltitudeAtOrBelow(ceiling, c, flightRule);
    if (a === null) return { altFt: null, rejection: "no-legal-level" };
    if (alt === null || a < alt) alt = a;
  }
  if (alt === null || alt < band.minFt) {
    return { altFt: null, rejection: "no-legal-level" };
  }
  if (alt > pohCeiling) return { altFt: null, rejection: "above-poh-ceiling" };

  // Cheapest possible terrain check: an endpoint's own field elevation
  // already above the chosen altitude needs no DEM at all.
  const fieldFt = Math.max(
    input.from.elevation_ft ?? 0,
    input.to.elevation_ft ?? 0,
  );
  if (fieldFt + buffer > alt) {
    return {
      altFt: null,
      rejection: "field-elevation",
      requiredAltFt: fieldFt + buffer,
    };
  }

  const dem = input.dem;
  if (!dem) return { altFt: alt };

  // Coarse pass. The bound never under-reports, so clearing it is
  // proof; failing it only means we have to look properly.
  if (hasTerrainBound(dem) && (!input.via || input.via.length === 0)) {
    const bound = dem.maxTerrainAlongFt(input.from, input.to);
    if (bound === null) {
      return { altFt: null, rejection: "terrain-unknown" };
    }
    if (bound + buffer <= alt) return { altFt: alt };
  }

  const { peakFt, offGrid } = legTerrainPeakFt({
    from: input.from,
    to: input.to,
    dem,
    via: input.via,
  });
  // Fail closed. The DEM is CONUS-only and ~500 airports in the
  // dataset sit outside it, nearly all of them Alaskan; treating "no
  // data" as "clear" would have the app assert a route works at 8,000
  // ft over terrain it cannot see.
  if (offGrid) return { altFt: null, rejection: "terrain-unknown" };
  if (peakFt === null) return { altFt: alt };
  if (peakFt + buffer > alt) {
    return {
      altFt: null,
      rejection: "terrain",
      requiredAltFt: peakFt + buffer,
    };
  }
  return { altFt: alt };
}
