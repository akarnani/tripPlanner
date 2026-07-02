import { describe, expect, test } from "vitest";
import {
  assignLabelRows,
  labelCenterFrac,
  type StackableLabel,
} from "./RouteProfile";

function label(nm: number, text: string): StackableLabel {
  return { nm, text, row: 0 };
}

/** The horizontal extent [lo, hi] (0..1) a label occupies once laid
 *  out — the same box the packer and renderer use. */
function extent(
  l: StackableLabel,
  winStart: number,
  winEnd: number,
): [number, number] {
  const center = labelCenterFrac(l.text, l.nm, winStart, winEnd);
  const half = Math.min(0.45, (l.text.length * 7.2) / 1000 / 2) + 0.01;
  return [center - half, center + half];
}

describe("assignLabelRows", () => {
  test("two wide labels at nearby distances land on different rows", () => {
    // The KEGE regression: two long callouts a short distance apart used
    // to render on the same row and overlap.
    const labels = [
      label(700, "terrain needs a 285 ft/nm climb — over standard"),
      label(760, "4.2° descent — terrain"),
    ];
    assignLabelRows(labels, 460, 1170);
    expect(labels[0].row).not.toBe(labels[1].row);
  });

  test("no two labels on the same row overlap horizontally", () => {
    const winStart = 0;
    const winEnd = 1000;
    const labels = [
      label(100, "312 ft/nm climb — over standard"),
      label(160, "4.5° descent — terrain"),
      label(180, "540 ft/nm climb — over aircraft"),
      label(500, "3.9° descent — terrain"),
      label(520, "260 ft/nm climb — over standard"),
      label(950, "6.1° descent — terrain"),
    ];
    assignLabelRows(labels, winStart, winEnd);
    // Group by row and assert pairwise non-overlap within each row.
    const byRow = new Map<number, StackableLabel[]>();
    for (const l of labels) {
      (byRow.get(l.row) ?? byRow.set(l.row, []).get(l.row)!).push(l);
    }
    for (const group of byRow.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const [aLo, aHi] = extent(group[i], winStart, winEnd);
          const [bLo, bHi] = extent(group[j], winStart, winEnd);
          const overlaps = aLo < bHi && aHi > bLo;
          expect(overlaps).toBe(false);
        }
      }
    }
  });

  test("well-separated labels all stay on row 0", () => {
    const labels = [
      label(50, "300 ft/nm climb — over standard"),
      label(500, "4° descent — terrain"),
      label(950, "310 ft/nm climb — over standard"),
    ];
    assignLabelRows(labels, 0, 1000);
    expect(labels.every((l) => l.row === 0)).toBe(true);
  });
});

describe("labelCenterFrac", () => {
  test("clamps a wide label away from the left edge so it can't clip", () => {
    // A long label whose true position is at the very left edge gets
    // pushed right by half its width.
    const frac = labelCenterFrac(
      "540 ft/nm climb — over aircraft",
      0,
      0,
      1000,
    );
    expect(frac).toBeGreaterThan(0.1);
  });

  test("clamps a wide label away from the right edge", () => {
    const frac = labelCenterFrac(
      "540 ft/nm climb — over aircraft",
      1000,
      0,
      1000,
    );
    expect(frac).toBeLessThan(0.9);
  });
});
