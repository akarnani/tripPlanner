import type { Airport } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import type { LegAltitudeOverride } from "@/engine/interactive";
import type { InteractiveCandidate } from "@/engine/candidates";
import { AirportLink } from "./AirportLink";

interface Props {
  /** Origin airport identifier (display purposes). */
  originIdent: string;
  /** Destination airport identifier (display purposes). */
  destinationIdent: string;
  /** User-chosen intermediate stops, in order. Empty when nothing's
   *  been clicked yet. */
  stops: readonly Airport[];
  /** The computed route currently rendered on the map. Used to read
   *  per-leg distance / time / fuel / altitude back from the engine. */
  route: PlannedRoute | null;
  /** Per-leg altitude overrides, parallel to `route.legs`. `null` or
   *  `undefined` means "let the hemispheric rule pick". */
  legAltitudes: readonly LegAltitudeOverride[];
  /** Per-leg feasibility flags from the engine. `false` means the
   *  leg burns into the configured reserve and the UI surfaces it
   *  as a warning row. */
  legFeasibility: readonly boolean[];
  /** Per-stop refuel flags. `stopRefuels[i]` is true when the
   *  airport at `stops[i]` sells compatible fuel — i.e. the route
   *  refuels there. `false` is a pass-through; the next leg's fuel
   *  carries over from this leg's arrival fuel and the UI flags it. */
  stopRefuels: readonly boolean[];
  /** Distance from the current departure point (last stop or origin
   *  if no stops yet) to the destination, in nm. */
  distanceToDestNm: number;
  /** Solid (with-reserve) ring radius in nm at the current departure. */
  rangeSolidNm: number;
  /** Dashed (no-reserve) ring radius in nm at the current departure. */
  rangeDashedNm: number;
  /** True when the destination falls inside the solid (safe) ring,
   *  meaning the trip can finish on the current tank. */
  destInRange: boolean;
  /** Highest altitude the selected aircraft's POH cruise table
   *  publishes. Caps the per-leg altitude dropdown so the pilot
   *  can't pick a level the engine has no data for. */
  cruiseCeilingFt: number;
  onRemoveStop: (stopIndex: number) => void;
  onChangeLegAltitude: (legIndex: number, altFt: number | null) => void;
  onExit: () => void;
  /** Ranked airports near the current track, nearest-detour first.
   *  Omit (or pass an empty list) to hide the candidate section. */
  candidates?: readonly InteractiveCandidate[];
  onSelectCandidate?: (ident: string) => void;
  onHoverCandidate?: (ident: string | null) => void;
  /** Selected aircraft's fuel type — labels the fuel chip. */
  aircraftFuelType?: string;
}

/** Cruise altitude options offered in the per-leg dropdown. Below
 *  FL180 the typical VFR/IFR+500 levels; from FL180 up — Class A
 *  airspace, no +500 convention — every 1,000 ft to FL310, which
 *  covers the highest published cruise altitude across all current
 *  aircraft (SF50 to 28,000 ft / FL280). The dropdown is a
 *  convenience: the engine accepts any altitude the pilot picks. */
const ALT_OPTIONS = [
  3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500, 12500, 13500, 14500,
  15500, 16500, 17500,
  18000, 19000, 20000, 21000, 22000, 23000, 24000, 25000, 26000, 27000, 28000,
  29000, 30000, 31000,
];

function fmtNm(nm: number): string {
  return `${Math.round(nm).toLocaleString()} nm`;
}

function fmtFt(ft: number): string {
  return `${Math.round(ft).toLocaleString()} ft`;
}

