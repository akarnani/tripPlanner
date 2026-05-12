import { useMemo, useState } from "react";
import { airports } from "@/data/loaders";
import { aircraft as allAircraft, aircraftBySlug } from "@/data/aircraft";
import { applyFilters, DEFAULT_FILTERS } from "@/engine/filters";
import { usableRange } from "@/engine/performance";
import { MapView } from "./ui/MapView";
import { FilterPanel } from "./ui/FilterPanel";
import { AircraftPanel } from "./ui/AircraftPanel";

export function App() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [aircraftSlug, setAircraftSlug] = useState(
    allAircraft[0]?.slug ?? "",
  );
  const [altitude_ft, setAltitude] = useState(6500);
  const [reserve_min, setReserve] = useState(45);

  const selectedAircraft = aircraftBySlug(aircraftSlug) ?? allAircraft[0];

  const range = useMemo(
    () =>
      usableRange({
        aircraft: selectedAircraft,
        altitude_ft,
        reserve_hours: reserve_min / 60,
      }),
    [selectedAircraft, altitude_ft, reserve_min],
  );

  const matches = useMemo(() => applyFilters(airports, filters), [filters]);

  return (
    <div className="flex h-full w-full">
      <aside className="w-80 shrink-0 space-y-5 overflow-y-auto border-r border-slate-200 bg-slate-50 p-4">
        <header>
          <h1 className="text-lg font-semibold text-slate-900">Trip Planner</h1>
          <p className="mt-1 text-xs text-slate-600">
            GA route planning with fuel stops, terrain warnings, and approach
            filters.
          </p>
        </header>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-800">
            Aircraft &amp; cruise
          </h2>
          <AircraftPanel
            aircraft={allAircraft}
            selectedSlug={selectedAircraft.slug}
            onSelect={setAircraftSlug}
            altitude_ft={altitude_ft}
            onAltitudeChange={setAltitude}
            reserve_min={reserve_min}
            onReserveChange={setReserve}
            range={range}
          />
        </section>
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
          Routing, terrain warnings, and exports land in later phases.
        </p>
      </aside>
      <main className="relative flex-1">
        <MapView airports={matches} />
      </main>
    </div>
  );
}
