"""Extract the cells observed around this city from the OpenCelliD dumps.

Not part of a build, and unlike `fetch_asr.py` this one needs a credential: a
free OpenCelliD API token, from opencellid.org, passed as OPENCELLID_TOKEN or
`--token`. The token is never written into the output.

What this is for, and what it is emphatically not for
-----------------------------------------------------
OpenCelliD is crowdsourced. Each row is a cell identifier together with the
*centroid of the positions phones were in when they saw it*, which is not where
the transmitter is. The error runs to hundreds of metres and is biased toward
roads, because that is where the contributors were driving. Around Kierston the
median observed site sits 785 m from the nearest registered ASR structure,
which is entirely consistent with those being the same sites, mislocated.

So: **never use these coordinates as tower positions.** Structures come from
ASR and from the rooftop model. What this file is read for is the half of the
network ASR knows nothing about — the identifiers.

    which eNodeB and gNodeB id ranges an operator actually uses here, so the
    simulation can allocate from a block that is demonstrably clear of them

    which tracking area codes are in use, and how many of them a city this size
    is divided into

    how many sectors and band layers a site carries, as a median over real ones

    which radio technologies are actually deployed — around Kierston that is
    LTE and NR and nothing else, which is the 3G shutdown showing up as data
    rather than as an assumption

Coverage is uneven by operator and that unevenness is not evidence. Verizon is
absent from the Kierston extract entirely despite owning more registered
structures here than anyone else; it is a known blind spot in crowdsourced
collection rather than a fact about the market. An operator missing from this
file means nothing at all about whether it is on the air.
"""

import argparse
import collections
import csv
import gzip
import io
import json
import math
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "init"))

import profile as city_profile  # noqa: E402
from paths import OPENCELLID as OUTPUT  # noqa: E402

ENDPOINT = "https://opencellid.org/ocid/downloads"

# The mobile country codes a US city needs. 310 is the original US assignment
# and 311/312/316 are the overflow the FCC opened as it filled; 313 is where
# EchoStar's Boost network lives, which is the one that matters here because a
# Boost IMSI does not start 310 and code that assumes it does breaks on them.
US_MCC = ("310", "311", "312", "313", "316")

# The columns of an OpenCelliD dump, which has no header row.
COLUMNS = ("radio", "mcc", "net", "area", "cell", "unit", "lon", "lat",
           "range", "samples", "changeable", "created", "updated", "signal")

# Which operator an (mcc, mnc) pair belongs to. The same table `init/personal_
# records/devices.py` carries, plus the codes that only ever appear on the air:
# a network broadcasts several MNCs and a SIM is provisioned against one of
# them, so the two lists overlap without being equal.
OPERATORS = {
    ("310", "004"): "Verizon", ("310", "012"): "Verizon",
    ("310", "010"): "Verizon", ("311", "480"): "Verizon",
    ("310", "410"): "AT&T", ("310", "150"): "AT&T", ("310", "070"): "AT&T",
    ("310", "260"): "T-Mobile", ("310", "160"): "T-Mobile",
    ("310", "200"): "T-Mobile", ("310", "120"): "T-Mobile (ex-Sprint)",
    ("311", "490"): "T-Mobile (ex-Sprint)",
    ("313", "340"): "Boost",
}

# How many low bits of the cell identifier belong to the cell rather than to
# the base station. LTE splits a 28-bit ECI into a 20-bit eNodeB id and an
# 8-bit cell; NR's 36-bit NCI has a configurable split, and 12 is the common
# choice — so a gNodeB id recovered this way is an estimate and is labelled one.
CELL_BITS = {"LTE": 8, "NR": 12}


def metres(lat, lon, centre):
    dy = (lat - centre[0]) * 111_320
    dx = (lon - centre[1]) * 111_320 * math.cos(math.radians(centre[0]))
    return math.hypot(dx, dy)


def download(mcc, token, cache=None):
    """One MCC's dump, decompressed. Returns None where there is nothing to serve.

    A cache directory is checked first and written back to on success, because
    the download quota is a couple of files a day against five MCCs a US city
    wants. Without it, standing up a city takes three days and re-running the
    extract after a bug costs another two.
    """
    if cache:
        cached = cache / f"{mcc}.csv.gz"
        if cached.exists():
            print(f"  MCC {mcc}: from cache")
            return gzip.decompress(cached.read_bytes()).decode("utf-8", "replace")

    url = f"{ENDPOINT}?token={token}&type=mcc&file={mcc}.csv.gz"
    try:
        with urllib.request.urlopen(url) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        # 401 is a bad token. 403 and 429 are both the download quota, which is
        # a couple of files a day — the service is inconsistent about which it
        # returns, so neither should be read as a permissions problem.
        raise SystemExit(
            f"OpenCelliD refused MCC {mcc}: {error.code} {error.reason}\n"
            f"  401: bad token. 403/429: daily download quota used; retry "
            f"tomorrow or pass --cache with a directory holding {mcc}.csv.gz")
    if not payload:
        return None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / f"{mcc}.csv.gz").write_bytes(payload)
    return gzip.decompress(payload).decode("utf-8", "replace")


