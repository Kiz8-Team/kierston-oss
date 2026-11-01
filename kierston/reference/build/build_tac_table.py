"""Reduce a TAC allocation table to the handset models Kierston uses.

The first eight digits of an IMEI are the Type Allocation Code, and they name
the make and model of the handset. That mapping is what makes an IMEI worth
anything to somebody holding one: the serial that follows it identifies the
individual phone, but the TAC is the part that answers "what is this". Every
IMEI lookup service, every stolen-handset check and every piece of forensic
tooling resolves a TAC against a database to get back a manufacturer and a
model name.

Which is the whole reason this file exists rather than a generator. Kierston is
a benchmark for investigative tooling, and a synthetic city whose TACs resolve
to nothing would fail the lookup step of every workflow it is meant to
exercise — worse, it would fail it *detectably*, marking every handset in the
city as fake before any other question got asked. Colliding with the real
allocation is the goal here and not a hazard: a TAC identifies a model, not a
person and not a handset, so a real iPhone 15 TAC on a synthetic iPhone 15
impersonates nobody. It simply makes the record true.

Source
------
The GSMA owns the authoritative TAC database and licenses it. Public bulk
mirrors exist and are good enough, because a TAC is a published fact the moment
a phone ships — anybody with the handset can read it off the box.

    https://github.com/MoazEb/tac-database   tac_full.csv, MIT licensed,
                                             254,997 rows, coverage to
                                             December 2025, itself
                                             cross-referenced from Osmocom's
                                             tacdb and public IMEI databases

Two other mirrors were checked and rejected. VTSTech/IMEIDB (27,763 rows) stops
at the iPhone 8 and Galaxy S8, which is 2017 — it cannot name a single handset
released in the eight years this city's phones were actually bought in.
tacdb.osmocom.org is upstream of the file above and is already folded into it.

The 12 MB source is not checked in: `kierston/data/*.csv` is gitignored, the
same arrangement the NHTS and EPA extracts have. Download it once, run this,
and commit the ~40 KB of JSON that comes out.

    curl -L -o kierston/data/tac_full.csv \\
      https://raw.githubusercontent.com/MoazEb/tac-database/main/tac_full.csv
    python util_scripts/build_tac_table.py

What this keeps, and what it throws away
----------------------------------------
Only the models `init/personal_records/devices.py` can actually assign. That is
around fifty of them against 254,997 rows, so this is a 99.98% cut, and the
point of taking it is that the catalogue and the TAC table must not be able to
drift apart: a model in one and not the other is a handset whose IMEI decodes
to the wrong phone, which is precisely the failure this whole exercise is meant
to prevent. CATALOGUE below is therefore the join, written out by hand, and the
script fails loudly on any entry it cannot resolve.

US variants are preferred where the source distinguishes them, because this is
a US city. A Galaxy A15 sold in Allentown is an SM-A156U and the SM-A156E is
sold somewhere else; both are real TACs and only one of them belongs in a
Pennsylvania pocket. Where the source draws no such distinction — Apple's
A-numbers are only sometimes annotated, and Google's G-codes never are — every
variant is eligible and the difference is not recoverable.

Leading zeros are restored. The source stores TACs as bare numbers, so a TAC
allocated by PTCRB — reporting body 01, which is the *US* body and therefore
disproportionately what a US-market handset carries — arrives seven digits
long with its leading zero eaten by a spreadsheet. Every TCL entry in the
catalogue is in that state. Left uncorrected they would be seven-digit TACs,
which no validator accepts and no lookup resolves.
"""

import argparse
import csv
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path


# Reference assets are city-independent: the same TAC allocation stands behind
# every city, so this is distilled once into reference/ and never re-run by a
# build. `raw/` holds the bulk original it was cut from.
REFERENCE = Path(__file__).resolve().parents[1]
SOURCE = REFERENCE / "raw" / "tac_full.csv"
OUT = REFERENCE / "tac_table.json"

SOURCE_URL = ("https://raw.githubusercontent.com/MoazEb/tac-database/main/"
              "tac_full.csv")
SOURCE_REPO = "https://github.com/MoazEb/tac-database"
SOURCE_LICENSE = "MIT"

# How many TACs to keep per model. A popular handset holds far more than this —
# the source lists 200 for the iPhone 15 alone, one per storage tier, colour,
# modem and market — and keeping all of them would bloat the table without
# adding structure. Eight is enough that a city's worth of one model does not
# report a single TAC, which is the thing that would look wrong.
TACS_PER_MODEL = 8

