import { test, expect, type Page } from "@playwright/test";

/** The Plan button shows "Loading airport database…" while datasets
 *  load via fetch. Wait for the button to become the enabled "Plan
 *  trip" before each test so they aren't racing the dataset load. */
async function waitForDataReady(page: Page): Promise<void> {
  await expect(page.getByTestId("plan-trip")).toHaveAttribute(
    "data-state",
    "idle",
    { timeout: 30_000 },
  );
}

async function parseMatchCount(page: Page): Promise<number> {
  const counter = page.getByText(/of [\d,]+ airports match\./);
  const t = (await counter.textContent()) ?? "";
  const m = t.match(/^([\d,]+) of/);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
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
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("KSEA");
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("KBOI");
    await expect(page.getByRole("button", { name: "VFR" })).toHaveClass(
      /bg-slate-900/,
    );
  });

  test("Plan button shows a spinner state while computing", async ({
    page,
  }) => {
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
    const before = await parseMatchCount(page);
    await page.getByLabel("Minimum runway length (ft)").fill("8000");
    await expect.poll(() => parseMatchCount(page)).not.toBe(before);
  });

  test("Precision approach filter restricts the match count below 'no filter'", async ({
    page,
  }) => {
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
    await page.getByTestId("plan-trip").click();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });

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
});
