// NOTE: this file lives under ui/ (it's UI-adjacent state, not routing
// math) but stays framework-agnostic on purpose — no React imports —
// so it's trivially unit-testable and could move to engine/ later
// without touching its API.
import type { HardFilters } from "@/engine/filters";
import type { FlightRule } from "@/engine/hemispheric";
import type { RunwaySettings } from "@/engine/runway";

/** Everything about the pilot's inputs that determines what a plan
 *  looks like. Captured right after a successful plan so the app can
 *  later detect that the *displayed* route no longer matches the
 *  *current* inputs (T1 stale-plan detection). Callers should store
 *  `pinnedStopIds` / `excludedIds` as sorted copies so two snapshots
 *  built from the same logical set (in different insertion order)
 *  compare equal. */
export interface PlanSnapshot {
  origin: string;
  destination: string;
  aircraftSlug: string;
  targetAltFt: number;
  reserveMin: number;
  startingFuelGal: number;
  flightRule: FlightRule;
  capLegTime: boolean;
  maxLegHr: number;
  filters: HardFilters;
  runwaySettings: RunwaySettings;
  pinnedStopIds: readonly string[];
  excludedIds: readonly string[];
}

/** Recursively sorts object keys (arrays keep their element order) so
 *  `JSON.stringify` produces the same string regardless of the order
 *  properties were set in. Good enough for the small, flat-ish shapes
 *  here (`HardFilters`, `RunwaySettings`, primitives, string arrays) —
 *  no need for a general-purpose deep-equal library. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortKeysDeep(input[key]);
    }
    return sorted;
  }
  return value;
}

/** Deep-compares two snapshots via sorted-key `JSON.stringify` — the
 *  objects involved are small, so this is simpler and plenty fast
 *  compared to a field-by-field comparator, and it stays correct if
 *  `PlanSnapshot` gains fields later. */
export function snapshotsEqual(a: PlanSnapshot, b: PlanSnapshot): boolean {
  return stableStringify(a) === stableStringify(b);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Human-readable list of what changed between two snapshots, most
 *  significant first — used for the "Inputs changed since this plan"
 *  banner. Callers typically show the first entry plus "and N more". */
export function describePlanDiff(
  prev: PlanSnapshot,
  next: PlanSnapshot,
): string[] {
  const diffs: string[] = [];

  if (prev.targetAltFt !== next.targetAltFt) {
    diffs.push(
      `altitude ${prev.targetAltFt.toLocaleString()} → ${next.targetAltFt.toLocaleString()} ft`,
    );
  }
  if (prev.aircraftSlug !== next.aircraftSlug) {
    diffs.push(`aircraft ${prev.aircraftSlug} → ${next.aircraftSlug}`);
  }
  if (prev.reserveMin !== next.reserveMin) {
    diffs.push(`reserve ${prev.reserveMin} → ${next.reserveMin} min`);
  }
  if (prev.startingFuelGal !== next.startingFuelGal) {
    diffs.push(
      `starting fuel ${prev.startingFuelGal.toLocaleString()} → ${next.startingFuelGal.toLocaleString()} gal`,
    );
  }
  if (prev.flightRule !== next.flightRule) {
    diffs.push(`flight rule ${prev.flightRule} → ${next.flightRule}`);
  }
  if (prev.origin !== next.origin) {
    diffs.push(`origin ${prev.origin} → ${next.origin}`);
  }
  if (prev.destination !== next.destination) {
    diffs.push(`destination ${prev.destination} → ${next.destination}`);
  }
  if (prev.capLegTime !== next.capLegTime) {
    diffs.push(
      `leg-time cap ${prev.capLegTime ? "on" : "off"} → ${next.capLegTime ? "on" : "off"}`,
    );
  } else if (prev.maxLegHr !== next.maxLegHr) {
    diffs.push(`leg-time cap ${prev.maxLegHr} → ${next.maxLegHr} hr`);
  }
  if (stableStringify(prev.filters) !== stableStringify(next.filters)) {
    diffs.push("filters changed");
  }
  if (
    stableStringify(prev.runwaySettings) !== stableStringify(next.runwaySettings)
  ) {
    diffs.push("runway check settings changed");
  }
  if (!arraysEqual(prev.pinnedStopIds, next.pinnedStopIds)) {
    diffs.push("pinned stops changed");
  }
  if (!arraysEqual(prev.excludedIds, next.excludedIds)) {
    diffs.push("excluded airports changed");
  }

  return diffs;
}