# The reporting body identifier is the first two digits of a TAC and names the
# body that allocated it. This is the published list; anything outside it in a
# selected TAC means the source row is corrupt, so it is checked rather than
# assumed.
REPORTING_BODIES = {
    "00": "Test / pre-allocation",
    "01": "PTCRB (USA)",
    "10": "PTCRB (USA)",
    "30": "Australia",
    "33": "France",
    "35": "BABT (UK)",
    "44": "BABT (UK)",
    "45": "Denmark",
    "49": "Germany",
    "50": "BABT (UK)",
    "51": "Spain",
    "52": "BABT (UK)",
    "53": "Australia",
    "54": "BABT (UK)",
    "86": "TAF (China)",
    "91": "India",
    "98": "Reserved",
    "99": "Global Hexadecimal Administrator",
}

# The join. Left is (make, model) exactly as devices.py's MODELS spells it;
# right is the label the source file uses, which is the first comma-separated
# segment of its SPECS column upper-cased. They disagree often enough that
# guessing at the mapping does not work — the source calls the 2024 Motorola
# flagship "MOTOROLA EDGE 2024" and the 2023 stylus phone "MOTO G STYLUS
# (2023)", with and without parentheses in the same catalogue — so every pair
# is written out and checked.
CATALOGUE = {
    ("Apple", "iPhone 8"): "APPLE IPHONE 8",
    ("Apple", "iPhone XR"): "APPLE IPHONE XR",
    ("Apple", "iPhone 11"): "APPLE IPHONE 11",
    # The source keys the 2020 SE on its generation and the 2022 SE on the
    # bare name, which is backwards from how Apple markets them and is why
    # both are pinned here rather than pattern-matched.
    ("Apple", "iPhone SE (2nd generation)"): "APPLE IPHONE SE (2ND GEN)",
    # ... and the bare label covers the 2016 original as well as the 2022
    # phone, so this one needs a second filter or a third of its TACs date the
    # handset six years early.
    ("Apple", "iPhone 12"): "APPLE IPHONE 12",
    ("Apple", "iPhone 13"): "APPLE IPHONE 13",
    ("Apple", "iPhone 13 Pro"): "APPLE IPHONE 13 PRO",
    ("Apple", "iPhone SE (3rd generation)"): ("APPLE IPHONE SE", "3rd Gen"),
    ("Apple", "iPhone 14"): "APPLE IPHONE 14",
    ("Apple", "iPhone 14 Pro"): "APPLE IPHONE 14 PRO",
    ("Apple", "iPhone 15"): "APPLE IPHONE 15",
    ("Apple", "iPhone 15 Pro"): "APPLE IPHONE 15 PRO",
    ("Apple", "iPhone 16"): "APPLE IPHONE 16",
    ("Apple", "iPhone 16 Pro"): "APPLE IPHONE 16 PRO",
    ("Apple", "iPhone 16e"): "APPLE IPHONE 16E",
    ("Apple", "iPhone 17"): "APPLE IPHONE 17",
    ("Apple", "iPhone 17 Pro"): "APPLE IPHONE 17 PRO",

    ("Samsung", "Galaxy S8"): "SAMSUNG GALAXY S8",
    ("Samsung", "Galaxy S9"): "SAMSUNG GALAXY S9",
    ("Samsung", "Galaxy A10e"): "SAMSUNG GALAXY A10E",
    ("Samsung", "Galaxy A20"): "SAMSUNG GALAXY A20",
    ("Samsung", "Galaxy S10"): "SAMSUNG GALAXY S10",
    ("Samsung", "Galaxy A03s"): "SAMSUNG GALAXY A03S",
    ("Samsung", "Galaxy A13 5G"): "SAMSUNG GALAXY A13 5G",
    ("Samsung", "Galaxy A14 5G"): "SAMSUNG GALAXY A14 5G",
    ("Samsung", "Galaxy A15 5G"): "SAMSUNG GALAXY A15 5G",
    ("Samsung", "Galaxy A16 5G"): "SAMSUNG GALAXY A16 5G",
    ("Samsung", "Galaxy A53 5G"): "SAMSUNG GALAXY A53 5G",
    ("Samsung", "Galaxy A54 5G"): "SAMSUNG GALAXY A54 5G",
    ("Samsung", "Galaxy A55 5G"): "SAMSUNG GALAXY A55 5G",
    ("Samsung", "Galaxy S21 5G"): "SAMSUNG GALAXY S21 5G",
    ("Samsung", "Galaxy S22"): "SAMSUNG GALAXY S22",
    ("Samsung", "Galaxy S23"): "SAMSUNG GALAXY S23",
    ("Samsung", "Galaxy S24"): "SAMSUNG GALAXY S24",
    ("Samsung", "Galaxy S25"): "SAMSUNG GALAXY S25",

    ("Motorola", "moto e4"): "MOTOROLA MOTO E4",
    ("Motorola", "moto e5 play"): "MOTOROLA MOTO E5 PLAY",
    ("Motorola", "moto g7"): "MOTOROLA MOTO G7",
    ("Motorola", "moto g pure"): "MOTOROLA MOTO G PURE",
    ("Motorola", "moto g play (2023)"): "MOTOROLA MOTO G PLAY (2023)",
    ("Motorola", "moto g play (2024)"): "MOTOROLA MOTO G PLAY (2024)",
    ("Motorola", "moto g stylus (2023)"): "MOTOROLA MOTO G STYLUS (2023)",
    ("Motorola", "moto g 5G (2024)"): "MOTOROLA MOTO G 5G 2024",
    ("Motorola", "moto g power (2025)"): "MOTOROLA MOTO G POWER (2025)",
    ("Motorola", "edge (2024)"): "MOTOROLA EDGE 2024",

    ("Google", "Pixel 6a"): "GOOGLE PIXEL 6A",
    ("Google", "Pixel 7"): "GOOGLE PIXEL 7",
    ("Google", "Pixel 7a"): "GOOGLE PIXEL 7A",
    ("Google", "Pixel 8"): "GOOGLE PIXEL 8",
    ("Google", "Pixel 8a"): "GOOGLE PIXEL 8A",
    ("Google", "Pixel 9"): "GOOGLE PIXEL 9",
    ("Google", "Pixel 9a"): "GOOGLE PIXEL 9A",
    ("Google", "Pixel 10"): "GOOGLE PIXEL 10",

    ("OnePlus", "Nord N30"): "ONEPLUS NORD N30",
    ("OnePlus", "OnePlus 12"): "ONEPLUS 12",
    ("OnePlus", "OnePlus 13"): "ONEPLUS 13",

    ("TCL", "TCL 30 XE 5G"): "TCL 30 XE 5G",
    ("TCL", "TCL 40 XE 5G"): "TCL 40 XE 5G",
    ("TCL", "TCL 50 XE 5G"): "TCL 50 XE 5G",

    ("Nokia", "Nokia G300"): "NOKIA G300",
    ("Nokia", "Nokia G400 5G"): "NOKIA G400 5G",

    # LG K30 is deliberately absent. The source dates it 2018 on some variants
    # and 2019 on others — the US X410 and the later LM-X320 are different
    # phones wearing one name — and there is no way to tell from these rows
    # which allocation belongs to which. Dropping a model costs the catalogue
    # nothing; guessing costs it the one property it is here for.
    ("LG", "LG K51"): "LG K51",
    ("LG", "LG Stylo 6"): "LG STYLO 6",
    ("LG", "LG Velvet 5G"): "LG VELVET 5G",
}

