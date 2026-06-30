#!/usr/bin/env python3
"""Sanity-check freshly-generated dataset files before they're committed.

Each argument is "PATH:MIN" — the JSON file at PATH must be a top-level
array with at least MIN elements. A pipeline that exits 0 but writes an
empty or implausibly short file (e.g. the FAA changed a fixed-width
layout and the parser silently dropped every record) would otherwise
commit nothing and keep the weekly run green forever. Failing here turns
that into a red run, which the notify job escalates to an issue.

Exit status is non-zero (and a ::error:: annotation is emitted) on the
first file that's missing, unreadable, not an array, or under its floor.
"""
import json
import sys


def fail(msg: str) -> None:
    # GitHub Actions surfaces ::error:: lines as annotations on the run.
    print(f"::error::{msg}")
    sys.exit(1)


def main(specs: list[str]) -> None:
    if not specs:
        fail("check_counts.py: no PATH:MIN specs given")
    for spec in specs:
        path, _, min_str = spec.rpartition(":")
        if not path or not min_str.isdigit():
            fail(f"check_counts.py: bad spec {spec!r} (want PATH:MIN)")
        minimum = int(min_str)
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            fail(f"{path}: file not written by the pipeline")
        except (OSError, json.JSONDecodeError) as exc:
            fail(f"{path}: unreadable / invalid JSON ({exc})")
        if not isinstance(data, list):
            fail(f"{path}: expected a top-level JSON array")
        count = len(data)
        if count < minimum:
            fail(f"{path}: only {count:,} records (floor {minimum:,}) — likely a parse regression")
        print(f"{path}: {count:,} records (floor {minimum:,}) ✓")


if __name__ == "__main__":
    main(sys.argv[1:])
