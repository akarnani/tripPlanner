# Mobile Responsiveness Plan & Design

_Status: proposal (no code yet). Target branch: `claude/mobile-responsiveness-plan-vsxuq6`._

## 1. Why it's broken today

The app is a hardcoded **three-column desktop layout with zero responsive
design** — there is not a single `sm:`/`md:`/`lg:` breakpoint anywhere in
`app/src`. The root render (`App.tsx:1301`) is one non-wrapping horizontal
flex row:

```
┌───────────────┬──────────────────────────┬───────────────┐
│ left <aside>  │      <main> map          │  right <aside>│
│ w-80 (320px)  │      flex-1              │  w-80 (320px) │
│ shrink-0      │                          │  shrink-0     │
│ inputs        │  MapLibre + overlays     │  legs/results │
└───────────────┴──────────────────────────┴───────────────┘
```

- **The two rails alone demand 640px** before the map gets a single pixel.
  Both are `shrink-0`, so on a 375px phone the row overflows and is clipped.
- **`<body class="h-screen w-screen overflow-hidden">`** (`index.html:22`)
  locks the viewport — there is no document scroll to fall back on. Anything
  that doesn't fit is simply cut off.
- **No page-scroll escape hatch**, no stacking, no drawers. The layout has
  exactly one shape.

Everything below flows from fixing that shell, then making the touch
interactions work.

### Secondary breakages (catalogued)

| Area | Problem | Files |
|---|---|---|
| Fixed rails | Two `w-80 shrink-0` columns = 640px hard floor | `App.tsx:1302,1568` |
| Body scroll | `overflow-hidden` on body, everything on `h-full` | `index.html:22`, `index.css` |
| Results table | `<table>` with every cell `whitespace-nowrap`; overflows instead of reflowing; tuned "to fit the 320px rail" | `LegTable.tsx:167,193` |
| Aircraft inputs | `grid grid-cols-3` of 6-digit numeric fields | `AircraftPanel.tsx:47` |
| Trip inputs | `grid grid-cols-2` origin/dest | `TripPanel.tsx:30` |
| Profile dock | `absolute bottom-0 h-[28%] min-h-[150px]` over the map | `RouteProfile.tsx:426` |
| Magic offsets | Toast / legend / stale-banner hardcode `bottom-[calc(28%+…)]` coupled to the dock height | `Toast.tsx:34`, `MapLegend.tsx:98`, `App.tsx:1536` |
| Popover | `SavedTripsPopover` fixed 320px, clamps X but not Y | `SavedTripsPopover.tsx:20,42` |
| Legend | fixed `w-44`, `absolute left-3 bottom-3` | `MapLegend.tsx:96` |
| Touch targets | map dots 12px; row action buttons `h-6 w-6` (24px); inputs ~28px tall | `MapView.tsx:293`, `LegTable.tsx:278` |

### Touch-hostile interactions (functional, not cosmetic)

- **Pinned-stop reordering uses HTML5 drag-and-drop** (`PinnedStops.tsx:144`)
  — DnD events **do not fire on touch**, so reordering is fully broken on
  mobile.
- **Map airport tooltips are hover-only** (`mouseenter`/`mouseleave`,
  `MapView.tsx:919`). Interactive mode already has a **tap-to-pin** popup with
  an "Add stop" button (a good template), but the default browse tooltip has
  no touch equivalent.
- **Cross-panel highlight sync** (leg row ⇄ map ⇄ route-issues ⇄ profile) is
  driven entirely by `onMouseEnter`/`onMouseLeave` in `LegTable`,
  `RouteIssuesPanel`, `WhyStopsPanel`, `InteractivePanel`. No tap path.
- **`title=` tooltips** scattered across panels — never appear on touch.
- **Drag-to-move a stop** on the map (`MapView.tsx:564`) sets
  `touch-action:none` so it _may_ work, but a 12px target fights map panning.
- **Profile wheel-zoom** is desktop-only (`wheel` listener).

### What already helps

