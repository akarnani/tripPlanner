import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Airport } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import { interpolateGreatCircle } from "@/engine/geo";
import statesUrl from "@data/us-states.geojson?url";

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
const BASEMAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`
  : // Fall back to MapLibre's demo basemap when no MapTiler key is
    // configured (e.g. fresh clone, CI runs without the secret). Keeps
    // local dev and the Playwright suite working without credentials.
    "https://demotiles.maplibre.org/style.json";
const SRC_AIRPORTS = "airports";
const SRC_ROUTE = "route";
const SRC_STOPS = "route-stops";
const SRC_STATES = "us-states";
const LAYER_TOWERED = "airports-towered";
const LAYER_NONTOWERED = "airports-nontowered";
const LAYER_ROUTE = "route-line";
const LAYER_STOPS = "route-stops-pts";
const LAYER_STOPS_LABELS = "route-stops-labels";
const LAYER_STATES = "us-states-borders";

interface Props {
  airports: readonly Airport[];
  route: PlannedRoute | null;
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
  const lines: GeoJSON.Feature[] = route.legs.map((leg) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: interpolateGreatCircle(leg.fromAirport, leg.toAirport, 32)
        .map((p) => [p.lon, p.lat]),
    },
    properties: {},
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
  // tree-shaken out of the bundle.
  //
  // The dot IS the marker element (no extra wrapper). Maplibre
  // applies its own `.maplibregl-marker` class which sets
  // `position:absolute`; wrapping the dot in a `position:relative`
  // <div> overrides that and breaks marker positioning, which is why
  // an earlier draft of this rendered nothing on screen.
  const dot = document.createElement("div");
  dot.style.cssText =
    "width:12px; height:12px; border-radius:9999px;" +
    "background:#ea580c; border:2px solid #ffffff;" +
    "box-shadow:0 1px 2px rgba(0,0,0,0.2);" +
    "cursor:grab; touch-action:none; user-select:none;" +
    "box-sizing:content-box;";
  const label = document.createElement("div");
  label.textContent = ident;
  label.style.cssText =
    "position:absolute; left:50%; top:14px; transform:translateX(-50%);" +
    "font-size:12px; font-weight:500; color:#1f2937; white-space:nowrap;" +
    "text-shadow:-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff;" +
    "pointer-events:none;";
  dot.appendChild(label);
  return dot;
}

export function MapView({ airports, route, onMoveStop }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // styleReady is state, not a ref, so the source-update effects below
  // re-run when the map's `load` event finally fires. With a ref the
  // initial dataset load would race the load event and silently get
  // dropped — sources/layers would be created with the empty
  // EMPTY_DATASETS values from mount, and nothing would push the real
  // airports onto them until the next prop change (e.g. the user
  // touched a filter).
  const [styleReady, setStyleReady] = useState(false);
  const stopMarkersRef = useRef<maplibregl.Marker[]>([]);
  // The onMoveStop callback can change identity across renders (App
  // creates a new function each render). Keep a ref so the marker
  // dragend handlers always see the latest closure without having to
  // tear down and rebuild markers on every parent re-render.
  const onMoveStopRef = useRef(onMoveStop);
  onMoveStopRef.current = onMoveStop;

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

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: [-98, 39],
      zoom: 3.5,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      setStyleReady(true);

      // State borders under everything else — visual SA without
      // depending on a richer basemap. The fetch happens in the
      // background; the layer just stays empty until it lands.
      map.addSource(SRC_STATES, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_STATES,
        type: "line",
        source: SRC_STATES,
        paint: {
          "line-color": "#94a3b8",
          "line-width": 1,
          "line-opacity": 0.7,
        },
      });
      fetch(statesUrl)
        .then((r) => r.json())
        .then((geojson) => {
          (map.getSource(SRC_STATES) as maplibregl.GeoJSONSource | undefined)
            ?.setData(geojson);
        })
        .catch((e) => console.warn("state borders failed to load:", e));

      map.addSource(SRC_AIRPORTS, {
        type: "geojson",
        data: airportsToGeoJSON(airports),
      });
      map.addLayer({
        id: LAYER_TOWERED,
        type: "circle",
        source: SRC_AIRPORTS,
        filter: ["==", ["get", "has_control_tower"], true],
        paint: {
          "circle-radius": 4,
          "circle-color": "#1d4ed8",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
      map.addLayer({
        id: LAYER_NONTOWERED,
        type: "circle",
        source: SRC_AIRPORTS,
        filter: ["==", ["get", "has_control_tower"], false],
        paint: {
          "circle-radius": 3,
          "circle-color": "#65a30d",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });

      map.addSource(SRC_ROUTE, {
        type: "geojson",
        data: routeToGeoJSON(route),
      });
      map.addLayer({
        id: LAYER_ROUTE,
        type: "line",
        source: SRC_ROUTE,
        paint: {
          "line-color": "#ea580c",
          "line-width": 3,
          "line-opacity": 0.85,
        },
      });

      map.addSource(SRC_STOPS, {
        type: "geojson",
        data: stopsToGeoJSON(route),
      });
      map.addLayer({
        id: LAYER_STOPS,
        type: "circle",
        source: SRC_STOPS,
        paint: {
          "circle-radius": 6,
          "circle-color": "#ea580c",
          "circle-stroke-color": "#ffffff",
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
          "text-color": "#1f2937",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });


      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
      });
      for (const layer of [LAYER_TOWERED, LAYER_NONTOWERED]) {
        map.on("mouseenter", layer, (e) => {
          map.getCanvas().style.cursor = "pointer";
          const f = e.features?.[0];
          if (!f || f.geometry.type !== "Point") return;
          const [lon, lat] = f.geometry.coordinates as [number, number];
          const p = f.properties ?? {};
          popup
            .setLngLat([lon, lat])
            .setHTML(
              `<div class="text-xs"><strong>${p.ident}</strong> ${p.name}<br/>${p.city}${p.state ? ", " + p.state : ""}<br/>${p.max_runway_ft.toLocaleString()} ft · ${p.has_control_tower ? "towered" : "non-towered"}</div>`,
            )
            .addTo(map);
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
          popup.remove();
        });
      }

      mapRef.current = map;
      ensureStopMarkers(map, route);
    });

    return () => {
      for (const m of stopMarkersRef.current) m.remove();
      stopMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []); // mount-only

  useEffect(() => {
    if (!mapRef.current || !styleReady) return;
    (mapRef.current.getSource(SRC_AIRPORTS) as maplibregl.GeoJSONSource)
      ?.setData(airportsToGeoJSON(airports));
  }, [airports, styleReady]);

  useEffect(() => {
    if (!mapRef.current || !styleReady) return;
    (mapRef.current.getSource(SRC_ROUTE) as maplibregl.GeoJSONSource)
      ?.setData(routeToGeoJSON(route));
    (mapRef.current.getSource(SRC_STOPS) as maplibregl.GeoJSONSource)
      ?.setData(stopsToGeoJSON(route));
    ensureStopMarkers(mapRef.current, route);
    if (route && route.legs.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const leg of route.legs) {
        bounds.extend([leg.fromAirport.lon, leg.fromAirport.lat]);
        bounds.extend([leg.toAirport.lon, leg.toAirport.lat]);
      }
      mapRef.current.fitBounds(bounds, { padding: 80, duration: 600 });
    }
  }, [route, styleReady]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
