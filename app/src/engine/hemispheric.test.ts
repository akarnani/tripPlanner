import { describe, expect, test } from "vitest";
import {
  hemisphericAltitude,
  initialTrueCourseDeg,
  magneticCourseDeg,
} from "./hemispheric";

describe("initialTrueCourseDeg", () => {
  test("due east is ~90°", () => {
    const c = initialTrueCourseDeg({ lat: 40, lon: -100 }, { lat: 40, lon: -90 });
    expect(c).toBeGreaterThan(85);
    expect(c).toBeLessThan(95);
  });
  test("due west is ~270°", () => {
    const c = initialTrueCourseDeg({ lat: 40, lon: -90 }, { lat: 40, lon: -100 });
    expect(c).toBeGreaterThan(265);
    expect(c).toBeLessThan(275);
  });
  test("due north is ~0°", () => {
    const c = initialTrueCourseDeg({ lat: 30, lon: -100 }, { lat: 40, lon: -100 });
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(2);
  });
  test("due south is ~180°", () => {
    const c = initialTrueCourseDeg({ lat: 40, lon: -100 }, { lat: 30, lon: -100 });
    expect(c).toBeGreaterThan(178);
    expect(c).toBeLessThan(182);
  });
});

describe("magneticCourseDeg", () => {
  test("subtracts east variation from true course", () => {
    expect(magneticCourseDeg(90, 15)).toBe(75); // KSEA-ish
    expect(magneticCourseDeg(180, 15)).toBe(165);
  });
  test("adds west (negative) variation to true course", () => {
    expect(magneticCourseDeg(90, -15)).toBe(105); // east coast
    expect(magneticCourseDeg(0, -15)).toBe(15);
  });
  test("wraps around 360", () => {
    expect(magneticCourseDeg(5, 15)).toBeCloseTo(350, 6);
    expect(magneticCourseDeg(355, -15)).toBeCloseTo(10, 6);
  });
});

describe("hemisphericAltitude", () => {
  test("VFR eastbound rounds up to odd+500", () => {
    expect(hemisphericAltitude(5000, 90, "VFR")).toBe(5500);
    expect(hemisphericAltitude(5500, 90, "VFR")).toBe(5500);
    expect(hemisphericAltitude(5600, 90, "VFR")).toBe(7500);
    expect(hemisphericAltitude(4000, 90, "VFR")).toBe(5500);
    expect(hemisphericAltitude(8500, 45, "VFR")).toBe(9500);
  });
  test("VFR westbound rounds up to even+500", () => {
    expect(hemisphericAltitude(5000, 270, "VFR")).toBe(6500);
    expect(hemisphericAltitude(6500, 270, "VFR")).toBe(6500);
    expect(hemisphericAltitude(6600, 270, "VFR")).toBe(8500);
    expect(hemisphericAltitude(3500, 270, "VFR")).toBe(4500);
  });
  test("IFR eastbound rounds up to odd thousands", () => {
    expect(hemisphericAltitude(4500, 90, "IFR")).toBe(5000);
    expect(hemisphericAltitude(5000, 90, "IFR")).toBe(5000);
    expect(hemisphericAltitude(5100, 90, "IFR")).toBe(7000);
  });
  test("IFR westbound rounds up to even thousands", () => {
    expect(hemisphericAltitude(5500, 270, "IFR")).toBe(6000);
    expect(hemisphericAltitude(6000, 270, "IFR")).toBe(6000);
    expect(hemisphericAltitude(6100, 270, "IFR")).toBe(8000);
  });
  test("course exactly 180° is westbound (boundary check)", () => {
    expect(hemisphericAltitude(5000, 180, "VFR")).toBe(6500);
  });
  test("course exactly 0° is eastbound (boundary check)", () => {
    expect(hemisphericAltitude(5000, 0, "VFR")).toBe(5500);
  });
  test("below the 3,000 ft floor the rule does not apply", () => {
    expect(hemisphericAltitude(2500, 90, "VFR")).toBe(2500);
    expect(hemisphericAltitude(2500, 270, "IFR")).toBe(2500);
  });
});