export function InteractivePanel({
  originIdent,
  destinationIdent,
  stops,
  route,
  legAltitudes,
  legFeasibility,
  stopRefuels,
  distanceToDestNm,
  rangeSolidNm,
  rangeDashedNm,
  destInRange,
  cruiseCeilingFt,
  onRemoveStop,
  onChangeLegAltitude,
  onExit,
  candidates,
  onSelectCandidate,
  onHoverCandidate,
  aircraftFuelType,
}: Props) {
  const legs = route?.legs ?? [];
  const lastStopIdent =
    stops.length > 0
      ? (stops[stops.length - 1].icao ?? stops[stops.length - 1].lid)
      : originIdent;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink">
          Interactive build
        </span>
        <button
          type="button"
          onClick={onExit}
          className="text-xs text-muted underline hover:text-ink"
        >
          Switch to auto plan
        </button>
      </div>
      <p className="text-xs text-muted">
        Click any airport on the map to add it as the next stop. Each
        stop is assumed to be a refuel stop (next tank full). The
        rings show your range from the current departure point — solid
        is with reserves, dashed is everything in the tank.
      </p>
      <div className="rounded border border-hairline bg-card">
        <RouteRow
          label="From"
          ident={originIdent}
          isStart
          onRemove={undefined}
        />
        {stops.map((stop, i) => (
          <LegAndStop
            key={`${stop.id}-${i}`}
            leg={legs[i]}
            stopIdent={stop.icao ?? stop.lid}
            altFt={legAltitudes[i] ?? legs[i]?.cruise_alt_ft ?? null}
            isOverride={legAltitudes[i] !== null && legAltitudes[i] !== undefined}
            defaultAltFt={legs[i]?.cruise_alt_ft}
            feasible={legFeasibility[i] ?? true}
            refuels={stopRefuels[i] ?? true}
            cruiseCeilingFt={cruiseCeilingFt}
            onAltitudeChange={(alt) => onChangeLegAltitude(i, alt)}
            onRemove={() => onRemoveStop(i)}
          />
        ))}
        <LegAndStop
          // The closing leg → destination. legIndex = stops.length.
          leg={legs[stops.length]}
          stopIdent={destinationIdent}
          altFt={
            legAltitudes[stops.length] ??
            legs[stops.length]?.cruise_alt_ft ??
            null
          }
          isOverride={
            legAltitudes[stops.length] !== null &&
            legAltitudes[stops.length] !== undefined
          }
          defaultAltFt={legs[stops.length]?.cruise_alt_ft}
          feasible={legFeasibility[stops.length] ?? true}
          cruiseCeilingFt={cruiseCeilingFt}
          onAltitudeChange={(alt) => onChangeLegAltitude(stops.length, alt)}
          onRemove={undefined}
          isDestination
          destInRange={destInRange}
        />
      </div>
      <div className="rounded border border-hairline bg-surface p-2 text-xs text-ink">
        <div>
          <span className="text-muted">To destination from here:</span>{" "}
          <span className="whitespace-nowrap font-mono font-medium">
            {fmtNm(distanceToDestNm)}
          </span>
        </div>
        <div>
          <span className="text-muted">Range from here:</span>{" "}
          <span className="whitespace-nowrap font-mono font-medium">
            {fmtNm(rangeSolidNm)}
          </span>{" "}
          with reserve ·{" "}
          <span className="whitespace-nowrap font-mono">
            {fmtNm(rangeDashedNm)}
          </span>{" "}
          total
        </div>
      </div>
      {candidates && candidates.length > 0 && (
        <div>
          <div className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-muted">
            Candidates near track
          </div>
          <p className="mb-2 text-xs text-muted">
            From {lastStopIdent}, sorted by detour · click to add as next
            stop
          </p>
          <div className="rounded border border-hairline bg-card">
            {candidates.map((c) => (
              <CandidateRow
                key={c.airport.id}
                candidate={c}
                aircraftFuelType={aircraftFuelType}
                onSelect={() =>
                  onSelectCandidate?.(c.airport.icao ?? c.airport.lid)
                }
                onHover={(hovering) =>
                  onHoverCandidate?.(
                    hovering ? (c.airport.icao ?? c.airport.lid) : null,
                  )
                }
              />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Hovering a row highlights the airport on the map.
          </p>
        </div>
      )}
    </div>
  );
}

interface RouteRowProps {
  label: string;
  ident: string;
  isStart?: boolean;
  onRemove?: () => void;
}

function RouteRow({ label, ident, isStart, onRemove }: RouteRowProps) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span
        className={
          "inline-block h-2 w-2 rounded-full " +
          (isStart ? "bg-ink" : "bg-accent")
        }
      />
      <span className="text-xs uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="font-mono text-xs font-semibold text-ink">
        {ident}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label="Remove stop"
          onClick={onRemove}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center text-muted hover:text-danger"
        >
          ×
        </button>
      )}
    </div>
  );
}

