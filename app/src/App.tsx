import { useCallback, useMemo, useRef, useState } from "react";
import { useEffect } from "react";
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
import { type PlannedRoute } from "@/engine/plan";
import {
  buildInteractiveLeg,
  buildInteractiveRoute,
  interactiveRangeRings,
  recommendLegAltitude,
  type LegAltitudeOverride,
} from "@/engine/interactive";
import { rankInteractiveCandidates } from "@/engine/candidates";
import { greatCircleNM } from "@/engine/geo";
import {
  aircraftSupportsRunwayCheck,
  classifyAirportRunwayFit,
  DEFAULT_RUNWAY_SETTINGS,
  filterByRunwayFit,
  oatFromIsaDelta,
  perLegWeights,
  type RunwaySettings,
} from "@/engine/runway";
import {
  cruiseBurnGph,
  perLegArrivalFuel,
  reserveFuelGal,
} from "@/engine/fuel";
import {
  collectRouteIssues,
  type RunwayLegWarning,
} from "@/engine/routeIssues";
import { buildRouteProfile } from "@/engine/routeProfile";
import {
  RouteProfileDock,
  type ViewportBounds,
} from "./ui/RouteProfileDock";
import { RouteProfile } from "./ui/RouteProfile";
import { explainStopChoices } from "@/engine/stopAlternatives";
import { WhyStopsPanel } from "./ui/WhyStopsPanel";
import { obstaclesNearRoute } from "@/engine/obstacles";
import { analyzeTerrain, type TerrainAnalysis } from "@/engine/terrain";
import { terminalCorridorWarnings } from "@/engine/terrainPenalty";
import type { FlightRule } from "@/engine/hemispheric";
import { TerrainGridDEMSampler } from "@/engine/terrainGrid";
import { MagneticVariationGrid } from "@/engine/magneticVariation";
import terrainGridUrl from "@data/terrain_grid.bin.gz?url";
import magneticGridUrl from "@data/magnetic_grid.bin.gz?url";
import { MapView, type MapViewApi } from "./ui/MapView";
import { AirportLink } from "./ui/AirportLink";
import { FilterPanel } from "./ui/FilterPanel";
import { AircraftPanel } from "./ui/AircraftPanel";
import { TripPanel } from "./ui/TripPanel";
import { LegTable } from "./ui/LegTable";
import { ExportPanel } from "./ui/ExportPanel";
import { ExcludedAirports } from "./ui/ExcludedAirports";
import { InteractivePanel } from "./ui/InteractivePanel";
import { PinnedStops } from "./ui/PinnedStops";
import { suggestDetours, type DetourSuggestion } from "./engine/detours";
import type { LatLon } from "./engine/geo";
import { RunwayPanel } from "./ui/RunwayPanel";
import { RouteIssuesPanel } from "./ui/RouteIssuesPanel";
import { SavedTripsPopover } from "./ui/SavedTripsPopover";
import { Section } from "./ui/Section";
import { Toast, type ToastData } from "./ui/Toast";
import { MapLegend } from "./ui/MapLegend";
import { FirstRunHint } from "./ui/FirstRunHint";
import { ThemeToggle } from "./ui/theme";
import { usePlanner } from "./ui/usePlanner";
import { useMediaQuery } from "./ui/useMediaQuery";
import {
  describePlanDiff,
  snapshotsEqual,
  type PlanSnapshot,
} from "./ui/planSnapshot";
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

/** Everything the single-slot undo needs to restore a pre-mutation
 *  world synchronously — including the planned routes themselves, so
 *  undo never has to replan. */
interface UndoSnapshot {
  pinnedStopIds: readonly string[];
  excludedIds: ReadonlySet<string>;
  routes: PlannedRoute[];
  selectedRoute: number;
  planSnapshot: PlanSnapshot | null;
}

