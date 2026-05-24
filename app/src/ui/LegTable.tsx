import { useState } from "react";
import type { Leg, PlannedRoute } from "@/engine/plan";
import { costFnById } from "@/engine/costFns";
import { CRUISE_ALT_OPTIONS } from "./altitudeOptions";

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
  /** When provided, the Alt column becomes a select. The handler
   *  receives the leg and the chosen altitude (or null to revert to
   *  the auto/hemispheric-chosen value). Omit for interactive mode
   *  (which owns its own per-leg altitude UI in the sidebar). */
  onChangeLegAltitude?: (leg: Leg, altFt: number | null) => void;
  /** Returns true when the parent considers this leg's altitude an
   *  explicit user override (vs. auto-chosen). Used to highlight the
   *  cell. Only consulted when `onChangeLegAltitude` is provided. */
  isLegAltOverridden?: (leg: Leg) => boolean;
  /** Cap for the altitude select — the aircraft's published cruise
   *  ceiling. Options above this are hidden so the pilot can't pick a
   *  level the engine has no POH data for. */
  cruiseCeilingFt?: number;
}

export function LegTable({
  routes,
  selected,
  onSelect,
  onExcludeStop,
  onReplaceStop,
  onChangeLegAltitude,
  isLegAltOverridden,
  cruiseCeilingFt,
}: Props) {
  if (routes.length === 0) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-slate-200 bg-white">
        {routes.map((r, i) => {
          const label = costFnById(r.costFnId)?.label ?? r.costFnId;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              className={
                "relative flex-1 px-3 py-2.5 text-xs font-medium transition " +
                (i === selected
                  ? "text-slate-900"
                  : "text-slate-500 hover:text-slate-800")
              }
            >
              {label}
              <span className="text-slate-400">
                {" · "}
                {r.totals.stops} stop{r.totals.stops === 1 ? "" : "s"}
              </span>
              {i === selected && (
                <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-600" />
              )}
            </button>
          );
        })}
      </div>
      <RouteDetail
        route={routes[selected]}
        onExcludeStop={onExcludeStop}
        onReplaceStop={onReplaceStop}
        onChangeLegAltitude={onChangeLegAltitude}
        isLegAltOverridden={isLegAltOverridden}
        cruiseCeilingFt={cruiseCeilingFt}
      />
    </div>
  );
}

interface RouteDetailProps {
  route: PlannedRoute;
  onExcludeStop: (airportId: string, ident: string) => void;
  onReplaceStop: (oldAirportId: string, newIdent: string) => void;
  onChangeLegAltitude?: (leg: Leg, altFt: number | null) => void;
  isLegAltOverridden?: (leg: Leg) => boolean;
  cruiseCeilingFt?: number;
}

