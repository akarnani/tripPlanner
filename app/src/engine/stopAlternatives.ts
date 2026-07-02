import type { Airport } from "@/data/loaders";
import type { Aircraft } from "@/data/aircraft";
import { costFnById } from "./costFns";
import { greatCircleNM } from "./geo";
import type { FlightRule } from "./hemispheric";
import { buildInteractiveLeg } from "./interactive";
import {
  buildLegProfile,
  NORMAL_CLIMB_MAX_FT_PER_NM,
  NORMAL_DESCENT_MAX_DEG,
} from "./legProfile";
import { usableRange } from "./performance";
import type { PlannedRoute } from "./plan";
import {
  classifyAirportRunwayFit,
  type RunwaySettings,
} from "./runway";
import type { Edge, VariationFn } from "./routing";
import type { DEMSampler } from "./terrain";

/** How many nearby-by-detour airports get a full two-leg fuel-feasibility
 *  probe per stop, once the detour cap has already trimmed the pool.
 *  This runs two `buildInteractiveLeg` calls per candidate (prev→c and
 *  c→next) instead of one, so the cap is tighter than a typical probe
 *  count — this only runs on demand (panel expand), not per render, but
 *  there's no reason to probe airports that are obviously off the
 *  direct course. */
const PROBE_COUNT = 12;

const DEFAULT_PER_STOP_LIMIT = 5;

/** Converts a glidepath gradient in ft/nm to degrees — the inverse of
 *  `RouteProfile.tsx`'s `degToFtPerNm`, kept local here since only the
 *  chart needs the ft/nm form and only this module needs the reverse. */
const FT_PER_NM = 6076.12;
function ftPerNmToDeg(ftPerNm: number): number {
  return (Math.atan(ftPerNm / FT_PER_NM) * 180) / Math.PI;
}

export interface StopAlternative {
  airport: Airport;
  verdict: "tie" | "costlier" | "shorter" | "runway-short" | "over-leg-cap";
  /** Minutes slower than the chosen stop under the real `totalTime`
   *  cost function (the SAME leg model the planner uses — buildGraph
   *  and buildInteractiveLeg share it), applied to this candidate's two
   *  legs vs. the chosen stop's two. Negative means genuinely shorter:
   *  the planner culls airports outside the route corridor before it
   *  searches, so a low-detour field just outside that cull can beat
   *  the chosen stop and never have been considered — surfaced here as
   *  a "shorter" suggestion, not an error. */
  deltaMin: number;
  /** One-line human copy quantifying why this specific airport lost,
   *  e.g. "adds ~6 min — 42 nm off the direct route",
   *  "routes over higher terrain (+8 min terrain penalty)",
   *  "runway short at estimated weight — POH needs 3,200 ft, 2,650 ft
   *  available". Gradient and runway-tight notes, when they fire, are
   *  appended as additional " · "-joined clauses. */
  reason: string;
}

export interface StopExplanation {
  stopId: string;
  stopIdent: string;
  /** True when this stop was pinned by the pilot rather than chosen
   *  by the optimizer. Pinned stops are never probed against
   *  alternatives — scoring "better" airports against a stop the
   *  pilot deliberately picked (not the planner) is misleading. */
  pinned: boolean;
  alternatives: StopAlternative[];
}

export interface ExplainStopChoicesInput {
  route: PlannedRoute;
  matches: readonly Airport[]; // the filter-passing candidate set
  baseMatches: readonly Airport[]; // the candidate set BEFORE the runway-fit filter
  aircraft: Aircraft;
  targetAltFt: number;
  flightRule: FlightRule;
  reserveHr: number;
  startingFuelGal: number;
  variation: VariationFn;
  dem?: DEMSampler;
  /** Stop ids the pilot pinned (vs. chosen by the optimizer). Pinned
   *  stops get `{ pinned: true, alternatives: [] }` with no probing. */
  pinnedStopIds?: ReadonlySet<string>;
  runwaySettings: RunwaySettings;
  /** Pilot's per-leg time cap in hours, when enabled. */
  maxLegHr?: number;
  perStopLimit?: number; // default 5 alternatives per stop
}