interface LegAndStopProps {
  leg: PlannedRoute["legs"][number] | undefined;
  stopIdent: string;
  altFt: number | null;
  isOverride: boolean;
  defaultAltFt: number | undefined;
  feasible: boolean;
  /** True when this stop is a refuel (airport sells compatible fuel).
   *  False means pass-through — the UI shows a "no fuel" warning so
   *  the pilot knows the next leg's range is reduced. The destination
   *  doesn't pass this prop; only intermediate stops do. */
  refuels?: boolean;
  /** Highest published cruise altitude in the aircraft's POH —
   *  options above this are hidden so the pilot can't pick a level
   *  the engine has no data for. */
  cruiseCeilingFt: number;
  onAltitudeChange: (altFt: number | null) => void;
  onRemove?: () => void;
  isDestination?: boolean;
  destInRange?: boolean;
}

function LegAndStop({
  leg,
  stopIdent,
  altFt,
  isOverride,
  defaultAltFt,
  feasible,
  refuels,
  cruiseCeilingFt,
  onAltitudeChange,
  onRemove,
  isDestination,
  destInRange,
}: LegAndStopProps) {
  // Build the dropdown options. Filter the canonical list to
  // altitudes the aircraft's POH actually covers, then merge in
  // the current selection / default so they remain selectable
  // even if outside the canonical set.
  const allowed = ALT_OPTIONS.filter((a) => a <= cruiseCeilingFt);
  const seen = new Set(allowed);
  const opts = [...allowed];
  if (altFt !== null && !seen.has(altFt)) {
    opts.push(altFt);
    seen.add(altFt);
  }
  if (defaultAltFt !== undefined && !seen.has(defaultAltFt)) {
    opts.push(defaultAltFt);
  }
  opts.sort((a, b) => a - b);

  return (
    <>
      {leg && (
        <div className="border-t border-hairline px-2 py-1.5 text-xs text-ink">
          {/* flex-wrap: metrics + the altitude control don't reliably
              fit one 248px line (six-digit altitudes, "custom" tag) —
              rather than clipping the select at the sidebar edge, the
              control drops to its own right-aligned line. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-muted">↓</span>
            <span className="whitespace-nowrap font-mono">
              {fmtNm(leg.distance_nm)}
            </span>
            <span className="text-muted">·</span>
            <span className="whitespace-nowrap font-mono">
              {leg.time_hr.toFixed(1)} hr
            </span>
            <span className="text-muted">·</span>
            <span className="whitespace-nowrap font-mono">
              {leg.fuel_gal.toFixed(1)} gal
            </span>
            <span className="ml-auto flex items-center gap-1">
              {isOverride && (
                <span className="rounded-full border border-accent px-1.5 py-0 text-xs font-medium text-accent">
                  custom
                </span>
              )}
              <select
                value={altFt ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onAltitudeChange(v === "" ? null : Number.parseInt(v, 10));
                }}
                className={
                  "rounded border bg-card px-1 py-0.5 text-xs font-mono text-ink " +
                  (isOverride ? "border-accent" : "border-hairline-input")
                }
                title={
                  isOverride
                    ? "Custom altitude; click hemispheric option to revert"
                    : "Hemispheric default — pick another to override"
                }
              >
                <option value="">auto</option>
                {opts.map((alt) => (
                  <option key={alt} value={alt}>
                    {fmtFt(alt)}
                  </option>
                ))}
              </select>
            </span>
          </div>
          {!feasible && (
            <div className="mt-1 text-xs text-danger">
              ⚠ Burns through reserve at this altitude / starting fuel.
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-hairline px-2 py-1.5">
        <span
          className={
            "inline-block h-2 w-2 rounded-full " +
            (isDestination ? "bg-ink" : "bg-accent")
          }
        />
        <span className="text-xs uppercase tracking-wide text-muted">
          {isDestination ? "To" : "Stop"}
        </span>
        <span className="font-mono text-xs font-semibold text-ink">
          <AirportLink ident={stopIdent} />
        </span>
        {isDestination && destInRange && (
          <span className="text-xs font-medium text-ok">
            in range ✓
          </span>
        )}
        {!isDestination && refuels === false && (
          <span
            className="text-xs font-medium text-caution"
            title="Airport does not stock the aircraft's fuel type. The next leg departs on whatever fuel remains."
          >
            no fuel · pass-through
          </span>
        )}
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove stop ${stopIdent}`}
            onClick={onRemove}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center text-muted hover:text-danger"
          >
            ×
          </button>
        )}
      </div>
    </>
  );
}

interface Chip {
  text: string;
  tone: "ok" | "caution" | "neutral";
}

/** Build the chip set for one candidate: range margin, fuel
 *  availability, and any terrain shortfall — same three facts the
 *  hover popup already surfaces, just laid out for comparison. */
function candidateChips(
  c: InteractiveCandidate,
  aircraftFuelType: string | undefined,
): Chip[] {
  const chips: Chip[] = [];
  if (c.rangeStatus === "in") {
    chips.push({
      text: `in range · ${Math.round(c.spareNm)} nm spare`,
      tone: "ok",
    });
  } else if (c.rangeStatus === "past-reserve") {
    chips.push({
      text: `past reserve by ${Math.round(c.spareNm)} nm`,
      tone: "caution",
    });
  } else {
    chips.push({ text: "out of range", tone: "caution" });
  }
  chips.push(
    c.sellsFuel
      ? { text: aircraftFuelType ?? "fuel", tone: "neutral" }
      : { text: "no fuel", tone: "caution" },
  );
  if (c.arrivalShortfallFt > 0) {
    chips.push({
      text: `terrain +${Math.round(c.arrivalShortfallFt).toLocaleString()} ft on arrival`,
      tone: "caution",
    });
  }
  if (c.departureShortfallFt > 0) {
    chips.push({
      text: `terrain +${Math.round(c.departureShortfallFt).toLocaleString()} ft on departure`,
      tone: "caution",
    });
  }
  return chips;
}

function chipClass(tone: Chip["tone"]): string {
  if (tone === "ok") {
    return "border border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] text-ok";
  }
  if (tone === "caution") {
    return "border border-[color-mix(in_srgb,var(--caution)_35%,transparent)] bg-[color-mix(in_srgb,var(--caution)_10%,transparent)] text-caution";
  }
  return "border border-hairline bg-surface text-muted";
}

interface CandidateRowProps {
  candidate: InteractiveCandidate;
  aircraftFuelType?: string;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
}

function CandidateRow({
  candidate,
  aircraftFuelType,
  onSelect,
  onHover,
}: CandidateRowProps) {
  const ident = candidate.airport.icao ?? candidate.airport.lid;
  const chips = candidateChips(candidate, aircraftFuelType);
  const worst = chips.some((c) => c.tone === "caution") ? "caution" : "ok";
  return (
    <div className="border-t border-hairline first:border-t-0">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        className={
          "cursor-pointer border-l-2 px-2.5 py-2 " +
          (worst === "caution" ? "border-l-caution" : "border-l-ok")
        }
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-sm font-semibold text-ink">
            <AirportLink ident={ident} />
          </span>
          <span className="shrink-0 text-xs text-muted">
            +{Math.round(candidate.detourNm)} nm detour
          </span>
        </div>
        <div className="my-0.5 text-xs text-muted">
          {candidate.airport.name}
        </div>
        <div className="flex flex-wrap gap-1">
          {chips.map((chip, i) => (
            <span
              key={i}
              className={
                "rounded-full px-1.5 py-0.5 text-xs font-medium " +
                chipClass(chip.tone)
              }
            >
              {chip.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
