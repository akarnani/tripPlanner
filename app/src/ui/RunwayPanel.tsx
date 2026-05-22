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
  const active = settings.enabled && !disabled;
  return (
    <div className="space-y-3">
      <label
        className={
          "flex items-start gap-2 rounded-lg border p-2.5 text-xs transition " +
          (active
            ? "border-brand-200 bg-brand-50/60 text-slate-800"
            : "border-slate-200 bg-slate-50 text-slate-700") +
          (disabled ? " opacity-60" : "")
        }
      >
        <input
          type="checkbox"
          checked={settings.enabled && !disabled}
          disabled={disabled}
          onChange={(e) =>
            onChange({ ...settings, enabled: e.target.checked })
          }
          className="mt-0.5 h-3.5 w-3.5"
        />
        <span>
          Check runway lengths against POH
          <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
            Uses POH takeoff & landing distance tables, rounded up to the
            next-higher published cell.
          </span>
        </span>
      </label>
      {!aircraftHasData && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          The {aircraftModel} performance file has no takeoff/landing
          tables — runway check is unavailable.
        </p>
      )}
      <div
        className={
          "space-y-3 " + (active ? "" : "pointer-events-none opacity-50")
        }
      >
        <div>
          <label htmlFor="runway-buffer" className="field-label">
            Buffer
          </label>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-700">
            <input
              id="runway-buffer"
              type="number"
              min={0}
              max={5000}
              step={100}
              value={settings.buffer_ft}
              disabled={!active}
              onChange={(e) =>
                onChange({
                  ...settings,
                  buffer_ft: Number.parseInt(e.target.value, 10) || 0,
                })
              }
              className="input w-24"
            />
            <span className="text-slate-500">ft beyond POH required</span>
          </div>
        </div>
        <div>
          <span className="field-label">Weight assumption</span>
          <div className="seg mt-1">
            {(
              [
                { id: "estimated", label: "Estimated" },
                { id: "maxGross", label: "Max gross" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                disabled={!active}
                onClick={() => onChange({ ...settings, weight: opt.id })}
                className={
                  "seg-btn " +
                  (settings.weight === opt.id ? "seg-btn-active" : "")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            Estimated uses the route's computed weight and reads the
            next-higher POH weight tier — never an average, never a
            scaled number. When the POH only publishes one weight
            tier, both modes return that same cell.
          </p>
        </div>
        <div>
          <label htmlFor="runway-isa" className="field-label">
            Assumed temperature
          </label>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-700">
            <span className="text-slate-500">ISA +</span>
            <input
              id="runway-isa"
              type="number"
              min={-20}
              max={50}
              step={5}
              value={settings.isa_delta_c}
              disabled={!active}
              onChange={(e) =>
                onChange({
                  ...settings,
                  isa_delta_c: Number.parseInt(e.target.value, 10) || 0,
                })
              }
              className="input w-20"
            />
            <span className="text-slate-500">°C</span>
          </div>
        </div>
      </div>
    </div>
  );
}