function identOf(a: Airport): string {
  return a.icao ?? a.lid;
}

/** Mirrors `filterByRunwayFit`'s conservative up-front check: max
 *  gross weight at takeoff, max landing (or max gross) weight at
 *  landing. Used both to verify why an airport was excluded from
 *  `matches` and to flag "tight" airports that made it through. */
function classifyMaxGrossFit(
  aircraft: Aircraft,
  airport: Airport,
  settings: RunwaySettings,
) {
  return classifyAirportRunwayFit({
    aircraft,
    airport,
    settings,
    takeoff_weight_lb: aircraft.weights?.max_gross_lb,
    landing_weight_lb:
      aircraft.weights?.max_landing_lb ?? aircraft.weights?.max_gross_lb,
  });
}

interface PoolCandidate {
  airport: Airport;
  /** Set when this candidate is in `baseMatches` but not `matches`,
   *  and `classifyMaxGrossFit` confirms the exclusion really was the
   *  POH runway check (not assumed from the set difference alone). */
  runwayShort?: {
    requiredFt: number; // required distance + buffer — the "wanted" number
    availableFt: number;
  };
}

/** Builds the candidate pool per the inclusion criteria: every airport
 *  in `matches`, plus airports in `baseMatches` but not `matches` when
 *  `classifyMaxGrossFit` confirms the POH runway check is what
 *  excluded them. Airports missing from `matches` for any other
 *  reason (tower, approach, fuel, manual runway floor, etc.) are never
 *  added — only a confirmed runway-fit failure earns the tag. */
function buildCandidatePool(input: {
  matches: readonly Airport[];
  baseMatches: readonly Airport[];
  routeAirportIds: ReadonlySet<string>;
  aircraft: Aircraft;
  runwaySettings: RunwaySettings;
}): PoolCandidate[] {
  const { matches, baseMatches, routeAirportIds, aircraft, runwaySettings } =
    input;
  const pool = new Map<string, PoolCandidate>();
  for (const a of matches) {
    if (routeAirportIds.has(a.id)) continue;
    pool.set(a.id, { airport: a });
  }
  const matchIds = new Set(matches.map((a) => a.id));
  for (const a of baseMatches) {
    if (routeAirportIds.has(a.id) || matchIds.has(a.id)) continue;
    const fit = classifyMaxGrossFit(aircraft, a, runwaySettings);
    if (!fit || fit.worst !== "insufficient") continue; // not actually a runway exclusion
    const requiredFt =
      (fit.takeoff_status === "insufficient"
        ? fit.takeoff_required_ft
        : fit.landing_required_ft) + runwaySettings.buffer_ft;
    pool.set(a.id, {
      airport: a,
      runwayShort: { requiredFt, availableFt: fit.available_ft },
    });
  }
  return [...pool.values()];
}

function runwayShortReason(tag: {
  requiredFt: number;
  availableFt: number;
}): string {
  return (
    `runway short at estimated weight — POH needs ` +
    `${Math.round(tag.requiredFt).toLocaleString()} ft, ` +
    `${Math.round(tag.availableFt).toLocaleString()} ft available`
  );
}

/** Reason for an "over-leg-cap" verdict: identifies whichever
 *  hypothetical leg (prev→candidate or candidate→next) actually
 *  breaches the pilot's cap — the worse-overage leg when both do. */
