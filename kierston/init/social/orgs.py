"""Build the catalog of organizations from POIs, worksites and schools.

The social graph needs edges, and almost every edge between two adults who are
not related runs through a place they both turn up at. Three kinds of place do
that work, and the reason they are one catalogue rather than three is that from
the graph's point of view they are indistinguishable: a parish, a warehouse and
a high school are all a roster of people who see each other repeatedly.

    voluntary   POIs people join — congregations, clubs, gyms, lodges, the
                community centres. Built here from the raw POI export, because
                the compact pois.json has dropped the religion, denomination
                and sport tags that decide who joins which one.
    work        the sites in workplaces.json that ended up with staff. Not
                re-derived: assign_work already decided who works where, so
                this reads that answer and turns it into an affiliation.
    school      the schools in schools.json, likewise from assign_school.
    union       one local per INDP sector, which has no POI at all — the union
                hall on the map is UAW Local 677 and nothing else, while a
                twelfth of the workforce carries a card. A local is a real
                affiliation with no address, so it gets an org record with no
                coordinates and is drawn without a distance term.

Every org carries a `pull` — a lognormal size draw, not a capacity. Capacity is
the right model for workplaces, where a seat is a seat; it is the wrong one for
congregations, where the distribution is the point. Real congregations run from
forty people to two thousand in the same square mile, and a catalogue where all
112 are equally likely produces a city with no large church in it, which is the
single most visible way this could look wrong.

What is deliberately not modelled: service times, meeting nights, seasons. A
unit is a cohort of people who know each other, and when it meets does not
change who is in it.
"""

import argparse
import json
import math
import random
import sys
from collections import Counter
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script. Nothing here imports one yet; the path is
# set because affiliations.py imports *this* module by that name.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from paths import POIS_EXPORT as EXPORT, PUMS_CODEBOOK as CODEBOOK, SIM_DATA  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKPLACES = SIM_DATA / "workplaces.json"
SCHOOLS = SIM_DATA / "schools.json"
EMPLOYMENT = SIM_DATA / "employment.json"
ENROLLMENT = SIM_DATA / "enrollment.json"
ORGS = SIM_DATA / "orgs.json"

DEFAULT_SEED = 20260730

# OSM tag -> org class. Only tags that describe somewhere with a membership;
# a restaurant has regulars but not a roster, and the difference is whether
# the same forty people are there every week.
CLASSES = {
    "amenity=place_of_worship": "worship",
    "leisure=fitness_centre": "gym",
    "leisure=sports_centre": "sports",
    "leisure=pitch": "sports",
    "leisure=track": "sports",
    "leisure=stadium": "sports",
    "leisure=golf_course": "sports",
    "leisure=bowling_alley": "sports",
    "amenity=dojo": "sports",
    "amenity=social_centre": "fraternal",
    "office=association": "fraternal",
    "amenity=community_centre": "civic",
    "amenity=library": "civic",
    "amenity=arts_centre": "civic",
    "amenity=theatre": "civic",
    "tourism=museum": "civic",
    "amenity=music_school": "civic",
    "amenity=social_facility": "youth",
}

# social_facility covers two unrelated things under one tag. Residential and
# clinical care — nursing homes, hospices, shelters — are places people are
# *housed*, and a resident's tie to the building is not a membership. Only the
# outreach half of the tag produces a roster.
FACILITY_SKIP = {"nursing_home", "assisted_living", "group_home", "hospice",
                 "shelter", "food_bank", "clinic", "day_care", "ambulatory_care"}

# Names that decide a class the tags get wrong. OSM tags the senior centres and
# the Boys & Girls Clubs the same way, and they draw completely different
# people; `civic` skews old and `youth` is nobody over eighteen.
NAME_RULES = (
    (("senior", "b'nai b'rith", "active life"), "civic"),
    (("boys & girls", "boys and girls", "youth", "big brothers", "teen",
      "children", "camelot", "mentoring"), "youth"),
    (("vfw", "legion", "masonic", "lodge", "aerie", "elks", "moose",
      "scottish rite", "alpha ", "beta ", "sigma ", "tau "), "fraternal"),
)

# A pitch belongs to a club the way a court belongs to a league: the venue is
# real and public, the club that plays on it is the thing people join. Sport
# comes from the tag where OSM has one, which it does for 90% of pitches.
DEFAULT_SPORT = "general"

# Spread of org sizes within a class, as the sigma of a lognormal on `pull`.
# Worship is the widest by a distance — a cathedral and a storefront church are
# both one place_of_worship node. Gyms and clubs vary much less.
PULL_SIGMA = {"worship": 0.95, "sports": 0.55, "gym": 0.50,
              "fraternal": 0.45, "civic": 0.60, "youth": 0.55}
DEFAULT_PULL_SIGMA = 0.5

