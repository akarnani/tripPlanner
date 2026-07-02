import { useEffect, useMemo, useRef, useState } from "react";
import {
  NORMAL_CLIMB_MAX_FT_PER_NM,
  NORMAL_DESCENT_MAX_DEG,
  STANDARD_CLIMB_FT_PER_NM,
} from "@/engine/legProfile";
import type { RouteProfileData } from "@/engine/routeProfile";

interface Props {
  data: RouteProfileData;
  /** Visible along-route window (nm), synced to the map viewport. */
  windowStartNm: number;
  windowEndNm: number;
  hoveredLegIndex?: number | null;
  onHoverLeg?: (i: number | null) => void;
  onClose: () => void;
  /** Fired when the user wheel-zooms over the chart. `lat`/`lon` are the
   *  along-route point under the cursor, so the map zooms around the
   *  spot the pilot is actually looking at instead of its own center. */
  onZoomAround?: (p: { lat: number; lon: number; deltaZoom: number }) => void;
}

// The chart's geometry lives in ROUTE-DATA coordinates: x is distance
// along the route in nm, y is negated altitude in feet (negated so "up"
// on screen is higher altitude — SVG's y grows downward). The full
// route is drawn ONCE in this space; panning/zooming the map only moves
// the SVG `viewBox` over it (see `viewBox` below), which the browser
// re-rasterizes on its own — no path strings are rebuilt and React
// writes no path DOM per frame. `preserveAspectRatio="none"` stretches
// the window to the panel, so all strokes use vector-effect:
// non-scaling-stroke and all text lives in HTML overlays.

type Pt = [number, number];

// Full chart height in y (feet) always spans far more than any real
// route, so vertical rules/bands drawn to these extents fill the panel
// at any viewBox and get clipped by it rather than falling short.
const Y_FLOOR = 1_000_000; // screen-down extent (y = -ft, so +y is down)
const Y_CEIL = -1_000_000; // screen-up extent

const FT_PER_NM = 6076.12;
/** Converts a glidepath angle in degrees to a gradient in ft/nm. */
function degToFtPerNm(deg: number): number {
  return Math.tan((deg * Math.PI) / 180) * FT_PER_NM;
}

/** ~7.2 px per mono char over a conservative ~1,000 px panel width. */
const LABEL_CHAR_FRAC = 7.2 / 1000;

/** A callout that carries enough to lay itself out: where it sits and
 *  how wide its text is. */
export interface StackableLabel {
  nm: number;
  text: string;
  row: number;
}

/** The clamped center fraction (0..1) a label renders at — center of
 *  its chip, pushed off the panel edges so a wide chip never clips. */
export function labelCenterFrac(
  text: string,
  nm: number,
  winStart: number,
  winEnd: number,
): number {
  const span = Math.max(1e-6, winEnd - winStart);
  const half = Math.min(0.45, (text.length * LABEL_CHAR_FRAC) / 2) + 0.01;
  const raw = (nm - winStart) / span;
  return Math.min(1 - half, Math.max(half, raw));
}

/** Assigns each label a `row` (mutating in place) so that no two labels
 *  on the same row overlap horizontally. Overlap is judged by each
 *  label's ESTIMATED pixel span (chars × mono width), not a fixed nm
 *  gap — the callouts vary a lot in length, so one gap either
 *  over-stacks the short ones or lets the long ones collide (the bug
 *  this replaces). Greedy first-fit over [lo, hi] fraction intervals,
 *  using the same clamped center the renderer draws at so the layout
 *  the packer reasons about matches the pixels. */
export function assignLabelRows(
  labels: StackableLabel[],
  winStart: number,
  winEnd: number,
): void {
  labels.sort((a, b) => a.nm - b.nm);
  const rows: Array<Array<[number, number]>> = [];
  for (const l of labels) {
    const center = labelCenterFrac(l.text, l.nm, winStart, winEnd);
    const half = Math.min(0.45, (l.text.length * LABEL_CHAR_FRAC) / 2) + 0.01;
    const lo = center - half;
    const hi = center + half;
    let row = 0;
    while (rows[row] && rows[row].some(([a, b]) => lo < b && hi > a)) {
      row++;
    }
    (rows[row] ??= []).push([lo, hi]);
    l.row = row;
  }
}

