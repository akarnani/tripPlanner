import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Airport } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import type { TerminalCorridorWarning } from "@/engine/terrainPenalty";
import { geodesicCircle, interpolateGreatCircle } from "@/engine/geo";
import { useTheme, type ResolvedTheme } from "./theme";
import { airnavUrl } from "./AirportLink";
import statesUrl from "@data/us-states.geojson?url";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
// Keyless fallback (fresh clone, CI without the secret): an inline
// style rather than a remote one. A remote fallback means the style
// never finishes loading when the tile server is unreachable — and
// none of our sources/layers ever register, so the map is dead, not
// just blank. The inline style loads instantly and offline; the
// committed state-borders GeoJSON still gives US context on top. The
// glyphs endpoint is only consulted if a symbol layer actually draws
// text; failures there are non-fatal.
function fallbackStyle(theme: ResolvedTheme): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: `trip-planner-fallback-${theme}`,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": theme === "dark" ? "#12161B" : "#F7F3E8",
        },
      },
    ],
  };
}
const BASEMAP_STYLES: Record<
  ResolvedTheme,
  string | maplibregl.StyleSpecification
> = {
  light: MAPTILER_KEY
    ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
    : fallbackStyle("light"),
  dark: MAPTILER_KEY
    ? `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_KEY}`
    : fallbackStyle("dark"),
};

// Per-theme layer palette (T8). All map-layer colors come from here —
// never hard-code a hex in a layer definition. Values mirror the CSS
// theme tokens in index.css; MapLibre paint properties can't read CSS
// variables, so the resolved hex pairs are duplicated as constants.
// HTML markers and popup fragments DO read the CSS vars directly.
const PALETTE: Record<
  ResolvedTheme,
  {
    /** Route line (--accent; dark uses a brighter #E05FD5 for glow). */
    route: string;
    /** Endpoint stop dots on the GeoJSON layer (--accent). */
    stops: string;
    /** Towered airports + range rings (--data). */
    data: string;
    /** Non-towered airport dots (--olive). */
    nontowered: string;
    /** Terrain-warning halos (--caution). */
    caution: string;
    /** State borders / secondary linework (--muted). */
    muted: string;
    /** Map label text (--ink). */
    labelText: string;
    /** Label halos + marker strokes (--card). */
    card: string;
    /** Candidate highlight ring (--accent). */
    accent: string;
  }
> = {
  light: {
    route: "#B83280",
    stops: "#B83280",
    data: "#2B6CB0",
    nontowered: "#7A8A3A",
    caution: "#A05E12",
    muted: "#8A8371",
    labelText: "#2B2A26",
    card: "#FFFDF6",
    accent: "#B83280",
  },
  dark: {
    route: "#E05FD5",
    stops: "#D357C9",
    data: "#53D3E0",
    nontowered: "#6B8A5E",
    caution: "#FFB02E",
    muted: "#67737F",
    labelText: "#E8EDF2",
    card: "#1A2027",
    accent: "#D357C9",
  },
};

const SRC_AIRPORTS = "airports";
const SRC_ROUTE = "route";
const SRC_STOPS = "route-stops";
const SRC_STATES = "us-states";
const SRC_TERRAIN_WARN = "route-terrain-warnings";
const SRC_RANGE_SOLID = "interactive-range-solid";
const SRC_RANGE_DASHED = "interactive-range-dashed";
const LAYER_TOWERED = "airports-towered";
const LAYER_NONTOWERED = "airports-nontowered";
const LAYER_AIRPORT_HIGHLIGHT = "airport-highlight-ring";
const LAYER_ROUTE = "route-line";
const LAYER_ROUTE_CASING = "route-line-casing";
const LAYER_ROUTE_HOVER = "route-line-hover";
const LAYER_STOPS = "route-stops-pts";
const LAYER_STOPS_LABELS = "route-stops-labels";
const LAYER_STATES = "us-states-borders";
const LAYER_TERRAIN_WARN = "route-terrain-warning-halo";
const LAYER_RANGE_SOLID_FILL = "interactive-range-solid-fill";
const LAYER_RANGE_SOLID_LINE = "interactive-range-solid-line";
const LAYER_RANGE_DASHED_LINE = "interactive-range-dashed-line";
const IMG_TOWERED = "towered-square";

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Leg-highlight filter (T5). `null` maps to -1, which matches no
 *  feature since legIndex is always ≥ 0. */
function legFilter(
  legIndex: number | null | undefined,
): maplibregl.FilterSpecification {
  return ["==", ["get", "legIndex"], legIndex ?? -1];
}

/** Candidate-highlight filter (T10). The sentinel can never collide
 *  with a real ident (idents are alphanumeric). */
function identFilter(
  ident: string | null | undefined,
): maplibregl.FilterSpecification {
  return ["==", ["get", "ident"], ident ?? "__none__"];
}

/** Imperative handle for callers that need to drive the map from
 *  outside its own gesture handlers (e.g. the route-profile panel's
 *  wheel-zoom, which zooms the map around the point under the cursor
 *  rather than the map's own center). */
export interface MapViewApi {
  zoomAround(center: { lat: number; lon: number }, deltaZoom: number): void;
}

