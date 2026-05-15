import type { CostFn, Edge } from "./routing";

export interface CostFnDefinition {
  id: string;
  label: string;
  description: string;
  build: (params: Record<string, number>) => CostFn;
}

// Built-in cost functions. Adding a new objective (e.g. `cheapestFuel` once
// fuel prices land) means registering one more entry here — the router and
// UI iterate over `costFunctions` without further wiring.
//
// Constraints like "no leg longer than X hours" are NOT modeled as
// objectives — they're applied in buildGraph by dropping disqualified
// edges before any objective sees the graph. That way every objective
// respects the constraint without having to know about it.
//
// For now there's only one objective, `totalTime`, that models the full
// gate-to-gate cost of a trip:
//
//   * `e.time_hr` — climb + cruise flight time for the leg (already
//     computed by buildGraph).
//   * `STOP_OVERHEAD_HR` — a fixed per-edge ground-time charge that
//     captures the taxi, fuel, run-up, and start cycle you pay for
//     every refuel stop. With this term, the planner inherently
//     prefers fewer stops — without needing a separate "fewest stops"
//     objective, which in a no-wind model produces the same answer as
//     "shortest total time" anyway.
//   * `extra.terrain_penalty_hr` — soft penalty (in flight-time units)
//     for stops where high terrain would block a gradual climb-out or
//     standard 1,000/3 nm arrival descent. Computed by buildGraph when
//     a DEM sampler is provided.
//   * `SHORT_LEG_PENALTY_HR × shortLegPenalty(...)` — discourages
//     stopping for fuel after barely leaving the previous stop. The
//     per-edge overhead alone doesn't differentiate same-stop-count
//     routes; this term breaks the tie in favor of evenly-spaced legs.
//     The penalty applies only below a threshold so longer-than-needed
//     legs aren't *rewarded* (which would let detours and backtracks
//     sneak ahead of more-direct routes).
//
// A second objective will earn its keep once wind/weather enter the
// model, when "more stops via favorable winds" can plausibly beat the
// great-circle route. Until then, two objectives just duplicate work
// and produce the same route.
const STOP_OVERHEAD_HR = 0.4;
const SHORT_LEG_PENALTY_HR = 0.5;
const SHORT_LEG_ABS_CAP_NM = 200;
const SHORT_LEG_RANGE_FRACTION = 0.5;

function shortLegPenalty(distance_nm: number, maxLegNm: number): number {
  const threshold = Number.isFinite(maxLegNm) && maxLegNm > 0
    ? Math.min(SHORT_LEG_ABS_CAP_NM, SHORT_LEG_RANGE_FRACTION * maxLegNm)
    : SHORT_LEG_ABS_CAP_NM;
  if (threshold <= 0) return 0;
  return Math.max(0, (threshold - distance_nm) / threshold);
}

export const costFunctions: CostFnDefinition[] = [
  {
    id: "totalTime",
    label: "Total time",
    description:
      "Gate-to-gate trip time. Sums per-leg climb + cruise time, plus a " +
      "ground-time charge for every refuel stop, plus soft penalties for " +
      "terrain that blocks a gradual climb/descent at a stop and for legs " +
      "much shorter than the aircraft's range (which usually means a " +
      "wastefully placed fuel stop).",
    build: (params) => {
      const maxLegNm = params.maxLegNm ?? Infinity;
      return (e: Edge) =>
        e.time_hr +
        STOP_OVERHEAD_HR +
        (e.extra?.terrain_penalty_hr ?? 0) +
        SHORT_LEG_PENALTY_HR * shortLegPenalty(e.distance_nm, maxLegNm);
    },
  },
];

export function costFnById(id: string): CostFnDefinition | undefined {
  return costFunctions.find((c) => c.id === id);
}