def local(text, centre, radius):
    """The rows inside the extent, as dicts, with a distance attached."""
    span = radius / 111_320 * 1.5
    found = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < len(COLUMNS):
            continue
        try:
            lon, lat = float(row[6]), float(row[7])
        except ValueError:
            continue
        if abs(lat - centre[0]) > span or abs(lon - centre[1]) > span * 1.4:
            continue
        distance = metres(lat, lon, centre)
        if distance > radius:
            continue
        cell = dict(zip(COLUMNS, row))
        found.append({
            "radio": cell["radio"],
            "mcc": cell["mcc"],
            "mnc": cell["net"],
            "operator": OPERATORS.get((cell["mcc"], cell["net"])),
            "area": int(cell["area"]),
            "cell": int(cell["cell"]),
            "lat": lat,
            "lon": lon,
            "observed_range_m": int(cell["range"]),
            "samples": int(cell["samples"]),
            "updated": datetime.fromtimestamp(
                int(cell["updated"]), timezone.utc).date().isoformat(),
            "metres_from_centre": round(distance),
        })
    return found


def summarise(cells):
    """The allocation facts this file exists to supply, per operator and radio.

    Only ranges and counts, deliberately. The individual identifiers are kept
    in the extract for provenance, but what the pipeline reads is this: an
    operator's observed id span, so it can allocate outside it.
    """
    grouped = collections.defaultdict(list)
    for cell in cells:
        grouped[(cell["operator"] or f"{cell['mcc']}-{cell['mnc']}",
                 cell["radio"])].append(cell)

    summary = []
    for (operator, radio), rows in sorted(grouped.items()):
        bits = CELL_BITS.get(radio)
        stations = sorted({row["cell"] >> bits for row in rows}) if bits else []
        sectors = collections.Counter(row["cell"] >> bits for row in rows) \
            if bits else collections.Counter()
        counts = sorted(sectors.values())
        summary.append({
            "operator": operator,
            "radio": radio,
            "mcc": rows[0]["mcc"],
            "mnc_observed": sorted({row["mnc"] for row in rows}),
            "cells": len(rows),
            "sites": len(stations),
            "station_id_min": stations[0] if stations else None,
            "station_id_max": stations[-1] if stations else None,
            "station_id_estimated": radio == "NR",
            "median_cells_per_site": counts[len(counts) // 2] if counts else None,
            "tracking_areas": sorted({row["area"] for row in rows}),
        })
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--token", default=os.environ.get("OPENCELLID_TOKEN"))
    parser.add_argument("--out", type=Path, default=OUTPUT)
    parser.add_argument("--mcc", nargs="+", default=US_MCC)
    parser.add_argument("--margin", type=int, default=3000)
    parser.add_argument("--cache", type=Path, default=None,
                        help="directory of <mcc>.csv.gz files, read before "
                             "downloading and updated after")
    args = parser.parse_args()

    if not args.token:
        raise SystemExit(
            "no OpenCelliD token; pass --token or set OPENCELLID_TOKEN.\n"
            "  Free tokens: https://opencellid.org/")

    city = city_profile.load()
    centre = tuple(city.extent.center)
    radius = city.extent.radius_m + args.margin

    cells, fetched = [], []
    for mcc in args.mcc:
        text = download(mcc, args.token, args.cache)
        if not text:
            print(f"  MCC {mcc}: empty")
            continue
        found = local(text, centre, radius)
        print(f"  MCC {mcc}: {text.count(chr(10)):,} rows, {len(found)} local")
        fetched.append(mcc)
        cells += found

    cells.sort(key=lambda row: (row["operator"] or "", row["radio"],
                                row["metres_from_centre"]))
    inside = sum(1 for c in cells
                 if c["metres_from_centre"] <= city.extent.radius_m)

    allocation = summarise(cells)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "source": "OpenCelliD bulk MCC dumps",
        "url": ENDPOINT,
        "license": "CC BY-SA 4.0, Unwired Labs",
        "retrieved": datetime.now(timezone.utc).date().isoformat(),
        "mcc_fetched": fetched,
        "centre": list(centre),
        "radius_m": radius,
        "note": "Positions are crowdsourced centroids of where handsets "
                "observed each cell, not transmitter locations — they run "
                "hundreds of metres out and are biased toward roads. Read this "
                "file for identifier allocation and site structure only. "
                "Operator coverage is uneven; an absent operator is a gap in "
                "collection, not in the market.",
        "count": len(cells),
        "within_city_radius": inside,
        "allocation": allocation,
        "cells": cells,
    }, indent=1))

    print(f"\n{args.out}")
    print(f"  {len(cells)} observed cells, {inside} inside the city radius")
    for row in allocation:
        print(f"  {row['operator']:<22} {row['radio']:<3} "
              f"{row['cells']:>4} cells  {row['sites']:>3} sites  "
              f"ids {row['station_id_min']}–{row['station_id_max']}")


if __name__ == "__main__":
    main()
