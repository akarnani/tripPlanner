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
  airportSellsCompatibleFuel,
  airportsInRouteCorridor,
  applyFilters,
  DEFAULT_FILTERS,
} from "@/engine/filters";
import { planWithWaypoints, type PlannedRoute } from "@/engine/plan";
import {
  buildInteractiveLeg,
  buildInteractiveRoute,
  interactiveRangeRings,
  recommendLegAltitude,
  type LegAltitudeOverride,
} from "@/engine/interactive";
import { greatCircleNM } from "@/engine/geo";
import {
  aircraftSupportsRunwayCheck,
  classifyAirportRunwayFit,
  DEFAULT_RUNWAY_SETTINGS,
  filterByRunwayFit,
  oatFromIsaDelta,
  perLegWeights,
  type RunwayFitStatus,
  type RunwaySettings,
} from "@/engine/runway";

interface RunwayLegWarning {
  legIndex: number;
  phase: "takeoff" | "landing";
  ident: string;
  status: RunwayFitStatus;
  required_ft: number;
  available_ft: number;
  buffer_ft: number;
  weight_lb: number;
  /** Field pressure altitude used for the POH lookup (we use field
   *  elevation as a proxy when altimeter isn't known). Echoed in
   *  the warning so the pilot can spot-check against the chart. */
  pressure_alt_ft: number;
  /** OAT used for the POH lookup, in °C. Currently always
   *  ISA + the configured delta. */
  temp_c: number;
}
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
import { InteractivePanel } from "./ui/InteractivePanel";
import { PinnedStops } from "./ui/PinnedStops";
import { RunwayPanel } from "./ui/RunwayPanel";
import { RunwayWarnings } from "./ui/RunwayWarnings";
import { SidebarSection } from "./ui/SidebarSection";
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

  // Wizard accordion: exactly one sidebar section is expanded at a
  // time. Starts on "aircraft" — the natural first step (drives fuel,
  // range, runway check). Clicking a section header toggles it;
  // clicking "Continue →" inside a section advances to the next.
  type WizardStep =
    | "trips"
    | "aircraft"
    | "trip"
    | "runway"
    | "filters"
    | null;
  const [expandedSection, setExpandedSection] = useState<WizardStep>("aircraft");
  function toggleSection(id: Exclude<WizardStep, null>) {
    setExpandedSection((prev) => (prev === id ? null : id));
  }

  // Interactive-build state. Only consulted when planningMode is
  // "interactive"; the auto-plan flow above is fully independent so
  // toggling between modes never throws away the other mode's work.
  type PlanningMode = "auto" | "interactive";
  const [planningMode, setPlanningMode] = useState<PlanningMode>("auto");
  const [interactiveStopIds, setInteractiveStopIds] = useState<readonly string[]>(
    [],
  );
  const [legAltitudes, setLegAltitudes] = useState<readonly LegAltitudeOverride[]>(
    [],
  );
  const [runwaySettings, setRunwaySettings] = useState<RunwaySettings>(
    DEFAULT_RUNWAY_SETTINGS,
  );

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

  // The POH-driven runway check supersedes the manual minimum-
  // runway filter when both could apply. We only consider it
  // "active" when the toggle is on AND the aircraft has POH data —
  // without data the runway check is a no-op and the manual filter
  // should remain available.
  const runwayCheckActive =
    runwaySettings.enabled && aircraftSupportsRunwayCheck(selectedAircraft);

  const baseMatches = useMemo(() => {
    // When the runway check is active, ignore the manual
    // minRunwayFt floor — the POH check is strictly more accurate
    // and the manual cutoff was either redundant or contradictory.
    const effectiveFilters = runwayCheckActive
      ? { ...filters, minRunwayFt: 0 }
      : filters;
    return applyFilters(datasets, effectiveFilters, selectedAircraft.fuel.type);
  }, [datasets, filters, selectedAircraft.fuel.type, runwayCheckActive]);

  // Runway-fit filter sits on top of `applyFilters` so the user can
  // toggle it independently. Origin / destination / pinned stops are
  // exempt — the pilot has explicitly chosen them; runway concerns
  // surface as per-leg warnings rather than silently dropping the
  // requested route.
  const runwayExemptIds = useMemo(() => {
    const ids = new Set<string>();
    const o = airportByIdent(datasets.airports, origin);
    const d = airportByIdent(datasets.airports, destination);
    if (o) ids.add(o.id);
    if (d) ids.add(d.id);
    for (const id of pinnedStopIds) ids.add(id);
    for (const id of interactiveStopIds) ids.add(id);
    return ids;
  }, [
    datasets.airports,
    origin,
    destination,
    pinnedStopIds,
    interactiveStopIds,
  ]);

  const matches = useMemo(
    () =>
      filterByRunwayFit({
        airports: baseMatches,
        aircraft: selectedAircraft,
        settings: runwaySettings,
        exemptIds: runwayExemptIds,
      }),
    [baseMatches, selectedAircraft, runwaySettings, runwayExemptIds],
  );

  // Resolved origin and destination airports — null until the user
  // types valid idents and the dataset is loaded. Used by both modes
  // for distance / ring math; the auto planner also resolves them
  // inside runPlan() but interactive mode needs the live values
  // every render.
  const originAirport = useMemo(
    () => airportByIdent(datasets.airports, origin),
    [datasets.airports, origin],
  );
  const destinationAirport = useMemo(
    () => airportByIdent(datasets.airports, destination),
    [datasets.airports, destination],
  );

  const interactiveStopAirports = useMemo(() => {
    const out = [];
    for (const id of interactiveStopIds) {
      const a = datasets.airports.find((x) => x.id === id);
      if (a) out.push(a);
    }
    return out;
  }, [interactiveStopIds, datasets.airports]);

  // Build the interactive route + per-leg fuel feasibility from the
  // current sequence. Recomputed on every dependency change (cheap —
  // a handful of climbFromTo + cruiseAt + terrain calls).
  const interactiveBuild = useMemo(() => {
    if (planningMode !== "interactive") return null;
    if (!originAirport || !destinationAirport) return null;
    const sequence = [
      originAirport,
      ...interactiveStopAirports,
      destinationAirport,
    ];
    try {
      return buildInteractiveRoute({
        sequence,
        aircraft: selectedAircraft,
        targetAltFt,
        flightRule,
        reserveHr: reserveMin / 60,
        startingFuelGal,
        legAltitudes,
        variation: variationFn,
        dem: demReady ? demSampler : undefined,
      });
    } catch {
      return null;
    }
  }, [
    planningMode,
    originAirport,
    destinationAirport,
    interactiveStopAirports,
    selectedAircraft,
    targetAltFt,
    flightRule,
    reserveMin,
    startingFuelGal,
    legAltitudes,
    demReady,
  ]);

  // The "current departure point" for interactive mode — the last
  // stop the user picked, or the origin if none yet. The range rings
  // center here and the next click adds the next stop after it.
  const interactiveDeparture = useMemo(() => {
    if (planningMode !== "interactive") return null;
    return interactiveStopAirports.length > 0
      ? interactiveStopAirports[interactiveStopAirports.length - 1]
      : (originAirport ?? null);
  }, [planningMode, interactiveStopAirports, originAirport]);

  // Fuel actually onboard at the current departure point — depends
  // on the upstream chain of refuel vs pass-through stops, so we
  // pull it straight from the interactive build result rather than
  // reproducing the propagation rules here. With no stops yet we
  // depart on the pilot's configured starting fuel.
  const interactiveDepartureFuelGal = useMemo(() => {
    if (planningMode !== "interactive") return 0;
    if (interactiveStopAirports.length === 0)
      return Math.min(
        startingFuelGal,
        selectedAircraft.fuel.usable_capacity_gal,
      );
    if (!interactiveBuild) return 0;
    // legStartFuelGal[i] is the fuel at the start of leg i. The
    // current departure is `sequence[stops.length]`, which starts
    // leg `stops.length` (the closing leg → destination). That's
    // exactly the fuel we want.
    return (
      interactiveBuild.legStartFuelGal[interactiveStopAirports.length] ?? 0
    );
  }, [
    planningMode,
    interactiveStopAirports.length,
    startingFuelGal,
    selectedAircraft,
    interactiveBuild,
  ]);

  // Range rings at the current departure point. Scaled to actual
  // fuel onboard there — see interactiveDepartureFuelGal — so a
  // pass-through stop visibly shrinks the next ring.
  const interactiveRings = useMemo(() => {
    if (planningMode !== "interactive" || !interactiveDeparture) return null;
    return interactiveRangeRings({
      aircraft: selectedAircraft,
      altitude_ft: targetAltFt,
      reserve_hr: reserveMin / 60,
      fuel_onboard_gal: interactiveDepartureFuelGal,
    });
  }, [
    planningMode,
    interactiveDeparture,
    interactiveDepartureFuelGal,
    selectedAircraft,
    targetAltFt,
    reserveMin,
  ]);

  const interactiveDistanceToDest = useMemo(() => {
    if (!interactiveDeparture || !destinationAirport) return 0;
    return greatCircleNM(interactiveDeparture, destinationAirport);
  }, [interactiveDeparture, destinationAirport]);

  function handleEnterInteractive() {
    setPlanningMode("interactive");
    setInteractiveStopIds([]);
    setLegAltitudes([]);
    setRoutes([]);
    setError(null);
  }

  function handleExitInteractive() {
    setPlanningMode("auto");
    setInteractiveStopIds([]);
    setLegAltitudes([]);
  }

  function handleAddInteractiveStop(ident: string) {
    if (planningMode !== "interactive") return;
    if (!originAirport || !destinationAirport) return;
    const airport = airportByIdent(datasets.airports, ident);
    if (!airport) return;
    if (airport.id === originAirport.id) return;
    if (airport.id === destinationAirport.id) return;
    const airportId = airport.id;
    setInteractiveStopIds((prev) =>
      prev.includes(airportId) ? prev : [...prev, airportId],
    );
    // Track a slot in legAltitudes for the newly-inserted leg's
    // (= leg into the new stop) altitude. The closing leg to the
    // destination was at index N (== stops.length) before; after the
    // insert it moves to N+1. Insert a `null` before the closing
    // entry so existing per-leg overrides stay attached to the same
    // leg.
    setLegAltitudes((prev) => {
      const closing = prev[prev.length - 1];
      const head = prev.slice(0, -1);
      return [...head, null, closing ?? null];
    });
  }

  function handleRemoveInteractiveStop(stopIndex: number) {
    if (planningMode !== "interactive") return;
    setInteractiveStopIds((prev) => prev.filter((_, i) => i !== stopIndex));
    // Drop the altitude entry for the removed leg (= leg INTO the
    // removed stop, at index stopIndex).
    setLegAltitudes((prev) => prev.filter((_, i) => i !== stopIndex));
  }

  function handleChangeLegAltitude(legIndex: number, altFt: number | null) {
    setLegAltitudes((prev) => {
      const next = prev.slice();
      while (next.length <= legIndex) next.push(null);
      next[legIndex] = altFt;
      return next;
    });
  }

  /** Build the hover-popup HTML fragment for a candidate airport when
   *  in interactive mode. Includes the leg distance from the current
   *  departure, range status, any terrain warnings on the prospective
   *  approach, and an altitude recommendation that differs from the
   *  current target. Returns null when the airport isn't a sensible
   *  candidate (origin / destination / already-selected stop). */
  function interactiveHoverHtml(ident: string): string | null {
    if (planningMode !== "interactive") return null;
    if (!interactiveDeparture || !destinationAirport) return null;
    const a = airportByIdent(datasets.airports, ident);
    if (!a) return null;
    if (a.id === interactiveDeparture.id) return null;
    if (interactiveStopIds.includes(a.id)) return null;
    const dist = greatCircleNM(interactiveDeparture, a);
    const solid = interactiveRings?.solid_nm ?? 0;
    const dashed = interactiveRings?.dashed_nm ?? 0;
    const inSolid = dist <= solid;
    const inDashed = dist <= dashed;
    const reachability = inSolid
      ? `<span style="color:#0f766e">in range (${Math.round(dist).toLocaleString()} nm, ${Math.round(solid - dist).toLocaleString()} nm to spare)</span>`
      : inDashed
        ? `<span style="color:#b45309">past reserve — ${Math.round(dist).toLocaleString()} nm, ${Math.round(dist - solid).toLocaleString()} nm into the reserve</span>`
        : `<span style="color:#b91c1c">out of range (${Math.round(dist).toLocaleString()} nm, ${Math.round(dashed).toLocaleString()} nm max on this tank)</span>`;
    const sellsFuel = airportSellsCompatibleFuel(a, selectedAircraft.fuel.type);
    const fuelBit = sellsFuel
      ? null
      : `<span style="color:#b45309">no ${selectedAircraft.fuel.type} — pass-through only</span>`;
    // Compute the prospective leg into this airport to surface
    // terrain warnings and altitude advice. Use the global target
    // altitude — the per-leg override hasn't been chosen yet for a
    // not-yet-added leg.
    const fuel =
      interactiveStopAirports.length === 0
        ? startingFuelGal
        : selectedAircraft.fuel.usable_capacity_gal;
    const probe = buildInteractiveLeg({
      from: interactiveDeparture,
      to: a,
      aircraft: selectedAircraft,
      targetAltFt,
      flightRule,
      startingFuelGal: fuel,
      reserveHr: reserveMin / 60,
      variation: variationFn,
      dem: demReady ? demSampler : undefined,
    });
    const arrShort = probe.leg.extra?.terrain_arrival_shortfall_ft ?? 0;
    const depShort = probe.leg.extra?.terrain_departure_shortfall_ft ?? 0;
    const terrainBits: string[] = [];
    if (arrShort > 0) {
      terrainBits.push(
        `arrival corridor needs +${Math.round(arrShort).toLocaleString()} ft`,
      );
    }
    if (depShort > 0) {
      terrainBits.push(
        `departure corridor needs +${Math.round(depShort).toLocaleString()} ft`,
      );
    }
    const rec = recommendLegAltitude({
      aircraft: selectedAircraft,
      from: interactiveDeparture,
      to: a,
      targetAltFt,
      flightRule,
      variation: variationFn,
      minSafeAltFt:
        arrShort > 0 || depShort > 0
          ? probe.leg.cruise_alt_ft + Math.max(arrShort, depShort)
          : null,
    });
    const altBits: string[] = [];
    if (rec.defaultAltFt !== probe.leg.cruise_alt_ft) {
      // Shouldn't really happen — probe uses the default. Defensive.
    }
    if (rec.cheapestAltFt !== rec.defaultAltFt) {
      altBits.push(
        `cheapest at ${rec.cheapestAltFt.toLocaleString()} ft (vs ${rec.defaultAltFt.toLocaleString()})`,
      );
    }
    const parts: string[] = [`<div style="margin-top:4px">${reachability}</div>`];
    if (fuelBit) parts.push(`<div>${fuelBit}</div>`);
    if (terrainBits.length > 0) {
      parts.push(
        `<div style="color:#b45309">⚠ ${terrainBits.join(" · ")}</div>`,
      );
    }
    if (altBits.length > 0) {
      parts.push(`<div style="color:#475569">alt: ${altBits.join(" · ")}</div>`);
    }
    return parts.join("");
  }

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

  const currentRoute =
    planningMode === "interactive"
      ? (interactiveBuild?.route ?? null)
      : (routes[selectedRoute] ?? null);
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

  // Per-leg runway-fit warnings. Skipped entirely when the runway
  // check is off, the aircraft lacks POH data, or there's no route.
  // Pass-through stops (interactive mode) carry weight through to
  // the next leg's takeoff per the perLegWeights model.
  const runwayWarnings = useMemo(() => {
    if (!currentRoute) return [] as RunwayLegWarning[];
    if (!runwaySettings.enabled) return [];
    if (!aircraftSupportsRunwayCheck(selectedAircraft)) return [];
    const legs = currentRoute.legs;
    // Per-stop refuel flags: each leg-origin after the first refuels
    // iff that airport sells the aircraft's fuel type. The trip
    // origin always counts as a refuel for the weight-model entry
    // point (the pilot fills up before departure).
    const legOriginRefuels = legs.map((leg, i) =>
      i === 0
        ? true
        : airportSellsCompatibleFuel(
            leg.fromAirport,
            selectedAircraft.fuel.type,
          ),
    );
    const weights = perLegWeights({
      aircraft: selectedAircraft,
      legFuelBurnGal: legs.map((l) => l.fuel_gal),
      legOriginRefuels,
      startingFuelGal,
    });
    if (!weights) return [];
    const out: RunwayLegWarning[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const wt = weights[i];
      const takeoffFit = classifyAirportRunwayFit({
        aircraft: selectedAircraft,
        airport: leg.fromAirport,
        settings: runwaySettings,
        takeoff_weight_lb: wt.takeoff_lb,
      });
      const fromElev = leg.fromAirport.elevation_ft ?? 0;
      const toElev = leg.toAirport.elevation_ft ?? 0;
      if (takeoffFit && takeoffFit.takeoff_status !== "ok") {
        out.push({
          legIndex: i,
          phase: "takeoff",
          ident: leg.fromAirport.icao ?? leg.fromAirport.lid,
          status: takeoffFit.takeoff_status,
          required_ft: takeoffFit.takeoff_required_ft,
          available_ft: takeoffFit.available_ft,
          buffer_ft: runwaySettings.buffer_ft,
          weight_lb: wt.takeoff_lb,
          pressure_alt_ft: fromElev,
          temp_c: oatFromIsaDelta(fromElev, runwaySettings.isa_delta_c),
        });
      }
      const landingFit = classifyAirportRunwayFit({
        aircraft: selectedAircraft,
        airport: leg.toAirport,
        settings: runwaySettings,
        landing_weight_lb: wt.landing_lb,
      });
      if (landingFit && landingFit.landing_status !== "ok") {
        out.push({
          legIndex: i,
          phase: "landing",
          ident: leg.toAirport.icao ?? leg.toAirport.lid,
          status: landingFit.landing_status,
          required_ft: landingFit.landing_required_ft,
          available_ft: landingFit.available_ft,
          buffer_ft: runwaySettings.buffer_ft,
          weight_lb: wt.landing_lb,
          pressure_alt_ft: toElev,
          temp_c: oatFromIsaDelta(toElev, runwaySettings.isa_delta_c),
        });
      }
    }
    return out;
  }, [currentRoute, runwaySettings, selectedAircraft, startingFuelGal]);

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
      planningMode,
      // Persist interactive selections so a saved interactive trip
      // can be loaded back with the same chain and per-leg altitudes
      // (or none, for auto-mode trips). LegAltitudeOverride is
      // `number | null | undefined`; collapse to `number | null` for
      // JSON.
      interactiveStopIds: [...interactiveStopIds],
      legAltitudes: legAltitudes.map((a) =>
        a === undefined || a === null ? null : a,
      ),
      runwaySettings,
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
    // Restore interactive-mode state. Trips saved before this field
    // existed load into auto mode with empty interactive selections.
    setPlanningMode(t.planningMode ?? "auto");
    setInteractiveStopIds(t.interactiveStopIds ?? []);
    setLegAltitudes(t.legAltitudes ?? []);
    setRunwaySettings(t.runwaySettings ?? DEFAULT_RUNWAY_SETTINGS);
    setRoutes([]);
    setError(null);
  }

  function handleDeleteTrip(name: string) {
    setTrips(deleteTrip(name));
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="z-10 flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-5 backdrop-blur">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-card">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 1 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1L15 22v-1.5L13 19v-5.5l8 2.5z" />
          </svg>
        </div>
        <div className="flex-1">
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Trip Planner
          </h1>
          <p className="text-[11px] text-slate-500">
            GA route planning · fuel stops · terrain · approaches
          </p>
        </div>
        <div className="hidden items-center gap-3 text-[11px] text-slate-500 sm:flex">
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 " +
              (dataReady
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700")
            }
          >
            <span
              className={
                "h-1.5 w-1.5 rounded-full " +
                (dataReady ? "bg-emerald-500" : "animate-pulse bg-amber-500")
              }
              aria-hidden="true"
            />
            {dataReady ? "Airport database ready" : "Loading airports…"}
          </span>
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 " +
              (demReady
                ? "bg-emerald-50 text-emerald-700"
                : "bg-slate-100 text-slate-500")
            }
          >
            <span
              className={
                "h-1.5 w-1.5 rounded-full " +
                (demReady ? "bg-emerald-500" : "bg-slate-400")
              }
              aria-hidden="true"
            />
            {demReady ? "Terrain ready" : "Terrain loading…"}
          </span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-[340px] shrink-0 space-y-3 overflow-y-auto border-r border-slate-200 bg-slate-50 p-4">
          <SidebarSection
            title="Saved trips"
            summary={
              trips.length === 0
                ? "Save the current trip to revisit later"
                : `${trips.length} saved · click to load or save`
            }
            expanded={expandedSection === "trips"}
            onToggle={() => toggleSection("trips")}
          >
            <TripsPanel
              trips={trips}
              defaultName={`${origin} → ${destination}`}
              onSave={handleSaveTrip}
              onLoad={handleLoadTrip}
              onDelete={handleDeleteTrip}
            />
          </SidebarSection>
          <SidebarSection
            number={1}
            title="Aircraft & cruise"
            summary={`${selectedAircraft.make} ${selectedAircraft.model} · ${targetAltFt.toLocaleString()} ft · ${reserveMin} min reserve · ${startingFuelGal.toFixed(0)}/${selectedAircraft.fuel.usable_capacity_gal} gal`}
            expanded={expandedSection === "aircraft"}
            onToggle={() => toggleSection("aircraft")}
            onContinue={() => setExpandedSection("trip")}
            continueLabel="Continue to trip →"
          >
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
          </SidebarSection>
          <SidebarSection
            number={2}
            title="Trip"
            summary={
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono font-medium text-slate-700">
                  {origin}
                </span>
                <span className="text-slate-400">→</span>
                <span className="font-mono font-medium text-slate-700">
                  {destination}
                </span>
                <span className="text-slate-400">·</span>
                <span>{flightRule}</span>
                {planningMode === "interactive" && (
                  <span className="rounded-full bg-orange-100 px-1.5 text-[10px] font-semibold uppercase text-orange-700">
                    interactive
                  </span>
                )}
                {capLegTime && (
                  <>
                    <span className="text-slate-400">·</span>
                    <span>cap {maxLegHr}h</span>
                  </>
                )}
              </span>
            }
            expanded={expandedSection === "trip"}
            onToggle={() => toggleSection("trip")}
            onContinue={() => setExpandedSection("runway")}
            continueLabel="Continue to runway check →"
          >
            {planningMode === "auto" ? (
              <>
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
                <button
                  type="button"
                  onClick={handleEnterInteractive}
                  disabled={!dataReady || !originAirport || !destinationAirport}
                  className="btn-secondary mt-3 w-full text-xs"
                >
                  Build interactively →
                </button>
                <div className="mt-4">
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
                <div className="mt-4">
                  <ExcludedAirports
                    excludedIds={excludedIds}
                    airports={datasets.airports}
                    originIdent={origin}
                    destinationIdent={destination}
                    onExclude={handleExcludeStops}
                    onInclude={handleIncludeStop}
                  />
                </div>
              </>
            ) : (
              <InteractivePanel
                originIdent={originAirport?.icao ?? originAirport?.lid ?? origin}
                destinationIdent={
                  destinationAirport?.icao ?? destinationAirport?.lid ?? destination
                }
                stops={interactiveStopAirports}
                route={currentRoute}
                legAltitudes={legAltitudes}
                legFeasibility={interactiveBuild?.feasibility ?? []}
                stopRefuels={interactiveBuild?.stopRefuels ?? []}
                distanceToDestNm={interactiveDistanceToDest}
                rangeSolidNm={interactiveRings?.solid_nm ?? 0}
                rangeDashedNm={interactiveRings?.dashed_nm ?? 0}
                destInRange={
                  (interactiveRings?.solid_nm ?? 0) >= interactiveDistanceToDest
                }
                cruiseCeilingFt={
                  selectedAircraft.cruise[selectedAircraft.cruise.length - 1]
                    ?.altitude_ft ?? 0
                }
                onRemoveStop={handleRemoveInteractiveStop}
                onChangeLegAltitude={handleChangeLegAltitude}
                onExit={handleExitInteractive}
              />
            )}
          </SidebarSection>
          <SidebarSection
            number={3}
            title="Runway check"
            summary={runwayCheckSummary(
              runwaySettings,
              aircraftSupportsRunwayCheck(selectedAircraft),
            )}
            expanded={expandedSection === "runway"}
            onToggle={() => toggleSection("runway")}
            onContinue={() => setExpandedSection("filters")}
            continueLabel="Continue to filters →"
          >
            <RunwayPanel
              settings={runwaySettings}
              onChange={setRunwaySettings}
              aircraftHasData={aircraftSupportsRunwayCheck(selectedAircraft)}
              aircraftModel={selectedAircraft.model}
            />
          </SidebarSection>
          <SidebarSection
            number={4}
            title="Airport filters"
            summary={`${matches.length.toLocaleString()} of ${datasets.airports.length.toLocaleString()} airports match`}
            expanded={expandedSection === "filters"}
            onToggle={() => toggleSection("filters")}
          >
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              matchCount={matches.length}
              totalCount={datasets.airports.length}
              hasApproachData={datasets.hasApproachData}
              aircraftFuelType={selectedAircraft.fuel.type}
              runwayCheckActive={runwayCheckActive}
            />
          </SidebarSection>
        </aside>
        <main className="relative flex-1">
          <MapView
            airports={matches}
            route={currentRoute}
            onMoveStop={planningMode === "auto" ? handleMoveStop : undefined}
            terminalWarnings={terminalWarnings}
            interactive={
              planningMode === "interactive" &&
              interactiveDeparture &&
              destinationAirport &&
              interactiveRings
                ? {
                    center: interactiveDeparture,
                    destination: destinationAirport,
                    rangeSolidNm: interactiveRings.solid_nm,
                    rangeDashedNm: interactiveRings.dashed_nm,
                    onAirportClick: handleAddInteractiveStop,
                    onAirportHoverHtml: interactiveHoverHtml,
                  }
                : undefined
            }
          />
        </main>
        {(routes.length > 0 || (planningMode === "interactive" && currentRoute)) && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-slate-200 bg-slate-50">
            <div className="flex-1 overflow-y-auto">
              <LegTable
                routes={planningMode === "interactive" && currentRoute ? [currentRoute] : routes}
                selected={planningMode === "interactive" ? 0 : selectedRoute}
                onSelect={planningMode === "interactive" ? () => {} : setSelectedRoute}
                onExcludeStop={
                  planningMode === "interactive"
                    ? () => {}
                    : (id) => handleExcludeStops([id])
                }
                onReplaceStop={
                  planningMode === "interactive" ? () => {} : handleReplaceStop
                }
              />
            </div>
            <TerrainPanel
              analysis={terrain}
              targetAltFt={targetAltFt}
              onReplanAtMinSafe={handleReplanAtMinSafe}
              terminalWarnings={terminalWarnings}
            />
            <RunwayWarnings warnings={runwayWarnings} />
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
    </div>
  );
}

function runwayCheckSummary(
  settings: RunwaySettings,
  aircraftHasData: boolean,
): string {
  if (!aircraftHasData) return "Not available for this aircraft";
  if (!settings.enabled) return "Off — enable to check runway lengths";
  const w = settings.weight === "maxGross" ? "max gross" : "estimated";
  const isa = settings.isa_delta_c >= 0
    ? `ISA+${settings.isa_delta_c}°C`
    : `ISA${settings.isa_delta_c}°C`;
  return `On · ${w} weight · +${settings.buffer_ft} ft buffer · ${isa}`;
}