function overLegCapReason(params: {
  prevToCTimeHr: number;
  cToNextTimeHr: number;
  prev: Airport;
  candidate: Airport;
  next: Airport;
  maxLegHr: number;
}): string | null {
  const { prevToCTimeHr, cToNextTimeHr, prev, candidate, next, maxLegHr } =
    params;
  const prevOver = prevToCTimeHr > maxLegHr;
  const nextOver = cToNextTimeHr > maxLegHr;
  if (!prevOver && !nextOver) return null;
  const useCToNext =
    nextOver &&
    (!prevOver || cToNextTimeHr - maxLegHr >= prevToCTimeHr - maxLegHr);
  const fromIdent = useCToNext ? identOf(candidate) : identOf(prev);
  const toIdent = useCToNext ? identOf(next) : identOf(candidate);
  return `pushes the ${fromIdent}→${toIdent} leg over your ${maxLegHr} hr cap`;
}

/** Attributes a "costlier" candidate's extra minutes to its most
 *  likely driver — extra distance (the default) or a bigger terrain
 *  penalty — by comparing those components between the candidate's two
 *  hypothetical legs and the chosen stop's two actual legs. Best-effort
 *  human copy: the verdict and `deltaMin` are the load-bearing numbers,
 *  this just points at the largest visible contributor.
 *
 *  Field elevation is deliberately NOT a driver here: with a fixed
 *  cruise altitude the time cost of a lower field is tiny (the climb
 *  covers ground you'd otherwise cruise, and climb speed isn't far off
 *  cruise), so a 5,000 ft elevation gap is worth under two minutes.
 *  Such candidates land in the "tie" bucket, which is the honest and
 *  more useful answer than quoting an inflated climb figure. */
function attributeCostlierReason(params: {
  deltaMin: number;
  detourNm: number;
  altLegs: readonly [Edge, Edge];
  chosenLegs: readonly [Edge, Edge];
  chosenStop: Airport;
}): string {
  // Only ever called with deltaMin > 2 (slower); shorter and near-tie
  // candidates are handled by the caller.
  const { deltaMin, detourNm, altLegs, chosenLegs, chosenStop } = params;

  const altTerrainHr =
    (altLegs[0].extra?.terrain_penalty_hr ?? 0) +
    (altLegs[1].extra?.terrain_penalty_hr ?? 0);
  const chosenTerrainHr =
    (chosenLegs[0].extra?.terrain_penalty_hr ?? 0) +
    (chosenLegs[1].extra?.terrain_penalty_hr ?? 0);
  const terrainDeltaMin = Math.round((altTerrainHr - chosenTerrainHr) * 60);

  // Terrain drives the reason only when it accounts for the bulk of the
  // extra time; otherwise it's the detour.
  if (terrainDeltaMin >= 1 && terrainDeltaMin * 2 >= deltaMin) {
    return `routes over higher terrain (+${terrainDeltaMin} min terrain penalty)`;
  }
  if (Math.round(detourNm) >= 1) {
    return `adds ~${deltaMin} min — ${Math.round(detourNm)} nm off the direct route`;
  }
  return `adds ~${deltaMin} min over ${identOf(chosenStop)}`;
}

/** Gradient annotations, using the same thresholds as the route-profile
 *  chart (`NORMAL_CLIMB_MAX_FT_PER_NM` / `NORMAL_DESCENT_MAX_DEG`): the
 *  descent required to get into the candidate as a stop (prev→candidate)
 *  and the climb required to rejoin cruise leaving it (candidate→next).
 *  Only called for the final, already-ranked candidates — it walks the
 *  DEM via `buildLegProfile`, so it must never run on the whole probe
 *  set. */
