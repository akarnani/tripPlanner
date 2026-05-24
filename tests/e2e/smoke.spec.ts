import { test, expect, type Page } from "@playwright/test";

/** The top header shows a "Loading airports…" pill that flips to
 *  "Airport database ready" once the dataset load resolves. Used by
 *  beforeEach to keep tests from racing the load — and it works
 *  regardless of which sidebar section is expanded, unlike the
 *  Plan-trip button (which only renders when Trip is expanded). */
async function waitForDataReady(page: Page): Promise<void> {
  await expect(page.getByText("Airport database ready")).toBeVisible({
    timeout: 30_000,
  });
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
 *  collapses every section by default except "Aircraft & cruise", so
 *  tests that need to reach controls inside the other sections must
 *  open them first. Idempotent: if the section is already expanded
 *  we no-op. SidebarSection sets aria-label to the section title so
 *  this match is unambiguous. */
async function openSection(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  const expanded = await button.getAttribute("aria-expanded");
  if (expanded !== "true") await button.click();
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
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("KSEA");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("KBOI");
    // The VFR / IFR toggle is a segmented control; the active segment
    // gets the seg-btn-active class (white background, dark text).
    await expect(page.getByRole("button", { name: "VFR" })).toHaveClass(
      /seg-btn-active/,
    );
  });

  test("Plan button shows a spinner state while computing", async ({
    page,
  }) => {
    await openSection(page, "Trip");
    // The Plan button exposes a data-state attribute that's "idle"
    // before the click, "planning" during compute (≥ MIN_SPINNER_MS),
    // and "loading" while datasets are loading.
    //
    // Polling for the transient "planning" state from the test runner
    // with toHaveAttribute is racy on slower CI runners — by the time
    // Playwright's first CDP poll lands, the state may have already
    // flipped back to "idle". Instead, install a MutationObserver
    // in-page before clicking and record every data-state value and
    // every spinner-presence snapshot the button passes through.
    // After planning has clearly finished (route renders, button
    // settles back to idle) we read the history. The observer can't
    // miss a transition.
    const btn = page.getByTestId("plan-trip");
    await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="plan-trip"]',
      ) as HTMLElement | null;
      if (!el) throw new Error("plan-trip button missing before click");
      const snapshot = () => ({
        state: el.dataset.state ?? "",
        hasSpinner: !!el.querySelector('[data-testid="plan-trip-spinner"]'),
      });
      const w = window as unknown as {
        __planHistory: Array<{ state: string; hasSpinner: boolean }>;
        __planObserver: MutationObserver;
      };
      w.__planHistory = [snapshot()];
      w.__planObserver = new MutationObserver(() => {
        w.__planHistory.push(snapshot());
      });
      // Watch both the data-state attribute and child mutations so we
      // catch the spinner element appearing/disappearing too.
      w.__planObserver.observe(el, {
        attributes: true,
        attributeFilter: ["data-state"],
        childList: true,
        subtree: true,
      });
    });

    await btn.click();

    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(btn).toHaveAttribute("data-state", "idle");

    const history = await page.evaluate(() => {
      const w = window as unknown as {
        __planHistory: Array<{ state: string; hasSpinner: boolean }>;
        __planObserver: MutationObserver;
      };
      w.__planObserver.disconnect();
      return w.__planHistory;
    });

    expect(history.map((h) => h.state)).toContain("planning");
    const planningWithSpinner = history.some(
      (h) => h.state === "planning" && h.hasSpinner,
    );
    expect(planningWithSpinner).toBe(true);
  });

  test("plans KSEA→KBOI and renders a leg table with per-leg altitude + course", async ({
    page,
  }) => {
    await openSection(page, "Trip");
    await page.getByTestId("plan-trip").click();

    const legHeader = page.getByRole("button", {
      name: /Total time · \d+ stop/,
    });
    await expect(legHeader.first()).toBeVisible({ timeout: 30_000 });

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
    // odd-thousand + 500.
    const firstAltCell = page
      .locator("table tbody tr")
      .first()
      .locator("td")
      .nth(1);
    await expect(firstAltCell).toHaveText(/^\d+,?\d*$/);
    const altText = (await firstAltCell.textContent()) ?? "";
    expect(altText.replace(/,/g, "")).toMatch(/500$/);
  });

  test("flipping VFR → IFR drops the +500 from every leg altitude", async ({
    page,
  }) => {
    await openSection(page, "Trip");
    await page.getByTestId("plan-trip").click();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });

    const firstAlt = () =>
      page.locator("table tbody tr").first().locator("td").nth(1);
    const vfrAlt = (await firstAlt().textContent()) ?? "";
    expect(vfrAlt.replace(/,/g, "")).toMatch(/500$/);

    await page.getByRole("button", { name: "IFR" }).click();
    // Wait for the previous run's spinner to settle before re-clicking.
    await expect(page.getByTestId("plan-trip")).toHaveAttribute(
      "data-state",
      "idle",
    );
    await page.getByTestId("plan-trip").click();
    await expect(firstAlt()).not.toHaveText(vfrAlt, { timeout: 30_000 });
    const ifrAlt = (await firstAlt().textContent()) ?? "";
    expect(ifrAlt.replace(/,/g, "")).toMatch(/000$/);
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
    await openSection(page, "Trip");
    await page.getByTestId("plan-trip").click();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // Opening Trip auto-collapsed Aircraft; re-open it to read the
    // target-altitude input.
    await openSection(page, "Aircraft & cruise");
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

  test("GPX export downloads a non-empty file", async ({ page }) => {
    await openSection(page, "Trip");
    await page.getByTestId("plan-trip").click();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });

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
    // Returning to auto mode brings the Plan button back.
    await page.getByRole("button", { name: "Switch to auto plan" }).click();
    await expect(page.getByTestId("plan-trip")).toBeVisible();
  });
});
