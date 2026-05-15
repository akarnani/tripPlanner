import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import {
  airportByIdent,
  EMPTY_DATASETS,
  loadDatasets,
  type Datasets,
} from "@/data/loaders";
import { aircraft as allAircraft, aircraftBySlug } from "@/data/aircraft";
import {
  airportsInRouteCorridor,
  applyFilters,
  DEFAULT_FILTERS,
} from "@/engine/filters";
import { planWithWaypoints, type PlannedRoute } from "@/engine/plan";
import { greatCircleNM } from "@/engine/geo";
import { obstaclesNearRoute } from "@/engine/obstacles";
import { analyzeTerrain, type TerrainAnalysis } from "@/engine/terrain";
import { terminalCorridorWarnings } from "@/engine/terrainPenalty";
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
import { PinnedStops } from "./ui/PinnedStops";
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
  const [pinnedStopIds, setPinnedStopIds] = useState<readonly string[]>([]);
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

  interface PlanOverrides {
    /** Explicit exclusion set, used when the caller just mutated state
     *  and React hasn't committed yet. Falls back to the current
     *  excludedIds when omitted. */
    excluded?: ReadonlySet<string>;
    /** Same idea for the pinned waypoint list. */
    pinned?: readonly string[];
  }

  function runPlan(targetFt: number, overrides: PlanOverrides = {}) {
    setError(null);
    const o = airportByIdent(datasets.airports, origin);
    const d = airportByIdent(datasets.airports, destination);
    if (!o) {
      setError(`unknown origin: ${origin}`);
      setRoutes([]);
      return;
    }
    if (!d) {
      setError(`unknown destination: ${destination}`);
      setRoutes([]);
      return;
    }
    const excluded = overrides.excluded ?? excludedIds;
    const pinned = overrides.pinned ?? pinnedStopIds;
    // Pinned airports must be in the candidate set even when the hard
    // filters would have dropped them — the user explicitly chose
    // them. Origin/destination get the same exemption.
    const pinnedAirports = pinned
      .map((id) => datasets.airports.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a);
    // Drop airports that are nowhere near the direct route. With ~5k
    // public-use airports in CONUS, the unfiltered routing graph has
    // ~25M edges; an airport in Florida is never a useful fuel stop
    // for a Bay Area → Wisconsin flight, so culling them here turns
    // tens of seconds of planning into a fraction.
    const onRoute = airportsInRouteCorridor(matches, o, d);
    const candidates = Array.from(
      new Map(
        [...onRoute, o, d, ...pinnedAirports].map((a) => [a.id, a]),
      ).values(),
    );
    try {
      const result = planWithWaypoints({
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
        excludedAirportIds: excluded,
        waypoints: pinned,
        dem: demReady ? demSampler : undefined,
      });
      if (result.length === 0) {
        setError("no route found — try relaxing constraints");
        setRoutes([]);
        return;
      }
      setRoutes(result);
      setSelectedRoute(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function runWithSpinner(
    targetFt: number,
    overrides: PlanOverrides = {},
  ) {
    if (isPlanning) return;
    // flushSync forces React to commit the spinner-on render before
    // we yield. Without it, React 18 can defer the commit past our
    // requestAnimationFrame callbacks and runPlan() below blocks the
    // main thread for tens of seconds with the button still rendered
    // in its idle state.
    flushSync(() => setIsPlanning(true));
    const startedAt = performance.now();
    // After flushSync, the DOM has the spinner. Double-RAF ensures the
    // browser actually paints it before runPlan blocks. Tailwind's
    // animate-spin uses transform, which runs on the compositor and
    // keeps spinning while the main thread is busy.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          runPlan(targetFt, overrides);
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

  function handlePlan() {
    runWithSpinner(targetAltFt);
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

  const terminalWarnings = useMemo(
    () => (currentRoute ? terminalCorridorWarnings(currentRoute) : []),
    [currentRoute],
  );

  function handleReplanAtMinSafe() {
    if (!terrain) return;
    const newAlt = terrain.replanTargetFt;
    setTargetAltFt(newAlt);
    // Plan synchronously with the new altitude — setTargetAltFt only
    // takes effect on the next render, so handlePlan()'s closure would
    // otherwise see the stale value and replan at the old altitude.
    runWithSpinner(newAlt);
  }

  function handleExcludeStops(airportIds: string[]) {
    const nextExcluded = new Set(excludedIds);
    for (const id of airportIds) nextExcluded.add(id);
    // Excluding a pinned airport contradicts the pin — the exclusion
    // is the more recent intent, so drop the pin in the same commit.
    const droppedPins = new Set(airportIds);
    const nextPinned = pinnedStopIds.filter((id) => !droppedPins.has(id));
    const pinnedChanged = nextPinned.length !== pinnedStopIds.length;
    setExcludedIds(nextExcluded);
    if (pinnedChanged) setPinnedStopIds(nextPinned);
    runWithSpinner(targetAltFt, {
      excluded: nextExcluded,
      pinned: pinnedChanged ? nextPinned : undefined,
    });
  }

  function handleIncludeStop(airportId: string) {
    const next = new Set(excludedIds);
    next.delete(airportId);
    setExcludedIds(next);
    runWithSpinner(targetAltFt, { excluded: next });
  }

  function handleAddPins(airportIds: string[]) {
    const fresh = airportIds.filter((id) => !pinnedStopIds.includes(id));
    if (fresh.length === 0) return;
    const next = [...pinnedStopIds, ...fresh];
    // Pinning an excluded airport contradicts the exclusion — the
    // pin is the more recent intent, so drop the exclusion in the
    // same commit.
    let nextExcluded = excludedIds;
    let excludedChanged = false;
    for (const id of fresh) {
      if (nextExcluded.has(id)) {
        if (!excludedChanged) {
          nextExcluded = new Set(excludedIds);
          excludedChanged = true;
        }
        (nextExcluded as Set<string>).delete(id);
      }
    }
    setPinnedStopIds(next);
    if (excludedChanged) setExcludedIds(nextExcluded);
    runWithSpinner(targetAltFt, {
      pinned: next,
      excluded: excludedChanged ? nextExcluded : undefined,
    });
  }

  function handleRemovePin(airportId: string) {
    const next = pinnedStopIds.filter((id) => id !== airportId);
    setPinnedStopIds(next);
    runWithSpinner(targetAltFt, { pinned: next });
  }

  function handleReorderPins(nextPinned: string[]) {
    setPinnedStopIds(nextPinned);
    runWithSpinner(targetAltFt, { pinned: nextPinned });
  }

  function handleReplaceStop(oldAirportId: string, newIdent: string) {
    const replacement = airportByIdent(datasets.airports, newIdent);
    if (!replacement) {
      setError(`unknown airport: ${newIdent.toUpperCase()}`);
      return;
    }
    if (replacement.id === oldAirportId) return;

    const oldPinIndex = pinnedStopIds.indexOf(oldAirportId);
    let nextPinned: string[];
    let nextExcluded = excludedIds;

    if (oldPinIndex >= 0) {
      // The replaced stop was already pinned. Swap the pin in place
      // instead of leaving the old pin stale and adding another — and
      // don't exclude the old airport (the user just edited a pin
      // they explicitly set; excluding it would be surprising). If the
      // replacement is itself already pinned somewhere else, drop the
      // old pin and leave the existing position alone.
      nextPinned = pinnedStopIds.includes(replacement.id)
        ? pinnedStopIds.filter((id) => id !== oldAirportId)
        : pinnedStopIds.map((id, i) =>
            i === oldPinIndex ? replacement.id : id,
          );
    } else {
      // The old stop was a planner-chosen fuel stop, not a pin.
      // Exclude it so the planner can't pick it again, then pin the
      // new airport at the matching position in the route.
      const next = new Set(excludedIds);
      next.add(oldAirportId);
      nextExcluded = next;

      const route = routes[selectedRoute];
      const stopIds = route
        ? route.legs.slice(0, -1).map((l) => l.toAirport.id)
        : [];
      const oldPos = stopIds.indexOf(oldAirportId);
      let insertAt = pinnedStopIds.length;
      if (oldPos >= 0) {
        insertAt = 0;
        for (let i = 0; i < pinnedStopIds.length; i++) {
          const pinPos = stopIds.indexOf(pinnedStopIds[i]);
          if (pinPos >= 0 && pinPos < oldPos) insertAt = i + 1;
        }
      }
      nextPinned = pinnedStopIds.includes(replacement.id)
        ? [...pinnedStopIds]
        : [
            ...pinnedStopIds.slice(0, insertAt),
            replacement.id,
            ...pinnedStopIds.slice(insertAt),
          ];
    }

    // The replacement is being pinned — drop it from the exclusion
    // list if it happens to be there, since pin + exclude on the same
    // airport contradict each other.
    if (nextExcluded.has(replacement.id)) {
      const e = new Set(nextExcluded);
      e.delete(replacement.id);
      nextExcluded = e;
    }

    setExcludedIds(nextExcluded);
    setPinnedStopIds(nextPinned);
    runWithSpinner(targetAltFt, {
      excluded: nextExcluded,
      pinned: nextPinned,
    });
  }

  /** Map-drag snap radius: airports farther than this from the drop
   *  point are not considered. Picked to be generous at the default
   *  zoom (~13 px) but still small enough that a wild drop into open
   *  ocean snaps to nothing rather than a random coastal field. */
  const DRAG_SNAP_RADIUS_NM = 50;

  function handleMoveStop(
    oldAirportId: string,
    dropLngLat: { lat: number; lon: number },
  ): boolean {
    if (isPlanning) return false;
    // Search the filter-eligible set so a drop snaps to an airport
    // that's actually visible on the map. Origin/destination get
    // merged in for completeness but are skipped: dropping a stop
    // onto the origin/destination doesn't make sense as a route edit.
    const o = airportByIdent(datasets.airports, origin);
    const d = airportByIdent(datasets.airports, destination);
    let nearest: { id: string; ident: string; dist: number } | null = null;
    for (const a of matches) {
      if (a.id === oldAirportId) continue;
      if (o && a.id === o.id) continue;
      if (d && a.id === d.id) continue;
      const dist = greatCircleNM(dropLngLat, { lat: a.lat, lon: a.lon });
      if (dist > DRAG_SNAP_RADIUS_NM) continue;
      if (!nearest || dist < nearest.dist) {
        nearest = { id: a.id, ident: a.icao ?? a.lid, dist };
      }
    }
    if (!nearest) return false;
    if (nearest.id === oldAirportId) return false;
    // Drag is purely additive: pin the dragged-to airport so the route
    // is forced through it, but leave the dragged-from airport alone.
    // The user can still exclude the old stop via its × in the leg
    // table or excluded-stops panel if they want it gone.
    handleAddPins([nearest.id]);
    return true;
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
      pinnedStopIds: [...pinnedStopIds],
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
    setPinnedStopIds(t.pinnedStopIds ?? []);
    setRoutes([]);
    setError(null);
  }

  function handleDeleteTrip(name: string) {
    setTrips(deleteTrip(name));
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
            <PinnedStops
              pinnedIds={pinnedStopIds}
              airports={datasets.airports}
              aircraftFuelType={selectedAircraft.fuel.type}
              originIdent={origin}
              destinationIdent={destination}
              onAdd={handleAddPins}
              onRemove={handleRemovePin}
              onReorder={handleReorderPins}
            />
          </div>
          <div className="mt-3">
            <ExcludedAirports
              excludedIds={excludedIds}
              airports={datasets.airports}
              originIdent={origin}
              destinationIdent={destination}
              onExclude={handleExcludeStops}
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
        <MapView
          airports={matches}
          route={currentRoute}
          onMoveStop={handleMoveStop}
          terminalWarnings={terminalWarnings}
        />
      </main>
      {routes.length > 0 && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50">
          <div className="flex-1 overflow-y-auto">
            <LegTable
              routes={routes}
              selected={selectedRoute}
              onSelect={setSelectedRoute}
              onExcludeStop={(id) => handleExcludeStops([id])}
              onReplaceStop={handleReplaceStop}
            />
          </div>
          <TerrainPanel
            analysis={terrain}
            targetAltFt={targetAltFt}
            onReplanAtMinSafe={handleReplanAtMinSafe}
            terminalWarnings={terminalWarnings}
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
