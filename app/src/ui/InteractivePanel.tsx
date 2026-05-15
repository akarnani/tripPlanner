import type { Airport } from "@/data/loaders";
import type { PlannedRoute } from "@/engine/plan";
import type { LegAltitudeOverride } from "@/engine/interactive";

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
  onRemoveStop: (stopIndex: number) => void;
  onChangeLegAltitude: (legIndex: number, altFt: number | null) => void;
  onExit: () => void;
}

/** Cruise altitude options offered in the per-leg dropdown. Covers
 *  the typical GA range; pilots flying outside this range can type
 *  values directly. */
const ALT_OPTIONS = [
  3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500, 12500, 13500, 14500,
  15500, 16500, 17500,
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
  onRemoveStop,
  onChangeLegAltitude,
  onExit,
}: Props) {
  const legs = route?.legs ?? [];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-700">
          Interactive build
        </span>
        <button
          type="button"
          onClick={onExit}
          className="text-[11px] text-slate-500 underline hover:text-slate-700"
        >
          Switch to auto plan
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        Click any airport on the map to add it as the next stop. Each
        stop is assumed to be a refuel stop (next tank full). The
        rings show your range from the current departure point — solid
        is with reserves, dashed is everything in the tank.
      </p>
      <div className="rounded border border-slate-200 bg-white">
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
          onAltitudeChange={(alt) => onChangeLegAltitude(stops.length, alt)}
          onRemove={undefined}
          isDestination
          destInRange={destInRange}
        />
      </div>
      <div className="rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
        <div>
          <span className="text-slate-500">To destination from here:</span>{" "}
          <span className="font-medium">{fmtNm(distanceToDestNm)}</span>
        </div>
        <div>
          <span className="text-slate-500">Range from here:</span>{" "}
          <span className="font-medium">{fmtNm(rangeSolidNm)}</span> with
          reserve · <span>{fmtNm(rangeDashedNm)}</span> total
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
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span
        className={
          "inline-block h-2 w-2 rounded-full " +
          (isStart ? "bg-slate-700" : "bg-orange-500")
        }
      />
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
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
          className="ml-auto text-xs text-slate-400 hover:text-red-600"
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
  onAltitudeChange,
  onRemove,
  isDestination,
  destInRange,
}: LegAndStopProps) {
  // Build the dropdown options. Include the current selection and
  // the default if either isn't in the canonical list.
  const seen = new Set(ALT_OPTIONS);
  const opts = [...ALT_OPTIONS];
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
        <div className="border-t border-slate-100 px-2 py-1.5 text-[11px] text-slate-600">
          <div className="flex items-center gap-2">
            <span className="text-slate-400">↓</span>
            <span>{fmtNm(leg.distance_nm)}</span>
            <span className="text-slate-400">·</span>
            <span>{leg.time_hr.toFixed(1)} hr</span>
            <span className="text-slate-400">·</span>
            <span>{leg.fuel_gal.toFixed(1)} gal</span>
            <select
              value={altFt ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                onAltitudeChange(v === "" ? null : Number.parseInt(v, 10));
              }}
              className={
                "ml-auto rounded border px-1 py-0.5 text-[11px] font-mono " +
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
            <div className="mt-1 text-xs text-red-600">
              ⚠ Burns through reserve at this altitude / starting fuel.
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-slate-100 px-2 py-1.5">
        <span
          className={
            "inline-block h-2 w-2 rounded-full " +
            (isDestination ? "bg-slate-700" : "bg-orange-500")
          }
        />
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          {isDestination ? "To" : "Stop"}
        </span>
        <span className="font-mono text-xs font-semibold text-slate-900">
          {stopIdent}
        </span>
        {isDestination && destInRange && (
          <span className="text-[10px] font-medium text-green-700">
            in range ✓
          </span>
        )}
        {!isDestination && refuels === false && (
          <span
            className="text-[10px] font-medium text-amber-700"
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
            className="ml-auto text-xs text-slate-400 hover:text-red-600"
          >
            ×
          </button>
        )}
      </div>
    </>
  );
}
