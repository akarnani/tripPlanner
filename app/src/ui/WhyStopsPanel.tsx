import { useState } from "react";
import { AirportLink } from "./AirportLink";
import { useMediaQuery } from "./useMediaQuery";
import type { StopAlternative, StopExplanation } from "@/engine/stopAlternatives";

interface Props {
  /** Lazily computed on first expand — may be moderately expensive. */
  getExplanations: () => StopExplanation[];
  /** Hover an alternative row → highlight that airport on the map. */
  onHoverAirport?: (ident: string | null) => void;
}

function identOf(alt: StopAlternative): string {
  return alt.airport.icao ?? alt.airport.lid;
}

function reasonClass(verdict: StopAlternative["verdict"]): string {
  // "shorter" is an actionable win, not a knock against the airport —
  // tint it positive. runway-short / over-leg-cap are cautions;
  // tie / costlier are neutral.
  if (verdict === "shorter") return "text-ok";
  if (verdict === "tie" || verdict === "costlier") return "text-muted";
  return "text-caution";
}

/** Collapsed-by-default disclosure for the bottom of the right rail
 *  explaining why the auto-planner picked each intermediate stop over
 *  nearby alternatives. Deliberately does not persist open state (unlike
 *  Section.tsx) — this is a rarely-used "why" drill-down, not a control
 *  the pilot wants to leave open across trips. `getExplanations` is
 *  only called once, on first expand, and memoized after that so
 *  re-collapsing/re-expanding doesn't recompute it. */
export function WhyStopsPanel({ getExplanations, onHoverAirport }: Props) {
  const [open, setOpen] = useState(false);
  const [explanations, setExplanations] = useState<StopExplanation[] | null>(
    null,
  );
  // Touch has no hover; tap an alternative to toggle its map highlight.
  const coarse = useMediaQuery("(pointer: coarse)");
  const [tappedIdent, setTappedIdent] = useState<string | null>(null);

  // Once we know (post-expand) that there's nothing to explain — a
  // direct route with no intermediate stops — hide the whole
  // disclosure rather than show an empty shell.
  if (explanations !== null && explanations.length === 0) {
    return null;
  }

  function handleToggle() {
    if (!open && explanations === null) {
      setExplanations(getExplanations());
    }
    setOpen((prev) => !prev);
  }

  return (
    <div className="overflow-hidden rounded-md border border-hairline bg-card shadow-sm">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="flex min-h-[24px] w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="text-sm font-semibold text-ink">Why these stops?</span>
        <span
          aria-hidden="true"
          className={
            "inline-flex h-6 w-6 flex-shrink-0 items-center justify-center text-muted transition-transform " +
            (open ? "rotate-90" : "")
          }
        >
          ▸
        </span>
      </button>
      {open && explanations && explanations.length > 0 && (
        <div className="border-t border-hairline">
          <div className="divide-y divide-hairline">
            {explanations.map((exp) => (
              <div key={exp.stopId} className="px-3 py-2.5">
                {exp.pinned ? (
                  <>
                    <div className="text-xs font-semibold text-ink">
                      <span className="font-mono">
                        <AirportLink ident={exp.stopIdent} />
                      </span>{" "}
                      — pinned by you
                    </div>
                    <p className="mt-1.5 text-xs text-muted">
                      Alternatives aren't scored for stops you pinned.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-xs font-semibold text-ink">
                      <span className="font-mono">
                        <AirportLink ident={exp.stopIdent} />
                      </span>{" "}
                      — chosen stop
                    </div>
                    {exp.alternatives.length === 0 ? (
                      <p className="mt-1.5 text-xs text-muted">
                        Only airport in range that fits your filters.
                      </p>
                    ) : (
                      <ul className="mt-1.5 space-y-0.5">
                        {exp.alternatives.map((alt) => (
                          <li
                            key={alt.airport.id}
                            onMouseEnter={
                              coarse
                                ? undefined
                                : () => onHoverAirport?.(identOf(alt))
                            }
                            onMouseLeave={
                              coarse ? undefined : () => onHoverAirport?.(null)
                            }
                            onClick={
                              coarse
                                ? () => {
                                    const id = identOf(alt);
                                    const next = tappedIdent === id ? null : id;
                                    setTappedIdent(next);
                                    onHoverAirport?.(next);
                                  }
                                : undefined
                            }
                            className={
                              "flex min-h-[24px] flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-1 py-1 hover:bg-surface " +
                              (coarse ? "cursor-pointer " : "") +
                              (coarse && tappedIdent === identOf(alt)
                                ? "bg-surface"
                                : "")
                            }
                          >
                            <span className="shrink-0 font-mono text-xs font-semibold text-ink">
                              <AirportLink ident={identOf(alt)} />
                            </span>
                            <span
                              className={"text-xs " + reasonClass(alt.verdict)}
                            >
                              {alt.reason}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-hairline bg-surface px-3 py-2 text-xs text-muted">
            The planner minimizes total time with fuel as a hard reserve
            floor — landing with extra fuel is never penalized.
          </div>
        </div>
      )}
    </div>
  );
}
