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

/** Approximate a geodesic circle of `radiusNm` around `center`, sampled
 *  at `segments` equally-spaced bearings (0..360°). Returns a closed
 *  ring (first point repeated as the last) so the result can drop
 *  straight into a GeoJSON Polygon. The result is a true small circle
 *  on the sphere — not an equirectangular ellipse — so the rendered
 *  ring stays visually correct near the poles or at large radii. */
export function geodesicCircle(
  center: LatLon,
  radiusNm: number,
  segments: number,
): LatLon[] {
  if (radiusNm <= 0 || segments < 3) return [];
  const δ = radiusNm / EARTH_RADIUS_NM;
  const φ1 = toRad(center.lat);
  const λ1 = toRad(center.lon);
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);
  const out: LatLon[] = [];
  for (let i = 0; i <= segments; i++) {
    const θ = (2 * Math.PI * i) / segments;
    const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
    const φ2 = Math.asin(sinφ2);
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * sinδ * cosφ1,
        cosδ - sinφ1 * sinφ2,
      );
    out.push({ lat: toDeg(φ2), lon: toDeg(λ2) });
  }
  return out;
}

/**
 * Total length of a multi-segment path, summing each great-circle
 * segment. A path of fewer than two points has zero length.
 */
export function polylineLengthNM(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += greatCircleNM(points[i], points[i + 1]);
  }
  return total;
}

/**
 * Sample a multi-segment path at roughly `spacingNm`, following each
 * segment's great circle. Vertices are always included, so a track that
 * bends through a nav point is sampled *through* the bend rather than
 * across it — which is the whole point of shaping a leg.
 *
 * Consecutive duplicate points are dropped so a shape point that
 * coincides with an endpoint doesn't emit a zero-length segment.
 */
export function interpolatePolyline(
  points: readonly LatLon[],
  spacingNm: number,
): LatLon[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ ...points[0] }];
  const out: LatLon[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const d = greatCircleNM(a, b);
    if (d <= 0) continue;
    const segments = Math.max(1, Math.ceil(d / spacingNm));
    const leg = interpolateGreatCircle(a, b, segments);
    // Drop the shared vertex except on the first segment.
    out.push(...(out.length === 0 ? leg : leg.slice(1)));
  }
  // Degenerate path (every segment zero-length): still report the point.
  return out.length === 0 ? [{ ...points[0] }] : out;
}

/**
 * Where `p` falls along the great circle from `a` to `b`, as a fraction
 * of that path's length. 0 is abeam `a`, 1 is abeam `b`; values outside
 * [0, 1] mean `p` projects before or past the endpoints.
 *
 * Used to decide which leg of a multi-stop span a shape point belongs
 * to. This is a flat-earth projection onto the chord, which is accurate
 * enough for ordering points along a leg even though it is not a true
 * geodesic cross-track solution.
 */
export function alongTrackFraction(a: LatLon, b: LatLon, p: LatLon): number {
  // Work in a local equirectangular frame around `a`, scaling longitude
  // by cos(lat) so degrees are comparable in both axes.
  const latScale = Math.cos(toRad((a.lat + b.lat) / 2));
  const bx = (b.lon - a.lon) * latScale;
  const by = b.lat - a.lat;
  const px = (p.lon - a.lon) * latScale;
  const py = p.lat - a.lat;
  const denom = bx * bx + by * by;
  if (denom === 0) return 0;
  return (px * bx + py * by) / denom;
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
