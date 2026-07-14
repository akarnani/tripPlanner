import { test, expect, type Page } from "@playwright/test";

/** Datasets load via fetch; wait for the Plan button to settle to "idle"
 *  (its data-state) so tests aren't racing the load. On mobile the
 *  button lives in the bottom sheet's Plan-tab footer. */
async function waitForDataReady(page: Page): Promise<void> {
  await expect(page.getByTestId("plan-trip")).toHaveAttribute(
    "data-state",
    "idle",
    { timeout: 30_000 },
  );
}

test.describe("mobile bottom-sheet layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Trip Planner" }),
    ).toBeVisible();
    await waitForDataReady(page);
  });

  test("lays out without horizontal overflow and shows the tab bar", async ({
    page,
  }) => {
    // The whole point of the responsive work: no sideways scroll on a
    // phone-width viewport.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    for (const name of [/^plan$/i, /^route$/i, /^issues$/i]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }
  });

  test("planning flips the sheet to Route and renders the leg table", async ({
    page,
  }) => {
    await page.getByTestId("plan-trip").tap();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator("table tbody tr").first().locator("td").first(),
    ).toContainText("KSEA");
  });

  test("switching to the Issues tab swaps out the leg table", async ({
    page,
  }) => {
    await page.getByTestId("plan-trip").tap();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("table tbody tr").first()).toBeVisible();

    // Only the active tab's content is mounted, so the leg table is gone
    // on the Issues tab.
    await page.getByRole("button", { name: /^issues$/i }).tap();
    await expect(page.locator("table tbody tr")).toHaveCount(0);
  });

  test("tapping an airport pins its info popup (hover has no touch path)", async ({
    page,
  }) => {
    // Collapse the sheet to peek so the map is tappable, then tap a dot.
    // Scan a grid until a maplibre popup appears.
    await page.getByRole("button", { name: /resize panel/i }).tap();
    await page.getByRole("button", { name: /resize panel/i }).tap();
    await page.waitForTimeout(500);
    const canvas = page.locator("canvas.maplibregl-canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("map canvas not found");

    let popped = false;
    for (let gy = 0.25; gy <= 0.6 && !popped; gy += 0.05) {
      for (let gx = 0.1; gx <= 0.6 && !popped; gx += 0.05) {
        await page.mouse.click(box.x + box.width * gx, box.y + box.height * gy);
        await page.waitForTimeout(120);
        if ((await page.locator(".maplibregl-popup-content").count()) > 0) {
          popped = true;
        }
      }
    }
    expect(popped).toBe(true);
    await expect(
      page.locator(".maplibregl-popup-content").getByRole("link", {
        name: /AirNav/,
      }),
    ).toBeVisible();
  });
});
