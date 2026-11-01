"""Turn the school buildings in the workplace catalogue into enrollable institutions.

`workplaces.py` already found every school in Kierston — it had to, because
schools employ 1,999 people and the education sector has to come from
somewhere. What it produced is a catalogue of *employers*: a site with a floor
area and a staff capacity, which is the only thing work assignment needs. A
student needs three more things that catalogue does not carry:

    band      which grades this building actually teaches. A 12-year-old
              cannot be sent to a building that teaches kindergarten, and
              nothing in `class=school` distinguishes them.
    sector    public, charter or private. This is an eligibility constraint,
              not a label: PUMS records whether each student attends public or
              private, and the two cannot be pooled.
    capacity  how many students fit, which is a different number from how many
              staff fit and comes off a different divisor.

Where the band comes from
-------------------------
The building name, which is the only evidence there is. American schools are
named for their level with unusual consistency — "Elementary", "Middle",
"High School", "Early Childhood Center" — and 66 of the 77 sites here carry a
name. The 11 that do not are left unbanded and are eligible for any K-12 grade,
which lets the capacity fit use them rather than stranding their floor area.

This is inference from a string and it will occasionally be wrong. It is
reported per band every run so the misses are visible, and `EXCLUDE` catches
the cases where the name says the building is not a school at all.

Colleges are campuses, not buildings
------------------------------------
The 22 `class=college` sites are the individual buildings of Muhlenberg and
Cedar Crest — Ettinger Hall, Cressman Library, the Boiler House, the
President's Residence. Enrolling undergraduates into a boiler house is not a
rounding error, it is a category mistake: a campus is one institution that a
student attends, and which of its buildings they are standing in at 10am is a
question for the activity model, not for enrollment. Buildings within
CAMPUS_METRES of each other are therefore merged into a single record whose
floor area is the sum, sited at the floor-weighted centroid.

Capacity is floor area, as everywhere else
------------------------------------------
Same method `workplaces.py` uses for staff, different constant. AREA_PER_STUDENT
is gross building area per enrolled student, which for American schools runs
roughly 11 m² in an elementary school to 17 in a high school — the difference
being laboratories, gymnasia and a corridor network sized for bigger bodies.
These are as soft as the DENSITY table next door, and the achieved fit against
PUMS demand is printed every run so a bad constant shows up as an implausible
fill rather than as a silent shortfall three stages later.
"""

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population import pums


from paths import SIM_DATA
WORKPLACES = SIM_DATA / "workplaces.json"
OUTPUT = SIM_DATA / "schools.json"

DEFAULT_SEED = 20260729

# The site classes that could hold students at all. `kindergarten` is separate
# from `school` in OSM and carries the preschool end of the range.
SCHOOL_CLASSES = {"school", "kindergarten"}
COLLEGE_CLASSES = {"college", "university"}

# Gross floor area per enrolled student, m², by band. Wider at the top: a high
# school carries laboratories, a gymnasium and a cafeteria that an elementary
# school either lacks or shares with its assembly hall.
AREA_PER_STUDENT = {
    "prek": 10,
    "elem": 13,
    "middle": 15,
    "high": 17,
    # A commuter campus is mostly teaching space; a residential one counts its
    # dormitories in the same footprint, which is why this is not lower.
    "college": 14,
}

# K-12 bands in grade order. `prek` sits outside it — preschool is not part of
# the catchment system and is not compulsory — and `college` above it.
K12 = ("elem", "middle", "high")

# SCHG code -> band. The reference city's convention: elementary K-5, middle 6-8,
# high 9-12. Codes are the zero-padded codebook form pums.py now emits.
GRADE_BAND = {
    "01": "prek",                                            # nursery/preschool
    "02": "elem", "03": "elem", "04": "elem",                # K, 1, 2
    "05": "elem", "06": "elem", "07": "elem",                # 3, 4, 5
    "08": "middle", "09": "middle", "10": "middle",          # 6, 7, 8
    "11": "high", "12": "high", "13": "high", "14": "high",  # 9-12
    "15": "college", "16": "college",                        # undergrad, grad
}

# Name patterns that fix a band, most specific first — "Central Catholic High
# School" must not match on "Central Elementary" grounds, and an "Early
# Childhood Center" must be tested before anything matches "Center".
BAND_PATTERNS = [
    ("prek", r"pre-?k|pre-?school|nursery|early childhood|day ?care|"
             r"learning academy|little scholars"),
    ("high", r"high school|\bhs\b|senior high"),
    ("middle", r"middle school|junior high|intermediate school"),
    ("elem", r"elementary|primary school|grade school"),
]

