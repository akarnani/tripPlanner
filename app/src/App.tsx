import { useEffect, useMemo, useState } from "react";
import * as data from "@/data/loaders";
import { aircraft as allAircraft, aircraftBySlug } from "@/data/aircraft";
import { applyFilters, DEFAULT_FILTERS } from "@/engine/filters";
import { plan, type PlannedRoute } from "@/engine/plan";
import { obstaclesNearRoute } from "@/engine/obstacles";
import { analyzeTerrain, type TerrainAnalysis } from "@/engine/terrain";
import type { FlightRule } from "@/engine/hemispheric";
import { TerrainGridDEMSampler } from "@/engine/terrainGrid";
import { MagneticVariationGrid } from "@/engine/magneticVariation";
import terrainGridUrl from "@data/terrain_grid.bin.gz?url";
import magneticGridUrl from "@data/magnetic_grid.bin.gz?url";
import { MapView } from "./ui/MapView";
import { FilterPanel } from "./ui/FilterPanel";
import { AircraftPanel } from "./ui/AircraftPanel";
import { TripPanel } from "./ui/TripPanel";
import { LegTable } from "./ui/LegTable";
import { TerrainPanel } from "./ui/TerrainPanel";
import { ExportPanel } from "./ui/ExportPanel";

const demSampler = new TerrainGridDEMSampler(terrainGridUrl);
const magGrid = new MagneticVariationGrid(magneticGridUrl);
const variationFn = (p: { lat: number; lon: number }) =>
  magGrid.variationDeg(p);

export function App() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [aircraftSlug, setAircraftSlug] = useState(allAircraft[0]?.slug ?? "");
  const [targetAltFt, setTargetAltFt] = useState(6500);
  const [reserveMin, setReserveMin] = useState(45);
  // Starting fuel defaults to full tanks of whichever aircraft is
  // selected; an effect below resets the value when aircraft changes
  // so the input stays sensible.
  const [startingFuelGal, setStartingFuelGal] = useState<number>(
    allAircraft[0]?.fuel.usable_capacity_gal ?? 0,
  );
  const [origin, setOrigin] = useState("KSEA");
  const [destination, setDestination] = useState("KBOI");
  const [flightRule, setFlightRule] = useState<FlightRule>("VFR");
  const [capLegTime, setCapLegTime] = useState(false);
  const [maxLegHr, setMaxLegHr] = useState(2);
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [demReady, setDemReady] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);

  // Datasets are fetched at runtime instead of bundled into the JS so
  // the initial paint isn't blocked by parsing several MB of airport
  // JSON. The terrain DEM and magnetic-variation grids load in
  // parallel; planning + terrain analysis gracefully degrade until
  // they're ready.
  useEffect(() => {
    data
      .loadDatasets()
      .then(() => setDataReady(true))
      .catch((e) => {
        console.error("dataset load failed:", e);
        setError("Failed to load airport database; reload to retry.");
      });
    demSampler
      .load()
      .then(() => setDemReady(true))
      .catch((e) => console.warn("DEM grid failed to load:", e));
    magGrid
      .load()
      .catch((e) => console.warn("magnetic grid failed to load:", e));
  }, []);

  const selectedAircraft = aircraftBySlug(aircraftSlug) ?? allAircraft[0];

  // When the user picks a different aircraft, reset starting fuel to
  // that aircraft's full capacity — its tanks aren't comparable.
  useEffect(() => {
    setStartingFuelGal(selectedAircraft.fuel.usable_capacity_gal);
  }, [selectedAircraft.slug]);

  const matches = useMemo(
    () => (dataReady ? applyFilters(data.airports, filters) : []),
    [filters, dataReady],
  );

  function runPlan(targetFt: number) {
    setError(null);
    const o = data.airportByIdent(origin);
    const d = data.airportByIdent(destination);
    if (!o) {
      setError(`unknown origin: ${origin}`);
      return;
    }
    if (!d) {
      setError(`unknown destination: ${destination}`);
      return;
    }
    // Ensure origin and destination are in the candidate set even if
    // the hard filters would exclude them.
    const candidates = Array.from(
      new Map([...matches, o, d].map((a) => [a.id, a])).values(),
    );
    try {
      const result = plan({
        airports: candidates,
        origin: o.id,
        destination: d.id,
        aircraft: selectedAircraft,
        targetAltFt: targetFt,
        flightRule,
        reserveHr: reserveMin / 60,
        variation: variationFn,
        maxLegHr: capLegTime ? maxLegHr : undefined,
        startingFuelGal,
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

  function handlePlan() {
    if (isPlanning) return;
    setIsPlanning(true);
    // Yield to the browser so the spinner paints before Dijkstra/Yen's
    // chews through the candidate set. Without the timeout, React
    // batches the setIsPlanning update with the post-runPlan render.
    setTimeout(() => {
      try {
        runPlan(targetAltFt);
      } finally {
        setIsPlanning(false);
      }
    }, 0);
  }

  const currentRoute = routes[selectedRoute] ?? null;
  const routeObstacles = useMemo(
    () => obstaclesNearRoute(data.obstacles, currentRoute),
    [currentRoute, dataReady],
  );
  const terrain: TerrainAnalysis | null = useMemo(() => {
    if (!currentRoute) return null;
    return analyzeTerrain({
      legs: currentRoute.legs.map((l) => ({
        from: l.fromAirport,
        to: l.toAirport,
        fromIdent: l.fromAirport.icao ?? l.fromAirport.lid,
        toIdent: l.toAirport.icao ?? l.toAirport.lid,
        cruise_alt_ft: l.cruise_alt_ft,
      })),
      obstacles: routeObstacles,
      flightRule,
      dem: demReady ? demSampler : undefined,
      variation: variationFn,
    });
  }, [currentRoute, routeObstacles, flightRule, demReady]);

  function handleReplanAtMinSafe() {
    if (!terrain) return;
    setTargetAltFt(terrain.replanTargetFt);
    handlePlan();
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
            flightRule={flightRule}
            onFlightRuleChange={setFlightRule}
            capLegTime={capLegTime}
            onCapLegTimeChange={setCapLegTime}
            maxLegHr={maxLegHr}
            onMaxLegHrChange={setMaxLegHr}
            onPlan={handlePlan}
            isPlanning={isPlanning}
            dataReady={dataReady}
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
            targetAltFt={targetAltFt}
            onTargetAltChange={setTargetAltFt}
            reserveMin={reserveMin}
            onReserveChange={setReserveMin}
            startingFuelGal={startingFuelGal}
            onStartingFuelChange={setStartingFuelGal}
            capacityGal={selectedAircraft.fuel.usable_capacity_gal}
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
            totalCount={data.airports.length}
            hasApproachData={dataReady && data.hasApproachData}
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
            targetAltFt={targetAltFt}
            onReplanAtMinSafe={handleReplanAtMinSafe}
          />
          {currentRoute && (
            <ExportPanel
              route={currentRoute}
              aircraft={selectedAircraft}
              terrain={terrain}
            />
          )}
        </aside>
      )}
    </div>
  );
}
