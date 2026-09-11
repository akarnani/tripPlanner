#!/usr/bin/env python3
"""Blank the runway Pavement Classification field in an unzipped NASR APT file.

SwiftNASR cannot parse the value the FAA started shipping in the cycle
effective 2026-09-03. The field used to hold a bare five-part PCN
("71 /F/A/W/T"); it now leads with the rating system it is quoting
("PCN/11  /R/C/X/U"), and will hold four-part PCR values as airports move
to the ICAO Pavement Classification Rating. SwiftNASR requires exactly
five slash-separated components and throws otherwise — and because the
throw comes from parseRunwayRecord, the parse error handler drops the
whole runway record, length and width included. Measured on the
2026-09-03 cycle, parsing it unblanked costs 755 of the 7,487 runways
this pipeline ships and leaves 399 public-use airports with none at all.
Those are the load-rated paved fields, and the trip planner filters
candidate airports on runway length, so they would quietly stop
appearing in routes.

Nothing downstream reads pavement classification: pipeline-nasr writes
only length, width, and surface. So blank the field before parsing and
the runway records survive intact.

Remove this once SwiftNASR parses PCR-era values; see
https://github.com/RISCfuture/SwiftNASR.

Usage: patch_apt_pavement.py <unzipped-distribution-dir>
"""
import pathlib
import re
import sys

# The FAA identifies layout fields by element ID in the fourth column of a
# field-definition line, e.g.
#     L AN 0016 00050  A39     PAVEMENT CLASSIFICATION
# A39 is the runway record's pavement classification. Reading the offset
# and width from the layout rather than hardcoding them means a future
# cycle that moves or re-widens the field is still blanked correctly —
# and a cycle that renames or drops it fails loudly here.
FIELD_LINE = re.compile(
    r"^[A-Z]\s+A?N[A-Z]*\s+(?P<length>\d{4})\s+(?P<offset>\d{5})\s+A39\s+PAVEMENT CLASSIFICATION"
)
RECORD_TYPE = "RWY"


def fail(msg: str) -> None:
    # GitHub Actions surfaces ::error:: lines as annotations on the run.
    print(f"::error::{msg}")
    sys.exit(1)


def find_field(layout: pathlib.Path) -> tuple[int, int]:
    """Return the (0-based start, length) of the pavement classification field."""
    matches = [
        m
        for m in (FIELD_LINE.match(line) for line in layout.read_text(encoding="latin-1").splitlines())
        if m
    ]
    if len(matches) != 1:
        fail(
            f"{layout}: expected exactly 1 A39 PAVEMENT CLASSIFICATION field "
            f"definition, found {len(matches)} — the APT layout changed shape"
        )
    m = matches[0]
    # Layout offsets are 1-based positions within the record.
    return int(m.group("offset")) - 1, int(m.group("length"))


def main(argv: list[str]) -> None:
    if len(argv) != 1:
        fail("usage: patch_apt_pavement.py <unzipped-distribution-dir>")
    root = pathlib.Path(argv[0])
    apt = root / "APT.txt"
    layout = root / "Layout_Data" / "apt_rf.txt"
    for path in (apt, layout):
        if not path.is_file():
            fail(f"{path}: not found — is this an unzipped NASR distribution?")

    start, length = find_field(layout)
    blank = " " * length
    patched = 0
    kept = 0

    tmp = apt.with_suffix(".txt.patched")
    with apt.open("r", encoding="latin-1", newline="") as src, tmp.open(
        "w", encoding="latin-1", newline=""
    ) as dst:
        for line in src:
            if line.startswith(RECORD_TYPE) and len(line.rstrip("\r\n")) >= start + length:
                value = line[start : start + length]
                if value != blank:
                    line = line[:start] + blank + line[start + length :]
                    patched += 1
                else:
                    kept += 1
            dst.write(line)
    tmp.replace(apt)

    print(
        f"{apt}: blanked pavement classification on {patched:,} runway records "
        f"({kept:,} were already blank), field at byte {start + 1} width {length}"
    )
    if patched == 0:
        # Every cycle so far carries hundreds of these. Zero means the field
        # moved and the offsets above are lying, which is worth a red run.
        fail(f"{apt}: no runway record carried a pavement classification value")


if __name__ == "__main__":
    main(sys.argv[1:])