function gradientClauses(params: {
  prev: Airport;
  candidate: Airport;
  next: Airport;
  prevToCAltFt: number;
  cToNextAltFt: number;
  aircraft: Aircraft;
  dem: DEMSampler;
}): string[] {
  const { prev, candidate, next, prevToCAltFt, cToNextAltFt, aircraft, dem } =
    params;
  const clauses: string[] = [];

  const descentProfile = buildLegProfile({
    from: prev,
    to: candidate,
    cruiseAltFt: prevToCAltFt,
    aircraft,
    dem,
  });
  const descentDeg = ftPerNmToDeg(descentProfile.descent.reqFtPerNm);
  if (descentDeg > NORMAL_DESCENT_MAX_DEG) {
    clauses.push(`descent in requires ${descentDeg.toFixed(1)}° for terrain`);
  }

  const climbProfile = buildLegProfile({
    from: candidate,
    to: next,
    cruiseAltFt: cToNextAltFt,
    aircraft,
    dem,
  });
  if (climbProfile.climb.reqFtPerNm > NORMAL_CLIMB_MAX_FT_PER_NM) {
    clauses.push(
      `climb out needs ${Math.round(climbProfile.climb.reqFtPerNm)} ft/nm`,
    );
  }

  return clauses;
}

interface EvalContext {
  prev: Airport;
  stop: Airport;
  next: Airport;
  aircraft: Aircraft;
  targetAltFt: number;
  flightRule: FlightRule;
  reserveHr: number;
  fuelAtPrevGal: number;
  capacityGal: number;
  variation: VariationFn;
  dem?: DEMSampler;
  costFn: (e: Edge) => number;
  chosenLegs: readonly [Edge, Edge];
  maxLegHr?: number;
}

/** A candidate that survived fuel-feasibility, with everything needed
 *  to render its final reason once we know it made the perStopLimit
 *  cut (gradient/runway-tight annotation is deferred to that point). */
interface SurvivorCandidate {
  airport: Airport;
  verdict: StopAlternative["verdict"];
  deltaMin: number;
  baseReason: string;
  prevToCAltFt: number;
  cToNextAltFt: number;
  /** True when this candidate came from `matches` itself (as opposed
   *  to a runway-short tag from `baseMatches`) — only these are
   *  eligible for the separate "runway tight" annotation. */
  isMatchesMember: boolean;
}

function evaluateCandidate(
  pc: PoolCandidate,
  detourNm: number,
  ctx: EvalContext,
): SurvivorCandidate | null {
  const {
    prev,
    stop,
    next,
    aircraft,
    targetAltFt,
    flightRule,
    reserveHr,
    fuelAtPrevGal,
    capacityGal,
    variation,
    dem,
    costFn,
    chosenLegs,
    maxLegHr,
  } = ctx;
  const candidate = pc.airport;

  // Criterion 2: fully fuel-viable, both directions — infeasible
  // candidates are silently dropped, never listed (pilots understand
  // fuel; a wildly-out-of-range airport is worse than useless if it
  // takes the slot of a relevant one).
  const prevToC = buildInteractiveLeg({
    from: prev,
    to: candidate,
    aircraft,
    targetAltFt,
    flightRule,
    startingFuelGal: fuelAtPrevGal,
    reserveHr,
    variation,
    dem,
  });
  if (!prevToC.feasible) return null;

  // Intermediate stops always imply a top-off in this model (matching
  // buildInteractiveRoute's "any non-origin stop refuels to capacity"
  // simplification), so the candidate's onward leg starts with full
  // tanks regardless of whether it actually sells fuel.
  const cToNext = buildInteractiveLeg({
    from: candidate,
    to: next,
    aircraft,
    targetAltFt,
    flightRule,
    startingFuelGal: capacityGal,
    reserveHr,
    variation,
    dem,
  });
  if (!cToNext.feasible) return null;

  const altLegs: [Edge, Edge] = [prevToC.leg, cToNext.leg];
  const altCost = costFn(altLegs[0]) + costFn(altLegs[1]);
  const chosenCost = costFn(chosenLegs[0]) + costFn(chosenLegs[1]);
  const deltaMin = Math.round((altCost - chosenCost) * 60);

  let verdict: StopAlternative["verdict"];
  let baseReason: string;

  if (pc.runwayShort) {
    // Criterion-1 tag wins: the fundamental reason this airport isn't
    // a real option is the POH runway check, regardless of how its
    // time delta shakes out.
    verdict = "runway-short";
    baseReason = runwayShortReason(pc.runwayShort);
  } else {
    const legCapReason =
      maxLegHr !== undefined
        ? overLegCapReason({
            prevToCTimeHr: prevToC.leg.time_hr,
            cToNextTimeHr: cToNext.leg.time_hr,
            prev,
            candidate,
            next,
            maxLegHr,
          })
        : null;
    if (legCapReason) {
      verdict = "over-leg-cap";
      baseReason = legCapReason;
    } else if (Math.abs(deltaMin) <= 2) {
      verdict = "tie";
      baseReason = "essentially a tie — either works";
    } else if (deltaMin < 0) {
      // Genuinely shorter on the same leg model the planner uses. The
      // planner didn't pick it because its corridor cull dropped it
      // before the search — so surface it as an actionable suggestion,
      // not an apology.
      verdict = "shorter";
      baseReason = `≈${-deltaMin} min shorter than ${identOf(stop)} — pin it to route this way`;
    } else {
      verdict = "costlier";
      baseReason = attributeCostlierReason({
        deltaMin,
        detourNm,
        altLegs,
        chosenLegs,
        chosenStop: stop,
      });
    }
  }

  return {
    airport: candidate,
    verdict,
    deltaMin,
    baseReason,
    prevToCAltFt: prevToC.leg.cruise_alt_ft,
    cToNextAltFt: cToNext.leg.cruise_alt_ft,
    isMatchesMember: !pc.runwayShort,
  };
}

