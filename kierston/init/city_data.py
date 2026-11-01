"""The city's long lists: `cities/<slug>/*.csv`, one reader per file.

The profile carries the city's scalars; these carry what would make it
unreadable — a hundred-odd telephone exchanges, the banks with branches here,
the colleges a degree came from, the local firms that send the bills. Each is
a plain CSV with a header row, so a new city's author edits a spreadsheet
rather than a Python tuple.

Row order is data. Every consumer draws with `rng.choice` or a weighted
`rng.choices` over the rows as they stand, so reordering a file changes who
gets what even when the set of names is the same. Numbers are parsed back to
the type the draw used before these lists left the code — integer weights as
int, fractional ones as float — so a build reads the same values either way.
"""

import csv
from functools import lru_cache

from paths import (BANKS, BILLERS, COLLEGES, EXCHANGES, GRADUATE_SCHOOLS,
                   GUN_DEALERS, HIGH_SCHOOLS, MAGISTERIAL_DISTRICTS,
                   MORTGAGE_LENDERS, PHARMACIES, SCHOOL_TRANSPORT,
                   TAXI_OPERATORS, require)


def number(text):
    """`12` as int and `0.2` as float; blank as None."""
    if text == "":
        return None
    return float(text) if any(c in text for c in ".eE") else int(text)


@lru_cache(maxsize=None)
def rows(path):
    """Every row of a city CSV, as dicts of strings, in file order."""
    require(path, f"{path.name} is tracked in git beside the city profile; restore it")
    with path.open(newline="", encoding="utf-8") as handle:
        return tuple(csv.DictReader(handle))


def names(path):
    return tuple(row["name"] for row in rows(path))


def exchanges(area_codes):
    """({npa: landline NXXs}, {npa: wireless NXXs}), for every listed area code."""
    tables = {"landline": {npa: [] for npa in area_codes},
              "wireless": {npa: [] for npa in area_codes}}
    for row in rows(EXCHANGES):
        if row["npa"] not in tables[row["service"]]:
            raise SystemExit(f"{EXCHANGES.name}: area code {row['npa']} is not "
                             f"in [locale] area_codes")
        tables[row["service"]][row["npa"]].append(row["nxx"])
    return ({npa: tuple(v) for npa, v in tables["landline"].items()},
            {npa: tuple(v) for npa, v in tables["wireless"].items()})


def magisterial_districts():
    """(district, weight) for the magisterial courts that hear the city's cases."""
    return tuple((r["district"], number(r["weight"]))
                 for r in rows(MAGISTERIAL_DISTRICTS))


def banks():
    """(name, routing prefix, weight) for the banks with branches here."""
    return tuple((r["name"], r["routing_prefix"], number(r["weight"]))
                 for r in rows(BANKS))


def gun_dealers():
    """(name, FFL number) for the licensed dealers in and around the city."""
    return tuple((r["name"], r["ffl"]) for r in rows(GUN_DEALERS))


def colleges():
    """(name, level, weight): where a local associate or bachelor's degree was earned."""
    return tuple((r["name"], r["level"], number(r["weight"]))
                 for r in rows(COLLEGES))


def graduate_schools():
    return names(GRADUATE_SCHOOLS)


def high_schools():
    return names(HIGH_SCHOOLS)


def mortgage_lenders():
    return names(MORTGAGE_LENDERS)


def pharmacies():
    """(name, weight)."""
    return tuple((r["name"], number(r["weight"])) for r in rows(PHARMACIES))


def billers(role):
    """The rows of billers.csv for one role, as dicts with typed weight and price."""
    out = tuple({"name": r["name"], "weight": number(r["weight"]),
                 "price": number(r["price"])}
                for r in rows(BILLERS) if r["role"] == role)
    if not out:
        raise SystemExit(f"{BILLERS.name}: no biller with role {role!r}")
    return out


def biller(role):
    """The one biller for a role that has exactly one."""
    found = billers(role)
    if len(found) != 1:
        raise SystemExit(f"{BILLERS.name}: role {role!r} needs exactly one row, "
                         f"has {len(found)}")
    return found[0]["name"]


def school_transport(base):
    """The school district and its contractor, ids offset from `base`."""
    return tuple({"id": base + int(r["id_offset"]), "name": r["name"],
                  "kind": r["kind"], "legal_form": r["legal_form"],
                  "sectors": tuple(r["sectors"].split(";"))}
                 for r in rows(SCHOOL_TRANSPORT))


def taxi_operators(base):
    """The cab firms, with the workplace site each is based at and a fallback."""
    return tuple({"id": base + int(r["id_offset"]), "name": r["name"],
                  "kind": r["kind"], "legal_form": r["legal_form"],
                  "site": r["site"],
                  "fallback": (number(r["fallback_lat"]), number(r["fallback_lon"])),
                  "fallback_floor": int(r["fallback_floor"])}
                 for r in rows(TAXI_OPERATORS))
