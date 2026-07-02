import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { airportSellsCompatibleFuel } from "./filters";
import { greatCircleNM } from "./geo";
import type { FlightRule } from "./hemispheric";
import { buildInteractiveLeg } from "./interactive";
import type { DEMSampler } from "./terrain";
import type { VariationFn } from "./routing";

/** Cap on how many nearby airports get a full `buildInteractiveLeg`
 *  probe. Ranking by detour first and only probing the closest
 *  handful keeps the interactive candidate list instant even over a
 *  dense CONUS airport set. */
const MAX_PROBE_COUNT = 40;

const DEFAULT_LIMIT = 5;

export interface InteractiveCandidate {
  airport: Airport;
  /** d(departure→candidate) + d(candidate→destination) −
   *  d(departure→destination), in nautical miles. */
  detourNm: number;
  /** d(departure→candidate), in nautical miles. */
  legDistNm: number;
  /** Where `legDistNm` falls relative to the pilot's range rings:
   *  `in` — inside the with-reserve ring; `past-reserve` — beyond the
   *  reserve ring but still within the no-reserve (dashed) ring;
   *  `out` — beyond even the dashed ring (only reachable if a caller
   *  passes an already-filtered airport set that includes one). */
  rangeStatus: "in" | "past-reserve" | "out";
  /** Margin in nm relative to whichever ring `rangeStatus` refers to:
   *  positive gallons-to-spare distance when `in`; positive overrun
   *  distance when `past-reserve` or `out`. */
  spareNm: number;
  sellsFuel: boolean;
  /** From `buildInteractiveLeg`'s extras for the departure→candidate
   *  leg. Zero when the leg has no terrain penalty (or no DEM). */
  arrivalShortfallFt: number;
  departureShortfallFt: number;
}

/** Rank nearby airports as candidate next-stops for interactive
 *  route-building: filter to the dashed (no-reserve) range ring,
 *  compute each candidate's detour over the direct departure→
 *  destination course, sort by detour ascending, probe at most the
 *  nearest `MAX_PROBE_COUNT` with `buildInteractiveLeg` for terrain
 *  shortfalls, and return the best `limit` (default 5). */
export function rankInteractiveCandidates(input: {
  airports: readonly Airport[];
  departure: Airport;
  destination: Airport;
  excludeIds: ReadonlySet<string>;
  aircraft: Aircraft;
  targetAltFt: number;
  flightRule: FlightRule;
  startingFuelGal: number;
  reserveHr: number;
  rangeSolidNm: number;
  rangeDashedNm: number;
  variation: VariationFn;
  dem?: DEMSampler;
  limit?: number;
}): InteractiveCandidate[] {
  const {
    airports,
    departure,
    destination,
    excludeIds,
    aircraft,
    targetAltFt,
    flightRule,
    startingFuelGal,
    reserveHr,
    rangeSolidNm,
    rangeDashedNm,
    variation,
    dem,
    limit,
  } = input;

  const directNm = greatCircleNM(departure, destination);
  const fuelType = aircraft.fuel.type;

  type Ranked = { airport: Airport; detourNm: number; legDistNm: number };
  const ranked: Ranked[] = [];
  for (const a of airports) {
    if (a.id === departure.id || a.id === destination.id) continue;
    if (excludeIds.has(a.id)) continue;
    const legDistNm = greatCircleNM(departure, a);
    // Only airports within the dashed (no-reserve) ring are eligible
    // — anything farther can't be reached at all on the fuel onboard.
    if (legDistNm > rangeDashedNm) continue;
    const detourNm = legDistNm + greatCircleNM(a, destination) - directNm;
    ranked.push({ airport: a, detourNm, legDistNm });
  }
  ranked.sort((x, y) => x.detourNm - y.detourNm);

  const probeSet = ranked.slice(0, MAX_PROBE_COUNT);
  const candidates: InteractiveCandidate[] = probeSet.map((r) => {
    const { legDistNm } = r;
    let rangeStatus: InteractiveCandidate["rangeStatus"];
    let spareNm: number;
    if (legDistNm <= rangeSolidNm) {
      rangeStatus = "in";
      spareNm = rangeSolidNm - legDistNm;
    } else if (legDistNm <= rangeDashedNm) {
      rangeStatus = "past-reserve";
      spareNm = legDistNm - rangeSolidNm;
    } else {
      rangeStatus = "out";
      spareNm = legDistNm - rangeDashedNm;
    }

    const { leg } = buildInteractiveLeg({
      from: departure,
      to: r.airport,
      aircraft,
      targetAltFt,
      flightRule,
      startingFuelGal,
      reserveHr,
      variation,
      dem,
    });

    return {
      airport: r.airport,
      detourNm: r.detourNm,
      legDistNm,
      rangeStatus,
      spareNm,
      sellsFuel: airportSellsCompatibleFuel(r.airport, fuelType),
      arrivalShortfallFt: leg.extra?.terrain_arrival_shortfall_ft ?? 0,
      departureShortfallFt: leg.extra?.terrain_departure_shortfall_ft ?? 0,
    };
  });

  return candidates.slice(0, limit ?? DEFAULT_LIMIT);
}
