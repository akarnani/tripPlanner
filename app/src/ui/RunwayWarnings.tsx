import type { RunwayFitStatus } from "@/engine/runway";

interface Warning {
  legIndex: number;
  phase: "takeoff" | "landing";
  ident: string;
  status: RunwayFitStatus;
  required_ft: number;
  available_ft: number;
  buffer_ft: number;
  weight_lb: number;
  pressure_alt_ft: number;
  temp_c: number;
}

interface Props {
  warnings: readonly Warning[];
}

function fmtFt(ft: number): string {
  return `${Math.round(ft).toLocaleString()} ft`;
}

export function RunwayWarnings({ warnings }: Props) {
  if (warnings.length === 0) return null;
  return (
    <div className="border-t border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        Runway fit
      </div>
      <ul className="mt-1 space-y-1.5 text-xs">
        {warnings.map((w, i) => {
          const tone =
            w.status === "insufficient" ? "text-red-700" : "text-amber-700";
          const verb = w.phase === "takeoff" ? "Departure" : "Arrival";
          const wanted = w.required_ft + w.buffer_ft;
          // Tight means available ≥ required + buffer but
          // < required + 2 × buffer; insufficient means
          // available < required + buffer.
          const verdict = w.status === "insufficient" ? "short" : "tight";
          const elevLabel =
            Math.round(w.pressure_alt_ft) === 0
              ? "SL"
              : `${Math.round(w.pressure_alt_ft).toLocaleString()} ft`;
          return (
            <li key={i} className={tone}>
              <div>
                {verb}{" "}
                <span className="font-mono font-semibold">{w.ident}</span>{" "}
                runway {verdict}: {fmtFt(w.available_ft)} available vs{" "}
                {fmtFt(wanted)} wanted (POH {fmtFt(w.required_ft)} ground roll + {fmtFt(w.buffer_ft)} buffer)
              </div>
              <div className="text-[11px] text-slate-500">
                POH cell: {elevLabel} × {Math.round(w.temp_c)} °C ×{" "}
                {Math.round(w.weight_lb).toLocaleString()} lb
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
