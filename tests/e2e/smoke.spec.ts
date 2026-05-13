import { test, expect } from "@playwright/test";

test.describe("trip planner smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Side panel is the deterministic "page is alive" signal; the
    // MapLibre canvas may take longer (or fail in restricted networks)
    // and isn't necessary for the engine flow.
    await expect(page.getByRole("heading", { name: "Trip Planner" })).toBeVisible();
  });

  test("renders the planning UI with default values", async ({ page }) => {
    await expect(page.getByPlaceholder("KSEA")).toHaveValue("KSEA");
    await expect(page.getByPlaceholder("KBOI")).toHaveValue("KBOI");
    await expect(page.getByRole("button", { name: "VFR" })).toHaveClass(
      /bg-slate-900/,
    );
    await expect(page.getByRole("button", { name: "Plan trip" })).toBeVisible();
  });

  test("plans KSEA→KBOI and renders a leg table with per-leg altitude + course", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Plan trip" }).click();

    // The right-side aside only mounts when a route exists.
    const legHeader = page.getByText(/Alt\s*1 ·/);
    await expect(legHeader.first()).toBeVisible();

    // Leg table column headers
    await expect(page.getByRole("columnheader", { name: "Alt" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "MC" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "NM" })).toBeVisible();

    // First leg should originate at KSEA
    const firstLegCell = page.locator("table tbody tr").first().locator("td").first();
    await expect(firstLegCell).toContainText("KSEA");

    // The route is eastbound, target 6500 ft → first leg should be at 7500 ft (odd+500).
    const firstAltCell = page.locator("table tbody tr").first().locator("td").nth(1);
    await expect(firstAltCell).toHaveText("7,500");
  });

  test("flipping VFR → IFR drops the +500 from every leg altitude", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Plan trip" }).click();
    const vfrAlt = await page
      .locator("table tbody tr")
      .first()
      .locator("td")
      .nth(1)
      .textContent();
    expect(vfrAlt).toMatch(/,500$/); // VFR ends in 500

    await page.getByRole("button", { name: "IFR" }).click();
    await page.getByRole("button", { name: "Plan trip" }).click();
    const ifrAlt = await page
      .locator("table tbody tr")
      .first()
      .locator("td")
      .nth(1)
      .textContent();
    expect(ifrAlt).toMatch(/,000$/); // IFR ends in 000
  });

  test("min-safe replan bumps the target altitude when terrain dictates", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Plan trip" }).click();

    // Initial target altitude
    const targetInput = page.getByLabel("Target altitude (ft)");
    const before = Number((await targetInput.inputValue()) ?? "0");

    const replan = page.getByRole("button", { name: /Replan with .* ft target/ });
    // KSEA→KBOI at 6500 ft crosses the Cascades, so the replan button
    // should appear. If terrain analysis didn't fire (no DEM), skip.
    if (await replan.isVisible()) {
      await replan.click();
      await expect(targetInput).not.toHaveValue(String(before));
      const after = Number(await targetInput.inputValue());
      expect(after).toBeGreaterThan(before);
    }
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

  test("filters affect the airport match count", async ({ page }) => {
    const counter = page.getByText(/of .* airports match/);
    const before = await counter.textContent();
    await page.getByLabel("Minimum runway length (ft)").fill("8000");
    const after = await counter.textContent();
    expect(after).not.toEqual(before);
  });

  test("GPX export downloads a non-empty file", async ({ page }) => {
    await page.getByRole("button", { name: "Plan trip" }).click();
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
