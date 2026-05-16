#!/usr/bin/env node
// Validates every aircraft/<slug>/performance.yaml against the schema
// the trip planner expects. Exit 0 on success, 1 on the first failure.
// Invoked from .github/workflows/perf-validate.yml on PRs that touch
// the aircraft/ tree, and runnable locally:
//
//   node pipelines/validate_perf.mjs

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { load } from "js-yaml";

const ROOT = new URL("..", import.meta.url).pathname;
const FUEL_TYPES = new Set(["100LL", "Jet-A", "MoGas"]);

let failures = 0;

function fail(file, msg) {
  console.error(`✗ ${file}: ${msg}`);
  failures += 1;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isInt(v) {
  return Number.isInteger(v);
}

function validate(file, data) {
  if (typeof data !== "object" || data === null)
    return fail(file, "root must be a mapping");
  if (typeof data.make !== "string") return fail(file, "missing make");
  if (typeof data.model !== "string") return fail(file, "missing model");

  const f = data.fuel;
  if (!f) return fail(file, "missing fuel block");
  if (!FUEL_TYPES.has(f.type))
    return fail(file, `fuel.type must be one of ${[...FUEL_TYPES].join(", ")}`);
  if (!isNum(f.density_lb_per_gal) || f.density_lb_per_gal <= 0)
    return fail(file, "fuel.density_lb_per_gal must be positive");
  if (!isNum(f.usable_capacity_gal) || f.usable_capacity_gal <= 0)
    return fail(file, "fuel.usable_capacity_gal must be positive");

  if (!Array.isArray(data.cruise) || data.cruise.length === 0)
    return fail(file, "cruise must be a non-empty array");
  let prev = null;
  for (const [i, row] of data.cruise.entries()) {
    const where = `cruise[${i}]`;
    if (!isInt(row.altitude_ft) || row.altitude_ft < 0 || row.altitude_ft > 30000)
      return fail(file, `${where}: altitude_ft out of range`);
    if (!isInt(row.power_pct) || row.power_pct < 30 || row.power_pct > 100)
      return fail(file, `${where}: power_pct out of range`);
    if (!isNum(row.tas_kt) || row.tas_kt <= 0 || row.tas_kt >= 400)
      return fail(file, `${where}: tas_kt out of range`);
    if (!isNum(row.fuel_gph) || row.fuel_gph <= 0 || row.fuel_gph >= 100)
      return fail(file, `${where}: fuel_gph out of range`);
    if (prev && row.altitude_ft <= prev.altitude_ft)
      return fail(
        file,
        `${where}: rows must be strictly ascending by altitude_ft`,
      );
    if (prev && row.tas_kt > prev.tas_kt * 1.15)
      return fail(
        file,
        `${where}: TAS jumped >15% above ${prev.altitude_ft} ft — check POH`,
      );
    prev = row;
  }

  const c = data.climb;
  if (!c) return fail(file, "missing climb block");
  if (!isInt(c.rate_fpm) || c.rate_fpm <= 0)
    return fail(file, "climb.rate_fpm must be positive");
  if (!isNum(c.fuel_to_climb_gph) || c.fuel_to_climb_gph <= 0)
    return fail(file, "climb.fuel_to_climb_gph must be positive");

  // Optional weights block — when missing, runway checks are skipped
  // for the aircraft (back-compat). When present, max_gross is the
  // anchor for the takeoff/landing distance tables.
  if (data.weights !== undefined) {
    const w = data.weights;
    if (!isNum(w.max_gross_lb) || w.max_gross_lb <= 0 || w.max_gross_lb > 200000)
      return fail(file, "weights.max_gross_lb out of range");
    if (w.max_landing_lb !== undefined) {
      if (
        !isNum(w.max_landing_lb) ||
        w.max_landing_lb <= 0 ||
        w.max_landing_lb > w.max_gross_lb
      )
        return fail(file, "weights.max_landing_lb out of range (must be > 0 and ≤ max_gross_lb)");
    }
  }

  // Optional takeoff/landing tables. When present, weights.max_gross_lb
  // must be set so the engine knows the table's reference weight for
  // rows that don't specify weight_lb explicitly.
  for (const phase of ["takeoff", "landing"]) {
    const block = data[phase];
    if (block === undefined) continue;
    if (data.weights === undefined)
      return fail(file, `${phase} table requires a weights block (for the reference gross weight)`);
    if (!Array.isArray(block.distance_table) || block.distance_table.length === 0)
      return fail(file, `${phase}.distance_table must be a non-empty array`);
    for (const [i, row] of block.distance_table.entries()) {
      const where = `${phase}.distance_table[${i}]`;
      // weight_lb is optional: defaults to max_gross_lb (takeoff)
      // or max_landing_lb (landing) on load. When supplied it must
      // make physical sense.
      if (row.weight_lb !== undefined) {
        if (!isNum(row.weight_lb) || row.weight_lb <= 0 || row.weight_lb > data.weights.max_gross_lb)
          return fail(file, `${where}: weight_lb must be > 0 and ≤ weights.max_gross_lb`);
      }
      if (!isInt(row.pressure_alt_ft) || row.pressure_alt_ft < -1000 || row.pressure_alt_ft > 25000)
        return fail(file, `${where}: pressure_alt_ft out of range`);
      if (!isNum(row.temp_c) || row.temp_c < -60 || row.temp_c > 60)
        return fail(file, `${where}: temp_c out of range`);
      if (!isNum(row.ground_roll_ft) || row.ground_roll_ft <= 0 || row.ground_roll_ft > 20000)
        return fail(file, `${where}: ground_roll_ft out of range`);
      if (!isNum(row.total_50ft_ft) || row.total_50ft_ft <= 0 || row.total_50ft_ft > 20000)
        return fail(file, `${where}: total_50ft_ft out of range`);
      if (row.total_50ft_ft < row.ground_roll_ft)
        return fail(file, `${where}: total_50ft_ft must be ≥ ground_roll_ft`);
    }
    // Group rows by weight tier (using the explicit weight_lb if
    // present, otherwise the table's reference weight). Each tier
    // must form a complete (pressure_alt × temp) grid — pilots
    // reading a missing cell off a partial grid would silently get
    // the wrong distance, so we fail validation rather than
    // interpolate over a hole.
    const refWeight =
      phase === "landing"
        ? (data.weights.max_landing_lb ?? data.weights.max_gross_lb)
        : data.weights.max_gross_lb;
    const tiers = new Map();
    for (const row of block.distance_table) {
      const w = row.weight_lb ?? refWeight;
      let tier = tiers.get(w);
      if (!tier) {
        tier = { rows: [], alts: new Set(), temps: new Set() };
        tiers.set(w, tier);
      }
      tier.rows.push(row);
      tier.alts.add(row.pressure_alt_ft);
      tier.temps.add(row.temp_c);
    }
    for (const [w, tier] of tiers) {
      if (tier.rows.length !== tier.alts.size * tier.temps.size) {
        return fail(
          file,
          `${phase}.distance_table at weight=${w} is not a complete grid (${tier.alts.size} altitudes × ${tier.temps.size} temps = ${tier.alts.size * tier.temps.size} cells expected, got ${tier.rows.length})`,
        );
      }
    }
  }

  if (c.table !== undefined) {
    if (!Array.isArray(c.table) || c.table.length < 2)
      return fail(file, "climb.table must be an array of at least 2 rows");
    let prevClimb = null;
    for (const [i, row] of c.table.entries()) {
      const where = `climb.table[${i}]`;
      if (!isInt(row.altitude_ft) || row.altitude_ft < 0 || row.altitude_ft > 30000)
        return fail(file, `${where}: altitude_ft out of range`);
      if (!isNum(row.time_min) || row.time_min < 0 || row.time_min > 120)
        return fail(file, `${where}: time_min out of range`);
      if (!isNum(row.fuel_gal) || row.fuel_gal < 0 || row.fuel_gal > 50)
        return fail(file, `${where}: fuel_gal out of range`);
      if (!isNum(row.distance_nm) || row.distance_nm < 0 || row.distance_nm > 200)
        return fail(file, `${where}: distance_nm out of range`);
      if (prevClimb) {
        if (row.altitude_ft <= prevClimb.altitude_ft)
          return fail(
            file,
            `${where}: rows must be strictly ascending by altitude_ft`,
          );
        if (row.time_min < prevClimb.time_min)
          return fail(
            file,
            `${where}: time_min must be non-decreasing (table is cumulative from sea level)`,
          );
        if (row.fuel_gal < prevClimb.fuel_gal)
          return fail(
            file,
            `${where}: fuel_gal must be non-decreasing (table is cumulative from sea level)`,
          );
        if (row.distance_nm < prevClimb.distance_nm)
          return fail(
            file,
            `${where}: distance_nm must be non-decreasing (table is cumulative from sea level)`,
          );
      }
      prevClimb = row;
    }
  }
}

const aircraftDir = join(ROOT, "aircraft");
const entries = await readdir(aircraftDir, { withFileTypes: true });
let checked = 0;
for (const e of entries) {
  if (!e.isDirectory()) continue;
  const path = join(aircraftDir, e.name, "performance.yaml");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    fail(`aircraft/${e.name}/performance.yaml`, "file not found");
    continue;
  }
  let parsed;
  try {
    parsed = load(raw);
  } catch (err) {
    fail(path, `YAML parse error: ${err.message}`);
    continue;
  }
  validate(`aircraft/${e.name}/performance.yaml`, parsed);
  checked += 1;
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s) across ${checked} file(s).`);
  process.exit(1);
}
console.log(`✓ ${checked} aircraft performance file(s) validated.`);
