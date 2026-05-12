import type { PlannedRoute } from "@/engine/plan";

interface Props {
  routes: PlannedRoute[];
  selected: number;
  onSelect: (i: number) => void;
}

export function LegTable({ routes, selected, onSelect }: Props) {
  if (routes.length === 0) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-slate-200 bg-white">
        {routes.map((r, i) => (
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
            Alt {i + 1} · {r.totals.stops} stop{r.totals.stops === 1 ? "" : "s"}
          </button>
        ))}
      </div>
      <RouteDetail route={routes[selected]} />
    </div>
  );
}

function RouteDetail({ route }: { route: PlannedRoute }) {
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
            <th className="py-1 text-right">NM</th>
            <th className="py-1 text-right">Time</th>
            <th className="py-1 text-right">Fuel</th>
          </tr>
        </thead>
        <tbody>
          {route.legs.map((leg, i) => (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-1 font-mono">
                {leg.fromAirport.icao ?? leg.fromAirport.lid}
                <span className="px-1 text-slate-400">→</span>
                {leg.toAirport.icao ?? leg.toAirport.lid}
              </td>
              <td className="py-1 text-right">{leg.distance_nm.toFixed(0)}</td>
              <td className="py-1 text-right">
                {(leg.time_hr * 60).toFixed(0)}m
              </td>
              <td className="py-1 text-right">{leg.fuel_gal.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
