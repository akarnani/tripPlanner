import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import {
  airportByIdent,
  EMPTY_DATASETS,
  loadDatasets,
  type Datasets,
} from "@/data/loaders";
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
import { ExcludedAirports } from "./ui/ExcludedAirports";
import { TripsPanel } from "./ui/TripsPanel";
import {
  deleteTrip,
  listTrips,
  saveTrip,
  type SavedTrip,
} from "@/data/trips";

const demSampler = new TerrainGridDEMSampler(terrainGridUrl);
const magGrid = new MagneticVariationGrid(magneticGridUrl);
const variationFn = (p: { lat: number; lon: number }) =>
  magGrid.variationDeg(p);

const MIN_SPINNER_MS = 600;

export function App() {
  const [datasets, setDatasets] = useState<Datasets>(EMPTY_DATASETS);
  const [dataReady, setDataReady] = useState(false);
  const [demReady, setDemReady] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [aircraftSlug, setAircraftSlug] = useState(allAircraft[0]?.slug ?? "");
  const [targetAltFt, setTargetAltFt] = useState(6500);
  const [reserveMin, setReserveMin] = useState(45);
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
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [trips, setTrips] = useState<SavedTrip[]>(() => listTrips());

  // Datasets are fetched at runtime instead of being bundled into the
  // JS so the initial paint isn't blocked by parsing several MB of
  // JSON. The terrain DEM and magnetic-variation grids load in
  // parallel; planning + terrain analysis gracefully degrade until
  // they're ready.
  useEffect(() => {
    loadDatasets()
      .then((d) => {
        setDatasets(d);
        setDataReady(true);
      })
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
    () => applyFilters(datasets, filters, selectedAircraft.fuel.type),
    [datasets, filters, selectedAircraft.fuel.type],
  );

  function runPlan(targetFt: number) {
    setError(null);
    const o = airportByIdent(datasets.airports, origin);
    const d = airportByIdent(datasets.airports, destination);
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
        excludedAirportIds: excludedIds,
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
    // flushSync forces React to commit the spinner-on render before
    // we yield. Without it, React 18 can defer the commit past our
    // requestAnimationFrame callbacks and the runPlan() call below
    // blocks the main thread for tens of seconds with the button
    // still rendered in its idle state.
    flushSync(() => setIsPlanning(true));
    const startedAt = performance.now();
    // After flushSync, the DOM has the spinner. Double-RAF ensures the
    // browser actually paints it before runPlan blocks. Tailwind's
    // animate-spin uses transform, which runs on the compositor and
    // keeps spinning while the main thread is busy.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          runPlan(targetAltFt);
        } finally {
          // Always schedule the back-to-idle transition through
          // setTimeout. If runPlan blocks past MIN_SPINNER_MS,
          // calling setIsPlanning(false) synchronously here would
          // commit "planning" and "idle" in the same uninterrupted
          // JS task — the renderer never yields, so neither users
          // nor Playwright observe the spinner. The 50 ms floor
          // guarantees at least one event-loop tick of visible
          // spinner state.
          const elapsed = performance.now() - startedAt;
          const remaining = Math.max(50, MIN_SPINNER_MS - elapsed);
          setTimeout(() => setIsPlanning(false), remaining);
        }
      });
    });
  }

  const currentRoute = routes[selectedRoute] ?? null;
  const routeObstacles = useMemo(
    () => obstaclesNearRoute(datasets.obstacles, currentRoute),
    [currentRoute, datasets.obstacles],
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

  function handleExcludeStop(airportId: string) {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      next.add(airportId);
      return next;
    });
    // Replan immediately so the user sees the new route. The closure
    // here still has the old excludedIds — runPlan reads from React
    // state, but our state update above hasn't committed yet.
    // Workaround: derive a fresh set inline and pass through a
    // dedicated runPlanWithExclusions variant.
    runPlanWithExclusions(targetAltFt, (() => {
      const next = new Set(excludedIds);
      next.add(airportId);
      return next;
    })());
  }

  function handleIncludeStop(airportId: string) {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      next.delete(airportId);
      return next;
    });
    runPlanWithExclusions(targetAltFt, (() => {
      const next = new Set(excludedIds);
      next.delete(airportId);
      return next;
    })());
  }

  function handleSaveTrip(name: string) {
    const trip: SavedTrip = {
      name,
      origin,
      destination,
      aircraftSlug: selectedAircraft.slug,
      targetAltFt,
      reserveMin,
      startingFuelGal,
      flightRule,
      capLegTime,
      maxLegHr,
      filters,
      excludedIds: [...excludedIds],
      savedAt: new Date().toISOString(),
    };
    setTrips(saveTrip(trip));
  }

  function handleLoadTrip(t: SavedTrip) {
    setOrigin(t.origin);
    setDestination(t.destination);
    setAircraftSlug(t.aircraftSlug);
    setTargetAltFt(t.targetAltFt);
    setReserveMin(t.reserveMin);
    setStartingFuelGal(t.startingFuelGal);
    setFlightRule(t.flightRule);
    setCapLegTime(t.capLegTime);
    setMaxLegHr(t.maxLegHr);
    // Merge over defaults so trips saved before a new filter field
    // was added still load with sensible values for it.
    setFilters({ ...DEFAULT_FILTERS, ...t.filters });
    setExcludedIds(new Set(t.excludedIds));
    setRoutes([]);
    setError(null);
  }

  function handleDeleteTrip(name: string) {
    setTrips(deleteTrip(name));
  }

  function runPlanWithExclusions(
    targetFt: number,
    exclusions: ReadonlySet<string>,
  ) {
    if (isPlanning) return;
    flushSync(() => setIsPlanning(true));
    const startedAt = performance.now();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          // Same shape as runPlan but with the explicitly-passed
          // exclusions, so the user's brand-new exclusion takes
          // effect immediately rather than after the next render.
          setError(null);
          const o = airportByIdent(datasets.airports, origin);
          const d = airportByIdent(datasets.airports, destination);
          if (!o || !d) {
            setError(`unknown airport`);
            return;
          }
          const candidates = Array.from(
            new Map([...matches, o, d].map((a) => [a.id, a])).values(),
          );
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
            excludedAirportIds: exclusions,
          });
          if (result.length === 0) {
            setError(
              "no route found — try relaxing filters or removing exclusions",
            );
            setRoutes([]);
            return;
          }
          setRoutes(result);
          setSelectedRoute(0);
        } finally {
          const elapsed = performance.now() - startedAt;
          const remaining = Math.max(50, MIN_SPINNER_MS - elapsed);
          setTimeout(() => setIsPlanning(false), remaining);
        }
      });
    });
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
          <h2 className="mb-2 text-sm font-semibold text-slate-800">
            Saved trips
          </h2>
          <TripsPanel
            trips={trips}
            defaultName={`${origin} → ${destination}`}
            onSave={handleSaveTrip}
            onLoad={handleLoadTrip}
            onDelete={handleDeleteTrip}
          />
        </section>
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
          <div className="mt-3">
            <ExcludedAirports
              excludedIds={excludedIds}
              airports={datasets.airports}
              onInclude={handleIncludeStop}
            />
          </div>
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
            totalCount={datasets.airports.length}
            hasApproachData={datasets.hasApproachData}
            aircraftFuelType={selectedAircraft.fuel.type}
          />
        </section>
      </aside>
      <main className="relative flex-1">
        <MapView airports={matches} route={currentRoute} />
      </main>
      {routes.length > 0 && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50">
          <div className="flex-1 overflow-y-auto">
            <LegTable
              routes={routes}
              selected={selectedRoute}
              onSelect={setSelectedRoute}
              onExcludeStop={handleExcludeStop}
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
