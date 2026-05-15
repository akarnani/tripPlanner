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
export const costFunctions: CostFnDefinition[] = [
  {
    id: "fewestStops",
    label: "Fewest stops",
    description:
      "Minimum-hop path, tiebroken by shortest total time so the picked " +
      "route is never gratuitously slower than another equal-stop route.",
    // Hop-count strictly dominates; the time term only breaks ties.
    // 1e6 hr is many orders of magnitude beyond any realistic route,
    // so a single extra hop (+1.0) can never be undercut by faster legs.
    build: () => (e: Edge) => 1 + e.time_hr / 1e6,
  },
  {
    id: "shortestTime",
    label: "Shortest total time",
    description:
      "Minimize sum of leg times. Includes a soft terrain penalty " +
      "(folded in as added flight time) for stops where high terrain " +
      "would block a gradual climb after takeoff or a standard 1,000/3 " +
      "nm descent before landing.",
    build: () => (e: Edge) => e.time_hr + (e.extra?.terrain_penalty_hr ?? 0),
  },
];

export function costFnById(id: string): CostFnDefinition | undefined {
  return costFunctions.find((c) => c.id === id);
}
