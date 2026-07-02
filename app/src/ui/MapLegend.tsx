import { useState } from "react";

const STORAGE_KEY = "trip-planner.legend-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage unavailable — collapse state just won't persist.
  }
}

interface Props {
  raised?: boolean;
  interactiveMode: boolean;
}

interface Row {
  label: string;
  swatch: JSX.Element;
}

const BASE_ROWS: Row[] = [
  {
    label: "Towered",
    swatch: (
      <span className="h-2 w-2 flex-shrink-0 border border-card bg-data outline outline-1 outline-hairline" />
    ),
  },
  {
    label: "Non-towered",
    swatch: (
      <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full border border-card bg-olive outline outline-1 outline-hairline" />
    ),
  },
  {
    label: "Route",
    swatch: <span className="h-[3px] w-4 flex-shrink-0 bg-accent" />,
  },
  {
    label: "Fuel stop",
    swatch: (
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border-2 border-card bg-accent outline outline-1 outline-hairline" />
    ),
  },
  {
    label: "Terrain warning",
    swatch: (
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border border-caution bg-[color-mix(in_srgb,var(--caution)_35%,transparent)]" />
    ),
  },
];

const RANGE_ROWS: Row[] = [
  {
    label: "Range w/ reserve",
    swatch: (
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border-[1.5px] border-data" />
    ),
  },
  {
    label: "Max range",
    swatch: (
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border-[1.5px] border-dashed border-data" />
    ),
  },
];

/** Collapsible map legend, meant to be positioned bottom-left inside
 *  a `relative` map container (`absolute bottom-3 left-3` here; pass
 *  `raised` to sit above the docked route-profile panel).
 *  Collapse state persists across sessions. */
export function MapLegend({ interactiveMode, raised }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const rows = interactiveMode ? [...BASE_ROWS, ...RANGE_ROWS] : BASE_ROWS;

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }

  return (
    <div
      className={
        "absolute left-3 z-10 w-44 rounded-md border border-hairline bg-card p-2.5 shadow-md " +
        (raised ? "bottom-[calc(28%+0.75rem)]" : "bottom-3")
      }
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand legend" : "Collapse legend"}
        className="flex h-6 w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted"
      >
        Legend
        <span aria-hidden="true">{collapsed ? "+" : "–"}</span>
      </button>
      {!collapsed && (
        <div className="mt-1.5 grid gap-1.5 text-xs text-ink">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center gap-2">
              {row.swatch}
              {row.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