- `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
  is present, so we won't render at desktop zoom.
- The planner already runs in a **web worker** (`usePlanner.ts`), so the heavy
  compute won't jank a mobile main thread — the `flushSync` + double-rAF
  spinner pattern must be preserved.
- `Section` accordion **persists collapse state in localStorage** — reusable
  for a "collapsed by default on mobile" strategy.
- `InteractivePanel`, `WhyStopsPanel`, `ExcludedAirports` already use
  `flex-wrap`.

---

## 2. Goals & scope

**Goal:** the full planning workflow — set trip, plan, read legs/issues,
inspect the route on the map, export — works on phones, tablets, and
touchscreens, while the desktop experience stays **pixel-identical**.

**Target matrix:**

- Phone portrait: 360–430px (design floor 360px).
- Phone landscape / small tablet: 480–767px.
- Tablet: 768–1023px.
- Desktop: ≥1024px — **unchanged**.

**Non-goals:** no engine/routing changes, no visual redesign of desktop, no
new features. This is layout + interaction adaptation only.

**Principles:**

1. The **map is the hero** on small screens; inputs and results become
   summonable overlays, not permanent columns.
2. **Additive** — wrap the existing desktop layout in `lg:` and introduce
   mobile/tablet layouts below it, rather than rewriting the desktop path.
3. **Every hover affordance needs a tap equivalent**; no information should be
   reachable only by hovering.

---

## 3. Responsive layout model

Three layouts keyed off Tailwind's default breakpoints (already available,
just unused):

### Desktop — `lg:` ≥1024px (unchanged)

The current three-column flex, verbatim. We add `lg:` prefixes so it only
applies at this width; below `lg`, the mobile/tablet layout takes over.

### Tablet — `md:` 768–1023px

Two zones: **map + one dockable side panel.**

- Keep the map as `flex-1`.
- Collapse the **left inputs** into a slide-in drawer opened from a top-bar
  button (the inputs are transient — you set them, you plan, you don't need
  them pinned).
- Keep the **right results rail**, but narrower (`md:w-72`) and collapsible.
- Rationale: a tablet has room for map + results side by side; inputs are the
  thing you can afford to hide behind a toggle.

### Mobile — base (<768px)

**Full-screen map + a bottom sheet, coordinated by a bottom tab bar.**

```
┌─────────────────────────────┐
│  top app bar                │  ← title · ☰ inputs · saved · theme
├─────────────────────────────┤
│                             │
│                             │
│        MAP (hero)           │
│                             │
│                             │
├─────────────────────────────┤
│  ▁▁ drag handle ▁▁          │  ← bottom sheet (peek → half → full)
│  [Plan] [Route] [Issues]    │  ← segmented control inside the sheet
│  …content for active tab…   │
├─────────────────────────────┤
│  ⬤ Map   ◯ Plan   ◯ Route   │  ← optional bottom tab bar
└─────────────────────────────┘
```

**Recommended pattern: a single draggable bottom sheet** with three detents
(peek ~15%, half ~50%, full ~90%) and an internal segmented control switching
between **Plan** (all the input Sections), **Route** (LegTable + export), and
**Issues** (RouteIssuesPanel + WhyStops). The map is always behind it and
fully interactive when the sheet is at peek.

Why a bottom sheet over off-canvas drawers or full-screen tabs:

- Keeps the map visible while you tweak inputs and watch the route redraw —
  the core value of the app is the map, and a drawer that fully hides it loses
  that feedback loop.
- One coherent gesture surface (drag up/down) instead of two separate
  drawers with different open affordances.
- The existing **sticky Plan-trip footer** (`App.tsx:1428`) maps naturally to
  a persistent action bar pinned at the bottom of the sheet.

Alternatives considered (documented so the choice is revisitable):

- **Off-canvas drawers** (hamburger = inputs, results slide up): more familiar
  but two mental models, and inputs fully hide the map.
- **Full-screen tab switch** (Map / Plan / Results as exclusive screens):
  simplest to build, but you lose the "edit-and-watch-the-map" loop entirely.

If you'd prefer drawers or tabs over the bottom sheet, that's the one
high-level product decision worth confirming before implementation — it
changes roughly how the shell and overlays are structured, though the
component-level work in §4–§5 is the same either way.

---

## 4. Component-level changes

### Shell & chrome

- **`index.html`**: drop `overflow-hidden` from `<body>` (or scope it to
  `lg:`); switch the root height to **`100dvh`** (dynamic viewport height) so
  the mobile URL bar doesn't cover content; add
  `viewport-fit=cover` and honor `env(safe-area-inset-*)` on the top bar and
  bottom sheet.
- **`App.tsx` root**: replace `flex h-full w-full` with a layout that is
  column-stacked below `lg` and the current row at `lg`. Left/right `<aside>`
  become the drawer / bottom-sheet content, conditionally rendered by
  breakpoint (CSS-driven where possible so both DOMs don't mount at once on
  desktop; the right rail's "always mounted so the map doesn't reflow" note
  only matters at `lg`).
- **New mobile top app bar**: title, ☰ (open inputs / sheet Plan tab), saved
  trips, theme toggle. Reuses existing `SavedTripsPopover` and `ThemeToggle`.
- **New bottom sheet component**: draggable with detents, focus-trapped when
  full, dismiss on backdrop tap. Hosts the segmented control + the existing
  panels unchanged.

### Map & overlays

- MapLibre pinch-zoom/pan already work on touch — mainly a sizing win once the
  map goes full-width.
- **Decouple overlay offsets** from the profile dock's `28%`: replace the
  hardcoded `bottom-[calc(28%+…)]` in Toast / MapLegend / stale-banner with a
  layout that measures the dock (or a CSS variable), since the dock becomes a
  sheet on mobile.
- **Enlarge nav controls** and bump map marker hit areas toward ~24–44px on
  coarse pointers (transparent padding around the 12px dot; use a
  `(pointer: coarse)` media query rather than penalizing desktop density).
- Move overlays that collide on a narrow map: legend becomes a collapsible
  chip; FirstRunHint and stale banner become full-width, safe-area-aware
  toasts.

### Route profile

- On mobile, render the profile as **a detent of the bottom sheet** (or its
  own sheet) rather than a 28%/150px `absolute` overlay, so it doesn't eat a
  full-width short map. Drop `min-h-[150px]` below `md`.

### Forms

- **`AircraftPanel` `grid-cols-3` → `grid-cols-1 sm:grid-cols-3`** (stack the
  three numeric inputs on phones).
- **`TripPanel` `grid-cols-2` → stack below `sm`**.
- Ensure text inputs use **≥16px font on mobile** to prevent iOS auto-zoom on
  focus; give controls a **44px min tap height** via a `(pointer: coarse)`
  rule.
- `FilterPanel` is already single-column — leave it.

### Results

- **`LegTable`**: the `<table>` with `whitespace-nowrap` needs a mobile
  treatment. Two options: (a) wrap it in an `overflow-x-auto` scroller
  (cheapest, preserves the exact table), or (b) a **card-per-leg** layout
  below `md` (better ergonomics, more work). **Recommend (a) first, (b) as
  polish.** Either way, bump the `h-6 w-6` row action buttons for touch.
- `RouteIssuesPanel` / `WhyStopsPanel` already reflow — just verify at 360px.

### Popovers / menus

- **`SavedTripsPopover`**: clamp `top` as well as `left`, or promote to a
  centered sheet/dialog below `sm` (a 320px popover on a 360px screen should
  just be full-width).

### Exports

- `ExportPanel`'s three `flex-1` buttons are fine full-width; allow them to
  wrap below the narrowest widths. **QA note:** iOS Safari blob-download
  (`<a download>.click()`) is historically flaky — verify GPX/FPL/PDF actually
  save on iOS, and add a fallback (open in new tab) if needed.

---

## 5. Touch interaction parity

The rule: **anything reachable by hover must be reachable by tap.** Concrete
conversions:

- **Cross-panel highlight sync**: today `hoveredLegIndex` is set on
  `mouseenter`. Add **tap-to-select** on touch (tap a leg row → highlights the
  leg on the map and scrolls the profile; tap again / tap elsewhere to
  clear). Keep hover for mouse; drive both through the same
  `hoveredLegIndex`/`highlightIdent` state.
- **Map airport info**: extend the interactive-mode tap-to-pin popup pattern
  to browse mode so a tap shows the airport info card with actions (it already
  exists for interactive mode — generalize it).
- **Pinned-stop reordering**: replace HTML5 DnD (broken on touch) with either
  up/down arrow buttons or a pointer-events-based drag (works on both mouse
  and touch). Arrows are the lower-risk choice.
- **`title=` tooltips**: for any that carry non-decorative info, surface the
  same text via a tap target (info affordance) on coarse pointers.
- **Drag-to-move a stop on the map**: on touch this is error-prone; keep it
  for mouse, and ensure the tap-to-open airport card offers an explicit
  "replace/move stop" action as the touch path (the replace flow already
  exists via the leg table).
- **Profile wheel-zoom**: add pinch-to-zoom on the profile touch surface, or
  accept map-driven zoom only on mobile.

---

## 6. Testing

- **Playwright** currently has only a `Desktop Chrome` project
  (`playwright.config.ts:16`). Add **`iPhone 13` (Mobile Safari) and
  `Pixel 5` (Mobile Chrome)** projects using `devices[...]`, plus a tablet
  viewport.
- Extend `tests/e2e/smoke.spec.ts` (or add a `mobile.spec.ts`) to assert:
  no horizontal document overflow at 360px; the map is visible; the bottom
  sheet opens and switches tabs; a plan can be run and legs appear; export
  buttons are reachable.
- Manual device pass: iOS Safari (URL-bar/`dvh`, safe areas, blob download),
  Android Chrome, landscape orientations.
- Regression guard: a `lg` snapshot to confirm the desktop layout is
  byte-for-byte unchanged.

---

## 7. Phasing

**Phase 1 — Layout shell (the 80% win).**
Responsive root, `dvh`, drop the body scroll-lock, top app bar + bottom sheet,
route the existing panels into it, stack the `grid-cols-2/3` forms, wrap the
leg table in a horizontal scroller. After this the app is _usable_ on a phone.

**Phase 2 — Touch parity.**
Tap-to-select highlight sync, generalize the tap-to-pin airport card, replace
pinned-stop DnD, min tap sizes, coarse-pointer marker/control sizing.

**Phase 3 — Polish.**
Profile-as-sheet, decouple overlay offsets from the 28% magic number,
popover→sheet promotion, card-per-leg table, safe-area insets, iOS export
fallback, Playwright mobile projects + tests.

Each phase is independently shippable and leaves desktop untouched.

---

## 8. Risks & watch-items

- **Preserve the planning-spinner pattern** (`flushSync` + double-rAF +
  `MIN_SPINNER_MS` in `handlePlan`) when the Plan button moves into the sheet.
- **Don't double-mount** the heavy `App` state or the map across
  breakpoints — one `App`, CSS/conditional-rendered chrome.
- **`dvh` support** is good on modern iOS/Android but verify the fallback
  (`vh`) doesn't clip the bottom action bar behind the URL bar.
- **iOS blob downloads** (exports) — highest-risk functional item; test early.
- **Map performance** on low-end phones with the full airport layer — profile
  if the candidate set is large.
