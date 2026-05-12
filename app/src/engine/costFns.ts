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
export const costFunctions: CostFnDefinition[] = [
  {
    id: "fewestStops",
    label: "Fewest stops",
    description: "Unit edge cost; minimum-hop path.",
    build: () => () => 1,
  },
  {
    id: "maxLegTime",
    label: "Cap leg time",
    description:
      "Reject legs longer than the given hours; otherwise unit cost. Useful for shorter cockpit days.",
    build: (params) => {
      const max_hr = params.max_hr ?? 2;
      return (e: Edge) => (e.time_hr > max_hr ? Infinity : 1);
    },
  },
  {
    id: "shortestTime",
    label: "Shortest total time",
    description: "Minimize sum of leg times.",
    build: () => (e: Edge) => e.time_hr,
  },
];

export function costFnById(id: string): CostFnDefinition | undefined {
  return costFunctions.find((c) => c.id === id);
}
