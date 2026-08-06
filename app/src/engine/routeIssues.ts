import type { RunwayFitStatus } from "./runway";
import type { TerrainAnalysis } from "./terrain";
import type { TerminalCorridorWarning } from "./terrainPenalty";

/** A single item in the unified "Route issues" panel. Replaces the
 *  three previously-separate panels (terrain cruise warnings, terminal
 *  corridor warnings, runway-fit warnings) with one sorted list. */
export interface RouteIssue {
  legIndex: number;
  phase: "cruise" | "takeoff" | "landing" | "arrival" | "departure";
  severity: "caution" | "danger";
  /** Airport ident, or a "KGEG→KBOI" pair for a cruise-clearance issue. */
  ident: string;
  message: string;
  /** e.g. `POH cell: 2,556 ft × 15 °C × 2,550 lb` */
  detail?: string;
  action?: { label: string; apply: () => void };
}

/** Moved here from App.tsx — same shape, just relocated so the pure
 *  adapter below (and its tests) don't need to import from the app
 *  shell. */
export interface RunwayLegWarning {
  legIndex: number;
  phase: "takeoff" | "landing";
  ident: string;
  status: RunwayFitStatus;
  required_ft: number;
  available_ft: number;
  buffer_ft: number;
  weight_lb: number;
  /** Field pressure altitude used for the POH lookup (field elevation
   *  as a proxy when altimeter setting isn't known). Echoed so the
   *  pilot can spot-check the chart cell. */
  pressure_alt_ft: number;
  /** OAT used for the POH lookup, in °C. */
  temp_c: number;
}

const SEVERITY_RANK: Record<RouteIssue["severity"], number> = {
  danger: 0,
  caution: 1,
};

/** Adapts terrain cruise warnings + terminal corridor warnings + POH
 *  runway-fit warnings into one flat, sorted `RouteIssue[]`.
 *
 *  Severity mapping:
 *   - terrain cruise-clearance warnings → caution
 *   - terminal corridor warnings (departure/arrival) → caution
 *   - runway fit `tight` → caution, `insufficient` → danger
 *
 *  Sorted danger-before-caution, then by `legIndex` ascending. */
export function collectRouteIssues(input: {
  terrain: TerrainAnalysis | null;
  targetAltFt: number;
  corridor: readonly TerminalCorridorWarning[];
  runway: readonly RunwayLegWarning[];
  /** Attached to terrain cruise issues' `action.apply` when provided
   *  and `analysis.replanTargetFt > targetAltFt`. */
  onReplanAt?: (ft: number) => void;
  /** `TerminalCorridorWarning` doesn't carry a `legIndex` — the caller
   *  can supply an exact mapping (e.g. derived from the selected
   *  route's legs) here. Without it, corridor warnings fall back to
   *  their position in the `corridor` array as a stand-in legIndex;
   *  `terminalCorridorWarnings()` already emits them in leg-traversal
   *  order, so this preserves the intended sort order even without an
   *  exact index. */
  legIndexByIdent?: (ident: string, kind: "departure" | "arrival") => number;
  /** Legs of the selected route, for issues derived from the route
   *  itself rather than from a terrain / runway analysis. */
  legs?: readonly {
    fromIdent: string;
    toIdent: string;
    cruise_alt_ft: number;
    hemisphericConflict?: boolean;
  }[];
}): RouteIssue[] {
  const {
    terrain,
    targetAltFt,
    corridor,
    runway,
    onReplanAt,
    legIndexByIdent,
    legs,
  } = input;
  const issues: RouteIssue[] = [];

  // A leg bent through a nav point can cross the 0/180 course boundary,
  // and odd/even cruising levels are disjoint sets -- so no single
  // altitude is legal on both halves. The router picks the higher one
  // because that is the safe direction for terrain, but the pilot is
  // the one who has to answer for the altitude, so say it plainly
  // rather than let the leg render as though it complies.
  for (const [i, leg] of (legs ?? []).entries()) {
    if (!leg.hemisphericConflict) continue;
    issues.push({
      legIndex: i,
      phase: "cruise",
      severity: "caution",
      ident: `${leg.fromIdent}→${leg.toIdent}`,
      message: `${leg.fromIdent}→${leg.toIdent} turns through the hemispheric boundary — ${leg.cruise_alt_ft.toLocaleString()} ft is legal for part of the leg only`,
      detail: "no single cruising level is legal for both halves",
    });
  }

  if (terrain) {
    const needsReplan = onReplanAt && terrain.replanTargetFt > targetAltFt;
    const replanLabel = `Replan at ${terrain.replanTargetFt.toLocaleString()} ft`;
    for (const w of terrain.warnings) {
      // Zero/negative clearance means the cruise altitude is AT or
      // BELOW the worst sample — not a thin margin but a leg that
      // cannot be flown as planned. Escalate to danger and say so
      // plainly instead of rendering "clears by −1,473 ft".
      const below = w.clearance_ft <= 0;
      issues.push({
        legIndex: w.legIndex,
        phase: "cruise",
        severity: below ? "danger" : "caution",
        ident: `${w.fromIdent}→${w.toIdent}`,
        message: below
          ? `${w.fromIdent}→${w.toIdent} at ${w.cruise_alt_ft.toLocaleString()} ft is ${Math.round(-w.clearance_ft).toLocaleString()} ft BELOW ${w.worst.source_label} — leg is not flyable at this altitude`
          : `${w.fromIdent}→${w.toIdent} at ${w.cruise_alt_ft.toLocaleString()} ft clears ${w.worst.source_label} by only ${Math.round(w.clearance_ft).toLocaleString()} ft`,
        detail: `${Math.round(w.worst.elevation_ft).toLocaleString()} ft MSL`,
        ...(needsReplan
          ? { action: { label: replanLabel, apply: () => onReplanAt!(terrain.replanTargetFt) } }
          : {}),
      });
    }
  }

  corridor.forEach((w, i) => {
    const legIndex = legIndexByIdent ? legIndexByIdent(w.ident, w.kind) : i;
    const profile = w.kind === "departure" ? "climb" : "1,000/3 nm descent";
    issues.push({
      legIndex,
      phase: w.kind,
      severity: "caution",
      ident: w.ident,
      message: `${w.ident} ${w.kind}: terrain ${Math.round(w.shortfall_ft).toLocaleString()} ft above the standard ${profile} profile`,
    });
  });

  for (const w of runway) {
    if (w.status === "ok") continue;
    const severity: RouteIssue["severity"] =
      w.status === "insufficient" ? "danger" : "caution";
    const verb = w.phase === "takeoff" ? "Departure" : "Arrival";
    const verdict = w.status === "insufficient" ? "short" : "tight";
    const wanted = w.required_ft + w.buffer_ft;
    const elevLabel =
      Math.round(w.pressure_alt_ft) === 0
        ? "SL"
        : `${Math.round(w.pressure_alt_ft).toLocaleString()} ft`;
    issues.push({
      legIndex: w.legIndex,
      phase: w.phase,
      severity,
      ident: w.ident,
      message: `${verb} ${w.ident} runway ${verdict}: ${Math.round(w.available_ft).toLocaleString()} ft available vs ${Math.round(wanted).toLocaleString()} ft wanted`,
      detail: `POH cell: ${elevLabel} × ${Math.round(w.temp_c)} °C × ${Math.round(w.weight_lb).toLocaleString()} lb`,
    });
  }

  return issues.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return a.legIndex - b.legIndex;
  });
}
