import type { Airport } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import type { LegAltitudeOverride } from "@/engine/interactive";
import { CRUISE_ALT_OPTIONS, fmtFt } from "./altitudeOptions";

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
}

function fmtNm(nm: number): string {
  return `${Math.round(nm).toLocaleString()} nm`;
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
}: Props) {
  const legs = route?.legs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700">
          Click airports on the map
        </span>
        <button
          type="button"
          onClick={onExit}
          className="text-[11px] font-medium text-brand-600 hover:text-brand-800"
        >
          Switch to auto plan
        </button>
      </div>
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-600">
        Each click adds the next stop and assumes a refuel. The rings show
        your range from the current departure point — solid is with
        reserves, dashed is everything in the tank.
      </p>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
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
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-[11px] text-slate-700">
        <div className="flex items-baseline justify-between">
          <span className="text-slate-500">To destination from here</span>
          <span className="font-mono text-xs font-semibold text-slate-900">
            {fmtNm(distanceToDestNm)}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-slate-500">Range from here</span>
          <span className="font-mono text-xs">
            <span className="font-semibold text-slate-900">
              {fmtNm(rangeSolidNm)}
            </span>
            <span className="text-slate-400"> with reserve · </span>
            <span>{fmtNm(rangeDashedNm)}</span>
            <span className="text-slate-400"> total</span>
          </span>
        </div>
      </div>
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
    <div className="flex items-center gap-2 px-2.5 py-2">
      <span
        className={
          "inline-block h-2 w-2 rounded-full ring-2 " +
          (isStart
            ? "bg-slate-700 ring-slate-200"
            : "bg-orange-500 ring-orange-100")
        }
      />
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className="font-mono text-xs font-semibold text-slate-900">
        {ident}
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label="Remove stop"
          onClick={onRemove}
          className="icon-btn icon-btn-danger ml-auto"
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
  const allowed = CRUISE_ALT_OPTIONS.filter((a) => a <= cruiseCeilingFt);
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
        <div className="border-t border-slate-100 bg-slate-50/50 px-2.5 py-1.5 text-[11px] text-slate-600">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">↓</span>
            <span className="font-mono">{fmtNm(leg.distance_nm)}</span>
            <span className="text-slate-300">·</span>
            <span className="font-mono">{leg.time_hr.toFixed(1)} hr</span>
            <span className="text-slate-300">·</span>
            <span className="font-mono">{leg.fuel_gal.toFixed(1)} gal</span>
            <select
              value={altFt ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onAltitudeChange(v === "" ? null : Number.parseInt(v, 10));
              }}
              className={
                "ml-auto rounded-md border px-1.5 py-0.5 text-[11px] font-mono transition focus:outline-none focus:ring-2 focus:ring-brand-500/30 " +
                (isOverride
                  ? "border-orange-300 bg-orange-50 text-orange-900"
                  : "border-slate-300 bg-white text-slate-700")
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
          </div>
          {!feasible && (
            <div className="mt-1 rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700">
              ⚠ Burns through reserve at this altitude / starting fuel.
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-slate-100 px-2.5 py-2">
        <span
          className={
            "inline-block h-2 w-2 rounded-full ring-2 " +
            (isDestination
              ? "bg-slate-700 ring-slate-200"
              : "bg-orange-500 ring-orange-100")
          }
        />
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
          {isDestination ? "To" : "Stop"}
        </span>
        <span className="font-mono text-xs font-semibold text-slate-900">
          {stopIdent}
        </span>
        {isDestination && destInRange && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
            ✓ in range
          </span>
        )}
        {!isDestination && refuels === false && (
          <span
            className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
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
            className="icon-btn icon-btn-danger ml-auto"
          >
            ×
          </button>
        )}
      </div>
    </>
  );
}
