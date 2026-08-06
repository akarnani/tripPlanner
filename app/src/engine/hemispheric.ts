import type { LatLon } from "./geo";

export type FlightRule = "VFR" | "IFR";

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * Initial great-circle course from `a` to `b`, in degrees true,
 * normalized to [0, 360).
 */
export function initialTrueCourseDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Magnetic course from a true course and a magnetic variation. East
 * variation is positive; magnetic = true − variation. Result normalized
 * to [0, 360).
 */
export function magneticCourseDeg(
  trueCourseDeg: number,
  variationDeg: number,
): number {
  return ((trueCourseDeg - variationDeg) % 360 + 360) % 360;
}

/**
 * Hemispheric cruise-altitude rule per FAR 91.159 (VFR) and 91.179
 * (IFR), simplified to courses 0–179° vs 180–359°:
 *
 *   eastbound (0–179°)  · IFR: odd thousands  · VFR: odd + 500
 *   westbound (180–359°)· IFR: even thousands · VFR: even + 500
 *
 * The +500 VFR offset only applies below FL180. At 18,000 ft and
 * above, US airspace is Class A (positive control, IFR only), so
 * the cruise altitude is a straight odd/even thousand regardless
 * of the requested flight rule — a VFR target above 17,999 ft is
 * effectively a request for the next legal IFR level.
 *
 * The rule applies more than 3,000 ft AGL (VFR) or always for IFR
 * cruise; below the floor we return the floor altitude unchanged.
 */
export const CLASS_A_FLOOR_FT = 18000;

export function hemisphericAltitude(
  targetFt: number,
  courseDeg: number,
  rule: FlightRule,
  floorFt = 3000,
): number {
  if (targetFt < floorFt) return targetFt;
  const eastbound = courseDeg >= 0 && courseDeg < 180;
  // Eastbound cruises odd thousands (3000, 5000, 7000, …);
  // westbound cruises even thousands (4000, 6000, 8000, …).
  const firstThousand = eastbound ? 3 : 4;
  for (let k = 0; k < 30; k++) {
    const thousands = (firstThousand + k * 2) * 1000;
    const offset = rule === "VFR" && thousands < CLASS_A_FLOOR_FT ? 500 : 0;
    const candidate = thousands + offset;
    if (candidate >= targetFt) return candidate;
  }
  return targetFt;
}

/**
 * Smallest valid hemispheric altitude that is *also* at least
 * `minSafeFt`. Used by the terrain engine to suggest a replan altitude
 * that both clears terrain and complies with the cruise-altitude rule.
 */
export function nextValidAltitudeAtOrAbove(
  minSafeFt: number,
  courseDeg: number,
  rule: FlightRule,
): number {
  return hemisphericAltitude(minSafeFt, courseDeg, rule);
}

/**
 * Highest valid hemispheric cruise altitude at or *below* `capFt`, or
 * null when no legal level fits under the cap.
 *
 * The mirror image of `hemisphericAltitude`, and the reason a ceiling
 * is expressible at all: every other altitude path in the engine
 * rounds up, so a pilot asking to stay at or under 8,500 ft because of
 * icing, oxygen, or a layer had no way to say so. Searching downward
 * means the answer is a level the pilot may legally cruise at, not the
 * raw number they typed — 8,500 westbound VFR isn't legal, 8,500
 * eastbound VFR is.
 *
 * Returns `capFt` unchanged below `floorFt`, matching
 * `hemisphericAltitude`: the hemispheric rule simply doesn't apply
 * down there.
 */
export function hemisphericAltitudeAtOrBelow(
  capFt: number,
  courseDeg: number,
  rule: FlightRule,
  floorFt = 3000,
): number | null {
  if (capFt < floorFt) return capFt;
  const eastbound = courseDeg >= 0 && courseDeg < 180;
  const firstThousand = eastbound ? 3 : 4;
  let best: number | null = null;
  for (let k = 0; k < 30; k++) {
    const thousands = (firstThousand + k * 2) * 1000;
    const offset = rule === "VFR" && thousands < CLASS_A_FLOOR_FT ? 500 : 0;
    const candidate = thousands + offset;
    if (candidate > capFt) break;
    if (candidate >= floorFt) best = candidate;
  }
  return best;
}