/** Fixed aviation-reference gradient bands — what a "normal" arrival
 *  or departure looks like, independent of aircraft or terrain:
 *  descents 3–3.5° (≈318–372 ft/nm; the standard 1,000 ft / 3 nm
 *  glidepath is ≈3.1°), climbs 200–400 ft/nm (the 200 ft/nm standard
 *  IFR departure gradient up to a healthy GA climb). A path outside
 *  the band is the "terrain is driving this" signal. */
const DESCENT_BAND_FT_PER_NM: [number, number] = [
  degToFtPerNm(3),
  degToFtPerNm(NORMAL_DESCENT_MAX_DEG),
];
const CLIMB_BAND_FT_PER_NM: [number, number] = [200, NORMAL_CLIMB_MAX_FT_PER_NM];

/** Builds a normal-gradient reference band looking out from a field:
 *  a wedge with its apex at (apexNm, apexElevFt), bounded below by
 *  the band's gentle-edge ray and above by its steep-edge ray, both
 *  truncated where they reach `topAltFt`. `dir` is +1 to point the
 *  band forward (climb, out of a departure field) or -1 to point it
 *  backward (descent, into an arrival field). Returns null when
 *  there's no meaningful climb/descent to show (the field is already
 *  at `topAltFt`). */
function gradientBand(
  apexNm: number,
  apexElevFt: number,
  [gentleFtPerNm, steepFtPerNm]: [number, number],
  topAltFt: number,
  dir: 1 | -1,
): Pt[] | null {
  const rise = topAltFt - apexElevFt;
  if (rise <= 0) return null;
  const lowerNm = apexNm + dir * (rise / gentleFtPerNm);
  const upperNm = apexNm + dir * (rise / steepFtPerNm);
  return [
    [apexNm, apexElevFt],
    [lowerNm, topAltFt],
    [upperNm, topAltFt],
  ];
}

/** Full-route vertical profile docked over the lower part of the map
 *  (T-profile). The x-domain follows the map viewport: zoom the map
 *  into a leg and the profile stretches to match, so climb/descent
 *  gradients read at their true proportions instead of as cliffs.
 *  Shaded bands emanating from each airport mark the standard climb /
 *  descent gradient regions (see `gradientBand`); caution/danger bands
 *  mark thin terrain margins. */