# Charter schools are public — lottery-admitted, tuition-free, and PUMS records
# their students under SCH 2. Tested before the private patterns because most
# of them are named "... Academy Charter School" and would otherwise match
# `academy` below.
CHARTER = r"charter"

# Names that mean privately operated. `academy` is the loosest of these and is
# only reached for schools that already failed the charter test.
PRIVATE = (r"catholic|christian|parochial|\bsaints?\b|\bst\.\s|\bste\.\s|"
           r"jewish|hebrew|yeshiva|islamic|montessori|friends school|"
           r"day school|regional school|academy|mercy|lutheran|baptist|"
           r"seventh-day|adventist|episcopal|preparatory|\bprep\b")

# Buildings the extract classes as schools that no child is enrolled in. These
# are real institutions doing real teaching — they are simply not places a
# PUMS respondent means when they report a grade level, and leaving them in
# would hand a share of Kierston's twelve-year-olds to a police academy.
EXCLUDE = (r"police academy|fire academy|driving school|school of art|"
           r"music school|dance school|dancing school|federation|"
           r"beauty school|barber|truck driving|adult education|"
           r"career institute|technical institute")

# Campus buildings whose floor area is not teaching space. Excluded from the
# capacity sum but not from the campus itself — the President's Residence is
# part of Muhlenberg, it just does not hold a lecture.
NON_TEACHING = r"boiler|facilities|security|maintenance|president|residence|" \
               r"power plant|storage|garage"

# How close two college buildings have to be to count as one campus. 400 m
# spans Muhlenberg's quad comfortably and does not reach Cedar Crest, which is
# 2 km away.
CAMPUS_METRES = 400


