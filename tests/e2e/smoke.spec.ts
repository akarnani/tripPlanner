import { test, expect, type Page } from "@playwright/test";

/** The slice of the MapLibre API the map-layer tests drive. Declared
 *  here so the spec doesn't pull maplibre-gl into the test bundle. */
type MapLike = {
  getLayer(id: string): unknown;
  queryRenderedFeatures(
    g: undefined | { x: number; y: number },
    o: { layers: string[] },
  ): Array<{
    geometry: { coordinates: number[] };
    properties: Record<string, unknown>;
  }>;
  jumpTo(o: { center: [number, number]; zoom: number }): void;
  project(lngLat: [number, number]): { x: number; y: number };
};

/** Rendered feature counts for the nav-point layers, or -1 when the map
 *  handle isn't there (dev-build only) so callers can skip rather than
 *  pass vacuously. */
async function navCounts(page: Page): Promise<{
  navaids: number;
  fixes: number;
  routeNav: number;
  routeNavIdents: string[];
}> {
  return await page.evaluate(() => {
    const m = (window as unknown as { __tripPlannerMap?: MapLike })
      .__tripPlannerMap;
    const miss = { navaids: -1, fixes: -1, routeNav: -1, routeNavIdents: [] };
    if (!m || !m.getLayer("nav-points-navaids")) return miss;
    const feats = (id: string) =>
      m.getLayer(id) ? m.queryRenderedFeatures(undefined, { layers: [id] }) : [];
    const routeNav = feats("route-nav-points-sym");
    return {
      navaids: feats("nav-points-navaids").length,
      fixes: feats("nav-points-fixes").length,
      routeNav: routeNav.length,
      routeNavIdents: routeNav.map((f) => String(f.properties.ident)),
    };
  });
}

/** Move the camera and give MapLibre a beat to tile and paint. Can't
 *  wait on the map's `idle` event here: the label sources deliberately
 *  keep tiles pending whenever glyphs are unreachable (see the gate
 *  test), so `idle` may never fire even though everything that can
 *  draw has drawn. Positive assertions poll; this settle time only has
 *  to be enough for the negative ones. */
async function jumpTo(
  page: Page,
  zoom: number,
  center: [number, number],
): Promise<void> {
  await page.evaluate(
    ([z, lon, lat]) => {
      const m = (window as unknown as { __tripPlannerMap?: MapLike })
        .__tripPlannerMap!;
      m.jumpTo({ center: [lon, lat], zoom: z });
    },
    [zoom, center[0], center[1]],
  );
  await page.waitForTimeout(1500);
}

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

/** Runway check + airport filters live in collapsed accordions (T4);
 *  expand one by its header title before poking its controls. */
async function openSection(page: Page, title: string): Promise<void> {
  const header = page.getByRole("button", { name: new RegExp(title) });
  if ((await header.getAttribute("aria-expanded")) !== "true") {
    await header.click();
  }
}