export function App() {
  const [datasets, setDatasets] = useState<Datasets>(EMPTY_DATASETS);
  const [dataReady, setDataReady] = useState(false);
  const [demReady, setDemReady] = useState(false);
  const { requestPlan, requestDiagnosis, cancel, isPlanning, progress } = usePlanner();

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
  // Optional hard ceiling on cruise altitude. Off by default, so every
  // saved trip and the existing behaviour are untouched until a pilot
  // deliberately turns it on.
  const [capAltitude, setCapAltitude] = useState(false);
  const [maxAltFt, setMaxAltFt] = useState(9000);
  // Detour suggestions are opt-in: computing them means re-running the
  // altitude gate over thousands of candidate fixes, and a pilot who
  // meant to raise the ceiling shouldn't pay for a search they didn't
  // ask for.
  const [detours, setDetours] = useState<DetourSuggestion[] | null>(null);
  // The inputs the most recent failed plan actually ran with. Reading
  // live state instead would search against a different floor than the
  // one that failed, which is exactly wrong after a "Replan at N ft".
  const [failedPlan, setFailedPlan] = useState<{
    targetFt: number;
    maxAltFt: number | null;
    pinned: readonly string[];
  } | null>(null);
  const [ceilingHint, setCeilingHint] = useState<string | null>(null);
  const [pinnedStopIds, setPinnedStopIds] = useState<readonly string[]>([]);
  // Nav points keyed by their prefixed id ("nav:SEA" / "fix:HAROB"),
  // for labelling pins and resolving them back to positions at plan
  // time. Rebuilt only when the dataset changes.
  // Cycle expiry is a date comparison against "today", so it is
  // computed once per render rather than per route.
  const navDataExpired = useMemo(() => {
    const expires = datasets.navCycle?.expires;
    if (!expires) return false;
    return new Date(`${expires}T00:00:00Z`).getTime() <= Date.now();
  }, [datasets.navCycle]);

  const navPointsById = useMemo(
    () => new Map(datasets.navPoints.map((p) => [p.id, p])),
    [datasets.navPoints],
  );
  const [trips, setTrips] = useState<SavedTrip[]>(() => listTrips());

  // Snapshot of the inputs the current `routes` were planned with.
  // Compared against the live inputs to drive the stale-plan banner
  // and map dimming (T1). Null until the first successful plan.
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [hoveredLegIndex, setHoveredLegIndex] = useState<number | null>(null);
  const [highlightIdent, setHighlightIdent] = useState<string | null>(null);
  // Route summary carried by a loaded saved trip — shown in the rail
  // (with the stale banner) until the user replans.
  const [loadedTripSummary, setLoadedTripSummary] = useState<
    NonNullable<SavedTrip["routeSummary"]> | null
  >(null);
  // Loading a saved auto-mode trip queues a plan for the next render:
  // handleLoadTrip's setters haven't committed yet inside its own
  // closure, so calling runPlan there would plan the PREVIOUS trip's
  // inputs. The effect below fires once the loaded state is live.
  const [autoPlanQueued, setAutoPlanQueued] = useState(false);
  // True when the worker reported the current routes were searched
  // WITHOUT the terrain grid (fetch failed / not ready). Terrain
  // warnings still render — the main thread has its own sampler — so
  // without this flag the pilot has no way to know stop selection
  // ignored terrain.
  const [planTerrainBlind, setPlanTerrainBlind] = useState(false);
  // Docked route-profile panel over the map (open state). The viewport
  // the profile windows itself to is NOT App state: a map `move` fires
  // per animation frame, and routing that through App would re-render
  // the whole coordinator every frame (starving MapLibre → laggy pan/
  // zoom). Instead the viewport is a stable pub/sub the profile dock
  // subscribes to directly, so only the dock re-renders on a gesture.
  const [profileOpen, setProfileOpen] = useState(false);
  // Three layouts: desktop (≥1024) keeps the three columns; tablet
  // (768–1023) is map + results rail + a slide-in inputs drawer; phone
  // (<768) is a full-screen map with a bottom sheet.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const isTablet = useMediaQuery(
    "(min-width: 768px) and (max-width: 1023px)",
  );
  // Map overlays (legend, route-profile dock) belong on the roomy
  // desktop/tablet map; the phone hides them behind the bottom sheet.
  const wideMap = isDesktop || isTablet;
  // Tablet inputs drawer open state (unused by the other two layouts).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<
    "plan" | "route" | "issues" | "profile"
  >("plan");
  const [sheetDetent, setSheetDetent] = useState<"peek" | "half" | "full">(
    "half",
  );
  const viewportSubsRef = useRef<Set<(b: ViewportBounds) => void>>(new Set());
  const lastViewportRef = useRef<ViewportBounds | null>(null);
  const handleViewportChange = useCallback((b: ViewportBounds) => {
    lastViewportRef.current = b;
    for (const fn of viewportSubsRef.current) fn(b);
  }, []);
  const subscribeViewport = useCallback((fn: (b: ViewportBounds) => void) => {
    viewportSubsRef.current.add(fn);
    // Replay the latest bounds so a dock mounting mid-session windows
    // itself to the current viewport instead of the full route.
    if (lastViewportRef.current) fn(lastViewportRef.current);
    return () => {
      viewportSubsRef.current.delete(fn);
    };
  }, []);
  // Imperative map handle for the profile panel's wheel-zoom (zooms
  // the map around the along-route point under the cursor).
  const mapApiRef = useRef<MapViewApi | null>(null);
  const undoRef = useRef<UndoSnapshot | null>(null);

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

  // Fires the queued auto-plan for a just-loaded saved trip, once the
  // loaded inputs have committed (and the dataset is up, for trips
  // loaded quickly after a cold start).
  useEffect(() => {
    if (!autoPlanQueued || !dataReady) return;
    setAutoPlanQueued(false);
    runPlan(targetAltFt);
  }, [autoPlanQueued, dataReady]);

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

  // Ranked candidate stops inside the dashed (max-range) ring,
  // rendered as a pick list in the interactive sidebar (T10).
  const interactiveCandidates = useMemo(() => {
    if (
      planningMode !== "interactive" ||
      !interactiveDeparture ||
      !destinationAirport ||
      !interactiveRings
    )
      return [];
    const exclude = new Set<string>(interactiveStopIds);
    if (originAirport) exclude.add(originAirport.id);
    exclude.add(destinationAirport.id);
    try {
      return rankInteractiveCandidates({
        airports: matches,
        departure: interactiveDeparture,
        destination: destinationAirport,
        excludeIds: exclude,
        aircraft: selectedAircraft,
        targetAltFt,
        flightRule,
        startingFuelGal: interactiveDepartureFuelGal,
        reserveHr: reserveMin / 60,
        rangeSolidNm: interactiveRings.solid_nm,
        rangeDashedNm: interactiveRings.dashed_nm,
        variation: variationFn,
        dem: demReady ? demSampler : undefined,
      });
    } catch {
      return [];
    }
  }, [
    planningMode,
    interactiveDeparture,
    destinationAirport,
    interactiveRings,
    interactiveStopIds,
    originAirport,
    matches,
    selectedAircraft,
    targetAltFt,
    flightRule,
    interactiveDepartureFuelGal,
    reserveMin,
    demReady,
  ]);

  /** Enter interactive mode. Optionally seed the stop chain and
   *  per-leg altitudes from a planned route ("Edit this route").
   *  Without a seed, whatever interactive state existed before is
   *  kept alive — mode switches never clear the other mode's work. */
  function handleEnterInteractive(seed?: PlannedRoute) {
    if (seed) {
      setInteractiveStopIds(seed.legs.slice(0, -1).map((l) => l.toAirport.id));
      setLegAltitudes(seed.legs.map((l) => l.cruise_alt_ft));
    }
    setPlanningMode("interactive");
    setError(null);
  }

  function handleExitInteractive() {
    setPlanningMode("auto");
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
    setHighlightIdent(null);
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
      ? `<span style="color:var(--ok)">in range (${Math.round(dist).toLocaleString()} nm, ${Math.round(solid - dist).toLocaleString()} nm to spare)</span>`
      : inDashed
        ? `<span style="color:var(--caution)">past reserve — ${Math.round(dist).toLocaleString()} nm, ${Math.round(dist - solid).toLocaleString()} nm into the reserve</span>`
        : `<span style="color:var(--danger)">out of range (${Math.round(dist).toLocaleString()} nm, ${Math.round(dashed).toLocaleString()} nm max on this tank)</span>`;
    const sellsFuel = airportSellsCompatibleFuel(a, selectedAircraft.fuel.type);
    const fuelBit = sellsFuel
      ? null
      : `<span style="color:var(--caution)">no ${selectedAircraft.fuel.type} — pass-through only</span>`;
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
        `<div style="color:var(--caution)">⚠ ${terrainBits.join(" · ")}</div>`,
      );
    }
    if (altBits.length > 0) {
      parts.push(
        `<div style="color:var(--muted)">alt: ${altBits.join(" · ")}</div>`,
      );
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

  /** Snapshot the inputs a plan request is about to run with. Stored
   *  on success and diffed against the live inputs to detect a stale
   *  plan. Pinned/excluded are sorted so ordering-only changes (pin
   *  reorder aside — that changes the route) don't read as staleness
   *  in the set-membership sense; reorder still differs because the
   *  pinned list is compared, see planSnapshot.ts. */
  function makeSnapshot(
    targetFt: number,
    excluded: ReadonlySet<string>,
    pinned: readonly string[],
  ): PlanSnapshot {
    return {
      origin,
      destination,
      aircraftSlug: selectedAircraft.slug,
      targetAltFt: targetFt,
      maxAltFt: capAltitude ? maxAltFt : null,
      reserveMin,
      startingFuelGal,
      flightRule,
      capLegTime,
      maxLegHr,
      filters,
      runwaySettings,
      pinnedStopIds: [...pinned],
      excludedIds: [...excluded].sort(),
    };
  }

  function runPlan(targetFt: number, overrides: PlanOverrides = {}) {
    setError(null);
    setDetours(null);
    setCeilingHint(null);
    setFailedPlan(null);
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
    const pinnedNavPoints = pinned
      .map((id) => datasets.navPoints.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    // Drop airports that are nowhere near the route. With ~5k
    // public-use airports in CONUS, the unfiltered routing graph has
    // ~25M edges; an airport in Florida is never a useful fuel stop
    // for a Bay Area → Wisconsin flight, so culling them here turns
    // tens of seconds of planning into a fraction.
    //
    // The corridor follows the *pinned* path, not the direct
    // origin→destination line. A nav point pinned 150 nm off-track to
    // dodge terrain would otherwise put its own span's fuel stops
    // outside the band — the planner would silently pick worse stops
    // on exactly the routes this feature exists to create.
    // Anchors in the order the pilot pinned them — concatenating the
    // airport and nav-point lists separately would corridor a path
    // nobody is flying.
    const corridorAnchors: LatLon[] = [
      o,
      ...pinned
        .map(
          (id) =>
            datasets.airports.find((a) => a.id === id) ??
            datasets.navPoints.find((p) => p.id === id),
        )
        .filter((p): p is NonNullable<typeof p> => !!p),
      d,
    ];
    const onRoute = new Map<string, (typeof matches)[number]>();
    for (let i = 0; i < corridorAnchors.length - 1; i++) {
      for (const a of airportsInRouteCorridor(
        matches,
        corridorAnchors[i],
        corridorAnchors[i + 1],
      )) {
        onRoute.set(a.id, a);
      }
    }
    const candidates = Array.from(
      new Map(
        [...onRoute.values(), o, d, ...pinnedAirports].map((a) => [a.id, a]),
      ).values(),
    );
    // Snapshot the exact inputs this request runs with; committed
    // only when the worker returns a route.
    const snapshot = makeSnapshot(targetFt, excluded, pinned);
    requestPlan(
      {
        candidates,
        originId: o.id,
        destinationId: d.id,
        aircraft: selectedAircraft,
        targetAltFt: targetFt,
        maxAltFt: capAltitude ? maxAltFt : null,
        flightRule,
        reserveHr: reserveMin / 60,
        maxLegHr: capLegTime ? maxLegHr : undefined,
        startingFuelGal,
        excludedAirportIds: [...excluded],
        waypoints: [...pinned],
        navPoints: pinnedNavPoints,
      },
      {
        onResult: (result, meta) => {
          if (result.length === 0) {
            // With a ceiling in force, "no route" is an ordinary
            // answer rather than a malfunction, and the generic
            // message reads like something broke. Name the constraint
            // that is actually doing the work.
            setError(
              capAltitude
                ? `no route at or below ${maxAltFt.toLocaleString()} ft — raise the ceiling, or pin a nav point to route around the terrain`
                : "no route found — try relaxing constraints",
            );
            setFailedPlan({
              targetFt,
              maxAltFt: capAltitude ? maxAltFt : null,
              pinned: [...pinned],
            });
            setRoutes([]);
            setPlanSnapshot(null);
            return;
          }
          setRoutes(result);
          setSelectedRoute(0);
          setPlanSnapshot(snapshot);
          setLoadedTripSummary(null);
          setPlanTerrainBlind(!meta.demUsed);
          // The profile panel is part of reading a plan — open it with
          // the results rather than making the pilot find the toggle.
          setProfileOpen(true);
          // On the mobile layout, surface the freshly-planned route by
          // flipping the sheet to the Route tab and raising it to half.
          setSheetTab("route");
          setSheetDetent((d) => (d === "peek" ? "half" : d));
          // On tablet, close the inputs drawer to reveal the map + rail.
          setDrawerOpen(false);
        },
        onError: (message) => setError(message),
      },
    );
  }

  function handlePlan() {
    runPlan(targetAltFt);
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
        // Without this the clearance analysis runs down the direct
        // great circle while the map, the profile, and the router all
        // follow the shaped track — the app would warn about a ridge
        // the aircraft turned away from and stay silent about the one
        // it turned toward. Every consumer of a leg's ground track has
        // to agree on where the aeroplane actually is.
        via: l.via,
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

  // Unified route-issues list (T5): terrain + terminal corridors +
  // runway fits, sorted danger-first. Replaces the three stacked
  // warning panels.
  const routeIssues = useMemo(() => {
    const issues = collectRouteIssues({
      terrain,
      targetAltFt,
      corridor: terminalWarnings,
      runway: runwayWarnings,
      // "Replan at N ft" raises the target altitude, which directly
      // contradicts a ceiling the pilot just set. Offering it there
      // invites them to silently undo their own constraint.
      onReplanAt: capAltitude
        ? undefined
        : (ft) => {
            setTargetAltFt(ft);
            // Plan with the new altitude immediately — setTargetAltFt
            // only takes effect next render, so the closure would
            // otherwise replan at the stale value.
            runPlan(ft);
          },
      legs: (currentRoute?.legs ?? []).map((l) => ({
        fromIdent: l.fromAirport.icao ?? l.fromAirport.lid,
        toIdent: l.toAirport.icao ?? l.toAirport.lid,
        cruise_alt_ft: l.cruise_alt_ft,
        hemisphericConflict: l.extra?.hemispheric_conflict === 1,
        ceilingExceeded: l.extra?.ceiling_exceeded === 1,
      })),
    });
    // Nav data expires. The VOR MON programme is decommissioning
    // stations, and fix identifiers written into a GPX/FPL export may
    // not resolve on a panel GPS running a different AIRAC cycle -- so
    // an out-of-date cycle is a flyable-consequences problem, not a
    // housekeeping one. Only raised once the cycle has actually lapsed;
    // the footer carries the date the rest of the time.
    if (navDataExpired && routes.length > 0) {
      issues.unshift({
        legIndex: -1,
        phase: "cruise",
        severity: "caution",
        ident: "nav data",
        message: `Navaid and fix data expired ${datasets.navCycle?.expires ?? ""} \u2014 idents in exports may not resolve on a current database.`,
      });
    }
    // Surfaced first among cautions: an auto-planned route whose
    // search ran without the terrain grid picked its fuel stops
    // terrain-blind, even though per-leg terrain warnings (computed
    // main-thread) still render normally.
    if (planTerrainBlind && planningMode === "auto" && routes.length > 0) {
      issues.unshift({
        legIndex: -1,
        phase: "cruise",
        severity: "caution",
        ident: "route",
        message:
          "Terrain data wasn't available when this route was planned — fuel-stop selection ignored terrain. Replan to retry with terrain costs.",
        action: { label: "Replan", apply: () => runPlan(targetAltFt) },
      });
    }
    return issues;
  }, [
    terrain,
    targetAltFt,
    terminalWarnings,
    runwayWarnings,
    planTerrainBlind,
    planningMode,
    routes.length,
    navDataExpired,
    datasets.navCycle,
    // The hemispheric-conflict issues read the route's legs directly.
    // The terrain / corridor / runway inputs all derive from it too, so
    // this is belt-and-braces — but an issue list that can go stale
    // against the route it describes is not a thing to leave to luck.
    currentRoute,
  ]);

  // Per-leg fuel-on-landing for the displayed route (T6). Shares the
  // exact refuel/pass-through propagation the runway weight model
  // uses (perLegArrivalFuel mirrors perLegWeights).
  const arrivalFuelGal = useMemo(() => {
    if (!currentRoute) return undefined;
    const legs = currentRoute.legs;
    const legOriginRefuels = legs.map((leg, i) =>
      i === 0
        ? true
        : airportSellsCompatibleFuel(
            leg.fromAirport,
            selectedAircraft.fuel.type,
          ),
    );
    return perLegArrivalFuel({
      aircraft: selectedAircraft,
      legFuelBurnGal: legs.map((l) => l.fuel_gal),
      legOriginRefuels,
      startingFuelGal,
    });
  }, [currentRoute, selectedAircraft, startingFuelGal]);

  const reserveGal = useMemo(() => {
    try {
      return reserveFuelGal({
        aircraft: selectedAircraft,
        altitude_ft: targetAltFt,
        reserve_min: reserveMin,
      });
    } catch {
      return undefined;
    }
  }, [selectedAircraft, targetAltFt, reserveMin]);

  const cautionFloorGal = useMemo(() => {
    if (reserveGal === undefined) return undefined;
    try {
      return (
        reserveGal + (cruiseBurnGph(selectedAircraft, targetAltFt) * 15) / 60
      );
    } catch {
      return undefined;
    }
  }, [reserveGal, selectedAircraft, targetAltFt]);

  // Whole-route altitude-vs-terrain profile for the docked panel over
  // the map. Null until the DEM grid is up (a profile with no terrain
  // silhouette would be misleading rather than degraded).
  const routeProfile = useMemo(() => {
    if (!demReady || !currentRoute || currentRoute.legs.length === 0) {
      return null;
    }
    return buildRouteProfile({
      route: currentRoute,
      aircraft: selectedAircraft,
      dem: demSampler,
    });
  }, [demReady, currentRoute, selectedAircraft]);

  // The profile's along-track window follows the map viewport — that
  // computation lives in RouteProfileDock so it (and only it) re-runs
  // per gesture frame, not the whole App.

  // Stale-plan detection (T1): compare the live inputs against the
  // snapshot the current routes were planned with. Suppressed while a
  // replan is already in flight (the snapshot refreshes on result).
  const liveSnapshot = useMemo(
    () => makeSnapshot(targetAltFt, excludedIds, pinnedStopIds),
    [
      origin,
      destination,
      selectedAircraft.slug,
      targetAltFt,
      reserveMin,
      startingFuelGal,
      flightRule,
      capLegTime,
      maxLegHr,
      filters,
      runwaySettings,
      pinnedStopIds,
      excludedIds,
    ],
  );
  const isStale =
    planningMode === "auto" &&
    routes.length > 0 &&
    planSnapshot !== null &&
    !isPlanning &&
    !snapshotsEqual(planSnapshot, liveSnapshot);
  const staleDiffs = useMemo(
    () => (isStale && planSnapshot ? describePlanDiff(planSnapshot, liveSnapshot) : []),
    [isStale, planSnapshot, liveSnapshot],
  );

  /** Capture everything the single-slot undo restores. Called before
   *  any mutation that replans. */
  function pushUndo() {
    undoRef.current = {
      pinnedStopIds,
      excludedIds,
      routes,
      selectedRoute,
      planSnapshot,
    };
  }

  function handleUndo() {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null;
    // Kill any replan the undone mutation kicked off — the restored
    // routes are the source of truth and must not be overwritten by
    // a late worker result.
    cancel();
    setPinnedStopIds(u.pinnedStopIds);
    setExcludedIds(u.excludedIds);
    setRoutes(u.routes);
    setSelectedRoute(u.selectedRoute);
    setPlanSnapshot(u.planSnapshot);
    setToast(null);
  }

  /** Fixes that would make the direct origin→destination leg flyable
   *  under the current ceiling. Run on demand from the failure message. */
  function findDetours() {
    const o = airportByIdent(datasets.airports, origin);
    const d = airportByIdent(datasets.airports, destination);
    if (!o || !d || !failedPlan) return;
    // Search the same span the failed plan did. Pinned airports split
    // the trip into spans, and only one of them is blocked -- scanning
    // origin→destination direct would look for detours around terrain
    // that isn't on the failing leg.
    const anchors = [
      o,
      ...failedPlan.pinned
        .map((id) => datasets.airports.find((a) => a.id === id))
        .filter((a): a is NonNullable<typeof a> => !!a),
      d,
    ];
    const found: DetourSuggestion[] = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      found.push(
        ...suggestDetours({
          from: anchors[i],
          to: anchors[i + 1],
          navPoints: datasets.navPoints,
          band: { minFt: failedPlan.targetFt, maxFt: failedPlan.maxAltFt },
          flightRule,
          aircraft: selectedAircraft,
          dem: demReady ? demSampler : undefined,
          variation: variationFn,
        }),
      );
    }
    found.sort((a, b) => a.addedNm - b.addedNm);
    setDetours(found.slice(0, 3));
  }

  /** Asks the worker for the lowest ceiling that admits a route. */
  function findLowestCeiling() {
    const o = airportByIdent(datasets.airports, origin);
    const d = airportByIdent(datasets.airports, destination);
    if (!o || !d || !failedPlan) return;
    const matches = applyFilters(datasets, filters, selectedAircraft.fuel.type);
    const candidates = Array.from(
      new Map(
        [...airportsInRouteCorridor(matches, o, d), o, d].map((a) => [a.id, a]),
      ).values(),
    );
    requestDiagnosis(
      {
        candidates,
        originId: o.id,
        destinationId: d.id,
        aircraft: selectedAircraft,
        targetAltFt: failedPlan.targetFt,
        maxAltFt: failedPlan.maxAltFt,
        flightRule,
        reserveHr: reserveMin / 60,
        maxLegHr: capLegTime ? maxLegHr : undefined,
        startingFuelGal,
        excludedAirportIds: [...excludedIds],
        waypoints: [...failedPlan.pinned],
        navPoints: datasets.navPoints.filter((p) =>
          failedPlan.pinned.includes(p.id),
        ),
      },
      {
        onResult: () => {},
        onError: (m) => setCeilingHint(m),
        onDiagnosis: (dg) => {
          const leg =
            dg.blockerFrom && dg.blockerTo
              ? `${identOf(dg.blockerFrom)}\u2192${identOf(dg.blockerTo)}`
              : null;
          if (dg.lowestWorkableFt === null) {
            setCeilingHint(
              leg
                ? `No ceiling works: ${leg} needs ${dg.blockerRequiredAltFt?.toLocaleString() ?? "more"} ft, beyond this aircraft's published cruise table.`
                : "No ceiling works for this route with this aircraft.",
            );
            return;
          }
          setCeilingHint(
            `Lowest workable ceiling is ${dg.lowestWorkableFt.toLocaleString()} ft` +
              (leg
                ? ` \u2014 ${leg} needs ${dg.blockerRequiredAltFt?.toLocaleString() ?? "more"} ft`
                : ""),
          );
        },
      },
    );
  }

  function identOf(id: string): string {
    const a = datasets.airports.find((x) => x.id === id);
    if (a) return a.icao ?? a.lid;
    const p = datasets.navPoints.find((x) => x.id === id);
    if (p) return p.ident;
    return id;
  }

  function handleExcludeStops(airportIds: string[]) {
    pushUndo();
    const nextExcluded = new Set(excludedIds);
    for (const id of airportIds) nextExcluded.add(id);
    // Excluding a pinned airport contradicts the pin — the exclusion
    // is the more recent intent, so drop the pin in the same commit.
    const droppedPins = new Set(airportIds);
    const nextPinned = pinnedStopIds.filter((id) => !droppedPins.has(id));
    const pinnedChanged = nextPinned.length !== pinnedStopIds.length;
    setExcludedIds(nextExcluded);
    if (pinnedChanged) setPinnedStopIds(nextPinned);
    runPlan(targetAltFt, {
      excluded: nextExcluded,
      pinned: pinnedChanged ? nextPinned : undefined,
    });
    setToast({
      message: `${airportIds.map(identOf).join(", ")} excluded — route replanned`,
      actionLabel: "Undo",
      onAction: handleUndo,
    });
  }

  function handleIncludeStop(airportId: string) {
    pushUndo();
    const next = new Set(excludedIds);
    next.delete(airportId);
    setExcludedIds(next);
    runPlan(targetAltFt, { excluded: next });
  }

  function handleAddPins(airportIds: string[]) {
    const fresh = airportIds.filter((id) => !pinnedStopIds.includes(id));
    if (fresh.length === 0) return;
    pushUndo();
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
    runPlan(targetAltFt, {
      pinned: next,
      excluded: excludedChanged ? nextExcluded : undefined,
    });
  }

  function handleRemovePin(airportId: string) {
    pushUndo();
    const next = pinnedStopIds.filter((id) => id !== airportId);
    setPinnedStopIds(next);
    runPlan(targetAltFt, { pinned: next });
    setToast({
      message: `${identOf(airportId)} unpinned — route replanned`,
      actionLabel: "Undo",
      onAction: handleUndo,
    });
  }

  function handleReorderPins(nextPinned: string[]) {
    pushUndo();
    setPinnedStopIds(nextPinned);
    runPlan(targetAltFt, { pinned: nextPinned });
  }

  function handleReplaceStop(oldAirportId: string, newIdent: string) {
    const replacement = airportByIdent(datasets.airports, newIdent);
    if (!replacement) {
      setError(`unknown airport: ${newIdent.toUpperCase()}`);
      return;
    }
    if (replacement.id === oldAirportId) return;
    pushUndo();

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
    runPlan(targetAltFt, {
      excluded: nextExcluded,
      pinned: nextPinned,
    });
    setToast({
      message: `${identOf(oldAirportId)} replaced with ${replacement.icao ?? replacement.lid} — route replanned`,
      actionLabel: "Undo",
      onAction: handleUndo,
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
    // Drag means MOVE: route through the same replace semantics as
    // the leg table's ✎ action — exclude the dragged-from stop (or
    // swap the pin), pin the snapped-to airport at the same position,
    // and replan. The grab cursor promised a move; leaving the old
    // stop behind read as a bug.
    handleReplaceStop(oldAirportId, nearest.ident);
    return true;
  }

  function handleSaveTrip(name: string) {
    const routeForSummary =
      planningMode === "auto" ? (routes[selectedRoute] ?? null) : currentRoute;
    const trip: SavedTrip = {
      name,
      origin,
      destination,
      aircraftSlug: selectedAircraft.slug,
      targetAltFt,
      maxAltFt: capAltitude ? maxAltFt : null,
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
      // A lightweight summary of the planned route at save time —
      // routes themselves aren't persisted (datasets change cycle to
      // cycle), but the summary lets a loaded trip show what it was
      // instead of an empty rail.
      routeSummary: routeForSummary
        ? {
            stopIdents: routeForSummary.legs
              .slice(0, -1)
              .map((l) => l.toAirport.icao ?? l.toAirport.lid),
            distance_nm: routeForSummary.totals.distance_nm,
            time_hr: routeForSummary.totals.time_hr,
            fuel_gal: routeForSummary.totals.fuel_gal,
          }
        : undefined,
      savedAt: new Date().toISOString(),
    };
    setTrips(saveTrip(trip));
  }

  function handleLoadTrip(t: SavedTrip) {
    setOrigin(t.origin);
    setDestination(t.destination);
    setAircraftSlug(t.aircraftSlug);
    setTargetAltFt(t.targetAltFt);
    // Trips saved before the ceiling shipped have no maxAltFt and load
    // back unceilinged — which is how they were planned.
    setCapAltitude(t.maxAltFt != null);
    if (t.maxAltFt != null) setMaxAltFt(t.maxAltFt);
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
    setPlanSnapshot(null);
    setLoadedTripSummary(t.routeSummary ?? null);
    setError(null);
    // Plan immediately — a loaded trip that needs a second click on
    // Replan is just friction. Interactive trips rebuild live from
    // their restored state and don't use the auto planner.
    setAutoPlanQueued((t.planningMode ?? "auto") === "auto");
  }

  function handleDeleteTrip(name: string) {
    setTrips(deleteTrip(name));
  }

  // Summary chips for the collapsed sidebar accordions (T4).
  const runwayChip = runwaySettings.enabled
    ? aircraftSupportsRunwayCheck(selectedAircraft)
      ? "POH · on"
      : "no data"
    : "off";
  const filterChip = `${matches.length.toLocaleString()} match`;

  const hasRailContent =
    routes.length > 0 || (planningMode === "interactive" && currentRoute);

  const planButtonState = !dataReady
    ? "loading"
    : isPlanning
      ? "planning"
      : "idle";

  // ---- shared building blocks, assembled differently by the desktop
  //      columns and the mobile app-bar + bottom-sheet layout ----
  const headerControls = (
    <div className="flex items-center gap-2">
      <SavedTripsPopover
        trips={trips}
        defaultName={`${origin} → ${destination}`}
        onSave={handleSaveTrip}
        onLoad={handleLoadTrip}
        onDelete={handleDeleteTrip}
      />
      <ThemeToggle />
    </div>
  );

  const inputSections = (
    <>
      <Section id="trip" title="Trip" collapsible={false}>
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
                  />
                  <div className="mt-3">
                    <PinnedStops
                      pinnedIds={pinnedStopIds}
                      airports={datasets.airports}
                      navPointsByIdent={datasets.navPointsByIdent}
                      navPointsById={navPointsById}
                      aircraftFuelType={selectedAircraft.fuel.type}
                      originIdent={origin}
                      destinationIdent={destination}
                      onAdd={handleAddPins}
                      onRemove={handleRemovePin}
                      onReorder={handleReorderPins}
                    />
                    {datasets.navCycle?.effective && (
                      <p className="mt-1 text-[10px] text-muted">
                        Nav data cycle {datasets.navCycle.effective}
                        {datasets.navCycle.expires
                          ? ` \u2013 ${datasets.navCycle.expires}`
                          : ""}
                        {navDataExpired ? " (expired)" : ""}
                      </p>
                    )}
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
                </>
              ) : (
                <InteractivePanel
                  originIdent={
                    originAirport?.icao ?? originAirport?.lid ?? origin
                  }
                  destinationIdent={
                    destinationAirport?.icao ??
                    destinationAirport?.lid ??
                    destination
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
                    (interactiveRings?.solid_nm ?? 0) >=
                    interactiveDistanceToDest
                  }
                  cruiseCeilingFt={
                    selectedAircraft.cruise[selectedAircraft.cruise.length - 1]
                      ?.altitude_ft ?? 0
                  }
                  onRemoveStop={handleRemoveInteractiveStop}
                  onChangeLegAltitude={handleChangeLegAltitude}
                  onExit={handleExitInteractive}
                  candidates={interactiveCandidates}
                  onSelectCandidate={handleAddInteractiveStop}
                  onHoverCandidate={setHighlightIdent}
                  aircraftFuelType={selectedAircraft.fuel.type}
                />
              )}
            </Section>
            <Section id="aircraft" title="Aircraft & cruise" collapsible={false}>
              <AircraftPanel
                aircraft={allAircraft}
                selectedSlug={selectedAircraft.slug}
                onSelect={setAircraftSlug}
                targetAltFt={targetAltFt}
                onTargetAltChange={setTargetAltFt}
                capAltitude={capAltitude}
                onCapAltitudeChange={setCapAltitude}
                maxAltFt={maxAltFt}
                onMaxAltChange={setMaxAltFt}
                reserveMin={reserveMin}
                onReserveChange={setReserveMin}
                startingFuelGal={startingFuelGal}
                onStartingFuelChange={setStartingFuelGal}
                capacityGal={selectedAircraft.fuel.usable_capacity_gal}
              />
            </Section>
            <Section id="runway" title="Runway check" summary={runwayChip}>
              <RunwayPanel
                settings={runwaySettings}
                onChange={setRunwaySettings}
                aircraftHasData={aircraftSupportsRunwayCheck(selectedAircraft)}
                aircraftModel={selectedAircraft.model}
              />
            </Section>
            <Section id="filters" title="Airport filters" summary={filterChip}>
              <FilterPanel
                filters={filters}
                onChange={setFilters}
                matchCount={matches.length}
                totalCount={datasets.airports.length}
                hasApproachData={datasets.hasApproachData}
                aircraftFuelType={selectedAircraft.fuel.type}
                runwayCheckActive={runwayCheckActive}
              />
      </Section>
    </>
  );

  // Primary action(s) — the desktop sticky footer and the mobile Plan
  // tab footer both render this.
  const planFooter =
    planningMode === "auto" ? (
              <>
                <button
                  type="button"
                  data-testid="plan-trip"
                  data-state={planButtonState}
                  onClick={isPlanning ? cancel : handlePlan}
                  disabled={!dataReady}
                  className="w-full rounded bg-accent px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {!dataReady ? (
                    "Loading airport database…"
                  ) : isPlanning ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <span
                        data-testid="plan-trip-spinner"
                        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                      />
                      Cancel
                    </span>
                  ) : (
                    "Plan trip"
                  )}
                </button>
                {isPlanning && (
                  <p className="text-center text-xs text-muted" aria-live="polite">
                    {progress
                      ? `Planning… ${progress.expanded.toLocaleString()} airports considered · ${progress.found} route${progress.found === 1 ? "" : "s"} found`
                      : "Planning…"}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => handleEnterInteractive()}
                  disabled={!dataReady || !originAirport || !destinationAirport}
                  className="w-full rounded px-3 py-1.5 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
                >
                  Build interactively →
                </button>
                {error && <p className="text-xs text-danger">{error}</p>}
              {error && capAltitude && detours === null && (
                <button
                  type="button"
                  onClick={findDetours}
                  className="mt-1 rounded border border-hairline-input bg-card px-2 py-1 text-xs text-ink hover:bg-surface"
                >
                  Find a way around
                </button>
              )}
              {error && capAltitude && ceilingHint === null && failedPlan && (
                <button
                  type="button"
                  onClick={findLowestCeiling}
                  className="ml-1 mt-1 rounded border border-hairline-input bg-card px-2 py-1 text-xs text-ink hover:bg-surface"
                >
                  Lowest workable altitude
                </button>
              )}
              {ceilingHint && (
                <p className="mt-1 text-xs text-muted">{ceilingHint}</p>
              )}
              {detours !== null && (
                <div className="mt-1 text-xs">
                  {detours.length === 0 ? (
                    <p className="text-muted">
                      No nav point makes this leg work under the ceiling
                      without a large detour.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {detours.map((s) => (
                        <li key={s.navPoint.id} className="flex items-center gap-2">
                          <span className="font-mono text-ink">
                            {s.navPoint.ident}
                          </span>
                          <span className="text-muted">
                            +{Math.round(s.addedNm)} nm ·{" "}
                            {s.altFt.toLocaleString()} ft
                          </span>
                          <button
                            type="button"
                            onClick={() => handleAddPins([s.navPoint.id])}
                            className="rounded border border-hairline-input bg-card px-1.5 py-0.5 text-ink hover:bg-surface"
                          >
                            Pin
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              </>
            ) : (
              <p className="text-center text-xs text-muted">
                Interactive build — click airports on the map or pick from the
                candidate list.
              </p>
    );

  const mapMain = (
    <main className="relative flex-1">
        <MapView
          airports={matches}
          navPoints={datasets.navPoints}
          route={currentRoute}
          routeDimmed={isStale}
          hoveredLegIndex={hoveredLegIndex}
          highlightIdent={highlightIdent}
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
          onViewportChange={handleViewportChange}
          mapApiRef={mapApiRef}
        />
        {isTablet && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-hairline bg-card px-3 py-2 text-sm font-medium text-ink shadow-md hover:bg-surface"
          >
            <span aria-hidden="true">☰</span> Trip
          </button>
        )}
        {wideMap && (
          <MapLegend
            interactiveMode={planningMode === "interactive"}
            raised={profileOpen && !!routeProfile}
          />
        )}
        {wideMap && routeProfile && !profileOpen && (
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="absolute bottom-3 right-3 z-10 rounded-md border border-hairline bg-card px-2.5 py-1.5 text-xs font-medium text-ink shadow-md hover:bg-surface"
          >
            Profile ▴
          </button>
        )}
        {wideMap && routeProfile && profileOpen && (
          <RouteProfileDock
            data={routeProfile}
            subscribeViewport={subscribeViewport}
            hoveredLegIndex={hoveredLegIndex}
            onHoverLeg={setHoveredLegIndex}
            onClose={() => setProfileOpen(false)}
            onZoomAround={({ lat, lon, deltaZoom }) =>
              mapApiRef.current?.zoomAround({ lat, lon }, deltaZoom)
            }
          />
        )}
        {/* Stale-plan callout in the map's line of sight: the dimmed
            route needs an on-map explanation, not just the rail
            banner (easy to miss while panning the chart). */}
        {isStale && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
            <div className="pointer-events-auto flex items-center gap-3 rounded-md border border-caution bg-[color-mix(in_srgb,var(--caution)_14%,var(--card))] px-3 py-2 shadow-lg">
              <p className="text-xs text-caution">
                <strong>Plan out of date</strong>
                {staleDiffs.length > 0 && <> — {staleDiffs[0]}</>}
                {staleDiffs.length > 1 && <> and {staleDiffs.length - 1} more</>}
                <span className="block text-ink opacity-70">
                  The dimmed route was planned with your previous inputs.
                </span>
              </p>
              <button
                type="button"
                onClick={handlePlan}
                disabled={isPlanning}
                className="shrink-0 rounded bg-caution px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                Replan
              </button>
            </div>
          </div>
        )}
        {!hasRailContent && planningMode === "auto" && (
          <FirstRunHint origin={origin} destination={destination} />
        )}
        <Toast
          toast={toast}
          onDismiss={() => setToast(null)}
          raised={wideMap && profileOpen && !!routeProfile}
          position={wideMap ? "bottom" : "top"}
        />
    </main>
  );

  const staleRailBanner = isStale ? (
    <div className="border-b border-hairline border-l-4 border-l-caution bg-[color-mix(in_srgb,var(--caution)_12%,transparent)] p-3">
      <p className="text-xs text-caution">
        <strong>Inputs changed</strong> since this plan
        {staleDiffs.length > 0 && <> — {staleDiffs[0]}</>}
        {staleDiffs.length > 1 && <> and {staleDiffs.length - 1} more</>}
      </p>
      <button
        type="button"
        onClick={handlePlan}
        className="mt-2 w-full rounded bg-caution px-2 py-1 text-xs font-semibold text-white hover:opacity-90"
      >
        Replan
      </button>
    </div>
  ) : null;

  const legTableEl = (
    <LegTable
      routes={
        planningMode === "interactive" && currentRoute
          ? [currentRoute]
          : routes
      }
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
      arrivalFuelGal={arrivalFuelGal}
      reserveGal={reserveGal}
      cautionFloorGal={cautionFloorGal}
      reserveMin={reserveMin}
      hoveredLegIndex={hoveredLegIndex}
      onHoverLeg={setHoveredLegIndex}
      onEditRoute={
        planningMode === "auto" && routes[selectedRoute]
          ? () => handleEnterInteractive(routes[selectedRoute])
          : undefined
      }
      onShowProfile={routeProfile ? () => setProfileOpen(true) : undefined}
    />
  );

  const routeIssuesEl = (
    <RouteIssuesPanel
      issues={routeIssues}
      hoveredLegIndex={hoveredLegIndex}
      onHoverLeg={setHoveredLegIndex}
    />
  );

  const whyStopsEl =
    planningMode === "auto" &&
    routes[selectedRoute] &&
    routes[selectedRoute].legs.length > 1 ? (
      <WhyStopsPanel
        // Remount per route so explanations cached on first expand
        // never go stale after a replan.
        key={routes[selectedRoute].legs.map((l) => l.toAirport.id).join(">")}
        getExplanations={() =>
          explainStopChoices({
            route: routes[selectedRoute],
            matches,
            // Pool BEFORE the runway-fit filter, so a stop dropped only
            // for a tight/short runway can still surface as an
            // alternative rather than silently vanishing.
            baseMatches,
            aircraft: selectedAircraft,
            targetAltFt,
            flightRule,
            reserveHr: reserveMin / 60,
            startingFuelGal,
            variation: variationFn,
            dem: demReady ? demSampler : undefined,
            pinnedStopIds: new Set(pinnedStopIds),
            runwaySettings,
            maxLegHr: capLegTime ? maxLegHr : undefined,
          })
        }
        onHoverAirport={setHighlightIdent}
      />
    ) : null;

  const exportEl = currentRoute ? (
    <ExportPanel
      route={currentRoute}
      aircraft={selectedAircraft}
      terrain={terrain}
    />
  ) : null;

  const savedSummaryEl = loadedTripSummary ? (
    <div className="space-y-3 p-4">
      <div className="rounded border border-hairline bg-card p-3">
        <p className="text-xs font-semibold text-ink">Saved route summary</p>
        <p className="mt-1 font-mono text-xs text-ink">
          {[origin, ...loadedTripSummary.stopIdents, destination].map(
            (id, i) => (
              <span key={i}>
                {i > 0 && <span className="text-muted"> → </span>}
                <AirportLink ident={id} />
              </span>
            ),
          )}
        </p>
        <p className="mt-1 text-xs text-muted">
          {loadedTripSummary.distance_nm.toFixed(0)} nm ·{" "}
          {loadedTripSummary.time_hr.toFixed(1)} hr ·{" "}
          {loadedTripSummary.fuel_gal.toFixed(1)} gal
        </p>
      </div>
      <div className="rounded border border-hairline bg-card p-3">
        <p className="text-xs text-caution">
          <strong>Inputs may have changed</strong> since this trip was saved —
          replan to refresh the route.
        </p>
        <button
          type="button"
          onClick={handlePlan}
          disabled={!dataReady || isPlanning}
          className="mt-2 w-full rounded bg-caution px-2 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Replan
        </button>
      </div>
    </div>
  ) : null;

  const railEmptyEl = (
    <div className="flex flex-1 items-center justify-center p-6">
      <p className="text-center text-xs text-muted">
        Plan a trip to see legs, fuel, and route issues.
      </p>
    </div>
  );

  // ---- Desktop (≥ lg): the original three-column workspace ----
  // Shared column contents — assembled as fixed desktop columns, and as
  // the tablet drawer + rail.
  const inputScroller = (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-4 p-4 pb-0">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold text-ink">Trip Planner</h1>
          {headerControls}
        </header>
        {inputSections}
      </div>
      {/* Sticky footer inside the scroll container: the primary action
          stays visible at every scroll position (T4). */}
      <div className="sticky bottom-0 mt-4 space-y-2 border-t border-hairline bg-surface p-4">
        {planFooter}
      </div>
    </div>
  );

  const resultsRail = hasRailContent ? (
    <>
      {staleRailBanner}
      <div className="flex-1 overflow-y-auto">{legTableEl}</div>
      {routeIssuesEl}
      {whyStopsEl}
      {exportEl}
    </>
  ) : loadedTripSummary ? (
    savedSummaryEl
  ) : (
    railEmptyEl
  );

  // ---- Desktop (≥1024): the three-column workspace ----
  if (isDesktop) {
    return (
      <div className="flex h-full w-full bg-surface text-ink">
        <aside className="relative flex w-80 shrink-0 flex-col border-r border-hairline bg-surface">
          {inputScroller}
        </aside>
        {mapMain}
        {/* The right rail is always mounted (T7) so planning doesn't
            reflow the map; before the first plan it shows an empty
            state or the summary of a just-loaded saved trip. */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-hairline bg-surface">
          {resultsRail}
        </aside>
      </div>
    );
  }

  // ---- Tablet (768–1023): map + results rail, inputs in a drawer ----
  if (isTablet) {
    return (
      <div className="relative flex h-full w-full overflow-hidden bg-surface text-ink">
        {mapMain}
        <aside className="flex w-72 shrink-0 flex-col border-l border-hairline bg-surface">
          {resultsRail}
        </aside>
        {drawerOpen && (
          <button
            type="button"
            aria-label="Close trip inputs"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 z-30 bg-black/30"
          />
        )}
        <aside
          className={
            "absolute inset-y-0 left-0 z-40 flex w-80 max-w-[85%] flex-col border-r border-hairline bg-surface shadow-2xl transition-transform duration-300 " +
            (drawerOpen ? "translate-x-0" : "-translate-x-full")
          }
        >
          {inputScroller}
        </aside>
      </div>
    );
  }

  // ---- Mobile / tablet (< lg): full-screen map + bottom sheet ----
  const sheetHeightClass =
    sheetDetent === "peek"
      ? "h-[150px]"
      : sheetDetent === "half"
        ? "h-[56%]"
        : "h-[90%]";
  const cycleDetent = () =>
    setSheetDetent((d) =>
      d === "peek" ? "half" : d === "half" ? "full" : "peek",
    );
  const openSheetTab = (tab: "plan" | "route" | "issues" | "profile") => {
    setSheetTab(tab);
    setSheetDetent((d) => (d === "peek" ? "half" : d));
  };
  // The terrain profile is only offered once it's been built (DEM up +
  // a route). Falls off the tab bar otherwise.
  const sheetTabList: Array<"plan" | "route" | "issues" | "profile"> =
    routeProfile
      ? ["plan", "route", "issues", "profile"]
      : ["plan", "route", "issues"];

  const profileTab = routeProfile ? (
    <RouteProfile
      inline
      data={routeProfile}
      windowStartNm={0}
      windowEndNm={routeProfile.totalNm}
      hoveredLegIndex={hoveredLegIndex}
      onHoverLeg={setHoveredLegIndex}
    />
  ) : (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-center text-xs text-muted">
        Plan a trip to see the terrain profile.
      </p>
    </div>
  );

  const routeTab = hasRailContent ? (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">{legTableEl}</div>
      {whyStopsEl}
    </div>
  ) : loadedTripSummary ? (
    savedSummaryEl
  ) : (
    railEmptyEl
  );

  const issuesTab =
    hasRailContent && routeIssues.length > 0 ? (
      <div className="h-full overflow-y-auto">{routeIssuesEl}</div>
    ) : (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-center text-xs text-muted">
          {hasRailContent
            ? "No route issues flagged for this plan."
            : "Plan a trip to see route issues."}
        </p>
      </div>
    );

  const planTab = (
    <div className="h-full space-y-4 overflow-y-auto p-4">{inputSections}</div>
  );

  const sheetFooter =
    sheetTab === "plan" ? (
      <div className="pb-safe space-y-2 border-t border-hairline bg-surface p-4">
        {planFooter}
      </div>
    ) : sheetTab === "route" && exportEl ? (
      <div className="pb-safe">{exportEl}</div>
    ) : null;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-surface text-ink">
      <header className="pt-safe z-10 flex items-center gap-2 border-b border-hairline bg-surface px-4 pb-2">
        <h1 className="flex-1 text-base font-semibold text-ink">Trip Planner</h1>
        {headerControls}
      </header>
      {mapMain}
      {/* Overlay sheet: the map stays full-size behind it. (Native
          <select> mispositioning inside this scrolled overlay is handled
          by the custom Select component, not by the layout.) */}
      <div
        className={
          "absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-hairline bg-card shadow-[0_-10px_30px_-16px_rgba(0,0,0,0.4)] transition-[height] duration-300 " +
          sheetHeightClass
        }
      >
        <button
          type="button"
          onClick={cycleDetent}
          aria-label="Resize panel"
          className="flex shrink-0 justify-center py-2"
        >
          <span className="h-1 w-10 rounded-full bg-hairline-input" />
        </button>
        <div className="flex shrink-0 gap-1.5 px-3 pb-2">
          {sheetTabList.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => openSheetTab(tab)}
              className={
                "flex-1 rounded-md px-2 py-2 text-xs font-semibold capitalize " +
                (sheetTab === tab
                  ? "bg-accent text-white"
                  : "bg-surface text-muted")
              }
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {sheetTab === "plan"
            ? planTab
            : sheetTab === "route"
              ? routeTab
              : sheetTab === "profile"
                ? profileTab
                : issuesTab}
        </div>
        {sheetFooter}
      </div>
    </div>
  );
}