def metres(a, b):
    """Great-circle distance between two (lat, lon) pairs."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def band_of(name):
    """The band a school name declares, or None if it does not declare one."""
    for band, pattern in BAND_PATTERNS:
        if re.search(pattern, name, re.I):
            return band
    return None


def sector_of(name):
    """public, charter or private. Unnamed schools are public: they are the
    overwhelming majority of the stock, and a private school that failed to get
    its name into OSM is rarer than a public one that did."""
    if re.search(CHARTER, name, re.I):
        return "charter"
    if re.search(PRIVATE, name, re.I):
        return "private"
    return "public"


def campuses(sites):
    """Merge college buildings into campuses by single-link proximity.

    Single-link rather than a fixed radius from a seed: a campus is a chain of
    adjacent buildings, and a strict radius around whichever one happened to be
    first would cut a long quad in half.
    """
    parent = list(range(len(sites)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(sites)):
        for j in range(i + 1, len(sites)):
            a, b = (sites[i]["lat"], sites[i]["lon"]), (sites[j]["lat"], sites[j]["lon"])
            if metres(a, b) <= CAMPUS_METRES:
                parent[find(i)] = find(j)

    grouped = defaultdict(list)
    for index, site in enumerate(sites):
        grouped[find(index)].append(site)
    return list(grouped.values())


def teaching_floor(site):
    """Floor area that could hold a student. Zero for plant and housing."""
    if re.search(NON_TEACHING, site.get("name") or "", re.I):
        return 0
    return site["floor"]


def school_records(catalogue):
    """Every K-12 site as an enrollable record. Returns (records, excluded)."""
    records, excluded = [], Counter()
    for site in catalogue:
        if site["class"] not in SCHOOL_CLASSES:
            continue
        name = site.get("name") or ""
        if re.search(EXCLUDE, name, re.I):
            excluded[name or site["id"]] += 1
            continue

        band = band_of(name)
        # `kindergarten` is a class, not a name, and is the one case where the
        # tag says more about the band than the name does.
        if band is None and site["class"] == "kindergarten":
            band = "prek"
        # Unnamed and unmatched: eligible for any compulsory grade, so the fit
        # can use the floor area instead of stranding it.
        bands = [band] if band else list(K12)

        area = AREA_PER_STUDENT[bands[0]] if band else AREA_PER_STUDENT["elem"]
        records.append({
            "id": site["id"],
            "lat": site["lat"],
            "lon": site["lon"],
            "name": name,
            "kind": "school",
            "bands": bands,
            # Which bands were read off the name and which are a fallback.
            # Anything auditing the band inference needs the difference.
            "banded": band is not None,
            "sector": sector_of(name),
            "floor": site["floor"],
            "capacity": max(1, round(teaching_floor(site) / area)),
            "buildings": [site["id"]],
        })
    return records, excluded


def college_records(catalogue):
    """Every college campus as one enrollable record."""
    sites = [s for s in catalogue if s["class"] in COLLEGE_CLASSES
             and not re.search(EXCLUDE, s.get("name") or "", re.I)]

    records = []
    for group in campuses(sites):
        floor = sum(s["floor"] for s in group)
        teaching = sum(teaching_floor(s) for s in group)
        # Floor-weighted centroid: the campus sits where its mass is, not at
        # whichever building sorted first.
        lat = sum(s["lat"] * s["floor"] for s in group) / floor
        lon = sum(s["lon"] * s["floor"] for s in group) / floor
        # Named for its largest building, which for a real campus is the one
        # people mean. `buildings` keeps the parts addressable.
        anchor = max(group, key=lambda s: s["floor"])
        records.append({
            "id": anchor["id"],
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "name": anchor.get("name") or "",
            "kind": "college",
            "bands": ["college"],
            "banded": True,
            # Not inferred, because there is nothing here to infer it from. A
            # campus is named for its largest building — "New Science
            # Building", "Curtis Hall" — and a building name carries no trace
            # of whether the institution above it is public or private. Running
            # the school patterns over it does not fail, it quietly answers
            # "public" for two private colleges. Nothing reads this: a student
            # picks a campus regardless of sector, because PUMS's public /
            # private answer for an undergraduate describes an institution this
            # catalogue cannot identify from OSM building tags.
            "sector": "unknown",
            "floor": floor,
            "capacity": max(1, round(teaching / AREA_PER_STUDENT["college"])),
            "buildings": sorted(s["id"] for s in group),
        })
    return records


def demand():
    """{band: students} the PUMS weights imply, for the capacity report.

    Read from the sample rather than from population.json, so this stage can
    run and be checked before the population has been synthesised.
    """
    households, quarters = pums.load()
    people = [m for h in households for m in h["members"]] + list(quarters)
    counts = Counter()
    for person in people:
        if person["enrolled"] in (pums.ENROLLED_PUBLIC, pums.ENROLLED_PRIVATE) \
                and person["grade"]:
            band = GRADE_BAND.get(person["grade"])
            if band:
                counts[band] += person["weight"]
    return {band: round(count) for band, count in counts.items()}


def report(records, excluded, wanted):
    schools = [r for r in records if r["kind"] == "school"]
    colleges = [r for r in records if r["kind"] == "college"]
    print(f"{len(schools):,} schools and {len(colleges)} college campuses "
          f"({sum(len(c['buildings']) for c in colleges)} buildings)")

    print("\nband, from the building name:")
    for band in ("prek",) + K12:
        sized = [r for r in schools if r["banded"] and band in r["bands"]]
        seats = sum(r["capacity"] for r in sized)
        want = wanted.get(band, 0)
        fit = f"{seats / want * 100:5.0f}%" if want else "    —"
        print(f"  {band:<8} {len(sized):>3} sites {seats:>7,} seats   "
              f"PUMS wants {want:>6,}   {fit}")

    flexible = [r for r in schools if not r["banded"]]
    if flexible:
        print(f"  {'unbanded':<8} {len(flexible):>3} sites "
              f"{sum(r['capacity'] for r in flexible):>7,} seats   "
              f"eligible for any of {', '.join(K12)}")

    seats = sum(c["capacity"] for c in colleges)
    want = wanted.get("college", 0)
    fit = f"{seats / want * 100:5.0f}%" if want else "    —"
    print(f"  {'college':<8} {len(colleges):>3} sites {seats:>7,} seats   "
          f"PUMS wants {want:>6,}   {fit}")

    print("\nsector:")
    for sector, count in Counter(r["sector"] for r in schools).most_common():
        seats = sum(r["capacity"] for r in schools if r["sector"] == sector)
        print(f"  {sector:<8} {count:>3} sites {seats:>7,} seats")

    if excluded:
        print(f"\n{sum(excluded.values())} sites excluded as not enrollable:")
        for name in sorted(excluded):
            print(f"  {name}")

    print("\nlargest:")
    for record in sorted(records, key=lambda r: -r["capacity"])[:10]:
        print(f"  {record['capacity']:>5,}  "
              f"{(record['name'] or record['id'])[:44]:<44} "
              f"{'/'.join(record['bands'])} {record['sector']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="recorded in the output; unused")
    args = parser.parse_args()

    catalogue = json.loads(WORKPLACES.read_text())["site_records"]
    schools, excluded = school_records(catalogue)
    records = schools + college_records(catalogue)
    wanted = demand()

    SIM_DATA.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "source": WORKPLACES.name,
        "seed": args.seed,
        "area_per_student": AREA_PER_STUDENT,
        "grade_band": GRADE_BAND,
        "schools": len(records),
        "seats": sum(r["capacity"] for r in records),
        # What the sample says is wanted, carried alongside what was built, so
        # the fit is auditable from the file without re-reading PUMS.
        "demand": wanted,
        "excluded": sorted(excluded),
        "school_records": records,
    }, separators=(",", ":")))

    report(records, excluded, wanted)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
