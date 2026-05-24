import { test, expect, type Page } from "@playwright/test";

/** The top header shows a "Loading airports…" pill that flips to
 *  "Airport database ready" once the dataset load resolves. Used by
 *  beforeEach to keep tests from racing the load — and it works
 *  regardless of which sidebar section is expanded. */
async function waitForDataReady(page: Page): Promise<void> {
  await expect(page.getByText("Airport database ready")).toBeVisible({
    timeout: 30_000,
  });
}

/** Wait for the auto-replan effect to render the leg table. Default
 *  origin/destination (KSEA/KBOI) are valid out of the box, so this
 *  reliably succeeds within a beat or two of dataReady — no Plan
 *  button click required. */
async function waitForRoute(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

async function parseMatchCount(page: Page): Promise<number> {
  // The match counter sits inside the Filters section and reads e.g.
  // "1,234 / 5,678". The label "Matching airports" sits above the
  // numeric line — anchor on it so we don't accidentally match a
  // similar-shaped string elsewhere.
  const label = page.getByText("Matching airports");
  const numericLine = label.locator("xpath=following-sibling::*[1]");
  const t = (await numericLine.textContent()) ?? "";
  const m = t.match(/([\d,]+)\s*\/\s*([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
}

/** Click a sidebar section header to expand it. The wizard accordion
 *  collapses every section by default except "Aircraft", so tests that
 *  need to reach controls inside the other sections must open them
 *  first. SidebarSection sets aria-label to the section title so this
 *  match is unambiguous. */
async function openSection(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  const expanded = await button.getAttribute("aria-expanded");
  if (expanded !== "true") await button.click();
  // Wait for the expanded transition to actually settle — otherwise a
  // follow-up locator can resolve to an element that React unmounts
  // mid-click while the accordion shifts.
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

/** Fill the Trip step's From / To inputs and wait for the auto-replan
 *  effect to render the leg table. Most tests start from an empty
 *  origin/destination (the app no longer prefills KSEA/KBOI so a
 *  single keystroke doesn't surprise-advance the wizard). */
/** Read the displayed first-leg cruise altitude from the LegTable.
 *  In auto mode (no override), the select value is "auto" and the
 *  actual altitude is shown in the option label as e.g. "auto (6,500)";
 *  when overridden, the value is the bare number. Returns the
 *  altitude as a string without comma separators. */
async function firstLegAltitude(page: Page): Promise<string> {
  const select = page
    .locator("table tbody tr")
    .first()
    .locator("select")
    .first();
  const value = await select.inputValue();
  if (value !== "auto") return value;
  const firstOption = select.locator("option").first();
  const text = (await firstOption.textContent()) ?? "";
  const m = text.match(/\(([\d,]+)\)/);
  return (m?.[1] ?? "").replace(/,/g, "");
}

async function fillRoute(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await openSection(page, "Trip");
  await page.getByLabel("From", { exact: true }).fill(from);
  const toInput = page.getByLabel("To", { exact: true });
  await toInput.fill(to);
  // Playwright leaves focus on the filled input; the wizard pauses
  // auto-advance while focus is inside the section, so we explicitly
  // blur to release the pause.
  await toInput.blur();
  await waitForRoute(page);
  // Filling both inputs marks Trip "touched" and schedules a wizard
  // auto-advance (~1.5s). Wait for it to fire — otherwise the timer
  // can collapse Trip mid-click on subsequent interactions and detach
  // DOM under Playwright. Tests that need to interact with Trip
  // afterwards should call openSection(page, "Trip") explicitly.
  await expect(
    page.getByRole("button", { name: "Trip", exact: true }),
  ).toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });
}

test.describe("trip planner smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Trip Planner" }),
    ).toBeVisible();
    await waitForDataReady(page);
  });

  test("renders the planning UI with default values", async ({ page }) => {
    await openSection(page, "Trip");
    // Origin / destination start empty — the app intentionally doesn't
    // prefill them because the first keystroke would otherwise mark the
    // step touched while the (now stale) defaults were still valid and
    // surprise-advance the wizard.
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("");
    // The VFR / IFR toggle is a segmented control; the active segment
    // gets the seg-btn-active class (white background, dark text).
    await expect(page.getByRole("button", { name: "VFR" })).toHaveClass(
      /seg-btn-active/,
    );
  });

  test("auto-replans on settings change and renders a leg table with per-leg altitude + course", async ({
    page,
  }) => {
    // No Plan button anymore — auto-replan fires after the user fills
    // a valid origin/destination pair.
    await fillRoute(page, "KSEA", "KBOI");

    await expect(page.getByRole("columnheader", { name: "Alt" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "MC" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "NM" })).toBeVisible();

    const firstLegCell = page
      .locator("table tbody tr")
      .first()
      .locator("td")
      .first();
    await expect(firstLegCell).toContainText("KSEA");

    // Eastbound, VFR target 6500 → first-leg altitude lands on
    // odd-thousand + 500. The Alt cell is a <select>; un-overridden
    // legs read "auto" as the value, with the actual altitude in the
    // option label.
    expect(await firstLegAltitude(page)).toMatch(/500$/);
  });

  test("flipping VFR → IFR drops the +500 from every leg altitude", async ({
    page,
  }) => {
    await fillRoute(page, "KSEA", "KBOI");
    const vfrAlt = await firstLegAltitude(page);
    expect(vfrAlt).toMatch(/500$/);

    // Flip to IFR — auto-replan fires after the debounce, so just wait
    // for the first-leg altitude to change. fillRoute left Trip
    // expanded, but the touched-flag advance may have collapsed it by
    // now; openSection is a no-op if already open.
    await openSection(page, "Trip");
    await page.getByRole("button", { name: "IFR" }).click();
    await expect
      .poll(() => firstLegAltitude(page), { timeout: 30_000 })
      .not.toBe(vfrAlt);
    const ifrAlt = await firstLegAltitude(page);
    expect(ifrAlt).toMatch(/000$/);
  });

  test("flight rule pill updates the helper text", async ({ page }) => {
    await openSection(page, "Trip");
    await expect(
      page.getByText("Cruise altitudes round to odd-/even-thousands + 500."),
    ).toBeVisible();
    await page.getByRole("button", { name: "IFR" }).click();
    await expect(
      page.getByText("Cruise altitudes round to odd/even thousands."),
    ).toBeVisible();
  });

  test("min-runway filter changes the airport match count", async ({
    page,
  }) => {
    await openSection(page, "Airport filters");
    const before = await parseMatchCount(page);
    await page.getByLabel("Minimum runway length (ft)").fill("8000");
    await expect.poll(() => parseMatchCount(page)).not.toBe(before);
  });

  test("Precision approach filter restricts the match count below 'no filter'", async ({
    page,
  }) => {
    await openSection(page, "Airport filters");
    const select = page.getByLabel("Approach");
    if (!(await select.isEnabled())) test.skip();

    await select.selectOption("off");
    await expect.poll(() => parseMatchCount(page)).toBeGreaterThan(0);
    const offCount = await parseMatchCount(page);

    await select.selectOption("any");
    await expect
      .poll(() => parseMatchCount(page), { timeout: 5000 })
      .toBeLessThan(offCount);
    const anyCount = await parseMatchCount(page);
    expect(anyCount).toBeGreaterThan(0);

    await select.selectOption("precision");
    await expect
      .poll(() => parseMatchCount(page), { timeout: 5000 })
      .toBeLessThan(anyCount);
    const precCount = await parseMatchCount(page);
    expect(precCount).toBeGreaterThan(0);

    await select.selectOption("rnav");
    await expect
      .poll(() => parseMatchCount(page), { timeout: 5000 })
      .toBeGreaterThan(0);
  });

  test("min-safe replan bumps the target altitude when terrain dictates", async ({
    page,
  }) => {
    await fillRoute(page, "KSEA", "KBOI");

    // Target altitude now lives in the right-rail CruisePanel rather
    // than the Aircraft step — it's already visible alongside the route.
    const targetInput = page.getByLabel("Target altitude (ft)");
    const before = Number((await targetInput.inputValue()) ?? "0");

    const replan = page.getByRole("button", {
      name: /Replan with .* ft target/,
    });
    if (await replan.isVisible()) {
      await replan.click();
      await expect(targetInput).not.toHaveValue(String(before));
      const after = Number(await targetInput.inputValue());
      expect(after).toBeGreaterThan(before);
    }
  });

  test("cruise-altitude quick-pick chip changes the planned route", async ({
    page,
  }) => {
    // The CruisePanel in the right rail exposes quick-pick chips for
    // common VFR altitudes. Clicking a different chip flips the target
    // altitude state, the auto-replan fires, and the first-leg alt
    // updates accordingly.
    await fillRoute(page, "KSEA", "KBOI");
    const before = await firstLegAltitude(page);

    await page
      .getByRole("button", { name: "10,500", exact: true })
      .click();
    await expect
      .poll(() => firstLegAltitude(page), { timeout: 30_000 })
      .not.toBe(before);
  });

  test("GPX export downloads a non-empty file", async ({ page }) => {
    await fillRoute(page, "KSEA", "KBOI");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "GPX" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.gpx$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    expect(body).toContain("<gpx");
    expect(body).toContain("KSEA");
    expect(body).toContain("KBOI");
  });

  test("interactive mode swaps the trip panel and shows range info", async ({
    page,
  }) => {
    // The Build interactively button is gated on resolved origin /
    // destination — fill the route first.
    await fillRoute(page, "KSEA", "KBOI");
    await openSection(page, "Trip");
    // Entering interactive mode hides the auto-plan controls and
    // brings up the InteractivePanel with the stop chain and range
    // numbers. With no stops yet, the origin → destination leg is
    // the entire route.
    await page.getByRole("button", { name: "Build interactively →" }).click();
    await expect(
      page.getByRole("button", { name: "Switch to auto plan" }),
    ).toBeVisible();
    // The leg table now reflects the interactive build.
    await expect(
      page.getByRole("button", { name: /Interactive build · \d+ stop/ }),
    ).toBeVisible({ timeout: 5_000 });
    // Range numbers are populated (any value over zero).
    await expect(page.getByText(/Range from here/)).toBeVisible();
    // Returning to auto mode brings auto-replan back online.
    await page.getByRole("button", { name: "Switch to auto plan" }).click();
    await waitForRoute(page);
  });

  test("wizard auto-advances from Aircraft to Trip after user interaction", async ({
    page,
  }) => {
    // Aircraft is expanded by default. Changing the reserve input
    // marks the step touched; after ~1.5s the wizard auto-advances to
    // the Trip step (Aircraft collapses, Trip expands).
    const aircraftBtn = page.getByRole("button", {
      name: "Aircraft",
      exact: true,
    });
    const tripBtn = page.getByRole("button", { name: "Trip", exact: true });
    await expect(aircraftBtn).toHaveAttribute("aria-expanded", "true");
    await expect(tripBtn).toHaveAttribute("aria-expanded", "false");

    const reserve = page.getByLabel("Reserve (min)");
    await reserve.fill("60");
    // Blur so the focus-pause doesn't keep the timer suppressed; the
    // wizard should then advance within its ~1.5 s grace period.
    await reserve.blur();
    await expect(tripBtn).toHaveAttribute("aria-expanded", "true", {
      timeout: 5_000,
    });
    await expect(aircraftBtn).toHaveAttribute("aria-expanded", "false");
  });

  test("per-leg altitude select overrides the auto-picked level", async ({
    page,
  }) => {
    // The LegTable's Alt cell is a <select> in auto mode. Un-overridden
    // legs read "auto" as the select value, with the actual altitude
    // shown in the option label. Picking a specific number overrides
    // that leg's altitude without re-running the optimizer.
    await fillRoute(page, "KSEA", "KBOI");
    const firstAltSelect = page
      .locator("table tbody tr")
      .first()
      .locator("select")
      .first();
    await expect(firstAltSelect).toHaveValue("auto");
    // Pick an altitude. 10,500 and 8,500 are both in CRUISE_ALT_OPTIONS;
    // either will register as an override.
    await firstAltSelect.selectOption("10500");
    await expect(firstAltSelect).toHaveValue("10500");
    // The override should also tint the select orange — the class
    // signal is part of the public contract with the user (it tells
    // them the cell is now custom).
    await expect(firstAltSelect).toHaveClass(/bg-orange-50/);
    // Reverting via "auto" should drop the override and return to the
    // planner-picked value.
    await firstAltSelect.selectOption("auto");
    await expect(firstAltSelect).toHaveValue("auto");
    await expect(firstAltSelect).not.toHaveClass(/bg-orange-50/);
  });

  test("wizard auto-advance pauses while a field stays focused", async ({
    page,
  }) => {
    // The wizard should never yank a section closed under the cursor
    // mid-edit. We type into Trip's From input and keep focus there
    // past the normal 1.5 s deadline; Trip must stay expanded. Once we
    // blur, the advance fires.
    await openSection(page, "Trip");
    const tripBtn = page.getByRole("button", { name: "Trip", exact: true });
    const runwayBtn = page.getByRole("button", {
      name: "Runway check",
      exact: true,
    });

    const from = page.getByLabel("From", { exact: true });
    const to = page.getByLabel("To", { exact: true });
    await from.fill("KSEA");
    await to.fill("KBOI");
    // Focus is on To. Both endpoints are valid — without focus pause,
    // the wizard would advance ~1.5 s after the last keystroke. Wait
    // 2.5 s and assert Trip is still open.
    await page.waitForTimeout(2500);
    await expect(tripBtn).toHaveAttribute("aria-expanded", "true");
    await expect(runwayBtn).toHaveAttribute("aria-expanded", "false");

    // Blur — the focus-pause lifts, the scheduling effect re-runs,
    // and the wizard advances within its grace period.
    await to.blur();
    await expect(runwayBtn).toHaveAttribute("aria-expanded", "true", {
      timeout: 5_000,
    });
    await expect(tripBtn).toHaveAttribute("aria-expanded", "false");
  });
});