function RouteDetail({
  route,
  onExcludeStop,
  onReplaceStop,
  onChangeLegAltitude,
  isLegAltOverridden,
  cruiseCeilingFt,
}: RouteDetailProps) {
  // Index of the leg whose "Change to…" input is open, or null.
  const [editingLegIdx, setEditingLegIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-white p-4">
      <dl className="mb-4 grid grid-cols-3 gap-2">
        <Stat label="Distance" value={`${route.totals.distance_nm.toFixed(0)} nm`} />
        <Stat label="Total time" value={`${route.totals.time_hr.toFixed(1)} hr`} />
        <Stat label="Fuel" value={`${route.totals.fuel_gal.toFixed(1)} gal`} />
      </dl>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr className="text-left text-[10px] font-medium uppercase tracking-wide text-slate-500">
              <th className="px-2 py-1.5">Leg</th>
              <th className="px-2 py-1.5 text-right">Alt</th>
              <th className="px-2 py-1.5 text-right">MC</th>
              <th className="px-2 py-1.5 text-right">NM</th>
              <th className="px-2 py-1.5 text-right">Time</th>
              <th className="px-2 py-1.5 text-right">Fuel</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {route.legs.map((leg, i) => {
              const isLastLeg = i === route.legs.length - 1;
              const toIdent = leg.toAirport.icao ?? leg.toAirport.lid;
              const isEditing = editingLegIdx === i;
              const submitReplace = () => {
                const v = draft.trim();
                if (!v) return;
                onReplaceStop(leg.toAirport.id, v);
                setEditingLegIdx(null);
                setDraft("");
              };
              return (
                <tr key={i} className="group transition hover:bg-slate-50">
                  <td className="px-2 py-1.5 font-mono">
                    {leg.fromAirport.icao ?? leg.fromAirport.lid}
                    <span className="px-1 text-slate-300">→</span>
                    {isEditing ? (
                      <input
                        type="text"
                        autoFocus
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
                        className="w-20 rounded-md border border-brand-300 bg-white px-1 font-mono text-xs uppercase focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                      />
                    ) : (
                      <span className="font-semibold text-slate-900">
                        {toIdent}
                      </span>
                    )}
                  </td>
                  <td className="px-1 py-1 text-right font-mono tabular-nums">
                    <AltCell
                      leg={leg}
                      onChangeLegAltitude={onChangeLegAltitude}
                      isLegAltOverridden={isLegAltOverridden}
                      cruiseCeilingFt={cruiseCeilingFt}
                    />
                  </td>
                  <td
                    className="px-2 py-1.5 text-right font-mono tabular-nums"
                    title={
                      leg.variation_deg !== null
                        ? `TC ${leg.true_course_deg.toFixed(0)}° · var ${leg.variation_deg >= 0 ? "+" : ""}${leg.variation_deg.toFixed(0)}°`
                        : "no variation data — true course"
                    }
                  >
                    {leg.magnetic_course_deg.toFixed(0).padStart(3, "0")}°
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {leg.distance_nm.toFixed(0)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {leg.time_hr.toFixed(1)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                    {leg.fuel_gal.toFixed(1)}
                  </td>
                  <td className="px-1 py-1 text-right">
                    {!isLastLeg && !isEditing && (
                      <div className="flex justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          type="button"
                          title={`Change ${toIdent} to a different stop`}
                          onMouseDown={(e) => {
                            // mousedown beats the input's blur handler
                            // on the next render so the click can land
                            e.preventDefault();
                            setEditingLegIdx(i);
                            setDraft("");
                          }}
                          className="icon-btn text-[11px]"
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          title={`Exclude ${toIdent} and re-plan`}
                          onClick={() => onExcludeStop(leg.toAirport.id, toIdent)}
                          className="icon-btn icon-btn-danger text-[11px]"
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
      </div>
    </div>
  );
}

interface AltCellProps {
  leg: Leg;
  onChangeLegAltitude?: (leg: Leg, altFt: number | null) => void;
  isLegAltOverridden?: (leg: Leg) => boolean;
  cruiseCeilingFt?: number;
}

/** Alt cell: a styled select when the parent supplies a handler; a
 *  plain number otherwise (interactive mode owns its own altitude UI
 *  in the sidebar and doesn't want a duplicate here). */
function AltCell({
  leg,
  onChangeLegAltitude,
  isLegAltOverridden,
  cruiseCeilingFt,
}: AltCellProps) {
  if (!onChangeLegAltitude) {
    return (
      <span className="px-2 py-1.5">{leg.cruise_alt_ft.toLocaleString()}</span>
    );
  }
  // Merge canonical options with whatever altitude the route currently
  // flies — even if the auto-picked level isn't in the standard list
  // (e.g. a published cruise row at 12,500 in IFR), it has to be
  // selectable so the dropdown can show "currently flying X".
  const ceiling = cruiseCeilingFt ?? Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  const opts: number[] = [];
  for (const a of CRUISE_ALT_OPTIONS) {
    if (a > ceiling) continue;
    if (!seen.has(a)) {
      opts.push(a);
      seen.add(a);
    }
  }
  if (!seen.has(leg.cruise_alt_ft)) {
    opts.push(leg.cruise_alt_ft);
  }
  opts.sort((a, b) => a - b);
  const overridden = isLegAltOverridden?.(leg) ?? false;
  return (
    <select
      value={leg.cruise_alt_ft}
      onChange={(e) => {
        const raw = e.target.value;
        onChangeLegAltitude(leg, raw === "auto" ? null : Number.parseInt(raw, 10));
      }}
      aria-label={`Cruise altitude for ${leg.fromAirport.icao ?? leg.fromAirport.lid} → ${leg.toAirport.icao ?? leg.toAirport.lid}`}
      title={
        overridden
          ? "Custom altitude; pick 'auto' to revert to the hemispheric-cheapest level"
          : "Auto-picked — pick a specific altitude to override"
      }
      className={
        "w-full rounded-md border px-1.5 py-0.5 text-right text-xs font-mono tabular-nums transition focus:outline-none focus:ring-2 focus:ring-brand-500/30 " +
        (overridden
          ? "border-orange-300 bg-orange-50 text-orange-900"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300")
      }
    >
      <option value="auto">auto</option>
      {opts.map((alt) => (
        <option key={alt} value={alt}>
          {alt.toLocaleString()}
        </option>
      ))}
    </select>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-slate-900">
        {value}
      </dd>
    </div>
  );
}
