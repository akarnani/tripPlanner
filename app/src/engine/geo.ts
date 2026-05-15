const EARTH_RADIUS_NM = 3440.065;

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in nautical miles between two lat/lon points. */
export function greatCircleNM(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lon - a.lon);
  const s =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return EARTH_RADIUS_NM * c;
}

/**
 * Sample N+1 points along the great circle from `a` to `b` inclusive. Used
 * for drawing route legs and (in Phase 6) for sampling terrain.
 */
export function interpolateGreatCircle(
  a: LatLon,
  b: LatLon,
  segments: number,
): LatLon[] {
  if (segments < 1) return [a, b];
  const d = greatCircleNM(a, b) / EARTH_RADIUS_NM;
  if (d === 0) return Array.from({ length: segments + 1 }, () => ({ ...a }));
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);
  const out: LatLon[] = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λ = Math.atan2(y, x);
    out.push({ lat: toDeg(φ), lon: toDeg(λ) });
  }
  return out;
}

/** Point at fractional great-circle distance from `a` toward `b`. f<=0
 *  returns a, f>=1 returns b. Useful when only one point is needed and
 *  building the full interpolated path would be wasteful. */
export function pointAtFraction(a: LatLon, b: LatLon, f: number): LatLon {
  if (f <= 0) return { ...a };
  if (f >= 1) return { ...b };
  const d = greatCircleNM(a, b) / EARTH_RADIUS_NM;
  if (d === 0) return { ...a };
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
  const λ = Math.atan2(y, x);
  return { lat: toDeg(φ), lon: toDeg(λ) };
}
