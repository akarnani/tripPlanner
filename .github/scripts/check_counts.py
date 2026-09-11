#!/usr/bin/env python3
"""Sanity-check freshly-generated dataset files before they're committed.

Each positional argument is "PATH:MIN" — the JSON file at PATH must be a
top-level array with at least MIN elements. A pipeline that exits 0 but
writes an empty or implausibly short file (e.g. the FAA changed a
fixed-width layout and the parser silently dropped every record) would
otherwise commit nothing and keep the weekly run green forever. Failing
here turns that into a red run, which the notify job escalates to an
issue.

A whole-file floor only catches a wholesale parse failure. Losing one
record type — a runway layout the parser chokes on, say, while the
airports it belongs to still parse — barely moves the total but guts the
data the app plans with. So "--min-positive PATH:FIELD:MIN" additionally
requires that at least MIN records in PATH carry a positive numeric
FIELD: airports keep their runway counts, or the run goes red.

Exit status is non-zero (and a ::error:: annotation is emitted) on the
first check that fails.
"""
import json
import sys


def fail(msg: str) -> None:
    # GitHub Actions surfaces ::error:: lines as annotations on the run.
    print(f"::error::{msg}")
    sys.exit(1)


def load_array(path: str) -> list:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        fail(f"{path}: file not written by the pipeline")
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{path}: unreadable / invalid JSON ({exc})")
    if not isinstance(data, list):
        fail(f"{path}: expected a top-level JSON array")
    return data


def check_count(spec: str) -> None:
    path, _, min_str = spec.rpartition(":")
    if not path or not min_str.isdigit():
        fail(f"check_counts.py: bad spec {spec!r} (want PATH:MIN)")
    minimum = int(min_str)
    count = len(load_array(path))
    if count < minimum:
        fail(f"{path}: only {count:,} records (floor {minimum:,}) — likely a parse regression")
    print(f"{path}: {count:,} records (floor {minimum:,}) ✓")


def check_positive(spec: str) -> None:
    path, _, rest = spec.partition(":")
    field, _, min_str = rest.rpartition(":")
    if not path or not field or not min_str.isdigit():
        fail(f"check_counts.py: bad spec {spec!r} (want PATH:FIELD:MIN)")
    minimum = int(min_str)
    data = load_array(path)
    count = sum(
        1
        for rec in data
        if isinstance(rec, dict)
        and isinstance(rec.get(field), (int, float))
        and not isinstance(rec.get(field), bool)
        and rec[field] > 0
    )
    if count < minimum:
        fail(
            f"{path}: only {count:,} of {len(data):,} records have a positive "
            f"{field!r} (floor {minimum:,}) — likely a dropped record type"
        )
    print(f"{path}: {count:,} records with positive {field!r} (floor {minimum:,}) ✓")


def main(argv: list[str]) -> None:
    counts: list[str] = []
    positives: list[str] = []
    it = iter(argv)
    for arg in it:
        if arg == "--min-positive":
            spec = next(it, None)
            if spec is None:
                fail("check_counts.py: --min-positive needs a PATH:FIELD:MIN spec")
            positives.append(spec)
        elif arg.startswith("--"):
            fail(f"check_counts.py: unknown option {arg!r}")
        else:
            counts.append(arg)
    if not counts and not positives:
        fail("check_counts.py: no checks given")
    for spec in counts:
        check_count(spec)
    for spec in positives:
        check_positive(spec)


if __name__ == "__main__":
    main(sys.argv[1:])
