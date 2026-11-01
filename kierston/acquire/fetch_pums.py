"""Download every PUMS variable for the configured PUMA.

The extracts this replaces were each cut to the columns some earlier stage
happened to need, so every new question meant another trip to the API and
another file. This asks for every variable the configured ACS PUMS release
publishes and keeps them, because the sample is 3,811 people — the whole thing
is smaller than one of the building extracts, and there is no reason to ration
columns at that size.

Two files come out:

    sources/<city>/pums.json            [header, ...rows], one row per person
    sources/<city>/pums_codebook.json   what every variable and every code means

The codebook matters as much as the data. 352 of the 521 variables are coded
integers whose meaning lives only in the API metadata — INDP alone carries 266
industry labels, which is the mapping that `occp_mapping.json` had to be
parsed out of a PDF to provide for occupations. Saving it here means that
never has to happen again for any other coded field.

Batching
--------
The API caps a request at 50 variables, so this issues eleven of them and
joins on (SERIALNO, SPORDER) — the person key. Housing variables repeat across
the people in a household, which is what makes them safe to carry on a
person-level row.

A batch that the API rejects is bisected rather than abandoned, so one
unfetchable variable costs a few extra requests instead of taking 47 good ones
down with it. Which ones failed is reported at the end rather than passed over
in silence.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "init"))

import profile as city_profile  # noqa: E402
from paths import KIERSTON as ROOT, PUMS as OUTPUT, PUMS_CODEBOOK as CODEBOOK  # noqa: E402

KEYFILE = ROOT / ".census_key"

_PROFILE = city_profile.load()
DATASET = (f"https://api.census.gov/data/{_PROFILE.microdata.vintage}"
           f"/acs/{_PROFILE.microdata.dataset}/pums")
STATE = _PROFILE.microdata.state
# The API takes a comma-separated list, so a city spanning several PUMAs is a
# longer profile entry and not a second request.
PUMA = ",".join(_PROFILE.microdata.puma)

# The API's own cap. Two slots are spent on the join key in every batch.
BATCH = 50
KEY_COLUMNS = ("SERIALNO", "SPORDER")

# Returned automatically with every request, or accepted only as a predicate.
# Asking for them by name is either redundant or an error.
GEOGRAPHY = {"PUMA", "state", "for", "in", "ucgid"}


def api_key(override=None):
    """The Census key, from the flag, the environment, or kierston/.census_key.

    Never a literal in this file. The key is a credential and this script is
    checked in; keeping it out means the repository can be shared without
    rotating it.
    """
    key = override or os.environ.get("CENSUS_API_KEY")
    if not key and KEYFILE.exists():
        key = KEYFILE.read_text().strip()
    if not key:
        raise SystemExit(
            f"No Census API key. Pass --key, set CENSUS_API_KEY, or write it "
            f"to {KEYFILE.relative_to(ROOT)} (gitignored).")
    return key


def get(url, retries=3):
    """GET and decode JSON, retrying on the API's occasional 5xx."""
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            # 400 means the request itself is wrong — usually an unfetchable
            # variable — and retrying it will fail identically.
            if error.code < 500:
                raise
            if attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        time.sleep(2 ** attempt)


def variables(key):
    """Every fetchable variable name, and the raw metadata to save as codebook."""
    meta = get(f"{DATASET}/variables.json")["variables"]
    names = sorted(n for n in meta if n not in GEOGRAPHY)
    return names, meta


def fetch(names, key):
    """One batch. Returns {(serialno, sporder): {variable: value}}."""
    columns = list(KEY_COLUMNS) + [n for n in names if n not in KEY_COLUMNS]
    query = urllib.parse.urlencode({
        "get": ",".join(columns),
        "for": f"state:{STATE}",
        "PUMA": PUMA,
        "key": key,
    })
    rows = get(f"{DATASET}?{query}")
    header = rows[0]
    out = {}
    for row in rows[1:]:
        record = dict(zip(header, row))
        person = (record["SERIALNO"], record["SPORDER"])
        out[person] = {n: record[n] for n in columns if n in record}
    return out


def fetch_bisect(names, key, failed):
    """Fetch `names`, splitting on rejection to isolate what the API will not serve."""
    try:
        return fetch(names, key)
    except urllib.error.HTTPError as error:
        if error.code >= 500 or len(names) == 1:
            failed.extend(names)
            print(f"    ! dropped {', '.join(names)} ({error.code})")
            return {}
    half = len(names) // 2
    merged = {}
    for part in (names[:half], names[half:]):
        for person, values in fetch_bisect(part, key, failed).items():
            merged.setdefault(person, {}).update(values)
    return merged


def batches(names):
    """Split into requests of BATCH columns, the join key included in each."""
    body = [n for n in names if n not in KEY_COLUMNS]
    room = BATCH - len(KEY_COLUMNS)
    return [body[i:i + room] for i in range(0, len(body), room)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--key", help="Census API key (else CENSUS_API_KEY)")
    parser.add_argument("--no-replicates", action="store_true",
                        help="skip replicate weights PWGTP1-80 and WGTP1-80 "
                             "(160 of 521 variables, variance estimation only)")
    args = parser.parse_args()
    key = api_key(args.key)

    names, meta = variables(key)
    if args.no_replicates:
        names = [n for n in names
                 if not (n.startswith(("PWGTP", "WGTP")) and n[-1].isdigit())]

    groups = batches(names)
    print(f"{len(names)} variables in {len(groups)} requests")

    people, failed = {}, []
    for index, group in enumerate(groups, 1):
        print(f"  {index:>2}/{len(groups)}  {group[0]}..{group[-1]}", flush=True)
        for person, values in fetch_bisect(group, key, failed).items():
            people.setdefault(person, {}).update(values)

    columns = [n for n in names if n not in failed]
    # SERIALNO and SPORDER first: they are the key, and every later reader
    # groups on them.
    ordered = list(KEY_COLUMNS) + [n for n in columns if n not in KEY_COLUMNS]
    rows = [[people[p].get(n, "") for n in ordered]
            for p in sorted(people, key=lambda p: (p[0], int(p[1])))]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps([ordered] + rows, separators=(",", ":")))
    CODEBOOK.write_text(json.dumps({
        "dataset": DATASET,
        "state": STATE,
        "puma": PUMA,
        "variables": {n: meta[n] for n in ordered if n in meta},
    }, separators=(",", ":")))

    coded = sum(1 for n in ordered
                if (meta.get(n, {}).get("values") or {}).get("item"))
    print(f"\n{len(rows):,} people × {len(ordered)} variables")
    print(f"{coded} of them carry a value codebook")
    if failed:
        print(f"unavailable: {', '.join(failed)}")
    for path in (OUTPUT, CODEBOOK):
        print(f"Wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