# Denominations, for the 58 of 112 places of worship OSM tags as plain
# `christian`. The reference city's actual mix: heavily Catholic and mainline Protestant
# with a large and growing Pentecostal/evangelical Hispanic presence, which is
# the part that matters because it is what a majority-Hispanic congregation
# draw needs to land on.
UNTAGGED_DENOMINATIONS = (
    ("roman_catholic", 0.18), ("pentecostal", 0.22), ("baptist", 0.14),
    ("lutheran", 0.10), ("nondenominational", 0.12), ("methodist", 0.08),
    ("evangelical", 0.09), ("united_church_of_christ", 0.07),
)

# Which naming groups a denomination draws from, as a multiplier on the base
# rate. Only the strong signals are worth encoding: the Spanish-language
# Pentecostal and Catholic congregations, and the historically Black churches.
DENOMINATION_AFFINITY = {
    "roman_catholic": {"hispanic": 1.9, "nh_white": 0.9, "nh_black": 0.4},
    "catholic": {"hispanic": 1.9, "nh_white": 0.9, "nh_black": 0.4},
    "pentecostal": {"hispanic": 2.4, "nh_black": 1.4, "nh_white": 0.3},
    "baptist": {"nh_black": 2.6, "nh_white": 0.7, "hispanic": 0.5},
    "african_methodist_episcopal": {"nh_black": 6.0, "nh_white": 0.1,
                                    "hispanic": 0.1},
    "african_methodist_episcopal_zion": {"nh_black": 6.0, "nh_white": 0.1,
                                         "hispanic": 0.1},
    "lutheran": {"nh_white": 2.2, "hispanic": 0.35, "nh_black": 0.3},
    "united_church_of_christ": {"nh_white": 2.4, "hispanic": 0.3},
    "moravian": {"nh_white": 2.6, "hispanic": 0.2},
    "episcopal": {"nh_white": 2.0, "hispanic": 0.4},
    "methodist": {"nh_white": 1.8, "nh_black": 1.2, "hispanic": 0.4},
    "reformed": {"nh_white": 2.2, "hispanic": 0.3},
    "hindu": {"nh_asian": 12.0, "nh_white": 0.05, "hispanic": 0.02,
              "nh_black": 0.05},
    "jewish": {"nh_white": 3.0, "hispanic": 0.1, "nh_black": 0.1},
    "muslim": {"nh_asian": 4.0, "nh_black": 2.0, "nh_white": 0.3},
}

# Union density by INDP sector prefix, as a share of employed wage and salary
# workers. The spread across sectors is far wider than any average and is what
# decides whether a warehouse and a school district look the same, which they
# should not.
#
# These are per-sector rates and are not rescaled to any total. PA runs 12.3%
# overall and Kierston lands at 9.2%, which is the industry mix doing its job:
# this is a warehousing and retail city and both are near the bottom of the
# table. The affiliations report prints the pair, and the gap is the finding
# rather than a miss to tune out.
UNION_DENSITY = {
    "EDU": 0.34, "PUB": 0.30, "UTL": 0.24, "TRN": 0.18, "CON": 0.15,
    "MFG": 0.11, "MED": 0.09, "SCA": 0.08, "INF": 0.07, "WHL": 0.05,
    "RET": 0.04, "FIN": 0.02, "PRF": 0.03, "ENT": 0.03, "AGR": 0.02,
    "EXT": 0.06, "ADM": 0.05, "SRV": 0.03, "MIL": 0.00,
}
DEFAULT_UNION_DENSITY = 0.04


def position(element):
    """(lat, lon) for a node or a way, or None."""
    if "lat" in element and "lon" in element:
        return element["lat"], element["lon"]
    center = element.get("center")
    return (center["lat"], center["lon"]) if center else None


def address_of(tags):
    """US-style address from addr:* tags, dropping whatever is missing."""
    line = " ".join(p for p in (tags.get("addr:housenumber"),
                                tags.get("addr:street")) if p)
    tail = " ".join(p for p in (tags.get("addr:state"),
                                tags.get("addr:postcode")) if p)
    return ", ".join(p for p in (line, tags.get("addr:city"), tail) if p)


def classify(tags, name):
    """Org class for an element, or None if nothing joins it."""
    if tags.get("amenity") == "social_facility":
        if tags.get("social_facility") in FACILITY_SKIP:
            return None
    for key in ("amenity", "leisure", "office", "tourism"):
        value = tags.get(key)
        if value and f"{key}={value}" in CLASSES:
            lowered = name.lower()
            for words, override in NAME_RULES:
                if any(word in lowered for word in words):
                    return override
            return CLASSES[f"{key}={value}"]
    return None


def denomination(tags, rng):
    """The denomination of a place of worship, invented only where absent."""
    named = tags.get("denomination")
    if named:
        return named, False
    religion = tags.get("religion")
    if religion and religion != "christian":
        return religion, False
    roll = rng.random()
    for name, share in UNTAGGED_DENOMINATIONS:
        roll -= share
        if roll <= 0:
            return name, True
    return UNTAGGED_DENOMINATIONS[-1][0], True


def subclass(org_class, tags, rng):
    """The within-class distinction that decides who joins: sport, or creed."""
    if org_class == "worship":
        return denomination(tags, rng)
    if org_class == "sports":
        sport = (tags.get("sport") or DEFAULT_SPORT).split(";")[0]
        return sport, False
    return None, False


