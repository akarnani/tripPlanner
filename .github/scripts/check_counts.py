#!/usr/bin/env python3
"""Sanity-check freshly-generated dataset files before they're committed.

Each argument is "PATH:MIN". The JSON file at PATH must hold at least MIN
records. A pipeline that exits 0 but writes an empty or implausibly short
file (e.g. the FAA changed a fixed-width layout and the parser silently
dropped every record) would otherwise commit nothing and keep the weekly
run green forever. Failing here turns that into a red run, which the
notify job escalates to an issue.

Two file shapes are accepted:

  * a bare top-level array (airports.json, runways.json, …)
  * an object with exactly one array-valued key plus metadata
    (navaids.json / fixes.json, which carry a "cycle" stamp)

Files carrying a cycle stamp are additionally checked for staleness: if
the cycle already expired, we fetched an out-of-date distribution, which
is a silent-wrong-data failure rather than a missing-data one.

Exit status is non-zero (and a ::error:: annotation is emitted) on the
first file that's missing, unreadable, misshapen, expired, or under its
floor.
"""
import datetime
import json
import sys
from typing import NoReturn


def fail(msg: str) -> NoReturn:
    # GitHub Actions surfaces ::error:: lines as annotations on the run.
    print(f"::error::{msg}")
    sys.exit(1)


def record_count(path: str, data: object) -> int:
    """Number of records in either accepted file shape."""
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        arrays = [k for k, v in data.items() if isinstance(v, list)]
        if len(arrays) != 1:
            fail(
                f"{path}: expected a top-level array, or an object with exactly "
                f"one array-valued key (found {len(arrays)}: {sorted(arrays)})"
            )
        return len(data[arrays[0]])
    fail(f"{path}: expected a top-level JSON array or object")


def check_cycle(path: str, data: object) -> None:
    """Reject a dataset whose AIRAC cycle has already expired."""
    if not isinstance(data, dict):
        return
    cycle = data.get("cycle")
    if not isinstance(cycle, dict):
        return
    expires = cycle.get("expires")
    if not expires:
        fail(f"{path}: cycle stamp present but has no expiry date")
    try:
        expiry = datetime.date.fromisoformat(expires)
    except (TypeError, ValueError):
        # TypeError covers a non-string expiry, which would otherwise
        # exit with a bare traceback and no ::error:: annotation.
        fail(f"{path}: cycle expiry {expires!r} is not an ISO-8601 date")
    today = datetime.datetime.now(datetime.timezone.utc).date()
    if expiry <= today:
        fail(
            f"{path}: cycle expired {expiry} (today {today}) — the pipeline "
            f"fetched a stale distribution"
        )
    print(f"{path}: cycle effective {cycle.get('effective')} → {expiry} ✓")


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
        count = record_count(path, data)
        if count < minimum:
            fail(f"{path}: only {count:,} records (floor {minimum:,}) — likely a parse regression")
        print(f"{path}: {count:,} records (floor {minimum:,}) ✓")
        check_cycle(path, data)


if __name__ == "__main__":
    main(sys.argv[1:])
