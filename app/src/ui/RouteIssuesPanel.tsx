import type { RouteIssue } from "@/engine/routeIssues";
import { AirportLink } from "./AirportLink";

/** A route issue's ident is either a single airport ("KGEG") or a
 *  cruise pair ("KGEG→KBOI"); link each airport part to AirNav while
 *  keeping the arrow between them plain. */
function IssueIdentLinks({ ident }: { ident: string }) {
  const parts = ident.split("→");
  if (parts.length !== 2) return <AirportLink ident={ident} />;
  return (
    <>
      <AirportLink ident={parts[0]} />→<AirportLink ident={parts[1]} />
    </>
  );
}

interface Props {
  issues: readonly RouteIssue[];
  hoveredLegIndex: number | null;
  onHoverLeg: (i: number | null) => void;
}

const PHASE_LABEL: Record<RouteIssue["phase"], string> = {
  cruise: "cruise",
  takeoff: "T/O",
  landing: "Ldg",
  arrival: "arr",
  departure: "dep",
};

/** Unified replacement for the old TerrainPanel-cruise-warnings +
 *  corridor-warnings + RunwayWarnings stack — one severity-sorted
 *  list. Hovering a row surfaces the leg it belongs to (leg table
 *  row + map segment) via `onHoverLeg`. */
export function RouteIssuesPanel({ issues, hoveredLegIndex, onHoverLeg }: Props) {
  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-hairline bg-card px-3 py-2.5 shadow-sm">
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-ok bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] text-[10px] text-ok">
          ✓
        </span>
        <span className="text-xs text-muted">
          No route issues — terrain, obstacles, and runway fits all clear by
          margin.
        </span>
      </div>
    );
  }

  const dangerCount = issues.filter((i) => i.severity === "danger").length;
  const badgeSeverity = dangerCount > 0 ? "danger" : "caution";

  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <span className="text-sm font-semibold text-ink">Route issues</span>
        <span
          className={
            "rounded-full px-2 py-0.5 text-xs font-semibold " +
            (badgeSeverity === "danger"
              ? "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-danger"
              : "bg-[color-mix(in_srgb,var(--caution)_15%,transparent)] text-caution")
          }
        >
          {issues.length}
        </span>
      </div>
      <ul>
        {issues.map((issue, i) => {
          const isHovered = hoveredLegIndex === issue.legIndex;
          return (
            <li
              key={i}
              onMouseEnter={() => onHoverLeg(issue.legIndex)}
              onMouseLeave={() => onHoverLeg(null)}
              className={
                "flex gap-2.5 border-l-4 px-3 py-2.5 " +
                (i < issues.length - 1 ? "border-b border-b-hairline " : "") +
                (issue.severity === "danger"
                  ? "border-l-danger "
                  : "border-l-caution ") +
                (isHovered
                  ? "bg-[color-mix(in_srgb,var(--ink)_5%,transparent)]"
                  : "")
              }
            >
              <div className="flex-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs text-ink">
                    <strong className="font-mono">
                      <IssueIdentLinks ident={issue.ident} />
                    </strong>{" "}
                    {issue.message}
                  </span>
                  <span className="flex-shrink-0 whitespace-nowrap rounded bg-surface px-1.5 py-0.5 text-xs text-muted">
                    Leg {issue.legIndex + 1} · {PHASE_LABEL[issue.phase]}
                  </span>
                </div>
                {issue.detail && (
                  <div className="mt-0.5 text-xs text-muted">{issue.detail}</div>
                )}
                {issue.action && (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={issue.action.apply}
                      className="rounded border border-caution px-2 py-1 text-xs font-semibold text-caution hover:bg-[color-mix(in_srgb,var(--caution)_10%,transparent)]"
                    >
                      {issue.action.label}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-hairline bg-surface px-3 py-2 text-xs text-muted">
        Hovering an issue highlights its leg row and map segment.
      </div>
    </div>
  );
}
