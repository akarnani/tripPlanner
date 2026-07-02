import { useEffect, useMemo, useState } from "react";
import type { RouteProfileData } from "@/engine/routeProfile";
import { RouteProfile } from "./RouteProfile";

export interface ViewportBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Subscribe to map viewport changes. Returns an unsubscribe thunk.
 *  Implementations replay the last-known bounds immediately so the dock
 *  windows itself correctly the instant it mounts (before the next
 *  pan). */
export type SubscribeViewport = (
  fn: (b: ViewportBounds) => void,
) => () => void;

interface Props {
  data: RouteProfileData;
  subscribeViewport: SubscribeViewport;
  hoveredLegIndex?: number | null;
  onHoverLeg?: (i: number | null) => void;
  onClose: () => void;
  onZoomAround?: (p: { lat: number; lon: number; deltaZoom: number }) => void;
}

/** Computes the along-track window (nm) covered by the map viewport —
 *  the stretch of route currently on screen, so zooming the map
 *  stretches the profile with it. */
function windowForBounds(
  data: RouteProfileData,
  bounds: ViewportBounds | null,
): { start: number; end: number } {
  if (!bounds) return { start: 0, end: data.totalNm };
  let min = Infinity;
  let max = -Infinity;
  for (const p of data.points) {
    if (
      p.lon >= bounds.west &&
      p.lon <= bounds.east &&
      p.lat >= bounds.south &&
      p.lat <= bounds.north
    ) {
      if (p.distNm < min) min = p.distNm;
      if (p.distNm > max) max = p.distNm;
    }
  }
  // No route in view (panned away) → show the whole thing rather than
  // an empty chart.
  if (!Number.isFinite(min) || max - min < 1) {
    return { start: 0, end: data.totalNm };
  }
  return { start: min, end: max };
}

/** Isolates the map-viewport → profile-window chain into its own leaf so
 *  that panning/zooming the map (a per-animation-frame `move` burst)
 *  re-renders only this dock and the profile SVG — never the App
 *  coordinator, whose full re-render each frame otherwise starves
 *  MapLibre's own rendering and makes the gesture feel laggy. The dock
 *  subscribes to viewport changes directly instead of reading a piece
 *  of App state. */
export function RouteProfileDock({
  data,
  subscribeViewport,
  hoveredLegIndex,
  onHoverLeg,
  onClose,
  onZoomAround,
}: Props) {
  const [bounds, setBounds] = useState<ViewportBounds | null>(null);
  useEffect(() => subscribeViewport(setBounds), [subscribeViewport]);

  const win = useMemo(() => windowForBounds(data, bounds), [data, bounds]);

  return (
    <RouteProfile
      data={data}
      windowStartNm={win.start}
      windowEndNm={win.end}
      hoveredLegIndex={hoveredLegIndex}
      onHoverLeg={onHoverLeg}
      onClose={onClose}
      onZoomAround={onZoomAround}
    />
  );
}
