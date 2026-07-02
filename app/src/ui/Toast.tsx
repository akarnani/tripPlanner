import { useEffect } from "react";

export interface ToastData {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface Props {
  toast: ToastData | null;
  onDismiss: () => void;
  /** Lifts the toast above the docked route-profile panel. */
  raised?: boolean;
}

const AUTO_DISMISS_MS = 6000;

/** Bottom-center overlay toast. Render inside a `relative` parent
 *  (e.g. the map container) so the absolute positioning here is
 *  scoped to it. Auto-dismisses after ~6 s; callers are responsible
 *  for only ever having one toast queued at a time. */
export function Toast({ toast, onDismiss, raised }: Props) {
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div
      className={
        "pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 " +
        (raised ? "bottom-[calc(28%+1rem)]" : "bottom-4")
      }
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-md bg-ink px-4 py-2.5 text-card shadow-lg">
        <span className="text-xs">{toast.message}</span>
        {toast.actionLabel && toast.onAction && (
          <button
            type="button"
            onClick={() => {
              toast.onAction?.();
              onDismiss();
            }}
            className="text-xs font-semibold text-accent hover:underline"
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
