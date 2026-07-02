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
    <div className="border-t border-slate-200 bg-rose-50/40 px-4 py-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
        <span
          className="inline-block h-2 w-2 rounded-full bg-rose-500"
          aria-hidden="true"
        />
        Runway fit
      </div>
      <ul className="mt-2 space-y-1.5 text-xs">
        {warnings.map((w, i) => {
          const isInsufficient = w.status === "insufficient";
          const tone = isInsufficient
            ? "border-rose-200 bg-white/80 text-rose-800"
            : "border-amber-200 bg-white/80 text-amber-800";
          const verb = w.phase === "takeoff" ? "Departure" : "Arrival";
          const wanted = w.required_ft + w.buffer_ft;
          // Tight means available ≥ required + buffer but
          // < required + 2 × buffer; insufficient means
          // available < required + buffer.
          const verdict = isInsufficient ? "short" : "tight";
          const elevLabel =
            Math.round(w.pressure_alt_ft) === 0
              ? "SL"
              : `${Math.round(w.pressure_alt_ft).toLocaleString()} ft`;
          return (
            <li
              key={i}
              className={"rounded-md border px-2 py-1.5 " + tone}
            >
              <div>
                {verb}{" "}
                <span className="font-mono font-semibold">{w.ident}</span>{" "}
                runway {verdict}: {fmtFt(w.available_ft)} available vs{" "}
                {fmtFt(wanted)} wanted (POH {fmtFt(w.required_ft)} ground roll + {fmtFt(w.buffer_ft)} buffer)
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
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
