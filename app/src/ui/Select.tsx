import { useEffect, useId, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Set when a <label htmlFor> points at the trigger. */
  id?: string;
  /** Accessible name when there's no associated <label>. */
  ariaLabel?: string;
  /** Classes for the trigger button (mirror the old <select> styling). */
  className?: string;
  title?: string;
}

/** A `<select>` replacement whose menu is a `position: fixed` layer
 *  anchored to the trigger's viewport rect — the same trick
 *  SavedTripsPopover uses. A native `<select>` inside a scrolled,
 *  clipped container (the mobile bottom sheet) has its popup
 *  mispositioned by the browser; rendering our own menu sidesteps that
 *  entirely and works the same on every layout. */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  className = "",
  title,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  }>({ left: 0, width: 0 });
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selectedLabel = options[selectedIndex]?.label ?? "";

  function place() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const MAX_H = 260;
    const estH = Math.min(MAX_H, options.length * 36 + 8);
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < estH && r.top > spaceBelow;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
      width: r.width,
      ...(openUp
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
    });
  }

  function openMenu() {
    place();
    setHighlight(selectedIndex);
    setOpen(true);
  }

  function close(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }

  function commit(i: number) {
    const opt = options[i];
    if (opt) onChange(opt.value);
    close();
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    // The fixed menu is anchored to the trigger's viewport rect, so keep
    // it glued to the trigger as the sheet scrolls (capture: true catches
    // the inner scroll container). Repositioning — rather than closing —
    // also means a scroll-into-view right as the menu opens can't snap it
    // shut.
    function reposition() {
      place();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      close(e.key === "Escape");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(highlight);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={className + " flex items-center justify-between gap-1 text-left"}
      >
        <span className="truncate">{selectedLabel}</span>
        <span aria-hidden="true" className="shrink-0 text-muted">
          ▾
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          id={listId}
          style={{
            position: "fixed",
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
            maxHeight: 260,
          }}
          className="z-40 overflow-y-auto rounded-md border border-hairline bg-card py-1 shadow-lg"
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(i)}
              className={
                "cursor-pointer px-2 py-1.5 text-sm text-ink " +
                (i === highlight ? "bg-surface " : "") +
                (o.value === value ? "font-semibold" : "")
              }
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
