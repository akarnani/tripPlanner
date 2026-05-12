import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { Airport } from "@/data/loaders";

const PLACEHOLDER_STYLE = "https://demotiles.maplibre.org/style.json";
const SRC = "airports";
const LAYER_TOWERED = "airports-towered";
const LAYER_NONTOWERED = "airports-nontowered";

interface Props {
  airports: readonly Airport[];
}

function toGeoJSON(airports: readonly Airport[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: airports.map((a) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
      properties: {
        id: a.id,
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

export function MapView({ airports }: Props) {
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
      map.addSource(SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_TOWERED,
        type: "circle",
        source: SRC,
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
        source: SRC,
        filter: ["==", ["get", "has_control_tower"], false],
        paint: {
          "circle-radius": 3,
          "circle-color": "#65a30d",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
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
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      src?.setData(toGeoJSON(airports));
    });

    return () => {
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
    };
  }, [airports]);

  useEffect(() => {
    if (!mapRef.current || !styleReadyRef.current) return;
    const src = mapRef.current.getSource(SRC) as
      | maplibregl.GeoJSONSource
      | undefined;
    src?.setData(toGeoJSON(airports));
  }, [airports]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
