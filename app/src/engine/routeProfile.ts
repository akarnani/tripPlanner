import type { Aircraft } from "@/data/aircraft";
import type { PlannedRoute } from "./plan";
import type { DEMSampler } from "./terrain";
import {
  buildLegProfile,
  type LegProfileGradient,
  type LegProfilePoint,
  type LegProfileSpan,
} from "./legProfile";

export interface RouteProfilePoint extends LegProfilePoint {
  /** Which leg of the route this sample belongs to. */
  legIndex: number;
}

export interface RouteProfileAirport {
  distNm: number;
  ident: string;
  elevFt: number;
}

/** One leg's phase boundaries in whole-route cumulative distance. */
export interface RouteProfileSegment {
  legIndex: number;
  startNm: number;
  topOfClimbNm: number;
  topOfDescentNm: number;
  endNm: number;
  cruiseAltFt: number;
  /** Departure / arrival field elevations — the apexes of the
   *  climb/descent gradient cones the UI draws at each airport. */
  startElevFt: number;
  endElevFt: number;
  /** Altitude actually reached at top of climb / held at top of
   *  descent. Equals cruiseAltFt except on short "tent" legs where
   *  the ramps meet below the requested cruise. */
  topAltFt: number;
  /** Standard vs terrain-required climb gradient out of the departure
   *  field (see legProfile's buildLegProfile for how "required" is
   *  derived). */
  climb: LegProfileGradient;
  /** Standard vs terrain-required descent gradient into the arrival
   *  field. */
  descent: LegProfileGradient;
}

export interface RouteProfileData {
  points: RouteProfilePoint[];
  airports: RouteProfileAirport[];
  segments: RouteProfileSegment[];
  spans: Array<LegProfileSpan & { legIndex: number }>;
  totalNm: number;
}

/** Whole-route vertical profile: each leg's climb/cruise/descent
 *  profile (see buildLegProfile) concatenated onto one cumulative
 *  distance axis, with airport tick positions and thin-margin spans
 *  carried through. Points keep their lat/lon so the UI can window the
 *  chart to the portion of the route visible in the map viewport. */
export function buildRouteProfile(input: {
  route: PlannedRoute;
  aircraft: Aircraft;
  dem: DEMSampler;
}): RouteProfileData {
  const { route, aircraft, dem } = input;
  const points: RouteProfilePoint[] = [];
  const airports: RouteProfileAirport[] = [];
  const segments: RouteProfileSegment[] = [];
  const spans: RouteProfileData["spans"] = [];
  let offset = 0;

  route.legs.forEach((leg, legIndex) => {
    const p = buildLegProfile({
      from: leg.fromAirport,
      to: leg.toAirport,
      cruiseAltFt: leg.cruise_alt_ft,
      aircraft,
      dem,
      // Carrying `via` through is what keeps the cumulative axis honest:
      // each leg contributes its own `distance_nm`, so a shaped leg
      // pushes the following airports' ticks out by the detour instead
      // of leaving the chart shorter than the route it describes.
      via: leg.via,
    });
    if (legIndex === 0) {
      airports.push({
        distNm: 0,
        ident: leg.fromAirport.icao ?? leg.fromAirport.lid,
        elevFt: leg.fromAirport.elevation_ft ?? 0,
      });
    }
    // Skip each subsequent leg's first sample — it duplicates the
    // previous leg's arrival point at the shared airport.
    for (const pt of legIndex === 0 ? p.points : p.points.slice(1)) {
      points.push({ ...pt, distNm: offset + pt.distNm, legIndex });
    }
    segments.push({
      legIndex,
      startNm: offset,
      topOfClimbNm: offset + p.topOfClimbNm,
      topOfDescentNm: offset + p.topOfDescentNm,
      endNm: offset + p.distanceNm,
      cruiseAltFt: p.cruiseAltFt,
      startElevFt: leg.fromAirport.elevation_ft ?? 0,
      endElevFt: leg.toAirport.elevation_ft ?? 0,
      // Max profileFt over the leg's points is the apex reached at top
      // of climb, whether that's the requested cruise or (on a short
      // "tent" leg) the point where the ramps meet below it.
      topAltFt: Math.max(...p.points.map((pt) => pt.profileFt)),
      climb: p.climb,
      descent: p.descent,
    });
    for (const s of p.spans) {
      spans.push({
        legIndex,
        kind: s.kind,
        startNm: offset + s.startNm,
        endNm: offset + s.endNm,
      });
    }
    offset += p.distanceNm;
    airports.push({
      distNm: offset,
      ident: leg.toAirport.icao ?? leg.toAirport.lid,
      elevFt: leg.toAirport.elevation_ft ?? 0,
    });
  });

  return { points, airports, segments, spans, totalNm: offset };
}
