import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

const STORAGE_KEY = "theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "auto" || stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to default.
  }
  return "auto";
}

function prefersDark(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia(MEDIA_QUERY).matches;
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === "auto") return prefersDark() ? "dark" : "light";
  return preference;
}

export function ThemeProvider(props: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(),
  );
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolve(preference),
  );

  useEffect(() => {
    setResolved(resolve(preference));

    if (preference !== "auto" || typeof matchMedia !== "function") return;

    const mql = matchMedia(MEDIA_QUERY);
    const onChange = () => setResolved(resolve("auto"));
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [preference]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // localStorage unavailable — preference just won't persist.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center rounded border border-hairline bg-card p-0.5"
    >
      {OPTIONS.map(({ value, label }) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-pressed={selected}
            onClick={() => setPreference(value)}
            className={
              selected
                ? "rounded bg-accent px-2 py-1 text-xs font-medium text-white"
                : "rounded px-2 py-1 text-xs font-medium text-muted hover:text-ink"
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
