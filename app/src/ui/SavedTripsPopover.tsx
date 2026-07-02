import { useEffect, useRef, useState } from "react";
import type { SavedTrip } from "@/data/trips";
import { TripsPanel } from "./TripsPanel";

interface Props {
  trips: SavedTrip[];
  /** Default name suggestion in the save input, e.g. the current
   *  origin → destination pair. */
  defaultName: string;
  onSave: (name: string) => void;
  onLoad: (trip: SavedTrip) => void;
  onDelete: (name: string) => void;
}

/** Header button + popover wrapper around `TripsPanel` — moves saved
 *  trips out of the sidebar body and into a compact menu. Closes on
 *  outside click and Escape. */
/** Popover panel width (px). Fixed so the open position can be
 *  clamped to the viewport before the panel renders. */
const PANEL_W = 320;

export function SavedTripsPopover({ trips, defaultName, onSave, onLoad, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  // Viewport coordinates for the panel. `position: fixed` (instead of
  // absolute next to the button) because the button lives inside the
  // sidebar's overflow-y-auto scroll container, which clips anything
  // that pokes outside it — and a 320px panel anchored to a button in
  // a 320px sidebar always pokes outside it.
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next && buttonRef.current) {
        const r = buttonRef.current.getBoundingClientRect();
        setPanelPos({
          top: r.bottom + 8,
          // Keep the whole panel on-screen: prefer left-aligning with
          // the button, clamp to the right viewport edge, never go
          // past the left one.
          left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)),
        });
      }
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        className="rounded border border-hairline bg-card px-2.5 py-1.5 text-xs text-muted hover:text-ink"
      >
        Saved trips ▾
      </button>
      {open && (
        <div
          style={{ top: panelPos.top, left: panelPos.left, width: PANEL_W }}
          className="fixed z-30 rounded-md border border-hairline bg-card p-3 shadow-lg"
        >
          <TripsPanel
            trips={trips}
            defaultName={defaultName}
            onSave={onSave}
            onLoad={(trip) => {
              onLoad(trip);
              setOpen(false);
            }}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  );
}
