import { useEffect, useState } from "react";

/** Subscribe to a CSS media query and re-render when it flips.
 *  Falls back to `false` where `matchMedia` isn't available. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof matchMedia !== "function") return false;
    return matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mql = matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
