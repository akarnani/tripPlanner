import type { Airport, NavPoint } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { alongTrackFraction, greatCircleNM, polylineLengthNM } from "./geo";
import {
  initialTrueCourseDeg,
  magneticCourseDeg,
  type FlightRule,
} from "./hemispheric";
import { decideLegAltitude, type AltitudeBand } from "./altitudeBand";
import type { DEMSampler, VariationFn } from "./terrain";

export interface DetourSuggestion {
  navPoint: NavPoint;
  /** Extra ground distance versus the direct great circle, in nm. */
  addedNm: number;
  /** Cruise altitude the shaped leg would fly. */
  altFt: number;
}

export interface SuggestDetoursInput {
  from: Airport;
  to: Airport;
  navPoints: readonly NavPoint[];
  band: AltitudeBand;
  flightRule: FlightRule;
  aircraft: Aircraft;
  dem?: DEMSampler;
  variation?: VariationFn;
  /** How many to return. Offering forty options that all "work" is
   *  worse than offering none. */
  limit?: number;
  /** Reject anything that lengthens the leg by more than this fraction
   *  of its direct distance. Without it the search happily proposes
   *  routing round the south end of the Sierra: a genuine 4,000 ft win
   *  that costs +235 nm on a 74 nm leg. */
  maxAddedFraction?: number;
  /** Absolute cap on added distance, for very long legs where even a
   *  small fraction is a lot of flying. */
  maxAddedNm?: number;
}

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_ADDED_FRACTION = 0.35;
const DEFAULT_MAX_ADDED_NM = 150;

/**
 * Nav points that would make an otherwise-infeasible leg flyable
 * inside the altitude band, cheapest detour first.
 *
 * Ranked purely by added distance. In practice that tracks "fewest
 * extra fuel stops" closely enough — a detour long enough to add a stop
 * is long enough to lose on distance — and it has the advantage of
 * being a number the pilot can check against the map.
 *
 * Measured against the committed terrain grid, the winners are
 * strikingly cheap: on every mountain route tested, a ~25 nm lateral
 * nudge costing 3-7 nm of extra distance bought a full 2,000 ft of
 * required altitude. Candidates that project outside the leg are
 * skipped, so this never proposes doubling back.
 */
export function suggestDetours(input: SuggestDetoursInput): DetourSuggestion[] {
  const { from, to, navPoints, band, flightRule, aircraft, dem } = input;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const direct = greatCircleNM(from, to);
  if (direct <= 0) return [];
  const maxAdded = Math.min(
    direct * (input.maxAddedFraction ?? DEFAULT_MAX_ADDED_FRACTION),
    input.maxAddedNm ?? DEFAULT_MAX_ADDED_NM,
  );
  const variation_deg = input.variation?.(from) ?? null;

  const out: DetourSuggestion[] = [];
  for (const p of navPoints) {
    // Must sit alongside the leg, not before or past it.
    const f = alongTrackFraction(from, to, p);
    if (f <= 0.05 || f >= 0.95) continue;

    const addedNm = polylineLengthNM([from, p, to]) - direct;
    if (addedNm <= 0 || addedNm > maxAdded) continue;

    const segmentCoursesDeg = [
      courseDeg(from, p, variation_deg),
      courseDeg(p, to, variation_deg),
    ];
    const decision = decideLegAltitude({
      from,
      to,
      segmentCoursesDeg,
      band,
      flightRule,
      aircraft,
      dem,
      via: [p],
    });
    // The same fail-closed rule the gate uses applies to its own
    // suggestions: a detour that leaves the terrain grid is not a
    // detour we know anything about.
    if (decision.altFt === null) continue;

    out.push({ navPoint: p, addedNm, altFt: decision.altFt });
  }

  out.sort((a, b) => a.addedNm - b.addedNm);
  return out.slice(0, limit);
}

function courseDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  variation_deg: number | null,
): number {
  const t = initialTrueCourseDeg(a, b);
  return variation_deg !== null ? magneticCourseDeg(t, variation_deg) : t;
}
