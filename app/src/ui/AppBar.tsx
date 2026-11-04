import type { ReactNode } from "react";

export type LoadStatus = "loading" | "ready" | "failed";

interface Props {
  airports: LoadStatus;
  terrain: LoadStatus;
  /** Saved trips + theme toggle, shared with the mobile app bar. */
  controls: ReactNode;
}

const PILL_TONE: Record<LoadStatus, string> = {
  loading: "border-hairline text-muted",
  ready:
    "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-[color-mix(in_srgb,var(--ok)_10%,transparent)] text-ok",
  failed:
    "border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-danger",
};

const DOT_TONE: Record<LoadStatus, string> = {
  loading: "animate-pulse bg-muted",
  ready: "bg-ok",
  failed: "bg-danger",
};

function StatusPill({ label, status }: { label: string; status: LoadStatus }) {
  const text =
    status === "ready"
      ? `${label} ready`
      : status === "failed"
        ? `${label} unavailable`
        : `Loading ${label.toLowerCase()}…`;
  return (
    <span className={"pill " + PILL_TONE[status]} data-status={status}>
      <span className={"h-1.5 w-1.5 rounded-full " + DOT_TONE[status]} />
      {text}
    </span>
  );
}

/** Small plane glyph used as the app's brand mark. */
export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  return (
    <span
      aria-hidden="true"
      className={
        "inline-flex shrink-0 items-center justify-center rounded-lg bg-accent text-white shadow-sm " +
        box
      }
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
        <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" />
      </svg>
    </span>
  );
}

/** Full-width header for the desktop and tablet layouts: brand,
 *  dataset/terrain readiness, and the saved-trips + theme controls. */
export function AppBar({ airports, terrain, controls }: Props) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-hairline bg-card px-4 py-2.5">
      <BrandMark />
      <div className="min-w-0 flex-1">
        <h1 className="text-[15px] font-semibold leading-tight tracking-tight text-ink">
          Trip Planner
        </h1>
        <p className="truncate text-[11px] text-muted">
          GA route planning · fuel stops · terrain · approaches
        </p>
      </div>
      <div className="hidden items-center gap-1.5 lg:flex">
        <StatusPill label="Airport database" status={airports} />
        <StatusPill label="Terrain" status={terrain} />
      </div>
      {controls}
    </header>
  );
}
