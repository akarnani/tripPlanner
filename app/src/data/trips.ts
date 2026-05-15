import type { FlightRule } from "@/engine/hemispheric";
import type { HardFilters } from "@/engine/filters";

const STORAGE_KEY = "trip-planner.trips.v1";

/**
 * Everything we round-trip through localStorage when the user saves a
 * trip. Engine-derived state (the planned route itself, terrain
 * analysis, etc.) is intentionally NOT persisted — those rebuild from
 * the inputs in milliseconds and the underlying datasets change cycle
 * to cycle.
 */
export interface SavedTrip {
  name: string;
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
  excludedIds: string[];
  /** Ordered list of airport ids the user has pinned as required
   *  intermediate stops. Loaded as `[]` for trips saved before this
   *  field existed. */
  pinnedStopIds?: string[];
  /** Which planning UI the user was in when they saved. Trips saved
   *  before this field shipped load back into "auto" mode. */
  planningMode?: "auto" | "interactive";
  /** For interactive-mode trips, the ordered chain of intermediate
   *  airport ids the user picked between origin and destination.
   *  Empty / missing means no stops (direct leg). */
  interactiveStopIds?: string[];
  /** For interactive-mode trips, per-leg cruise altitude overrides
   *  parallel to the leg list (origin→stop1, stop1→stop2, …,
   *  lastStop→destination). `null` entries mean "let auto pick".
   *  Length matches `interactiveStopIds.length + 1` when saved. */
  legAltitudes?: (number | null)[];
  /** ISO timestamp of last save. Used for sort + display. */
  savedAt: string;
}

function read(): SavedTrip[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedTrip[];
  } catch {
    // Corrupt JSON or localStorage unavailable — degrade to empty
    // rather than throwing into the React render path.
    return [];
  }
}

function write(trips: SavedTrip[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trips));
  } catch {
    // Storage quota or private-mode failure; silently drop.
  }
}

/** Trips sorted newest-first by savedAt. */
export function listTrips(): SavedTrip[] {
  return read().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Save (or overwrite by name) and return the updated newest-first list. */
export function saveTrip(trip: SavedTrip): SavedTrip[] {
  const trips = read().filter((t) => t.name !== trip.name);
  trips.push(trip);
  write(trips);
  return listTrips();
}

export function deleteTrip(name: string): SavedTrip[] {
  const trips = read().filter((t) => t.name !== name);
  write(trips);
  return listTrips();
}
