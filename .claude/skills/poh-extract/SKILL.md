---
name: poh-extract
description: Extract cruise performance data from an aircraft POH PDF into the trip-planner's performance.yaml schema. Trigger when the user asks to "extract POH", "generate performance.yaml", or invokes /poh-extract on a directory under aircraft/.
---

# POH performance extraction

You are extracting cruise performance data from an aircraft Pilot's
Operating Handbook (POH) PDF into a `performance.yaml` file that the
trip planner uses for range and fuel-burn calculations.

## Inputs

The user invokes you with an argument that should be the path to an
aircraft directory under `aircraft/`, e.g. `/poh-extract aircraft/piper-archer-iii`.

That directory **must** contain a `poh.pdf` file (the contributor's
own copy of the POH). If it doesn't, stop and tell the user where to
place the PDF.

## Output schema

Write a single file at `<aircraft-dir>/performance.yaml` with this
exact structure:

```yaml
make: <string>            # Manufacturer, e.g. "Cessna", "Piper"
model: <string>           # Model designation, e.g. "172S", "Archer III"
fuel:
  type: 100LL | Jet-A | MoGas
  density_lb_per_gal: <float>     # 6.0 for 100LL, 6.7 for Jet-A
  usable_capacity_gal: <number>   # POH "usable fuel" figure
cruise:                   # One row per altitude/power point from the POH
  - altitude_ft: <integer>
    power_pct: <integer>
    tas_kt: <integer>
    fuel_gph: <float>
  # ... 4–8 rows is typical
climb:
  rate_fpm: <integer>     # Best-rate-of-climb at gross weight, sea level
  fuel_to_climb_gph: <float>
  # Optional but strongly preferred. The routing engine uses this
  # cumulative-from-sea-level table to model climb fuel/time/distance
  # per leg. Without it, the engine falls back to a coarse rate × duration
  # estimate that systematically over-credits high-altitude short legs.
  table:
    - altitude_ft: 0
      time_min: 0
      fuel_gal: 0.0
      distance_nm: 0
    - altitude_ft: <integer>
      time_min: <number>     # cumulative minutes from SL to this altitude
      fuel_gal: <number>     # cumulative gallons burned getting here
      distance_nm: <number>  # cumulative nm covered getting here
    # ... typically 4–7 rows, ascending, every 2,000 ft up to the
    # highest altitude the aircraft is rated for
```

See `aircraft/cessna-172s/performance.yaml` for a reference example.

## Procedure

1. **Locate the file.** Confirm `<aircraft-dir>/poh.pdf` exists. If
   the user didn't pass a directory, list `aircraft/*/poh.pdf` and ask
   which one to process.

2. **Read the relevant POH sections.** With the `Read` tool, open the
   PDF and skim:
   - Section 1 (general) for fuel type and usable capacity.
   - Section 5 (performance) for the cruise tables, the
     "Maximum Rate of Climb" chart (for `rate_fpm`), and the
     "Time, Fuel, and Distance to Climb" chart (for the optional
     climb `table`).

   Standard POHs put cruise performance tables on facing pages, with
   one table per altitude (sea level, 2000, 4000, 6000, 8000, etc.)
   and rows for different power settings. Extract the **standard
   atmosphere** ("ISA" or "0° from standard") column.

   The "Time, Fuel, and Distance to Climb" chart is usually a single
   table with a row per altitude and three columns: minutes, gallons,
   and nautical miles to reach that altitude **from sea level**. Copy
   the values verbatim — they are already cumulative, so don't add or
   subtract anything when transcribing.

3. **Pick representative rows.** Cover the full altitude range the
   aircraft is rated for. A reasonable selection:
   - 2000 ft @ best published power (often 75 %)
   - 4000 ft @ 75 % (or highest power available)
   - 6000 ft @ 75 % (or highest power available)
   - 8000 ft @ 65 %
   - 10000 ft @ 55 %
   - 12000 ft and higher only if the aircraft is approved there

   Use the TAS and fuel flow figures **at gross weight**, ignoring any
   "lean of peak" alternates unless that's the only column.

4. **Sanity check.** Before writing, verify the values pass these
   invariants — they're what `pipelines/validate_perf.mjs` enforces in
   CI:
   - `tas_kt` > 0 and < 400 (no jets in v1)
   - `fuel_gph` > 0 and < 100
   - `usable_capacity_gal` > 0
   - Rows are sorted by ascending `altitude_ft`
   - TAS does not increase wildly with altitude (POH cruise TAS
     should be roughly flat or decreasing with altitude for piston
     singles — flag any row where TAS > 1.15× the previous row's TAS)
   - GPH decreases or stays flat as power decreases at higher altitude
   - Climb-table rows (if present) are strictly ascending by altitude,
     and `time_min`, `fuel_gal`, and `distance_nm` are non-decreasing
     down the table (they're cumulative from sea level)

   If any value looks anomalous, **read the POH page again** before
   writing.

5. **Write the YAML.** Use the `Write` tool to create
   `<aircraft-dir>/performance.yaml`. Keep it tidy — alphabetical
   inside each block isn't required, but match the structure above
   exactly.

6. **Report.** Print a one-screen summary to the user with:
   - Make / model
   - Fuel type, usable capacity
   - The number of cruise rows extracted and the altitude range
   - The lowest- and highest-altitude TAS/GPH values, so they can
     spot-check against the POH at a glance.

Stop there. Don't commit; the contributor opens a PR after reviewing
the file against their POH. The `perf-validate.yml` workflow runs the
schema check + invariants automatically on the PR.

## What not to do

- Do **not** invent values. If the POH doesn't show 10,000 ft, omit
  that row rather than extrapolating.
- Do **not** include performance for non-standard conditions
  (turbocharged variants, alternate engines, etc.) unless that
  variant is what the directory is for.
- Do **not** mix performance data from different aircraft models into
  one YAML.
