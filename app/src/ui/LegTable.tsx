import { useState } from "react";
import type { PlannedRoute } from "@/engine/plan";
import { costFnById } from "@/engine/costFns";
import { AirportLink } from "./AirportLink";
import { useMediaQuery } from "./useMediaQuery";

interface Props {
  routes: PlannedRoute[];
  selected: number;
  onSelect: (i: number) => void;
  /** Called when the user clicks the × on a leg row. The id is the
   *  airport at the *to* end of that leg — never the destination. */
  onExcludeStop: (airportId: string, ident: string) => void;
  /** Called when the user replaces a suggested stop with a typed
   *  ICAO/LID. `oldAirportId` is the suggested stop, `newIdent` is the
   *  user input. Implementations should resolve the ident, exclude the
   *  old stop, pin the new airport, and re-plan. */
  onReplaceStop: (oldAirportId: string, newIdent: string) => void;
  /** Fuel on landing per leg of the SELECTED route (T6). Omit to hide
   *  the Arr column entirely. */
  arrivalFuelGal?: readonly number[];
  /** Reserve in gallons — drives the footnote and the danger cutoff
   *  for Arr tinting. */
  reserveGal?: number;
  /** Reserve + 15 min of cruise burn, in gallons — the ok/caution
   *  cutoff for Arr tinting. */
  cautionFloorGal?: number;
  /** Reserve in minutes, for the footnote copy. */
  reserveMin?: number;
  /** Highlights the matching leg row (hover synced with the map and
   *  the route-issues panel). */
  hoveredLegIndex?: number | null;
  onHoverLeg?: (i: number | null) => void;
  /** Renders an "Edit this route" button under the table when set. */
  onEditRoute?: () => void;
  /** When set, clicking a leg row opens the route-profile panel over
   *  the map. Omitted while the DEM grid hasn't loaded. */
  onShowProfile?: () => void;
}

export function LegTable({
  routes,
  selected,
  onSelect,
  onExcludeStop,
  onReplaceStop,
  arrivalFuelGal,
  reserveGal,
  cautionFloorGal,
  reserveMin,
  hoveredLegIndex,
  onHoverLeg,
  onEditRoute,
  onShowProfile,
}: Props) {
  if (routes.length === 0) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-hairline bg-card">
        {routes.map((r, i) => {
          const label = costFnById(r.costFnId)?.label ?? r.costFnId;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              className={
                "flex-1 px-3 py-2 text-xs font-medium " +
                (i === selected
                  ? "border-b-2 border-accent text-ink"
                  : "text-muted hover:text-ink")
              }
            >
              {label} · {r.totals.stops} stop{r.totals.stops === 1 ? "" : "s"}
            </button>
          );
        })}
      </div>
      <RouteDetail
        route={routes[selected]}
        onExcludeStop={onExcludeStop}
        onReplaceStop={onReplaceStop}
        arrivalFuelGal={arrivalFuelGal}
        reserveGal={reserveGal}
        cautionFloorGal={cautionFloorGal}
        reserveMin={reserveMin}
        hoveredLegIndex={hoveredLegIndex}
        onHoverLeg={onHoverLeg}
        onEditRoute={onEditRoute}
        onShowProfile={onShowProfile}
      />
    </div>
  );
}

interface RouteDetailProps {
  route: PlannedRoute;
  onExcludeStop: (airportId: string, ident: string) => void;
  onReplaceStop: (oldAirportId: string, newIdent: string) => void;
  arrivalFuelGal?: readonly number[];
  reserveGal?: number;
  cautionFloorGal?: number;
  reserveMin?: number;
  hoveredLegIndex?: number | null;
  onHoverLeg?: (i: number | null) => void;
  onEditRoute?: () => void;
  onShowProfile?: () => void;
}

/** Tint class for an Arr cell. Margin, not violation: ok/neutral once
 *  the leg lands with at least reserve + 15 min of cruise burn,
 *  caution below that, danger only below reserve itself (auto-planned
 *  legs never land there — interactive builds and stale plans can). */
function arrTintClass(
  arrGal: number,
  reserveGal: number | undefined,
  cautionFloorGal: number | undefined,
): string {
  if (reserveGal === undefined || cautionFloorGal === undefined) {
    return "text-ink";
  }
  if (arrGal < reserveGal) return "text-danger";
  if (arrGal < cautionFloorGal) return "text-caution";
  return "text-ok";
}

