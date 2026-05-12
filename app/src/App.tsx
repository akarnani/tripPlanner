import { useEffect, useMemo, useState } from "react";
import { airports, airportByIdent, obstacles } from "@/data/loaders";
import { aircraft as allAircraft, aircraftBySlug } from "@/data/aircraft";
import { applyFilters, DEFAULT_FILTERS } from "@/engine/filters";
import { usableRange } from "@/engine/performance";
import { plan, type PlannedRoute } from "@/engine/plan";
import { obstaclesNearRoute } from "@/engine/obstacles";
import { analyzeTerrain, type TerrainAnalysis } from "@/engine/terrain";
import { TerrainGridDEMSampler } from "@/engine/terrainGrid";
import terrainGridUrl from "@data/terrain_grid.bin.gz?url";

const demSampler = new TerrainGridDEMSampler(terrainGridUrl);
import { MapView } from "./ui/MapView";
import { FilterPanel } from "./ui/FilterPanel";
import { AircraftPanel } from "./ui/AircraftPanel";
import { TripPanel } from "./ui/TripPanel";
import { LegTable } from "./ui/LegTable";
import { TerrainPanel } from "./ui/TerrainPanel";
import { ExportPanel } from "./ui/ExportPanel";

export function App() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [aircraftSlug, setAircraftSlug] = useState(
    allAircraft[0]?.slug ?? "",
  );
  const [altitude_ft, setAltitude] = useState(6500);
  const [reserve_min, setReserve] = useState(45);
  const [origin, setOrigin] = useState("KSEA");
  const [destination, setDestination] = useState("KBOI");
  const [costFnId, setCostFnId] = useState("fewestStops");
  const [maxLegHr, setMaxLegHr] = useState(2);
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [demReady, setDemReady] = useState(false);

  useEffect(() => {
    demSampler.load().then(() => setDemReady(true)).catch((e) => {
      console.warn("DEM grid failed to load:", e);
    });
  }, []);

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

  function runPlan(atAltitudeFt: number) {
    setError(null);
    const o = airportByIdent(origin);
    const d = airportByIdent(destination);
    if (!o) {
      setError(`unknown origin: ${origin}`);
      return;
    }
    if (!d) {
      setError(`unknown destination: ${destination}`);
      return;
    }
    const r = usableRange({
      aircraft: selectedAircraft,
      altitude_ft: atAltitudeFt,
      reserve_hours: reserve_min / 60,
    });
    if (r.range_nm <= 0) {
      setError("range is zero — check fuel reserve");
      return;
    }
    // Ensure origin and destination are included in the candidate set even
    // if the hard filters would exclude them.
    const candidates = Array.from(
      new Map([...matches, o, d].map((a) => [a.id, a])).values(),
    );
    try {
      const result = plan({
        airports: candidates,
        origin: o.id,
        destination: d.id,
        aircraft: selectedAircraft,
        range: r,
        costFnId,
        costFnParams: { max_hr: maxLegHr },
        K: 3,
      });
      if (result.length === 0) {
        setError("no route found — try relaxing filters or raising reserve");
        setRoutes([]);
        return;
      }
      setRoutes(result);
      setSelectedRoute(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const handlePlan = () => runPlan(altitude_ft);

  const currentRoute = routes[selectedRoute] ?? null;
  const routeObstacles = useMemo(
    () => obstaclesNearRoute(obstacles, currentRoute),
    [currentRoute],
  );
  const terrain: TerrainAnalysis | null = useMemo(() => {
    if (!currentRoute) return null;
    return analyzeTerrain({
      legs: currentRoute.legs.map((l) => ({
        from: l.fromAirport,
        to: l.toAirport,
        fromIdent: l.fromAirport.icao ?? l.fromAirport.lid,
        toIdent: l.toAirport.icao ?? l.toAirport.lid,
      })),
      obstacles: routeObstacles,
      cruiseAltFt: altitude_ft,
      dem: demReady ? demSampler : undefined,
    });
  }, [currentRoute, routeObstacles, altitude_ft, demReady]);

  function handleReplanAtMinSafe() {
    if (!terrain) return;
    setAltitude(terrain.minSafeAltFt);
    runPlan(terrain.minSafeAltFt);
  }

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
          <h2 className="mb-2 text-sm font-semibold text-slate-800">Trip</h2>
          <TripPanel
            origin={origin}
            destination={destination}
            onOriginChange={setOrigin}
            onDestinationChange={setDestination}
            costFnId={costFnId}
            onCostFnChange={setCostFnId}
            maxLegHr={maxLegHr}
            onMaxLegHrChange={setMaxLegHr}
            onPlan={handlePlan}
            error={error}
          />
        </section>
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
      </aside>
      <main className="relative flex-1">
        <MapView
          airports={matches}
          route={currentRoute}
          obstacles={routeObstacles}
        />
      </main>
      {routes.length > 0 && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50">
          <div className="flex-1 overflow-y-auto">
            <LegTable
              routes={routes}
              selected={selectedRoute}
              onSelect={setSelectedRoute}
            />
          </div>
          <TerrainPanel
            analysis={terrain}
            cruiseAltFt={altitude_ft}
            onReplanAtMinSafe={handleReplanAtMinSafe}
          />
          {currentRoute && (
            <ExportPanel
              route={currentRoute}
              aircraft={selectedAircraft}
              altitude_ft={altitude_ft}
              terrain={terrain}
            />
          )}
        </aside>
      )}
    </div>
  );
}
