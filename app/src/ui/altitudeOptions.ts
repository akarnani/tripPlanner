/** Cruise-altitude choices for the per-leg dropdown.
 *
 *  Below FL180, only the typical VFR levels (X,500) — the engine
 *  applies whatever the pilot picks verbatim (no hemispheric snap on
 *  an explicit override), so listing IFR thousands here would just
 *  clutter the dropdown without adding flexibility. The numeric input
 *  in CruisePanel covers the "I really want 6,000 ft IFR" case.
 *
 *  At FL180 and above (Class A, no +500 convention) every 1,000 ft
 *  through FL310 — enough to cover every current aircraft (SF50 tops
 *  out at FL280). */
export const CRUISE_ALT_OPTIONS = [
  3500, 4500, 5500, 6500, 7500, 8500, 9500, 10500, 11500, 12500, 13500, 14500,
  15500, 16500, 17500,
  18000, 19000, 20000, 21000, 22000, 23000, 24000, 25000, 26000, 27000, 28000,
  29000, 30000, 31000,
];

export function fmtFt(ft: number): string {
  return `${Math.round(ft).toLocaleString()} ft`;
}
