import { useMemo, useState } from "react";
import { airports } from "@/data/loaders";
import { applyFilters, DEFAULT_FILTERS } from "@/engine/filters";
import { MapView } from "./ui/MapView";
import { FilterPanel } from "./ui/FilterPanel";

export function App() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const matches = useMemo(() => applyFilters(airports, filters), [filters]);

  return (
    <div className="flex h-full w-full">
      <aside className="w-80 shrink-0 space-y-4 border-r border-slate-200 bg-slate-50 p-4 overflow-y-auto">
        <header>
          <h1 className="text-lg font-semibold text-slate-900">Trip Planner</h1>
          <p className="mt-1 text-xs text-slate-600">
            GA route planning with fuel stops, terrain warnings, and approach
            filters.
          </p>
        </header>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-800">
            Airport filters
          </h2>
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            matchCount={matches.length}
            totalCount={airports.length}
          />
        </section>
        <p className="text-xs text-slate-500">
          Showing a small seed dataset until the NASR pipeline runs. Routing,
          performance, and exports land in later phases.
        </p>
      </aside>
      <main className="relative flex-1">
        <MapView airports={matches} />
      </main>
    </div>
  );
}
