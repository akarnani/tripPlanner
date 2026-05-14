import { useState } from "react";
import type { PlannedRoute } from "@/engine/plan";
import { costFnById } from "@/engine/costFns";

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
}

export function LegTable({
  routes,
  selected,
  onSelect,
  onExcludeStop,
  onReplaceStop,
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
                "flex-1 px-3 py-2 text-xs font-medium " +
                (i === selected
                  ? "border-b-2 border-slate-900 text-slate-900"
                  : "text-slate-500 hover:text-slate-800")
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
      />
    </div>
  );
}

interface RouteDetailProps {
  route: PlannedRoute;
  onExcludeStop: (airportId: string, ident: string) => void;
  onReplaceStop: (oldAirportId: string, newIdent: string) => void;
}

function RouteDetail({ route, onExcludeStop, onReplaceStop }: RouteDetailProps) {
  // Index of the leg whose "Change to…" input is open, or null.
  const [editingLegIdx, setEditingLegIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      <dl className="mb-3 grid grid-cols-3 gap-x-3 gap-y-1 text-xs text-slate-700">
        <div>
          <dt className="text-slate-500">Distance</dt>
          <dd className="font-semibold">
            {route.totals.distance_nm.toFixed(0)} nm
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Total time</dt>
          <dd className="font-semibold">
            {route.totals.time_hr.toFixed(1)} hr
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Fuel</dt>
          <dd className="font-semibold">
            {route.totals.fuel_gal.toFixed(1)} gal
          </dd>
        </div>
      </dl>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="py-1">Leg</th>
            <th className="py-1 text-right">Alt</th>
            <th className="py-1 text-right">MC</th>
            <th className="py-1 text-right">NM</th>
            <th className="py-1 text-right">Time (h)</th>
            <th className="py-1 text-right">Fuel</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
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
              <tr key={i} className="border-b border-slate-100">
                <td className="py-1 font-mono">
                  {leg.fromAirport.icao ?? leg.fromAirport.lid}
                  <span className="px-1 text-slate-400">→</span>
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
                      className="w-20 rounded border border-slate-300 bg-white px-1 font-mono text-xs uppercase"
                    />
                  ) : (
                    toIdent
                  )}
                </td>
                <td className="py-1 text-right">
                  {leg.cruise_alt_ft.toLocaleString()}
                </td>
                <td
                  className="py-1 text-right"
                  title={
                    leg.variation_deg !== null
                      ? `TC ${leg.true_course_deg.toFixed(0)}° · var ${leg.variation_deg >= 0 ? "+" : ""}${leg.variation_deg.toFixed(0)}°`
                      : "no variation data — true course"
                  }
                >
                  {leg.magnetic_course_deg.toFixed(0).padStart(3, "0")}°
                </td>
                <td className="py-1 text-right">
                  {leg.distance_nm.toFixed(0)}
                </td>
                <td className="py-1 text-right">
                  {leg.time_hr.toFixed(1)}
                </td>
                <td className="py-1 text-right">{leg.fuel_gal.toFixed(1)}</td>
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
                        className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        title={`Exclude ${toIdent} and re-plan`}
                        onClick={() => onExcludeStop(leg.toAirport.id, toIdent)}
                        className="rounded px-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
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
  );
}