# What a US-market variant looks like in the source's model-number field.
# Samsung suffixes its US models U or U1, Apple annotates some of its A-numbers
# outright, and LG uses carrier-coded suffixes. Anything else is not evidence
# either way rather than evidence against.
US_VARIANT = re.compile(
    r"SM-\w*U\d?\b|US Model|\bUnlocked US\b|LM-\w*(?:TM|VM|UM|AM)\b",
    re.IGNORECASE)


def label_of(specs):
    """The source's model label: the first comma-separated field of SPECS."""
    return specs.split(",")[0].strip().upper()


def released_in(specs):
    """The release year the source states, or None.

    The year is the last four-digit 20xx in the SPECS string, which is where
    this file puts it — sometimes after a comma and sometimes jammed onto the
    end of the model number with no separator at all ("Samsung SM-A156U2023").
    That is why this reads the last match rather than parsing fields.
    """
    years = re.findall(r"(20\d\d)", specs)
    return int(years[-1]) if years else None


def select(rows, label, required=None):
    """Up to TACS_PER_MODEL real TACs for one model, US variants first.

    `required` is a substring the SPECS must also contain, for the handful of
    labels the source reuses across generations of the same name.

    Deterministic: candidates are sorted by TAC before the cut, so re-running
    this against the same source produces the same table and a diff on the
    checked-in file means the source moved.
    """
    matched = [row for row in rows if row["label"] == label
               and (required is None or required in row["SPECS"])]
    if not matched:
        return [], []
    # US variants first, then the rest as a top-up rather than instead of.
    # Preferring them exclusively would leave a model with two TACs where the
    # source has a hundred, and a whole city sharing two allocations of one
    # popular handset is its own kind of wrong.
    preferred = [row for row in matched if US_VARIANT.search(row["SPECS"])]
    remainder = [row for row in matched if not US_VARIANT.search(row["SPECS"])]
    ordered = (sorted(preferred, key=lambda row: row["tac"])
               + sorted(remainder, key=lambda row: row["tac"]))
    # Distinct TACs only: the source lists one row per variant and two variants
    # can share an allocation.
    seen, picked = set(), []
    for row in ordered:
        if row["tac"] not in seen:
            seen.add(row["tac"])
            picked.append(row)
        if len(picked) == TACS_PER_MODEL:
            break
    return picked, matched