interface Props {
  airports: readonly Airport[];
  route: PlannedRoute | null;
  /** T1: dim the rendered route when the plan is stale (inputs changed
   *  since it was computed). Drops line-opacity 0.85 → 0.4 (dark-mode
   *  glow casing dims proportionally, 0.25 → 0.12). */
  routeDimmed?: boolean;
  /** T5: highlight this leg's great-circle segment on the map (driven
   *  by hovering a leg-table row or route issue). Null = no highlight. */
  hoveredLegIndex?: number | null;
  /** T10: draw an accent ring around the airport with this ident
   *  (driven by hovering an interactive candidate row). */
  highlightIdent?: string | null;
  /** Called when the user finishes dragging an intermediate stop
   *  marker. Implementations should resolve the nearest eligible
   *  airport to `dropLngLat` and (if found) re-plan via the same
   *  replace-stop pathway the LegTable ✎ action uses. Return `true`
   *  if the drop was accepted; `false` snaps the marker back to its
   *  original position. */
  onMoveStop?: (
    oldAirportId: string,
    dropLngLat: { lat: number; lon: number },
  ) => boolean;
  /** Per-airport corridor warnings to highlight on the map. Each warning
   *  paints a caution-toned halo around its airport with a hover popup
   *  that spells out the shortfall. */
  terminalWarnings?: readonly TerminalCorridorWarning[];
  /** When provided, the map is in interactive build mode: range rings
   *  are drawn around `center`, and clicking any airport pins a popup
   *  with the airport verdict and an explicit "Add stop" button that
   *  fires `onAirportClick` (T10 — clicking no longer adds the stop
   *  directly, so verdicts survive mouse movement and work on touch). */
  interactive?: {
    center: Airport;
    destination: Airport;
    rangeSolidNm: number;
    rangeDashedNm: number;
    /** Called with the clicked airport's ICAO or LID (whichever is
     *  set) when the user confirms via the pinned popup's "Add stop"
     *  button. The handler should ignore identifiers that match
     *  `center` or `destination`. */
    onAirportClick: (ident: string) => void;
    /** Optional hover enrichment. When provided, the airport popup
     *  appends this HTML fragment below the standard info — used to
     *  show distance from the current departure, terrain warnings,
     *  and altitude recommendations specific to interactive mode.
     *  Return `null` to skip the augmentation. */
    onAirportHoverHtml?: (ident: string) => string | null;
  };
  /** Fired (rAF-throttled) as the viewport moves, plus once on load.
   *  Drives the route-profile panel's along-track window so the
   *  profile stretches with the map zoom. */
  onViewportChange?: (bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  }) => void;
  /** Populated with an imperative handle once the map is mounted, and
   *  nulled on unmount. Lets the route-profile panel's wheel-zoom drive
   *  this map without routing every zoom gesture through props. */
  mapApiRef?: React.MutableRefObject<MapViewApi | null>;
}

function airportsToGeoJSON(
  airports: readonly Airport[],
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: airports.map((a) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
      properties: {
        ident: a.icao ?? a.lid,
        name: a.name,
        city: a.city,
        state: a.state,
        max_runway_ft: a.max_runway_ft ?? 0,
        has_control_tower: a.has_control_tower,
      },
    })),
  };
}

function routeToGeoJSON(
  route: PlannedRoute | null,
): GeoJSON.FeatureCollection {
  if (!route) return { type: "FeatureCollection", features: [] };
  const lines: GeoJSON.Feature[] = route.legs.map((leg, i) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: interpolateGreatCircle(leg.fromAirport, leg.toAirport, 32)
        .map((p) => [p.lon, p.lat]),
    },
    // legIndex feeds the hover-highlight layer's filter (T5).
    properties: { legIndex: i },
  }));
  return { type: "FeatureCollection", features: lines };
}