export function RouteProfile({
  data,
  windowStartNm,
  windowEndNm,
  hoveredLegIndex,
  onHoverLeg,
  onClose,
  onZoomAround,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);

  const win = useMemo(() => {
    let start = Math.max(0, Math.min(windowStartNm, data.totalNm));
    let end = Math.max(0, Math.min(windowEndNm, data.totalNm));
    if (end - start < 2) {
      // Degenerate window (extreme zoom-in or no route in view):
      // pad around the center so the chart never collapses.
      const mid = (start + end) / 2;
      start = Math.max(0, mid - 1);
      end = Math.min(data.totalNm, mid + 1);
    }
    return { start, end };
  }, [windowStartNm, windowEndNm, data.totalNm]);

  // Fixed full-route geometry, built ONCE per plan (and per hovered
  // leg). Every path is emitted in route-data coordinates and never
  // regenerated on a pan/zoom — that's what the viewBox is for. This
  // is the entire point of the architecture: the old code rebuilt all
  // of these strings on every viewport frame, which is what made
  // panning sluggish.
  const geom = useMemo(() => {
    const pts = data.points;
    const Y = (ft: number) => -ft;

    // Global vertical extent, used as the closing floor for the terrain
    // silhouette and gradient-band fills (a fixed floor keeps their
    // geometry static; the viewBox clips whatever isn't on screen).
    let gMin = Infinity;
    let gMax = -Infinity;
    for (const p of pts) {
      if (p.profileFt < gMin) gMin = p.profileFt;
      if (p.profileFt > gMax) gMax = p.profileFt;
      if (p.terrainFt !== null) {
        if (p.terrainFt < gMin) gMin = p.terrainFt;
        if (p.terrainFt > gMax) gMax = p.terrainFt;
      }
    }
    if (!Number.isFinite(gMin)) {
      gMin = 0;
      gMax = 1000;
    }
    const floorFt = gMin - Math.max(50, (gMax - gMin) * 0.05);

    const profilePath = pts
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${p.distNm.toFixed(2)},${Y(p.profileFt).toFixed(1)}`,
      )
      .join("");

    let terrain = "";
    let firstTd = 0;
    let lastTd = 0;
    let anyTerrain = false;
    for (const p of pts) {
      if (p.terrainFt === null) continue;
      if (!anyTerrain) {
        firstTd = p.distNm;
        anyTerrain = true;
      }
      lastTd = p.distNm;
      terrain += `${terrain ? "L" : "M"}${p.distNm.toFixed(2)},${Y(p.terrainFt).toFixed(1)}`;
    }
    const terrainPath = anyTerrain
      ? `${terrain}L${lastTd.toFixed(2)},${Y(floorFt).toFixed(1)}L${firstTd.toFixed(2)},${Y(floorFt).toFixed(1)}Z`
      : "";

    // Climb / descent gradient reference BANDS, one pair per leg
    // segment — the wedge between the fixed aviation-reference
    // gradients truncated at the altitude actually reached. Drawn full;
    // the viewBox does the clipping a zoomed map used to need explicit
    // polygon clipping for.
    const bands: Array<{ fill: string; edge: string }> = [];
    for (const s of data.segments) {
      const quads: Pt[][] = [
        gradientBand(s.startNm, s.startElevFt, CLIMB_BAND_FT_PER_NM, s.topAltFt, 1),
        gradientBand(s.endNm, s.endElevFt, DESCENT_BAND_FT_PER_NM, s.topAltFt, -1),
      ].filter((q): q is Pt[] => q !== null);
      for (const quad of quads) {
        const fill =
          quad
            .map(
              ([x, y], i) =>
                `${i === 0 ? "M" : "L"}${x.toFixed(2)},${Y(y).toFixed(1)}`,
            )
            .join("") + "Z";
        // Lower (standard-gradient) edge is quad[0]→quad[1] — the
        // reference pilots compare terrain against. Upper edge is
        // fill-only.
        const edge = `M${quad[0][0].toFixed(2)},${Y(quad[0][1]).toFixed(1)}L${quad[1][0].toFixed(2)},${Y(quad[1][1]).toFixed(1)}`;
        bands.push({ fill, edge });
      }
    }

    // Hovered-leg emphasis: re-stroke that leg's slice of the profile.
    let hoverLegPath = "";
    if (hoveredLegIndex !== null && hoveredLegIndex !== undefined) {
      hoverLegPath = pts
        .filter((p) => p.legIndex === hoveredLegIndex)
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"}${p.distNm.toFixed(2)},${Y(p.profileFt).toFixed(1)}`,
        )
        .join("");
    }

    return { profilePath, terrainPath, bands, hoverLegPath, gMin, gMax };
  }, [data, hoveredLegIndex]);

  // The viewBox over the fixed geometry: x follows the map window, y
  // auto-fits to the altitudes visible in that window (so zooming into
  // a leg expands the vertical axis, same as before). Recomputing this
  // per frame is cheap — a handful of min/max comparisons and four
  // numbers — versus rebuilding every path string.
  const viewBox = useMemo(() => {
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const p of data.points) {
      if (p.distNm < win.start || p.distNm > win.end) continue;
      if (p.profileFt < vMin) vMin = p.profileFt;
      if (p.profileFt > vMax) vMax = p.profileFt;
      if (p.terrainFt !== null) {
        if (p.terrainFt < vMin) vMin = p.terrainFt;
        if (p.terrainFt > vMax) vMax = p.terrainFt;
      }
    }
    if (!Number.isFinite(vMin)) {
      vMin = geom.gMin;
      vMax = geom.gMax;
    }
    const span = Math.max(1, vMax - vMin);
    const top = vMax + span * 0.12; // headroom above the peak
    const bottom = vMin - span * 0.04; // a little ground below the low
    const x = win.start;
    const w = Math.max(1e-6, win.end - win.start);
    const y = -top; // y grows down; top altitude is the most-negative y
    const h = Math.max(1, top - bottom);
    return `${x} ${y} ${w} ${h}`;
  }, [data.points, win, geom.gMin, geom.gMax]);

  // Terrain-alert callouts, computed from the segments intersecting the
  // window (see the tiers described below). Cheap — a few segments.
  const gradientLabels = useMemo(() => {
    // Gradient callouts flag where TERRAIN forces a steeper-than-standard
    // gradient — keyed off the raw terrain demand (built on the TERPS
    // 40:1 clearance ramp), not the aircraft's own climb, so a naturally
    // steep climber doesn't trip them on flat ground. Three tiers:
    //  · climb, terrain > the standard 200 ft/nm departure gradient but
    //    within the aircraft's POH climb → amber caution.
    //  · climb, terrain > the aircraft's POH climb → red danger.
    //  · descent, terrain steeper than the 3.5° band → amber caution.
    const labels: Array<{
      nm: number;
      text: string;
      tone: "caution" | "danger";
      row: number;
    }> = [];
    for (const s of data.segments) {
      const climbInView = s.topOfClimbNm >= win.start && s.startNm <= win.end;
      if (climbInView) {
        const req = s.climb.terrainReqFtPerNm;
        const cap = s.climb.stdFtPerNm;
        if (req > cap * 1.02) {
          labels.push({
            nm: s.topOfClimbNm,
            text: `terrain needs ${Math.round(req)} ft/nm — steeper than this aircraft climbs (${Math.round(cap)} ft/nm)`,
            tone: "danger",
            row: 0,
          });
        } else if (req > STANDARD_CLIMB_FT_PER_NM) {
          labels.push({
            nm: s.topOfClimbNm,
            text: `${Math.round(req)} ft/nm climb — over standard`,
            tone: "caution",
            row: 0,
          });
        }
      }
      const descentInView = s.topOfDescentNm <= win.end && s.endNm >= win.start;
      if (
        s.descent.terrainReqFtPerNm > DESCENT_BAND_FT_PER_NM[1] * 1.02 &&
        descentInView
      ) {
        const deg =
          (Math.atan(s.descent.terrainReqFtPerNm / FT_PER_NM) * 180) / Math.PI;
        labels.push({
          nm: s.topOfDescentNm,
          text: `${deg.toFixed(1)}° descent — terrain`,
          tone: "caution",
          row: 0,
        });
      }
    }
    assignLabelRows(labels, win.start, win.end);
    return labels;
  }, [data.segments, win]);

  const hover = hoverIdx !== null ? data.points[hoverIdx] : null;
  const hoverClearance =
    hover && hover.terrainFt !== null ? hover.profileFt - hover.terrainFt : null;

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const d = win.start + frac * (win.end - win.start);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < data.points.length; i++) {
      const dd = Math.abs(data.points[i].distNm - d);
      if (dd < bestDist) {
        bestDist = dd;
        best = i;
      }
    }
    setHoverIdx(best);
    onHoverLeg?.(data.points[best]?.legIndex ?? null);
  }

  // Refs so the wheel listener (attached once, non-passive) always
  // reads the latest window/points/callback without having to tear
  // down and re-attach on every render.
  const winRef = useRef(win);
  winRef.current = win;
  const ptsRef = useRef(data.points);
  ptsRef.current = data.points;
  const onZoomAroundRef = useRef(onZoomAround);
  onZoomAroundRef.current = onZoomAround;

  // React's synthetic onWheel can't reliably preventDefault (passive
  // listener warnings / no-ops in some browsers), so the page-scroll
  // guard has to be a real addEventListener with { passive: false }.
  // Scrolling over the profile must always stay on the profile, even
  // before a consumer wires onZoomAround.
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const w = winRef.current;
      const rect = el!.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      const d = w.start + frac * (w.end - w.start);
      const pts = ptsRef.current;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dd = Math.abs(pts[i].distNm - d);
        if (dd < bestDist) {
          bestDist = dd;
          best = i;
        }
      }
      const pt = pts[best];
      const cb = onZoomAroundRef.current;
      if (!pt || !cb) return;
      const deltaZoom = Math.max(-0.6, Math.min(0.6, -e.deltaY * 0.0025));
      cb({ lat: pt.lat, lon: pt.lon, deltaZoom });
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const visibleAirports = data.airports.filter(
    (a) => a.distNm >= win.start - 0.1 && a.distNm <= win.end + 0.1,
  );

  return (
    <div
      data-testid="route-profile"
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-10 flex h-[28%] min-h-[150px] flex-col border-t border-hairline bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-1">
        <span className="text-xs font-semibold text-ink">Route profile</span>
        <span className="flex-1 truncate text-right font-mono text-xs text-ink">
          {hover ? (
            <>
              {Math.round(hover.distNm)} nm ·{" "}
              {Math.round(hover.profileFt).toLocaleString()} ft
              {hoverClearance !== null && (
                <span
                  style={{
                    color:
                      hoverClearance <= 0
                        ? "var(--danger)"
                        : hoverClearance < 2000
                          ? "var(--caution)"
                          : "var(--ok)",
                  }}
                >
                  {" "}
                  {hoverClearance >= 0 ? "+" : "−"}
                  {Math.abs(Math.round(hoverClearance)).toLocaleString()} ft over
                  terrain
                </span>
              )}
            </>
          ) : (
            <span className="text-muted">
              {Math.round(win.start)}–{Math.round(win.end)} nm of{" "}
              {Math.round(data.totalNm)} nm · zoom the map to stretch the
              profile
            </span>
          )}
        </span>
        <button
          type="button"
          aria-label="Close route profile"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:text-ink"
        >
          ×
        </button>
      </div>
      <div ref={chartRef} className="relative flex-1">
        <svg
          viewBox={viewBox}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Route altitude profile, ${Math.round(data.totalNm)} nm`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => {
            setHoverIdx(null);
            onHoverLeg?.(null);
          }}
        >
          {data.spans.map((s, i) => (
            <rect
              key={i}
              x={s.startNm}
              y={Y_CEIL}
              width={Math.max(1e-4, s.endNm - s.startNm)}
              height={Y_FLOOR - Y_CEIL}
              style={{
                fill: s.kind === "danger" ? "var(--danger)" : "var(--caution)",
              }}
              fillOpacity={0.16}
            />
          ))}
          {/* Standard climb / descent gradient bands, emanating from
              each airport point up to the altitude actually reached —
              lets a pilot compare terrain (and the required-gradient
              path) against the normal gradient at a glance. Rendered
              *under* the terrain silhouette below so a band visibly
              disappears behind rising ground instead of shining
              through it. Dashed edge re-states the standard-gradient
              slope even where the low-opacity fill is subtle. */}
          {geom.bands.map((b, i) => (
            <g key={i}>
              <path d={b.fill} style={{ fill: "var(--data)" }} fillOpacity={0.12} />
              {b.edge && (
                <path
                  d={b.edge}
                  fill="none"
                  stroke="var(--data)"
                  strokeOpacity={0.5}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          ))}
          {geom.terrainPath && (
            <path
              d={geom.terrainPath}
              style={{ fill: "var(--olive)" }}
              fillOpacity={0.85}
              stroke="var(--olive)"
              strokeOpacity={0.7}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={geom.profilePath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {geom.hoverLegPath && (
            <path
              d={geom.hoverLegPath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={3.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {data.airports.map((a) => (
            <line
              key={`${a.ident}-${a.distNm}`}
              x1={a.distNm}
              x2={a.distNm}
              y1={Y_CEIL}
              y2={Y_FLOOR}
              stroke="var(--muted)"
              strokeOpacity={0.45}
              strokeDasharray="2 3"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hover && (
            <line
              x1={hover.distNm}
              x2={hover.distNm}
              y1={Y_CEIL}
              y2={Y_FLOOR}
              stroke="var(--muted)"
              strokeOpacity={0.7}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {/* Airport labels as HTML so the stretched SVG never distorts
            text. */}
        {visibleAirports.map((a) => (
          <span
            key={`${a.ident}-${a.distNm}`}
            style={{
              left: `${((a.distNm - win.start) / Math.max(1e-6, win.end - win.start)) * 100}%`,
            }}
            className="pointer-events-none absolute top-0.5 -translate-x-1/2 rounded bg-card/80 px-1 font-mono text-xs text-muted"
          >
            {a.ident}
          </span>
        ))}
        {/* Terrain-alert callouts (red = un-climbable terrain, amber =
            steeper than standard / steep descent). Overlapping ones
            stack into rows (width-aware, computed above). Center-
            anchored, with the center clamped so the chip never clips off
            a panel edge — matching the box model the stacking uses. */}
        {gradientLabels.map((l, i) => {
          const pct = labelCenterFrac(l.text, l.nm, win.start, win.end) * 100;
          return (
            <span
              key={i}
              style={{
                left: `${pct}%`,
                transform: "translateX(-50%)",
                // 1.5rem base offset (below the ident row) + one row per
                // horizontal-collision level.
                top: `${1.5 + l.row * 1.4}rem`,
                color: l.tone === "danger" ? "var(--danger)" : "var(--caution)",
              }}
              className="pointer-events-none absolute max-w-[60%] truncate rounded border border-hairline bg-card px-1.5 py-0.5 font-mono text-xs shadow-sm"
              title={l.text}
            >
              {l.text}
            </span>
          );
        })}
      </div>
      <p className="border-t border-hairline px-3 py-0.5 text-xs text-muted">
        Blue bands = normal gradients from each field (climb 200–400
        ft/nm · descent 3–3.5°). Callouts flag terrain that forces
        steeper than a standard 200 ft/nm departure (TERPS 40:1) —
        amber = steeper than standard / a steep descent, red = steeper
        than the aircraft can climb. Amber/red vertical bands = thin
        terrain margin.
      </p>
    </div>
  );
}