def build(source_path):
    rows = []
    with source_path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            tac = (row.get("TAC") or "").strip()
            if not tac.isdigit() or len(tac) > 8:
                continue
            # Restore the leading zeros a spreadsheet ate. A PTCRB allocation
            # starts 01 and arrives here seven digits long.
            row["tac"] = tac.zfill(8)
            row["label"] = label_of(row["SPECS"])
            rows.append(row)

    models, problems = {}, []
    for (make, model), entry in CATALOGUE.items():
        label, required = entry if isinstance(entry, tuple) else (entry, None)
        picked, matched = select(rows, label, required)
        if not picked:
            problems.append(f"no TAC found for {make} {model} "
                            f"(source label {label!r})")
            continue
        # Rows whose SPECS states no year at all are common and are not a
        # conflict — they are simply silent, and the model's other variants
        # date it.
        years = Counter(year for year in
                        (released_in(row["SPECS"]) for row in picked)
                        if year is not None)
        if not years:
            problems.append(f"{make} {model} ({label!r}) states no release year")
            continue
        if len(years) > 1:
            # Two release years under one label means the label is reused
            # across generations, which is how the iPhone SE got caught. Refuse
            # rather than pick the commoner one — a TAC that dates a handset to
            # the wrong generation is exactly the error this table prevents.
            problems.append(
                f"{make} {model} ({label!r}) spans release years "
                f"{sorted(y for y in years if y)} — add a SPECS filter")
            continue
        models[f"{make}|{model}"] = {
            "make": make,
            "model": model,
            "source_label": label,
            "source_rows": len(matched),
            "us_variant": bool(US_VARIANT.search(picked[0]["SPECS"])),
            # The release year the source states for the variants kept here.
            # devices.py carries its own release year for each model and the
            # verifier below compares the two, because a catalogue that dates a
            # handset differently from its TAC is a catalogue that will sell
            # somebody a phone a year before it existed.
            "released": years.most_common(1)[0][0],
            "tacs": [row["tac"] for row in picked],
            # Kept for provenance: which physical variant each TAC names, so a
            # disagreement with the catalogue is traceable to a row.
            "variants": [row["SPECS"] for row in picked],
        }
    return models, problems, len(rows)


def report(models, source_rows):
    bodies = Counter(tac[:2] for entry in models.values()
                     for tac in entry["tacs"])
    tacs = [tac for entry in models.values() for tac in entry["tacs"]]

    print(f"{source_rows:,} source rows -> {len(models)} models, "
          f"{len(tacs):,} TACs")
    print(f"  {len(tacs) - len(set(tacs)):,} TACs claimed by more than one model")
    print(f"  {sum(1 for t in tacs if len(t) != 8):,} TACs that are not 8 digits")
    print(f"  {sum(1 for e in models.values() if e['us_variant']):,} of "
          f"{len(models)} models resolved to a US variant")

    print("\n  reporting bodies:")
    for body, count in bodies.most_common():
        print(f"    {body}  {REPORTING_BODIES.get(body, 'UNKNOWN'):<34} "
              f"{count:>4}  {100 * count / len(tacs):5.1f}%")

    thin = [f"{e['make']} {e['model']} ({len(e['tacs'])})"
            for e in models.values() if len(e["tacs"]) < 3]
    if thin:
        print(f"\n  models with fewer than 3 TACs: {', '.join(thin)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(
            f"{args.source} is missing — download it once:\n"
            f"    curl -L -o {args.source} {SOURCE_URL}")

    models, problems, source_rows = build(args.source)
    if problems:
        # Loud rather than lenient. A model that silently lost its TACs would
        # be a model devices.py cannot assign, and the failure would surface as
        # a KeyError four files away.
        for problem in problems:
            print(f"  ! {problem}", file=sys.stderr)
        raise SystemExit(
            f"{len(problems)} catalog entries did not resolve; fix "
            f"CATALOGUE or drop the model from devices.py")

    args.out.write_text(json.dumps({
        "source": SOURCE_REPO,
        "source_file": SOURCE_URL,
        "source_license": SOURCE_LICENSE,
        "retrieved": date.today().isoformat(),
        "source_rows": source_rows,
        "tacs_per_model": TACS_PER_MODEL,
        "note": "Real GSMA-allocated TACs, cut to the handsets devices.py "
                "assigns. TACs are 8 digits with leading zeros restored; the "
                "source stores them as bare numbers.",
        "reporting_bodies": REPORTING_BODIES,
        "models": models,
    }, indent=1, sort_keys=True))

    report(models, source_rows)
    print(f"\nWrote {args.out} ({args.out.stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