/**
 * For each intermediate stop on `route`, lists the best nearby
 * alternative airports and the concrete, quantified reason each
 * lost — every slot goes to an airport a pilot would genuinely have
 * considered.
 *
 * Candidates are drawn from `matches` (the pilot's filter-passing
 * pool) plus any airport in `baseMatches` that the POH runway check
 * alone excluded (tagged `runway-short`, verified via
 * `classifyAirportRunwayFit` rather than assumed from the set
 * difference). Every candidate must then be fully fuel-viable in both
 * directions (via `buildInteractiveLeg`, the same math the interactive
 * planner uses) and within a competitive detour of the stop's own
 * prev→next great circle (`max(25 nm, 15%)`) — candidates that fail
 * either are silently dropped, never listed. Survivors are ranked by
 * detour ascending and capped at `perStopLimit`.
 *
 * Stops in `pinnedStopIds` are the pilot's own choice, not the
 * optimizer's — they're returned with `pinned: true` and no
 * alternatives probed.
 */
export function explainStopChoices(
  input: ExplainStopChoicesInput,
): StopExplanation[] {
  const {
    route,
    matches,
    baseMatches,
    aircraft,
    targetAltFt,
    flightRule,
    reserveHr,
    startingFuelGal,
    variation,
    dem,
    pinnedStopIds,
    runwaySettings,
    maxLegHr,
    perStopLimit = DEFAULT_PER_STOP_LIMIT,
  } = input;

  const legs = route.legs;
  if (legs.length < 2) return []; // direct route — no intermediate stops

  const routeOriginId = legs[0].fromAirport.id;
  const capacityGal = aircraft.fuel.usable_capacity_gal;
  const originFuelGal = Math.min(Math.max(startingFuelGal, 0), capacityGal);

  const routeAirportIds = new Set<string>();
  for (const l of legs) {
    routeAirportIds.add(l.fromAirport.id);
    routeAirportIds.add(l.toAirport.id);
  }

  const maxLegNm = usableRange({
    aircraft,
    altitude_ft: targetAltFt,
    reserve_hours: reserveHr,
  }).range_nm;
  const costFn = costFnById("totalTime")!.build({ maxLegNm });

  const explanations: StopExplanation[] = [];

  for (let i = 0; i < legs.length - 1; i++) {
    const legIn = legs[i];
    const legOut = legs[i + 1];
    const prev = legIn.fromAirport;
    const stop = legIn.toAirport;
    const next = legOut.toAirport;

    if (pinnedStopIds?.has(stop.id)) {
      explanations.push({
        stopId: stop.id,
        stopIdent: identOf(stop),
        pinned: true,
        alternatives: [],
      });
      continue;
    }

    const fuelAtPrevGal = prev.id === routeOriginId ? originFuelGal : capacityGal;
    const directNm = greatCircleNM(prev, next);
    const detourCapNm = Math.max(25, 0.15 * directNm);

    const pool = buildCandidatePool({
      matches,
      baseMatches,
      routeAirportIds,
      aircraft,
      runwaySettings,
    });

    // Criterion 3: detour-competitive — anything beyond the cap is
    // silently dropped before it ever gets a fuel-feasibility probe.
    const ranked: { candidate: PoolCandidate; detourNm: number }[] = [];
    for (const pc of pool) {
      const a = pc.airport;
      const detourNm = greatCircleNM(prev, a) + greatCircleNM(a, next) - directNm;
      if (detourNm > detourCapNm) continue;
      ranked.push({ candidate: pc, detourNm });
    }
    ranked.sort((x, y) => x.detourNm - y.detourNm);

    // Rebuild the chosen stop's two legs with the SAME model the
    // candidates use (buildInteractiveLeg + identical fuel
    // assumptions), rather than comparing against the planner's actual
    // route edges. The planner and buildInteractiveLeg cost legs
    // slightly differently, so mixing them made candidates look
    // spuriously faster than the stop the planner actually kept — and
    // forced an awkward "…faster by this panel's simplified model"
    // caveat. Scoring both sides the same way makes the delta honest.
    const chosenIn = buildInteractiveLeg({
      from: prev,
      to: stop,
      aircraft,
      targetAltFt,
      flightRule,
      startingFuelGal: fuelAtPrevGal,
      reserveHr,
      variation,
      dem,
    });
    const chosenOut = buildInteractiveLeg({
      from: stop,
      to: next,
      aircraft,
      targetAltFt,
      flightRule,
      startingFuelGal: capacityGal,
      reserveHr,
      variation,
      dem,
    });

    const ctx: EvalContext = {
      prev,
      stop,
      next,
      aircraft,
      targetAltFt,
      flightRule,
      reserveHr,
      fuelAtPrevGal,
      capacityGal,
      variation,
      dem,
      costFn,
      chosenLegs: [chosenIn.leg, chosenOut.leg],
      maxLegHr,
    };

    const survivors: SurvivorCandidate[] = [];
    for (const r of ranked.slice(0, PROBE_COUNT)) {
      const s = evaluateCandidate(r.candidate, r.detourNm, ctx);
      if (s) survivors.push(s);
    }
    // `survivors` preserves the ascending-detour order of `ranked`
    // (dropped candidates just leave gaps, they never reorder it), so
    // criterion 4's "rank by detour ascending" is already satisfied.
    const kept = survivors.slice(0, perStopLimit);

    const alternatives: StopAlternative[] = kept.map((s) => {
      const clauses = [s.baseReason];
      if (dem) {
        clauses.push(
          ...gradientClauses({
            prev,
            candidate: s.airport,
            next,
            prevToCAltFt: s.prevToCAltFt,
            cToNextAltFt: s.cToNextAltFt,
            aircraft,
            dem,
          }),
        );
      }
      if (s.isMatchesMember) {
        const fit = classifyMaxGrossFit(aircraft, s.airport, runwaySettings);
        if (fit && fit.worst === "tight") {
          clauses.push("runway tight at estimated weight");
        }
      }
      return {
        airport: s.airport,
        verdict: s.verdict,
        deltaMin: s.deltaMin,
        reason: clauses.join(" · "),
      };
    });

    explanations.push({
      stopId: stop.id,
      stopIdent: identOf(stop),
      pinned: false,
      alternatives,
    });
  }

  return explanations;
}