function stopsToGeoJSON(
  route: PlannedRoute | null,
): GeoJSON.FeatureCollection {
  // Only the endpoints (origin + destination) render via the GeoJSON
  // source; intermediate stops are realised as draggable HTML markers
  // (see ensureStopMarkers) so they can be moved by the user without
  // re-implementing drag interaction on a maplibre circle layer.
  if (!route || route.legs.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }
  const origin = route.legs[0].fromAirport;
  const destination = route.legs[route.legs.length - 1].toAirport;
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const a of [origin, destination]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
      properties: { ident: a.icao ?? a.lid, name: a.name },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildStopMarkerElement(ident: string): HTMLElement {
  // DOM marker styled to mirror the GeoJSON endpoint circle + label.
  // Inline styles instead of Tailwind classes because Tailwind's JIT
  // only scans source files; dynamically-built class names risk being
  // tree-shaken out of the bundle. Colors come from the theme's CSS
  // variables (T8) so the marker flips with light/dark automatically —
  // no rebuild needed on theme change.
  //
  // The dot IS the marker element (no extra wrapper). Maplibre
  // applies its own `.maplibregl-marker` class which sets
  // `position:absolute`; wrapping the dot in a `position:relative`
  // <div> overrides that and breaks marker positioning, which is why
  // an earlier draft of this rendered nothing on screen.
  const dot = document.createElement("div");
  dot.style.cssText =
    "width:12px; height:12px; border-radius:9999px;" +
    "background:var(--accent); border:2px solid var(--card);" +
    "box-shadow:0 1px 2px rgba(0,0,0,0.2);" +
    "cursor:grab; touch-action:none; user-select:none;" +
    "box-sizing:content-box;";
  const label = document.createElement("div");
  label.textContent = ident;
  label.style.cssText =
    "position:absolute; left:50%; top:14px; transform:translateX(-50%);" +
    "font-size:12px; font-weight:500; color:var(--ink); white-space:nowrap;" +
    "text-shadow:-1px -1px 0 var(--card), 1px -1px 0 var(--card), -1px 1px 0 var(--card), 1px 1px 0 var(--card);" +
    "pointer-events:none;";
  dot.appendChild(label);
  return dot;
}

/** 8px square icon for towered airports (T8): data-color fill with a
 *  1px card-color stroke, rendered at 2× for crisp edges. Squares vs
 *  dots gives a shape distinction on top of the color one. Returns
 *  null when a 2D canvas isn't available (e.g. jsdom). */
function buildToweredSquareIcon(
  fill: string,
  stroke: string,
): { data: ImageData; pixelRatio: number } | null {
  const ratio = 2;
  const size = 8 * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = ratio; // 1px at icon scale
  // strokeRect centers the stroke on the path; inset by half the line
  // width so the stroke stays fully inside the bitmap.
  ctx.strokeRect(ratio / 2, ratio / 2, size - ratio, size - ratio);
  return { data: ctx.getImageData(0, 0, size, size), pixelRatio: ratio };
}

/** Standard airport info fragment shared by the hover popup and the
 *  pinned click popup so both stay in sync. Colors are inline CSS-var
 *  styles, not Tailwind color classes, so they follow the theme (T8). */
function airportInfoHtml(
  p: Record<string, unknown>,
  extraHtml: string | null,
): string {
  const runway = Number(p.max_runway_ft ?? 0).toLocaleString();
  const ident = String(p.ident ?? "");
  return (
    `<strong>${ident}</strong> ${p.name}<br/>` +
    `${p.city}${p.state ? ", " + p.state : ""}<br/>` +
    `${runway} ft · ${p.has_control_tower ? "towered" : "non-towered"}` +
    `${extraHtml ?? ""}` +
    `<br/><a href="${airnavUrl(ident)}" target="_blank" rel="noopener noreferrer" ` +
    `style="color:var(--data);text-decoration:underline">AirNav ↗</a>`
  );
}

// Popup chrome (bubble background, tip, close button) is styled by
// maplibre's stylesheet with hard-coded white; retint it once with the
// theme tokens so popups follow light/dark (T8). Injected lazily on
// first mount and left in place — it's a static, idempotent rule set.
const POPUP_STYLE_ID = "mapview-popup-theme";
function ensurePopupStylesheet() {
  if (document.getElementById(POPUP_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = POPUP_STYLE_ID;
  style.textContent = `
.maplibregl-popup-content { background: var(--card); color: var(--ink); }
.maplibregl-popup-close-button { color: var(--muted); width: 24px; height: 24px; font-size: 16px; }
.maplibregl-popup-anchor-top .maplibregl-popup-tip,
.maplibregl-popup-anchor-top-left .maplibregl-popup-tip,
.maplibregl-popup-anchor-top-right .maplibregl-popup-tip { border-bottom-color: var(--card); }
.maplibregl-popup-anchor-bottom .maplibregl-popup-tip,
.maplibregl-popup-anchor-bottom-left .maplibregl-popup-tip,
.maplibregl-popup-anchor-bottom-right .maplibregl-popup-tip { border-top-color: var(--card); }
.maplibregl-popup-anchor-left .maplibregl-popup-tip { border-right-color: var(--card); }
.maplibregl-popup-anchor-right .maplibregl-popup-tip { border-left-color: var(--card); }
`;
  document.head.appendChild(style);
}

function terrainWarningsToGeoJSON(
  route: PlannedRoute | null,
  warnings: readonly TerminalCorridorWarning[],
): GeoJSON.FeatureCollection {
  if (!route || warnings.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }
  // Look up airport lat/lon by ident once instead of per warning.
  const byIdent = new Map<string, { lat: number; lon: number; name: string }>();
  for (const leg of route.legs) {
    for (const a of [leg.fromAirport, leg.toAirport]) {
      const ident = a.icao ?? a.lid;
      byIdent.set(ident, { lat: a.lat, lon: a.lon, name: a.name });
    }
  }
  // Multiple warnings may target the same airport (e.g. an intermediate
  // stop with both arrival and departure issues). Merge them so the map
  // shows a single halo per airport with combined hover text.
  const merged = new Map<
    string,
    { warnings: TerminalCorridorWarning[]; lat: number; lon: number; name: string }
  >();
  for (const w of warnings) {
    const ap = byIdent.get(w.ident);
    if (!ap) continue;
    const entry = merged.get(w.ident);
    if (entry) entry.warnings.push(w);
    else merged.set(w.ident, { warnings: [w], ...ap });
  }
  const features: GeoJSON.Feature[] = [];
  for (const [ident, m] of merged) {
    const summary = m.warnings
      .map(
        (w) =>
          `${w.kind === "departure" ? "Departure" : "Arrival"}: terrain ${Math.round(w.shortfall_ft).toLocaleString()} ft above profile`,
      )
      .join(" · ");
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [m.lon, m.lat] },
      properties: {
        ident,
        name: m.name,
        summary,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function rangeRingToGeoJSON(
  center: Airport | undefined,
  radiusNm: number,
): GeoJSON.FeatureCollection {
  if (!center || radiusNm <= 0) {
    return { type: "FeatureCollection", features: [] };
  }
  const ring = geodesicCircle(
    { lat: center.lat, lon: center.lon },
    radiusNm,
    72,
  );
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [ring.map((p) => [p.lon, p.lat])],
        },
        properties: { radius_nm: radiusNm },
      },
    ],
  };
}

export function MapView({
  airports,
  route,
  routeDimmed,
  hoveredLegIndex,
  highlightIdent,
  onMoveStop,
  terminalWarnings,
  interactive,
  onViewportChange,
  mapApiRef,
}: Props) {
  const warnings = terminalWarnings ?? [];
  const { resolved } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // styleReady is state, not a ref, so the source-update effects below
  // re-run when the map's `load` event finally fires. With a ref the
  // initial dataset load would race the load event and silently get
  // dropped — sources/layers would be created with the empty
  // EMPTY_DATASETS values from mount, and nothing would push the real
  // airports onto them until the next prop change (e.g. the user
  // touched a filter). It also flips false → true around a theme
  // setStyle() swap so the same effects re-push data into the fresh
  // sources once registerLayers has recreated them.
  const [styleReady, setStyleReady] = useState(false);
  const stopMarkersRef = useRef<maplibregl.Marker[]>([]);
  // The onMoveStop callback can change identity across renders (App
  // creates a new function each render). Keep a ref so the marker
  // dragend handlers always see the latest closure without having to
  // tear down and rebuild markers on every parent re-render.
  const onMoveStopRef = useRef(onMoveStop);
  onMoveStopRef.current = onMoveStop;
  // Same trick for the interactive callbacks: airport event handlers
  // are bound at layer registration, but the React-side callbacks
  // close over fresh state every render.
  const onAirportClickRef = useRef<((id: string) => void) | undefined>(
    interactive?.onAirportClick,
  );
  onAirportClickRef.current = interactive?.onAirportClick;
  const onAirportHoverHtmlRef = useRef<
    ((ident: string) => string | null) | undefined
  >(interactive?.onAirportHoverHtml);
  onAirportHoverHtmlRef.current = interactive?.onAirportHoverHtml;
  // And for the presentational props: registerLayers reads these when
  // it (re)creates layers after a theme swap so the fresh layers start
  // with the correct dimming/filters instead of the defaults.
  const routeDimmedRef = useRef(routeDimmed);
  routeDimmedRef.current = routeDimmed;
  const hoveredLegIndexRef = useRef(hoveredLegIndex);
  hoveredLegIndexRef.current = hoveredLegIndex;
  const highlightIdentRef = useRef(highlightIdent);
  highlightIdentRef.current = highlightIdent;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  // The mapApiRef prop is itself a ref object, but re-read it through a
  // ref of refs so the mount-only effect below (which assigns into it
  // once the map loads) always targets whatever ref object the latest
  // render passed in, not whichever one happened to be current at
  // mount time.
  const mapApiRefRef = useRef(mapApiRef);
  mapApiRefRef.current = mapApiRef;
  // Latest GeoJSON per source. setStyle() drops every custom source,
  // so registerLayers re-seeds fresh sources from this cache instead
  // of waiting for the prop effects to fire again.
  const sourceDataRef = useRef<Record<string, GeoJSON.FeatureCollection>>({});
  // Guards the one-time state-borders fetch across style swaps.
  const statesRequestedRef = useRef(false);
  // Reused transient hover popup (survives style swaps — popups are
  // map overlays, not style objects).
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  // T10: the single click-to-pin popup; replaced on each airport click.
  const pinnedPopupRef = useRef<maplibregl.Popup | null>(null);
  // Pending close of the hover popup. `mouseleave` on an airport marker
  // schedules the close on a short delay rather than removing instantly,
  // so the cursor can travel across the gap onto the popup (to click the
  // AirNav link) without it vanishing. Entering the popup cancels it.
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Delegated layer handlers registered by registerLayers. map.on(evt,
  // layerId, fn) listeners live on the Map (not the style), so without
  // explicit removal a theme swap would double-bind them. Each entry
  // is an unbind thunk.
  const layerHandlerUnbindsRef = useRef<Array<() => void>>([]);
  // Tracks which theme the map's basemap currently reflects, so the
  // theme effect can skip the first render (no setStyle on mount) and
  // the mount effect can pick the right initial basemap.
  const resolvedRef = useRef(resolved);
  // fitBounds only when the route itself changes — not when styleReady
  // toggles around a theme swap, which would otherwise yank the camera
  // back to the route extent on every theme toggle.
  const lastFitRouteRef = useRef<PlannedRoute | null>(null);

  function ensureStopMarkers(
    map: maplibregl.Map,
    nextRoute: PlannedRoute | null,
  ) {
    for (const m of stopMarkersRef.current) m.remove();
    stopMarkersRef.current = [];
    if (!nextRoute || nextRoute.legs.length < 2) return;
    // Intermediate stops: all toAirports except the last leg's (the
    // destination) and not the first leg's fromAirport (the origin).
    for (let i = 0; i < nextRoute.legs.length - 1; i++) {
      const stop = nextRoute.legs[i].toAirport;
      const ident = stop.icao ?? stop.lid;
      const el = buildStopMarkerElement(ident);
      // Seed the stale-plan dim so markers rebuilt mid-stale (theme
      // swap, route effect re-runs) don't pop back to full opacity.
      el.style.opacity = routeDimmedRef.current ? "0.35" : "1";
      const original: [number, number] = [stop.lon, stop.lat];
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat(original)
        .addTo(map);
      marker.on("dragstart", () => {
        el.style.cursor = "grabbing";
      });
      marker.on("dragend", () => {
        el.style.cursor = "grab";
        const at = marker.getLngLat();
        const accepted = onMoveStopRef.current?.(stop.id, {
          lat: at.lat,
          lon: at.lng,
        });
        if (!accepted) {
          // No snap target or drop rejected — return the marker to its
          // original airport so the displayed route stays consistent
          // with the planner state.
          marker.setLngLat(original);
        }
        // On acceptance the parent will set a new route prop, which
        // re-runs the route useEffect and rebuilds all markers from
        // scratch at the new airport positions.
      });
      stopMarkersRef.current.push(marker);
    }
  }

  /** (Re)creates every custom source, layer, image, and delegated
   *  layer event handler on a freshly-loaded style. Called from the
   *  initial `load` handler and again after each theme `setStyle()`
   *  swap (which drops all of the above). Sources are seeded from
   *  sourceDataRef so the map repopulates without waiting for props
   *  to change. */
  function registerLayers(map: maplibregl.Map, theme: ResolvedTheme) {
    const pal = PALETTE[theme];
    const data = (src: string) => sourceDataRef.current[src] ?? EMPTY_FC;

    // Unbind delegated handlers from the previous style's registration
    // pass; map.on(event, layerId, fn) listeners survive setStyle and
    // would fire twice once re-bound below.
    for (const unbind of layerHandlerUnbindsRef.current) unbind();
    layerHandlerUnbindsRef.current = [];
    const bind = <T extends keyof maplibregl.MapLayerEventType>(
      type: T,
      layerId: string,
      fn: (e: maplibregl.MapLayerEventType[T]) => void,
    ) => {
      map.on(type, layerId, fn);
      layerHandlerUnbindsRef.current.push(() => map.off(type, layerId, fn));
    };

    // Towered-airport square sprite, regenerated per theme (setStyle
    // also drops images). Guard against a stale copy just in case.
    if (map.hasImage(IMG_TOWERED)) map.removeImage(IMG_TOWERED);
    const square = buildToweredSquareIcon(pal.data, pal.card);
    if (square) {
      map.addImage(IMG_TOWERED, square.data, {
        pixelRatio: square.pixelRatio,
      });
    }

    // State borders under everything else — visual SA without
    // depending on a richer basemap. The fetch happens once, in the
    // background; the layer just stays empty until it lands (or is
    // seeded instantly from the cache on later theme swaps).
    map.addSource(SRC_STATES, { type: "geojson", data: data(SRC_STATES) });
    map.addLayer({
      id: LAYER_STATES,
      type: "line",
      source: SRC_STATES,
      paint: {
        "line-color": pal.muted,
        "line-width": 1,
        "line-opacity": 0.7,
      },
    });
    if (!statesRequestedRef.current) {
      statesRequestedRef.current = true;
      fetch(statesUrl)
        .then((r) => r.json())
        .then((geojson) => {
          sourceDataRef.current[SRC_STATES] = geojson;
          (map.getSource(SRC_STATES) as maplibregl.GeoJSONSource | undefined)
            ?.setData(geojson);
        })
        .catch((e) => {
          statesRequestedRef.current = false; // allow a retry next swap
          console.warn("state borders failed to load:", e);
        });
    }

    map.addSource(SRC_AIRPORTS, {
      type: "geojson",
      data: data(SRC_AIRPORTS),
    });
    // Towered airports render as squares (symbol layer with the
    // generated sprite) so tower status reads by shape as well as
    // color. Same layer id as the old circle layer so the delegated
    // hover/click handlers below and external references stay valid.
    map.addLayer({
      id: LAYER_TOWERED,
      type: "symbol",
      source: SRC_AIRPORTS,
      filter: ["==", ["get", "has_control_tower"], true],
      layout: {
        "icon-image": IMG_TOWERED,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
    map.addLayer({
      id: LAYER_NONTOWERED,
      type: "circle",
      source: SRC_AIRPORTS,
      filter: ["==", ["get", "has_control_tower"], false],
      paint: {
        "circle-radius": 3,
        "circle-color": pal.nontowered,
        "circle-stroke-color": pal.card,
        "circle-stroke-width": 1,
      },
    });
    // T10: accent ring around the candidate airport being hovered in
    // the sidebar list. Transparent fill, stroke only; filtered down
    // to a single ident (or the never-matching sentinel).
    map.addLayer({
      id: LAYER_AIRPORT_HIGHLIGHT,
      type: "circle",
      source: SRC_AIRPORTS,
      filter: identFilter(highlightIdentRef.current),
      paint: {
        "circle-radius": 10,
        "circle-opacity": 0,
        "circle-stroke-color": pal.accent,
        "circle-stroke-width": 2,
      },
    });

    map.addSource(SRC_ROUTE, { type: "geojson", data: data(SRC_ROUTE) });
    // Dark mode gets a soft glow: a wide low-opacity casing in the
    // route color under the 3px main line. Light mode skips it — the
    // warm basemap doesn't need the lift. Dims in step with the main
    // line when the plan is stale (T1).
    if (theme === "dark") {
      map.addLayer({
        id: LAYER_ROUTE_CASING,
        type: "line",
        source: SRC_ROUTE,
        paint: {
          "line-color": pal.route,
          "line-width": 8,
          "line-opacity": routeDimmedRef.current ? 0.12 : 0.25,
        },
      });
    }
    map.addLayer({
      id: LAYER_ROUTE,
      type: "line",
      source: SRC_ROUTE,
      paint: {
        "line-color": pal.route,
        "line-width": 3,
        "line-opacity": routeDimmedRef.current ? 0.4 : 0.85,
      },
    });
    // T5: full-opacity highlight over the hovered leg only; the filter
    // is swapped via setFilter as hoveredLegIndex changes.
    map.addLayer({
      id: LAYER_ROUTE_HOVER,
      type: "line",
      source: SRC_ROUTE,
      filter: legFilter(hoveredLegIndexRef.current),
      paint: {
        "line-color": pal.route,
        "line-width": 6,
        "line-opacity": 1,
      },
    });

    // Terrain-warning halos go BELOW the stop dots so the dot stays
    // visible and the caution ring just signals "look here". Added
    // before the stops layer for that reason.
    map.addSource(SRC_TERRAIN_WARN, {
      type: "geojson",
      data: data(SRC_TERRAIN_WARN),
    });
    map.addLayer({
      id: LAYER_TERRAIN_WARN,
      type: "circle",
      source: SRC_TERRAIN_WARN,
      paint: {
        "circle-radius": 12,
        "circle-color": pal.caution,
        "circle-opacity": 0.3,
        "circle-stroke-color": pal.caution,
        "circle-stroke-width": 1.5,
        "circle-stroke-opacity": 0.9,
      },
    });

    // Interactive-mode range rings sit below airports / stops so
    // the markers stay clickable through the translucent fill.
    // Dashed ring is line-only; solid ring fills lightly so the
    // "you can definitely make it" area reads at a glance. Both use
    // the data color (rings are information, not action).
    map.addSource(SRC_RANGE_DASHED, {
      type: "geojson",
      data: data(SRC_RANGE_DASHED),
    });
    map.addLayer({
      id: LAYER_RANGE_DASHED_LINE,
      type: "line",
      source: SRC_RANGE_DASHED,
      paint: {
        "line-color": pal.data,
        "line-width": 1.5,
        "line-opacity": 0.75,
        "line-dasharray": [3, 3],
      },
    });
    map.addSource(SRC_RANGE_SOLID, {
      type: "geojson",
      data: data(SRC_RANGE_SOLID),
    });
    map.addLayer({
      id: LAYER_RANGE_SOLID_FILL,
      type: "fill",
      source: SRC_RANGE_SOLID,
      paint: {
        "fill-color": pal.data,
        "fill-opacity": 0.08,
      },
    });
    map.addLayer({
      id: LAYER_RANGE_SOLID_LINE,
      type: "line",
      source: SRC_RANGE_SOLID,
      paint: {
        "line-color": pal.data,
        "line-width": 1.5,
        "line-opacity": 0.85,
      },
    });
    map.addSource(SRC_STOPS, { type: "geojson", data: data(SRC_STOPS) });
    map.addLayer({
      id: LAYER_STOPS,
      type: "circle",
      source: SRC_STOPS,
      paint: {
        "circle-radius": 6,
        "circle-color": pal.stops,
        "circle-stroke-color": pal.card,
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: LAYER_STOPS_LABELS,
      type: "symbol",
      source: SRC_STOPS,
      layout: {
        "text-field": ["get", "ident"],
        "text-size": 12,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": pal.labelText,
        "text-halo-color": pal.card,
        "text-halo-width": 1.5,
      },
    });

    if (!hoverPopupRef.current) {
      hoverPopupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      // Keep the popup alive while the cursor is over it so its links
      // (AirNav ↗) are reachable — a fresh container element is created
      // on every open, so re-bind on each open.
      hoverPopupRef.current.on("open", () => {
        const el = hoverPopupRef.current?.getElement();
        if (!el) return;
        el.addEventListener("mouseenter", cancelHoverClose);
        el.addEventListener("mouseleave", () => hoverPopupRef.current?.remove());
      });
    }
    const popup = hoverPopupRef.current;
    const cancelHoverClose = () => {
      if (hoverCloseTimerRef.current !== null) {
        clearTimeout(hoverCloseTimerRef.current);
        hoverCloseTimerRef.current = null;
      }
    };
    // Delay the close so the cursor can reach the popup; entering the
    // popup cancels this, leaving the popup handlers to close it.
    const scheduleHoverClose = () => {
      cancelHoverClose();
      hoverCloseTimerRef.current = setTimeout(() => {
        hoverCloseTimerRef.current = null;
        popup.remove();
      }, 200);
    };
    for (const layer of [LAYER_TOWERED, LAYER_NONTOWERED]) {
      bind("click", layer, (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const p = f.properties ?? {};
        const ident = p.ident;
        if (typeof ident !== "string") return;
        const [lon, lat] = f.geometry.coordinates as [number, number];
        // Browse mode (no onAirportClick handler): a tap pins the airport
        // info card. Hover tooltips never fire on touch, so this is the
        // only way to read an airport's details with a finger. Desktop
        // gets the same on click, which is harmless.
        if (!onAirportClickRef.current) {
          popup.remove();
          pinnedPopupRef.current?.remove();
          const pinned = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: true,
          })
            .setLngLat([lon, lat])
            .setHTML(
              `<div class="text-xs" style="color:var(--ink)">${airportInfoHtml(p, null)}</div>`,
            )
            .addTo(map);
          pinnedPopupRef.current = pinned;
          return;
        }
        // Interactive build mode: pin a popup with the airport verdict
        // and an explicit "Add stop" button (T10) — the stop is added
        // when the button is pressed, not on the map click, so the pilot
        // can read the verdict without a stray click committing it.
        const extraHtml = onAirportHoverHtmlRef.current?.(ident) ?? null;
        // The pinned popup replaces the transient hover one (which
        // would sit at the same spot) and any previously pinned popup
        // — one verdict at a time.
        popup.remove();
        pinnedPopupRef.current?.remove();
        const content = document.createElement("div");
        content.className = "text-xs";
        content.style.color = "var(--ink)";
        const info = document.createElement("div");
        info.innerHTML = airportInfoHtml(p, extraHtml);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Add stop";
        btn.style.cssText =
          "display:block; margin-top:6px; padding:4px 10px;" +
          "border:none; border-radius:4px; cursor:pointer;" +
          "background:var(--accent); color:#ffffff;" +
          "font-size:12px; font-weight:500;";
        content.append(info, btn);
        const pinned = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: false,
        })
          .setLngLat([lon, lat])
          .setDOMContent(content)
          .addTo(map);
        pinnedPopupRef.current = pinned;
        // Real DOM listener (not an inline onclick string) so the
        // handler closes over the latest React callback via the ref.
        btn.addEventListener("click", () => {
          onAirportClickRef.current?.(ident);
          pinned.remove();
        });
      });
      bind("mouseenter", layer, (e) => {
        cancelHoverClose();
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const [lon, lat] = f.geometry.coordinates as [number, number];
        const p = f.properties ?? {};
        const extraHtml =
          typeof p.ident === "string"
            ? (onAirportHoverHtmlRef.current?.(p.ident) ?? null)
            : null;
        popup
          .setLngLat([lon, lat])
          .setHTML(
            `<div class="text-xs" style="color:var(--ink)">${airportInfoHtml(p, extraHtml)}</div>`,
          )
          .addTo(map);
      });
      bind("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        scheduleHoverClose();
      });
    }
    // Terrain-warning halo popup: shows the shortfall summary for the
    // hovered stop. Falls through to the route-stop tooltip if both
    // layers cover the same pixel.
    bind("mouseenter", LAYER_TERRAIN_WARN, (e) => {
      cancelHoverClose();
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const p = f.properties ?? {};
      popup
        .setLngLat([lon, lat])
        .setHTML(
          `<div class="text-xs" style="color:var(--ink)"><strong>${p.ident}</strong> ${p.name}<br/><span style="color:var(--caution)">⚠ ${p.summary}</span></div>`,
        )
        .addTo(map);
    });
    bind("mouseleave", LAYER_TERRAIN_WARN, () => {
      map.getCanvas().style.cursor = "";
      scheduleHoverClose();
    });
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensurePopupStylesheet();
    const map = new maplibregl.Map({
      container: containerRef.current,
      // resolvedRef (not the closed-over `resolved`) so a theme change
      // racing map construction still picks the freshest basemap.
      style: BASEMAP_STYLES[resolvedRef.current],
      center: [-98, 39],
      zoom: 3.5,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    // Viewport reporting for the route-profile window. "move" fires
    // per frame while panning/zooming; collapse bursts onto rAF so
    // React sees at most one update per paint.
    let viewportRaf = 0;
    const emitViewport = () => {
      if (viewportRaf) return;
      viewportRaf = requestAnimationFrame(() => {
        viewportRaf = 0;
        const cb = onViewportChangeRef.current;
        if (!cb) return;
        const b = map.getBounds();
        cb({
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
        });
      });
    };
    map.on("move", emitViewport);

    map.on("load", () => {
      // mapRef is only assigned here (not at construction) so the
      // theme-swap effect below stays inert until the first style has
      // fully loaded — a setStyle() during initial load would make the
      // pending `load` handler register layers a second time.
      mapRef.current = map;
      registerLayers(map, resolvedRef.current);
      setStyleReady(true);
      ensureStopMarkers(map, route);
      emitViewport();
      if (mapApiRefRef.current) {
        mapApiRefRef.current.current = {
          zoomAround: ({ lat, lon }, dz) => {
            map.easeTo({
              zoom: Math.max(2, Math.min(14, map.getZoom() + dz)),
              around: new maplibregl.LngLat(lon, lat),
              duration: 120,
            });
          },
        };
      }
    });

    // Dev-only handle so e2e tests can assert against the live map
    // (e.g. that custom layers survive a theme swap). Never set in
    // production builds.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__tripPlannerMap = map;
    }

    return () => {
      for (const m of stopMarkersRef.current) m.remove();
      stopMarkersRef.current = [];
      if (hoverCloseTimerRef.current !== null) {
        clearTimeout(hoverCloseTimerRef.current);
        hoverCloseTimerRef.current = null;
      }
      hoverPopupRef.current?.remove();
      hoverPopupRef.current = null;
      pinnedPopupRef.current?.remove();
      pinnedPopupRef.current = null;
      layerHandlerUnbindsRef.current = [];
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__tripPlannerMap;
      }
      if (mapApiRefRef.current) mapApiRefRef.current.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []); // mount-only

  // Theme swap (T8). setStyle() drops all custom sources, layers,
  // images, and (effectively) the delegated layer handlers, so after
  // the new basemap's style.load we re-run registerLayers, which
  // re-seeds everything from the cached data refs. styleReady gates
  // the prop effects off during the swap window; flipping it back on
  // re-runs them against the fresh sources. Skips the initial render
  // — the mount effect already built the map with the right basemap.
  useEffect(() => {
    const prev = resolvedRef.current;
    resolvedRef.current = resolved;
    const map = mapRef.current;
    if (!map || prev === resolved) return;
    setStyleReady(false);
    // diff: false forces a full style rebuild. The default diff mode
    // transforms the current style into the target one incrementally,
    // which strips our runtime-added sources/layers (they're not in
    // the target style) and — because no full load happens — never
    // fires style.load, so registerLayers would never re-add them.
    map.setStyle(BASEMAP_STYLES[resolved], { diff: false });
    const onStyleLoad = () => {
      registerLayers(map, resolved);
      setStyleReady(true);
    };
    map.once("style.load", onStyleLoad);
    // Cleanup unregisters a still-pending handler if the theme flips
    // again before this style finished loading — otherwise both
    // handlers would run registerLayers and the second addSource pass
    // would throw on duplicate ids.
    return () => {
      map.off("style.load", onStyleLoad);
    };
  }, [resolved]);

  useEffect(() => {
    const fc = airportsToGeoJSON(airports);
    sourceDataRef.current[SRC_AIRPORTS] = fc;
    if (!mapRef.current || !styleReady) return;
    (mapRef.current.getSource(SRC_AIRPORTS) as maplibregl.GeoJSONSource)
      ?.setData(fc);
  }, [airports, styleReady]);

  useEffect(() => {
    const routeFC = routeToGeoJSON(route);
    const stopsFC = stopsToGeoJSON(route);
    sourceDataRef.current[SRC_ROUTE] = routeFC;
    sourceDataRef.current[SRC_STOPS] = stopsFC;
    if (!mapRef.current || !styleReady) return;
    (mapRef.current.getSource(SRC_ROUTE) as maplibregl.GeoJSONSource)
      ?.setData(routeFC);
    (mapRef.current.getSource(SRC_STOPS) as maplibregl.GeoJSONSource)
      ?.setData(stopsFC);
    ensureStopMarkers(mapRef.current, route);
    // Fit only when the route object itself changed — this effect also
    // re-runs when styleReady cycles around a theme swap, and yanking
    // the camera back on theme toggle would discard the user's pan.
    if (route && route.legs.length > 0 && lastFitRouteRef.current !== route) {
      lastFitRouteRef.current = route;
      const bounds = new maplibregl.LngLatBounds();
      for (const leg of route.legs) {
        bounds.extend([leg.fromAirport.lon, leg.fromAirport.lat]);
        bounds.extend([leg.toAirport.lon, leg.toAirport.lat]);
      }
      mapRef.current.fitBounds(bounds, { padding: 80, duration: 600 });
    }
  }, [route, styleReady]);

  useEffect(() => {
    const fc = terrainWarningsToGeoJSON(route, warnings);
    sourceDataRef.current[SRC_TERRAIN_WARN] = fc;
    if (!mapRef.current || !styleReady) return;
    (mapRef.current.getSource(SRC_TERRAIN_WARN) as maplibregl.GeoJSONSource)
      ?.setData(fc);
  }, [route, warnings, styleReady]);

  useEffect(() => {
    const solid = interactive
      ? rangeRingToGeoJSON(interactive.center, interactive.rangeSolidNm)
      : EMPTY_FC;
    const dashed = interactive
      ? rangeRingToGeoJSON(interactive.center, interactive.rangeDashedNm)
      : EMPTY_FC;
    sourceDataRef.current[SRC_RANGE_SOLID] = solid;
    sourceDataRef.current[SRC_RANGE_DASHED] = dashed;
    // Leaving interactive mode dismisses any pinned verdict popup —
    // its "Add stop" action would be a no-op outside interactive mode.
    if (!interactive) pinnedPopupRef.current?.remove();
    if (!mapRef.current || !styleReady) return;
    const m = mapRef.current;
    (m.getSource(SRC_RANGE_SOLID) as maplibregl.GeoJSONSource)?.setData(solid);
    (m.getSource(SRC_RANGE_DASHED) as maplibregl.GeoJSONSource)
      ?.setData(dashed);
  }, [interactive, styleReady]);

  // T1: stale-plan dimming. Fades the whole route rendering — line,
  // endpoint dots, labels, AND the draggable HTML stop markers. Dimming
  // only the line isn't legible: the markers and labels dominate
  // visually and at full opacity they read as "nothing changed".
  // styleReady is a dep so the opacity is re-applied to the fresh
  // layers after a theme swap (registerLayers also seeds it from the
  // ref, so there's no visible flash either way).
  useEffect(() => {
    if (!mapRef.current || !styleReady) return;
    const m = mapRef.current;
    if (m.getLayer(LAYER_ROUTE)) {
      m.setPaintProperty(LAYER_ROUTE, "line-opacity", routeDimmed ? 0.4 : 0.85);
    }
    // Casing only exists in dark mode.
    if (m.getLayer(LAYER_ROUTE_CASING)) {
      m.setPaintProperty(
        LAYER_ROUTE_CASING,
        "line-opacity",
        routeDimmed ? 0.12 : 0.25,
      );
    }
    if (m.getLayer(LAYER_STOPS)) {
      m.setPaintProperty(LAYER_STOPS, "circle-opacity", routeDimmed ? 0.35 : 1);
      m.setPaintProperty(
        LAYER_STOPS,
        "circle-stroke-opacity",
        routeDimmed ? 0.35 : 1,
      );
    }
    if (m.getLayer(LAYER_STOPS_LABELS)) {
      m.setPaintProperty(
        LAYER_STOPS_LABELS,
        "text-opacity",
        routeDimmed ? 0.4 : 1,
      );
    }
    for (const marker of stopMarkersRef.current) {
      marker.getElement().style.opacity = routeDimmed ? "0.35" : "1";
    }
  }, [routeDimmed, styleReady]);

  // T5: leg hover highlight.
  useEffect(() => {
    if (!mapRef.current || !styleReady) return;
    if (!mapRef.current.getLayer(LAYER_ROUTE_HOVER)) return;
    mapRef.current.setFilter(LAYER_ROUTE_HOVER, legFilter(hoveredLegIndex));
  }, [hoveredLegIndex, styleReady]);

  // T10: candidate airport highlight ring.
  useEffect(() => {
    if (!mapRef.current || !styleReady) return;
    if (!mapRef.current.getLayer(LAYER_AIRPORT_HIGHLIGHT)) return;
    mapRef.current.setFilter(
      LAYER_AIRPORT_HIGHLIGHT,
      identFilter(highlightIdent),
    );
  }, [highlightIdent, styleReady]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