function RouteDetail({
  route,
  onExcludeStop,
  onReplaceStop,
  arrivalFuelGal,
  reserveGal,
  cautionFloorGal,
  reserveMin,
  hoveredLegIndex,
  onHoverLeg,
  onEditRoute,
  onShowProfile,
}: RouteDetailProps) {
  // Index of the leg whose "Change to…" input is open, or null.
  const [editingLegIdx, setEditingLegIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // On touch there's no hover, so a row tap toggles the leg highlight
  // (map segment + cross-panel sync) instead of opening the profile
  // dock. Mouse devices keep hover + click-to-open-profile unchanged.
  const coarse = useMediaQuery("(pointer: coarse)");
  const showArr = arrivalFuelGal !== undefined;
  const showFootnote =
    showArr && reserveGal !== undefined && reserveMin !== undefined;
  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      <dl className="mb-3 grid grid-cols-3 gap-x-3 gap-y-1 text-xs text-ink">
        <div>
          <dt className="text-muted">Distance</dt>
          <dd className="font-semibold">
            {route.totals.distance_nm.toFixed(0)} nm
          </dd>
        </div>
        <div>
          <dt className="text-muted">Total time</dt>
          <dd className="font-semibold">
            {route.totals.time_hr.toFixed(1)} hr
          </dd>
        </div>
        <div>
          <dt className="text-muted">Fuel</dt>
          <dd className="font-semibold">
            {route.totals.fuel_gal.toFixed(1)} gal
          </dd>
        </div>
      </dl>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-hairline text-left text-muted">
            <th className="py-1">Leg</th>
            <th className="py-1 pl-2 text-right">Alt</th>
            <th className="py-1 pl-2 text-right">MC</th>
            <th className="py-1 pl-2 text-right">NM</th>
            {showArr && <th className="py-1 pl-2 text-right">Arr</th>}
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {route.legs.map((leg, i) => {
            const isLastLeg = i === route.legs.length - 1;
            const toIdent = leg.toAirport.icao ?? leg.toAirport.lid;
            const isEditing = editingLegIdx === i;
            const arrGal = arrivalFuelGal?.[i];
            const submitReplace = () => {
              const v = draft.trim();
              if (!v) return;
              onReplaceStop(leg.toAirport.id, v);
              setEditingLegIdx(null);
              setDraft("");
            };
            // Combined tooltip: true course / variation (previously on
            // the MC cell) plus leg time and fuel burn (previously
            // their own columns — pulled out so the remaining columns
            // fit the 320px rail without values wrapping mid-number).
            const rowTitle =
              (leg.variation_deg !== null
                ? `TC ${leg.true_course_deg.toFixed(0)}° · var ${leg.variation_deg >= 0 ? "+" : ""}${leg.variation_deg.toFixed(0)}°`
                : "no variation data — true course") +
              ` · ${leg.time_hr.toFixed(1)} hr · ${leg.fuel_gal.toFixed(1)} gal`;
            return (
              <tr
                key={i}
                title={rowTitle}
                onMouseEnter={coarse ? undefined : () => onHoverLeg?.(i)}
                onMouseLeave={coarse ? undefined : () => onHoverLeg?.(null)}
                onClick={() =>
                  coarse
                    ? onHoverLeg?.(hoveredLegIndex === i ? null : i)
                    : onShowProfile?.()
                }
                className={
                  "border-b border-hairline " +
                  (onShowProfile || coarse ? "cursor-pointer " : "") +
                  (hoveredLegIndex === i ? "bg-card" : "")
                }
              >
                <td className="whitespace-nowrap py-1 font-mono">
                  <AirportLink
                    ident={leg.fromAirport.icao ?? leg.fromAirport.lid}
                  />
                  <span className="px-1 text-muted">→</span>
                  {isEditing ? (
                    <input
                      type="text"
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitReplace();
                        } else if (e.key === "Escape") {
                          setEditingLegIdx(null);
                          setDraft("");
                        }
                      }}
                      onBlur={() => {
                        setEditingLegIdx(null);
                        setDraft("");
                      }}
                      placeholder={toIdent}
                      className="w-20 rounded border border-hairline-input bg-card px-1 font-mono text-xs uppercase text-ink"
                    />
                  ) : (
                    <AirportLink ident={toIdent} />
                  )}
                </td>
                <td className="whitespace-nowrap py-1 pl-2 text-right font-mono">
                  {leg.cruise_alt_ft.toLocaleString()}
                </td>
                <td className="whitespace-nowrap py-1 pl-2 text-right font-mono">
                  {leg.magnetic_course_deg.toFixed(0).padStart(3, "0")}°
                </td>
                <td className="whitespace-nowrap py-1 pl-2 text-right font-mono">
                  {leg.distance_nm.toFixed(0)}
                </td>
                {showArr && (
                  <td
                    className={
                      "whitespace-nowrap py-1 pl-2 text-right font-mono font-bold " +
                      arrTintClass(arrGal ?? 0, reserveGal, cautionFloorGal)
                    }
                  >
                    {arrGal !== undefined ? arrGal.toFixed(1) : "—"}
                  </td>
                )}
                <td className="py-1 pl-1 text-right">
                  {!isLastLeg && !isEditing && (
                    <div className="flex justify-end gap-0.5">
                      <button
                        type="button"
                        title={`Change ${toIdent} to a different stop`}
                        onMouseDown={(e) => {
                          // mousedown beats the input's blur handler on
                          // the next render so the click can land
                          e.preventDefault();
                          setEditingLegIdx(i);
                          setDraft("");
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-ink"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        title={`Exclude ${toIdent} and re-plan`}
                        aria-label={`Exclude ${toIdent} and re-plan`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onExcludeStop(leg.toAirport.id, toIdent);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] hover:text-danger"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {showFootnote && (
        <p className="mt-2 text-xs text-muted">
          Arr = fuel on landing · reserve {reserveGal!.toFixed(1)} gal (
          {reserveMin} min)
        </p>
      )}
      {onEditRoute && (
        <button
          type="button"
          onClick={onEditRoute}
          className="mt-3 w-full rounded border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:text-ink"
        >
          Edit this route
        </button>
      )}
    </div>
  );
}