async function planAndWaitForRoute(page: Page): Promise<void> {
  await page.getByTestId("plan-trip").click();
  await expect(
    page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("plan-trip")).toHaveAttribute(
    "data-state",
    "idle",
  );
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
      /bg-accent/,
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

    // The route-profile panel opens on its own with the plan (as soon
    // as the DEM grid is up — no click required).
    await expect(page.getByTestId("route-profile")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("img", { name: /Route altitude profile/ }),
    ).toBeVisible();
    // The dock (RouteProfileDock) subscribes to the map viewport and
    // feeds the window down; with the map fit to the whole route it
    // should report a non-degenerate "N–M nm of T nm" span.
    await expect(
      page.getByTestId("route-profile").getByText(/\d+–\d+ nm of \d+ nm/),
    ).toBeVisible();
    // The × closes it; a leg-row click and the Profile toggle both
    // bring it back.
    await page.getByRole("button", { name: "Close route profile" }).click();
    await expect(page.getByTestId("route-profile")).not.toBeVisible();
    await page.locator("table tbody tr").first().click();
    await expect(page.getByTestId("route-profile")).toBeVisible();
    await page.getByRole("button", { name: "Close route profile" }).click();
    await page.getByRole("button", { name: "Profile ▴" }).click();
    await expect(page.getByTestId("route-profile")).toBeVisible();
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
    await openSection(page, "Airport filters");
    const before = await parseMatchCount(page);
    await page.getByLabel("Minimum runway length (ft)").fill("8000");
    await expect.poll(() => parseMatchCount(page)).not.toBe(before);
  });

  test("Precision approach filter restricts the match count below 'no filter'", async ({
    page,
  }) => {
    await openSection(page, "Airport filters");
    const trigger = page.getByLabel("Approach");
    if (!(await trigger.isEnabled())) test.skip();

    // The Approach picker is a custom listbox (Select.tsx): open it, then
    // click the option.
    const pick = async (name: string | RegExp) => {
      await trigger.click();
      await page.getByRole("option", { name }).click();
    };

    await pick("No approach required");
    await expect.poll(() => parseMatchCount(page)).toBeGreaterThan(0);
    const offCount = await parseMatchCount(page);

    await pick(/^Any IAP/);
    await expect
      .poll(() => parseMatchCount(page), { timeout: 5000 })
      .toBeLessThan(offCount);
    const anyCount = await parseMatchCount(page);
    expect(anyCount).toBeGreaterThan(0);

    await pick("Precision or LPV");
    await expect
      .poll(() => parseMatchCount(page), { timeout: 5000 })
      .toBeLessThan(anyCount);
    const precCount = await parseMatchCount(page);
    expect(precCount).toBeGreaterThan(0);

    await pick("RNAV / GPS");
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
      name: /Replan at [\d,]+ ft/,
    });
    if (await replan.isVisible()) {
      await replan.click();
      await expect(targetInput).not.toHaveValue(String(before));
      const after = Number(await targetInput.inputValue());
      expect(after).toBeGreaterThan(before);
    }
  });

  test("every leg of a ceilinged plan respects the ceiling", async ({
    page,
  }) => {
    // The property that matters, and the one that regressed once: with
    // a ceiling set, no leg may be planned above it. KSEA→KBOI has a
    // genuine low route (the Columbia Gorge cuts the Cascades near sea
    // level), so this asserts the ceiling is *enforced*, not merely
    // that planning fails.
    await page.getByLabel("Stay at or below").check();
    await page.getByLabel("Maximum altitude (ft)").fill("8000");
    await planAndWaitForRoute(page);

    const alts = await page
      .locator("table tbody tr td:nth-child(3)")
      .allTextContents();
    const parsed = alts
      .map((t) => Number(t.replace(/[^\d]/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(parsed.length).toBeGreaterThan(0);
    for (const alt of parsed) expect(alt).toBeLessThanOrEqual(8000);
  });

  test("an impossible ceiling fails with both ways out offered", async ({
    page,
  }) => {
    // 4,000 ft leaves nothing legal above KBOI's 2,872 ft field once the
    // 2,000 ft terrain buffer is applied, anywhere on the route.
    await page.getByLabel("Stay at or below").check();
    await page.getByLabel("Maximum altitude (ft)").fill("4000");
    await page.getByTestId("plan-trip").click();

    await expect(page.getByText(/no route at or below 4,000 ft/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: "Find a way around" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Lowest workable altitude" }),
    ).toBeVisible();
  });

  test("the lowest-workable-altitude search reports a specific altitude", async ({
    page,
  }) => {
    await page.getByLabel("Stay at or below").check();
    await page.getByLabel("Maximum altitude (ft)").fill("4000");
    await page.getByTestId("plan-trip").click();
    await expect(page.getByText(/no route at or below/)).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: "Lowest workable altitude" }).click();
    await expect(
      page.getByText(/Lowest workable ceiling is [\d,]+ ft|No ceiling works/),
    ).toBeVisible({ timeout: 90_000 });
  });

  test("toggling the ceiling marks an existing plan stale", async ({ page }) => {
    await planAndWaitForRoute(page);
    await page.getByLabel("Stay at or below").check();
    await expect(page.getByText(/ceiling/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("nav points are zoom-gated: navaids come in before fixes", async ({
    page,
  }) => {
    // 8,120 nav points at low zoom is unreadable, so the browsing
    // layers are gated: navaids from z7, the six-times-denser fixes
    // from z8.5. Queried through MapLibre itself — these are canvas
    // layers, invisible to the DOM.
    //
    // Every "must be zero" here is checked at a camera position where
    // the same layer has just been proven to draw one zoom step up, so
    // a zero means "the gate closed it", not "the data never arrived".
    // That distinction is the whole test: the first version of these
    // layers rendered nothing at any zoom because their labels shared
    // a source with their icons, and a tile parse that has to resolve
    // glyphs never completes while the style's glyph endpoint is
    // unreachable — which is the normal state of a keyless build (the
    // fallback style points at demotiles) and of CI. The stalled tiles
    // took the icons down with the text. Labels now live on their own
    // source; if anyone merges them back, this test goes to zero.
    const probe = await navCounts(page);
    test.skip(probe.navaids === -1, "map test handle or nav layers unavailable");

    // An isolated VORTAC (nearest airport 22 nm away, so nothing else
    // is competing for the pixel) and an enroute fix on the KSEA→KBOI
    // great circle. Coordinates, not idents: the assertions below read
    // whatever the current NASR cycle put there.
    const NEAR_ACH: [number, number] = [-105.03993, 35.11171];
    const NEAR_NIPPS: [number, number] = [-119.0487, 45.45468];

    await jumpTo(page, 7.2, NEAR_ACH);
    await expect
      .poll(async () => (await navCounts(page)).navaids, { timeout: 20_000 })
      .toBeGreaterThan(0);

    await jumpTo(page, 6.8, NEAR_ACH);
    expect((await navCounts(page)).navaids).toBe(0);

    // Fixes: still gated where navaids already draw, in at z8.5+.
    await jumpTo(page, 8.8, NEAR_NIPPS);
    await expect
      .poll(async () => (await navCounts(page)).fixes, { timeout: 20_000 })
      .toBeGreaterThan(0);

    await jumpTo(page, 8.3, NEAR_NIPPS);
    const gated = await navCounts(page);
    expect(gated.fixes).toBe(0);
    expect(gated.navaids).toBeGreaterThan(0);

    // And nothing at all at a whole-region view.
    await jumpTo(page, 4, [-122.31, 47.45]);
    const wide = await navCounts(page);
    expect(wide.navaids).toBe(0);
    expect(wide.fixes).toBe(0);
  });

  test("clicking a navaid pops up its ident, type and tuned frequency", async ({
    page,
  }) => {
    // Picks whatever navaid the current cycle draws in an area with no
    // airports under it, so the assertion survives a NASR refresh. The
    // frequency check is the point: NASR stores kHz (117800), a pilot
    // tunes MHz (117.80).
    const probe = await navCounts(page);
    test.skip(probe.navaids === -1, "map test handle or nav layers unavailable");

    await jumpTo(page, 7.2, [-105.03993, 35.11171]);
    await expect
      .poll(async () => (await navCounts(page)).navaids, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Find a rendered navaid with a frequency and no airport symbol
    // sharing its pixel (airports own the click when they overlap).
    const target = await page.evaluate(() => {
      const m = (window as unknown as { __tripPlannerMap?: MapLike })
        .__tripPlannerMap!;
      for (const f of m.queryRenderedFeatures(undefined, {
        layers: ["nav-points-navaids"],
      })) {
        const at = m.project(f.geometry.coordinates as [number, number]);
        const airports = ["airports-towered", "airports-nontowered"].filter(
          (id) => m.getLayer(id),
        );
        if (m.queryRenderedFeatures(at, { layers: airports }).length > 0) {
          continue;
        }
        if (typeof f.properties.freq_khz !== "number") continue;
        return { ident: String(f.properties.ident), x: at.x, y: at.y };
      }
      return null;
    });
    expect(target).not.toBeNull();

    const canvas = await page.locator("canvas.maplibregl-canvas").boundingBox();
    expect(canvas).not.toBeNull();
    await page.mouse.click(canvas!.x + target!.x, canvas!.y + target!.y);

    const popup = page.locator(".maplibregl-popup-content").first();
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup).toContainText(target!.ident);
    // Ident plus facility type, the way the leg table names it.
    await expect(popup).toContainText(
      new RegExp(`${target!.ident}\\s+(VOR|VORTAC|VOR/DME|NDB|NDB/DME)`),
    );
    // kHz on the wire, tunable units on screen.
    await expect(popup).toContainText(/(\d{3}\.\d{2} MHz|\d{3,4} kHz)/);
  });

  test("a nav point on the route stays visible when zoomed out", async ({
    page,
  }) => {
    // The zoom gate must never hide a waypoint the pilot chose: pinned
    // nav points render from their own always-on layer. Pin a fix that
    // sits on the KSEA→KBOI great circle, re-plan, then zoom out past
    // every gate and assert it's still drawn while the browsing layers
    // are dark.
    const probe = await navCounts(page);
    test.skip(probe.navaids === -1, "map test handle or nav layers unavailable");

    await planAndWaitForRoute(page);
    await page.getByPlaceholder("KICAO or KSEA KGEG KBOI").first().fill("NIPPS");
    await page.getByRole("button", { name: "Add", exact: true }).first().click();
    await page.getByTestId("plan-trip").click();
    // The leg table naming the fix is the app's own statement that the
    // route is shaped through it.
    await expect(page.getByText(/via NIPPS/).first()).toBeVisible({
      timeout: 30_000,
    });

    await jumpTo(page, 4, [-122.31, 47.45]);
    await expect
      .poll(async () => (await navCounts(page)).routeNav, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const wide = await navCounts(page);
    expect(wide.navaids).toBe(0);
    expect(wide.fixes).toBe(0);
    expect(wide.routeNavIdents).toContain("NIPPS");
  });

  test("origin and destination dots draw without a glyph server", async ({
    page,
  }) => {
    // A symbol layer with text-field stalls its tile parse until glyphs
    // load, and a stalled tile takes every other layer on that source
    // down with it. The stop labels used to share the stops source, so
    // in any keyless or offline build -- local dev and CI both -- the
    // route drew but its endpoints silently did not.
    await planAndWaitForRoute(page);
    await page.waitForTimeout(1500);
    const counts = await page.evaluate(() => {
      const m = (window as unknown as { __tripPlannerMap?: MapLike })
        .__tripPlannerMap;
      if (!m) return null;
      return {
        stops: m.queryRenderedFeatures(undefined, {
          layers: ["route-stops-pts"],
        }).length,
        route: m.queryRenderedFeatures(undefined, { layers: ["route-line"] })
          .length,
      };
    });
    test.skip(counts === null, "map test handle unavailable");
    expect(counts!.route).toBeGreaterThan(0);
    expect(counts!.stops).toBeGreaterThan(0);
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

  test("interactive mode swaps the trip panel and shows range info", async ({
    page,
  }) => {
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
    await expect(page.getByText(/Range from here:/)).toBeVisible();
    // Returning to auto mode brings the Plan button back.
    await page.getByRole("button", { name: "Switch to auto plan" }).click();
    await expect(page.getByTestId("plan-trip")).toBeVisible();
  });

  test("changing an input after planning shows the stale banner; Replan clears it", async ({
    page,
  }) => {
    await planAndWaitForRoute(page);
    await expect(page.getByText("Inputs changed")).not.toBeVisible();

    // Bump the cruise altitude — the plan no longer matches the inputs.
    await page.getByLabel("Target altitude (ft)").fill("8500");
    const banner = page.getByText("Inputs changed");
    await expect(banner).toBeVisible();

    // The rendered route dims along with the banner (dev builds expose
    // the map as window.__tripPlannerMap).
    const routeOpacity = () =>
      page.evaluate(() => {
        const map = (
          window as unknown as {
            __tripPlannerMap?: {
              getLayer(id: string): unknown;
              getPaintProperty(id: string, prop: string): unknown;
            };
          }
        ).__tripPlannerMap;
        if (!map?.getLayer("route-line")) return -1;
        return map.getPaintProperty("route-line", "line-opacity") as number;
      });
    await expect.poll(routeOpacity, { timeout: 15_000 }).toBe(0.4);

    // The on-map callout explains the dimmed route in line of sight.
    const mapCallout = page.getByText("Plan out of date");
    await expect(mapCallout).toBeVisible();

    // Two Replan buttons while stale (rail banner + map callout);
    // either clears the state.
    await page
      .getByRole("button", { name: "Replan", exact: true })
      .first()
      .click();
    await expect(banner).not.toBeVisible({ timeout: 30_000 });
    await expect(mapCallout).not.toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("plan-trip")).toHaveAttribute(
      "data-state",
      "idle",
      { timeout: 30_000 },
    );
  });

  test("excluding a stop shows an undo toast; undo restores the route instantly", async ({
    page,
  }) => {
    // Cap legs at 1 hr so KSEA→KBOI needs intermediate stops — the
    // exclude × only renders on legs that end at a replaceable stop.
    await page.getByRole("checkbox", { name: /Cap each leg/ }).check();
    await page.locator("#max-leg-hr").fill("1");
    await planAndWaitForRoute(page);
    const legRows = page.locator("table tbody tr");
    const legCountBefore = await legRows.count();
    expect(legCountBefore).toBeGreaterThan(1);

    // Exclude the first intermediate stop via its × button.
    await page
      .getByRole("button", { name: /^Exclude / })
      .first()
      .click();
    await expect(page.getByText(/excluded — route replanned/)).toBeVisible();

    // Undo restores the previous routes synchronously — no waiting on
    // a replan.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByText(/excluded — route replanned/),
    ).not.toBeVisible();
    await expect(legRows).toHaveCount(legCountBefore);
  });

  test("loading a saved trip auto-plans it — no second click", async ({
    page,
  }) => {
    await planAndWaitForRoute(page);

    // Save under the default name via the header popover.
    await page.getByRole("button", { name: "Saved trips ▾" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved ✓" })).toBeVisible();
    // fill() below doesn't dispatch a pointerdown, so close the
    // popover explicitly before touching the form.
    await page.keyboard.press("Escape");

    // Change the destination so the loaded trip has real work to do.
    await page.getByLabel("To", { exact: true }).fill("KPDX");

    // Load it back: planning must start on its own and produce the
    // saved trip's route.
    await page.getByRole("button", { name: "Saved trips ▾" }).click();
    await page
      .getByRole("button", { name: /KSEA → KBOI/ })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: /Total time · \d+ stop/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("plan-trip")).toHaveAttribute(
      "data-state",
      "idle",
      { timeout: 30_000 },
    );
    await expect(page.getByLabel("To", { exact: true })).toHaveValue("KBOI");
    await expect(page.getByText("Inputs changed")).not.toBeVisible();
  });

  test("theme toggle switches to dark mode and persists across reload", async ({
    page,
  }) => {
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/dark/);

    // Wait for the initial style + custom layers (dev builds expose
    // the map instance as window.__tripPlannerMap for exactly this).
    const airportLayers = () =>
      page.evaluate(() => {
        const map = (
          window as unknown as {
            __tripPlannerMap?: {
              getLayer(id: string): unknown;
              isStyleLoaded(): boolean;
            };
          }
        ).__tripPlannerMap;
        if (!map || !map.isStyleLoaded()) return -1;
        return ["airports-towered", "airports-nontowered", "route-line"].filter(
          (id) => !!map.getLayer(id),
        ).length;
      });
    await expect.poll(airportLayers, { timeout: 30_000 }).toBe(3);

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveClass(/dark/);

    // setStyle() drops every runtime-added layer; registerLayers must
    // put them back once the dark basemap's style loads. A diff-based
    // setStyle silently skips that reload — this catches it.
    await expect.poll(airportLayers, { timeout: 30_000 }).toBe(3);

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Trip Planner" }),
    ).toBeVisible();
    await expect(html).toHaveClass(/dark/);
    await expect.poll(airportLayers, { timeout: 30_000 }).toBe(3);
  });
});