def voluntary(rng):
    """Org records for every POI with a membership."""
    elements = json.loads(EXPORT.read_text())["elements"]
    records, estimated = [], 0
    for element in elements:
        tags = element.get("tags") or {}
        name = tags.get("name") or ""
        org_class = classify(tags, name)
        where = position(element)
        if not org_class or not where:
            continue
        kind, guessed = subclass(org_class, tags, rng)
        estimated += guessed
        records.append({
            "id": f"v:{element['type']}/{element['id']}",
            "source": "poi",
            "class": org_class,
            "subclass": kind,
            "name": name,
            "lat": round(where[0], 6),
            "lon": round(where[1], 6),
            "address": address_of(tags),
            "pull": round(math.exp(rng.gauss(
                0, PULL_SIGMA.get(org_class, DEFAULT_PULL_SIGMA))), 3),
            "estimated": guessed,
        })
    return records, estimated


def workplaces():
    """Org records for the sites that actually have someone working at them.

    A site with no staff is a building, not an affiliation, and the catalogue
    holds 4,503 sites against roughly a thousand that drew anybody.
    """
    catalogue = {s["id"]: s for s in
                 json.loads(WORKPLACES.read_text())["site_records"]}
    staffed = Counter(a["site"] for a in
                      json.loads(EMPLOYMENT.read_text())["assignments"]
                      if a.get("site") and a.get("mode") in ("sited", "itinerant"))
    records = []
    for site_id, count in staffed.items():
        site = catalogue.get(site_id)
        if not site:
            continue
        records.append({
            "id": f"w:{site_id}",
            "source": "work",
            "class": "work",
            "subclass": site["class"],
            "name": site["name"],
            "lat": site["lat"],
            "lon": site["lon"],
            "address": site["address"],
            "pull": count,
            "estimated": False,
        })
    return records


def schools():
    """Org records for the schools that enrolled anybody."""
    catalogue = {s["id"]: s for s in
                 json.loads(SCHOOLS.read_text())["school_records"]}
    enrolled = Counter(a["school"] for a in
                       json.loads(ENROLLMENT.read_text())["assignments"]
                       if a.get("school") and a["school"] != "external")
    records = []
    for school_id, count in enrolled.items():
        school = catalogue.get(school_id)
        if not school:
            continue
        records.append({
            "id": f"s:{school_id}",
            "source": "school",
            "class": "school",
            "subclass": school["sector"],
            "name": school["name"],
            "lat": school["lat"],
            "lon": school["lon"],
            "address": "",
            "pull": count,
            "estimated": False,
        })
    return records


def locals_():
    """One union local per INDP sector, with no address.

    Every other org in this catalogue is somewhere. A local is not: the members
    are spread across every employer in the sector and the hall — where there
    is one — is not where they see each other. Distance is therefore not part
    of joining one, and the shop floor, not the hall, is the unit.
    """
    labels = json.loads(CODEBOOK.read_text())["variables"]["INDP"]["values"]["item"]
    sectors = {label.split("-", 1)[0].strip() for label in labels.values()}
    return [{
        "id": f"u:{sector}",
        "source": "union",
        "class": "union",
        "subclass": sector,
        "name": f"{sector} local",
        "lat": None,
        "lon": None,
        "address": "",
        "pull": 1.0,
        "estimated": True,
    } for sector in sorted(sectors) if UNION_DENSITY.get(sector, 0) > 0]


def report(records, estimated):
    by_class = Counter(r["class"] for r in records)
    print(f"{len(records):,} orgs")
    for name, count in by_class.most_common():
        print(f"  {name:<12}{count:>6,}")

    worship = [r for r in records if r["class"] == "worship"]
    print(f"\n{len(worship)} places of worship, {estimated} with a "
          f"denomination inferred:")
    for name, count in Counter(r["subclass"] for r in worship).most_common(8):
        print(f"  {name:<28}{count:>4}")

    sports = [r for r in records if r["class"] == "sports"]
    print(f"\n{len(sports)} sports venues:")
    for name, count in Counter(r["subclass"] for r in sports).most_common(8):
        print(f"  {name:<28}{count:>4}")

    named = [r for r in records if r["name"] and r["class"] in
             ("fraternal", "civic", "youth")]
    print(f"\n{len(named)} fraternal / civic / youth orgs:")
    for record in sorted(named, key=lambda r: r["class"])[:14]:
        print(f"  {record['class']:<10}{record['name'][:46]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="catalog seed; recorded in the output")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    poi_records, estimated = voluntary(rng)
    records = poi_records + workplaces() + schools() + locals_()

    ORGS.write_text(json.dumps({
        "source": [EXPORT.name, WORKPLACES.name, SCHOOLS.name],
        "seed": args.seed,
        "orgs": len(records),
        "classes": dict(Counter(r["class"] for r in records)),
        "union_density": UNION_DENSITY,
        "org_records": records,
    }, separators=(",", ":")))

    report(records, estimated)
    print(f"\nWrote {ORGS} ({ORGS.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
