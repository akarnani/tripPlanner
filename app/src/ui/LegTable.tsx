import type { PlannedRoute } from "@/engine/plan";
import { costFnById } from "@/engine/costFns";

interface Props {
  routes: PlannedRoute[];
  selected: number;
  onSelect: (i: number) => void;
  /** Called when the user clicks the × on a leg row. The id is the
   *  airport at the *to* end of that leg — never the destination. */
  onExcludeStop: (airportId: string, ident: string) => void;
}

export function LegTable({
  routes,
  selected,
  onSelect,
  onExcludeStop,
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
      />
    </div>
  );
}

interface RouteDetailProps {
  route: PlannedRoute;
  onExcludeStop: (airportId: string, ident: string) => void;
}

function RouteDetail({ route, onExcludeStop }: RouteDetailProps) {
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
            <th className="py-1 text-right">Time</th>
            <th className="py-1 text-right">Fuel</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {route.legs.map((leg, i) => {
            const isLastLeg = i === route.legs.length - 1;
            const toIdent = leg.toAirport.icao ?? leg.toAirport.lid;
            return (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-1 font-mono">
                  {leg.fromAirport.icao ?? leg.fromAirport.lid}
                  <span className="px-1 text-slate-400">→</span>
                  {toIdent}
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
                  {(leg.time_hr * 60).toFixed(0)}m
                </td>
                <td className="py-1 text-right">{leg.fuel_gal.toFixed(1)}</td>
                <td className="py-1 pl-1 text-right">
                  {!isLastLeg && (
                    <button
                      type="button"
                      title={`Exclude ${toIdent} and re-plan`}
                      onClick={() => onExcludeStop(leg.toAirport.id, toIdent)}
                      className="rounded px-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      ×
                    </button>
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
