import type { RunwaySettings } from "@/engine/runway";

interface Props {
  settings: RunwaySettings;
  onChange: (next: RunwaySettings) => void;
  /** True when the selected aircraft's performance.yaml carries POH
   *  takeoff & landing tables. Drives whether the controls are
   *  interactive — without data the runway check would be a silent
   *  no-op, and the UI explains why. */
  aircraftHasData: boolean;
  aircraftModel: string;
}

export function RunwayPanel({
  settings,
  onChange,
  aircraftHasData,
  aircraftModel,
}: Props) {
  const disabled = !aircraftHasData;
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-xs text-slate-700">
        <input
          type="checkbox"
          checked={settings.enabled && !disabled}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...settings, enabled: e.target.checked })
          }
          className="h-3.5 w-3.5"
        />
        Check runway lengths against POH
      </label>
      {!aircraftHasData && (
        <p className="text-[11px] text-amber-700">
          The {aircraftModel} performance file has no takeoff/landing
          tables — runway check is unavailable.
        </p>
      )}
      <div
        className={
          "space-y-2 " + (settings.enabled && !disabled ? "" : "opacity-50")
        }
      >
        <div>
          <label
            htmlFor="runway-buffer"
            className="block text-[11px] uppercase tracking-wide text-slate-500"
          >
            Buffer
          </label>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <input
              id="runway-buffer"
              type="number"
              min={0}
              max={5000}
              step={100}
              value={settings.buffer_ft}
              disabled={!settings.enabled || disabled}
              onChange={(e) =>
                onChange({
                  ...settings,
                  buffer_ft: Number.parseInt(e.target.value, 10) || 0,
                })
              }
              className="w-20 rounded border border-slate-300 bg-white px-2 py-1 disabled:bg-slate-100"
            />
            <span className="text-slate-500">ft beyond POH required</span>
          </div>
        </div>
        <div>
          <span className="block text-[11px] uppercase tracking-wide text-slate-500">
            Weight assumption
          </span>
          <div className="mt-1 inline-flex overflow-hidden rounded border border-slate-300">
            {(
              [
                { id: "estimated", label: "Estimated" },
                { id: "maxGross", label: "Max gross" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={!settings.enabled || disabled}
                onClick={() => onChange({ ...settings, weight: opt.id })}
                className={
                  "px-3 py-1 text-xs font-medium disabled:bg-slate-100 disabled:text-slate-400 " +
                  (settings.weight === opt.id
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-700 hover:bg-slate-100")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Estimated uses the route's computed weight and reads the
            next-higher POH weight tier — never an average, never a
            scaled number. When the POH only publishes one weight
            tier, both modes return that same cell.
          </p>
        </div>
        <div>
          <label
            htmlFor="runway-isa"
            className="block text-[11px] uppercase tracking-wide text-slate-500"
          >
            Assumed temperature
          </label>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className="text-slate-500">ISA +</span>
            <input
              id="runway-isa"
              type="number"
              min={-20}
              max={50}
              step={5}
              value={settings.isa_delta_c}
              disabled={!settings.enabled || disabled}
              onChange={(e) =>
                onChange({
                  ...settings,
                  isa_delta_c: Number.parseInt(e.target.value, 10) || 0,
                })
              }
              className="w-16 rounded border border-slate-300 bg-white px-2 py-1 disabled:bg-slate-100"
            />
            <span className="text-slate-500">°C</span>
          </div>
        </div>
      </div>
    </div>
  );
}
