import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { Airport, Obstacle } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import { interpolateGreatCircle } from "@/engine/geo";

const PLACEHOLDER_STYLE = "https://demotiles.maplibre.org/style.json";
const SRC_AIRPORTS = "airports";
const SRC_ROUTE = "route";
const SRC_STOPS = "route-stops";
const SRC_OBSTACLES = "obstacles";
const LAYER_TOWERED = "airports-towered";
const LAYER_NONTOWERED = "airports-nontowered";
const LAYER_ROUTE = "route-line";
const LAYER_STOPS = "route-stops-pts";
const LAYER_OBSTACLES = "obstacles-pts";

interface Props {
  airports: readonly Airport[];
  route: PlannedRoute | null;
  obstacles: readonly Obstacle[];
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

function obstaclesToGeoJSON(
  obstacles: readonly Obstacle[],
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: obstacles.map((o) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [o.lon, o.lat] },
      properties: {
        id: o.id,
        type: o.type,
        height_agl_ft: o.height_agl_ft,
        height_msl_ft: o.height_msl_ft,
      },
    })),
  };
}

function stopsToGeoJSON(
  route: PlannedRoute | null,
): GeoJSON.FeatureCollection {
  if (!route) return { type: "FeatureCollection", features: [] };
  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const leg of route.legs) {
    for (const a of [leg.fromAirport, leg.toAirport]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [a.lon, a.lat] },
        properties: { ident: a.icao ?? a.lid, name: a.name },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export function MapView({ airports, route, obstacles }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: PLACEHOLDER_STYLE,
      center: [-98, 39],
      zoom: 3.5,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      styleReadyRef.current = true;

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

      map.addSource(SRC_OBSTACLES, {
        type: "geojson",
        data: obstaclesToGeoJSON(obstacles),
      });
      map.addLayer({
        id: LAYER_OBSTACLES,
        type: "symbol",
        source: SRC_OBSTACLES,
        layout: {
          "text-field": ["concat", ["get", "height_agl_ft"], "'"],
          "text-size": 10,
          "text-offset": [0, 0.8],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#dc2626",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
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
    });

    return () => {
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
    };
  }, []); // mount-only

  useEffect(() => {
    if (!mapRef.current || !styleReadyRef.current) return;
    (mapRef.current.getSource(SRC_AIRPORTS) as maplibregl.GeoJSONSource)
      ?.setData(airportsToGeoJSON(airports));
  }, [airports]);

  useEffect(() => {
    if (!mapRef.current || !styleReadyRef.current) return;
    (mapRef.current.getSource(SRC_ROUTE) as maplibregl.GeoJSONSource)
      ?.setData(routeToGeoJSON(route));
    (mapRef.current.getSource(SRC_STOPS) as maplibregl.GeoJSONSource)
      ?.setData(stopsToGeoJSON(route));
    (mapRef.current.getSource(SRC_OBSTACLES) as maplibregl.GeoJSONSource)
      ?.setData(obstaclesToGeoJSON(obstacles));
    if (route && route.legs.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const leg of route.legs) {
        bounds.extend([leg.fromAirport.lon, leg.fromAirport.lat]);
        bounds.extend([leg.toAirport.lon, leg.toAirport.lat]);
      }
      mapRef.current.fitBounds(bounds, { padding: 80, duration: 600 });
    }
  }, [route, obstacles]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
