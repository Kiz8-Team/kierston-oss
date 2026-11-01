"""Build the catalogue of places people work, from buildings and POIs.

This is the demand-side twin of `extract_dwellings.py`, and it has the same
shape: take the OSM extract, decide which structures hold people, and say how
many each holds. What makes it harder is that a dwelling announces itself —
`building=house` is a house — while a workplace mostly does not. 4,516
non-residential buildings carry 4.26M m² of floor area, and only 41% of it has
any evidence at all of what industry occupies it.

Matching key
------------
Workers are matched to sites by INDP, not OCCP, and the distinction is the
whole reason this file can exist. Occupation says what a person does; industry
says what kind of establishment employs them. A cashier works at a supermarket,
a hospital gift shop or a filling station — OCCP 4720 maps to no building type
whatsoever. INDP 4971 is "Supermarkets and Other Grocery Retailers", which is
a building you can point at.

The codebook supplies the fallback ladder for free: every INDP label is
sector-prefixed (MED-, RET-, TRN-, ...), 17 groups over 188 codes in use here.
So "matching or adjacent" is exact INDP, then same sector, then anything —
no hand-built similarity matrix required.

Where the labels come from
--------------------------
Three sources, in descending order of trust, recorded per site in `evidence`:

    tag       the building's own amenity/shop/office/healthcare tag
    poi       a POI from pois.json that lands within MATCH_METRES
    inferred  nothing said; the industry was deduced (see below)

`inferred` is 59% of the floor area, and it is not a defect to be minimised —
`building=yes` and `building=commercial` between them hold 868k m² and cannot
be labelled from OSM at any effort, because the tag genuinely carries no
information. Warehouses and factories are barely better: the class is known,
the industry within it is not.

Deducing the rest
-----------------
So the inference runs the other way. ACS is authoritative about how many people
work in each industry; OSM is authoritative about where floor area sits. Fill
the labelled sites first, take what each industry still needs, and distribute
that residual across the anonymous buildings weighted by what their class could
plausibly hold — warehouses take TRN/WHL/MFG, offices take PRF/FIN/INF, and
`building=yes` takes anything at low weight because it is the class that means
"a building". The result is a reading of what must be inside the unlabelled
stock for the surveyed workforce to have somewhere to go.

Two things this deliberately does not do. It does not invent buildings: an
industry whose residual survives the allocation inflates the density of the
sites it already has, and the inflation is reported, because the m²-per-worker
constants are the least trustworthy numbers in the chain and bending them is
more honest than adding floor area nobody surveyed. And it does not site the
~10% who work outside the region — those get portals, below.

Portals
-------
POWPUMA says 9.9% of workers commute out of the region entirely. They need
somewhere to drive to that is not a building, so the boundary gets a ring of
portal nodes carrying the outbound share. Their positions are the extent of
the built area in each compass direction, which is a placeholder: they should
be snapped to where the arterials actually leave the map once the road graph
is wired in. Flagged `provisional` so that is visible rather than assumed.
"""

import argparse
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import facilities

from population import pums
from intake.tags import address_from_tags


from paths import (  # noqa: E402
    BUILDINGS_GEOM as GEOMETRY, POIS, PUMS_CODEBOOK as CODEBOOK, SIM_DATA)

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = SIM_DATA / "workplaces.json"
POPULATION = SIM_DATA / "population.json"

DEFAULT_SEED = 20260729

# Wider than the 30 m facilities.py uses. That threshold was tuned on nine
# emergency stations, which are freestanding and far apart; this runs over 2,162
# POIs including downtown retail strips where the point is dropped on the shop
# front and the building centroid is half a block back. Over-joining costs a
# capacity misattribution between neighbours that the residual step then
# corrects; under-joining loses a real business off the map entirely.
MATCH_METRES = 40

# Buildings nobody works in. Everything else is a candidate site — including
# `building=yes`, which is most of the uncertainty here.
RESIDENTIAL = {
    "house", "semidetached_house", "detached", "apartments", "terrace",
    "bungalow", "residential", "static_caravan", "houseboat", "dormitory",
    "garage", "garages", "carport", "shed", "outbuilding", "hut", "roof",
    "parking", "bridge", "barn",
}

# Floor area per worker, m². Wide by class because a warehouse is mostly air
# and an office is mostly desks. These are the softest numbers in the file;
# `--report` prints how far the fit has to stretch them.
DENSITY = {
    "office": 18, "bank": 25, "government": 25, "civic": 30, "commercial": 30,
    "retail": 40, "supermarket": 40, "kiosk": 40, "clinic": 40, "public": 40,
    "hospital": 50, "yes": 45,
    # Schools are big and mostly full of people who are not employees. Sizing
    # them like offices put 5,800 staff in Kierston's 53 schools against a
    # surveyed 1,999 for the whole education sector.
    "school": 200, "college": 150, "university": 150,
    "kindergarten": 50, "hotel": 60, "fire_station": 60, "service": 80,
    "sports_centre": 80, "industrial": 90, "manufacture": 90,
    "construction": 90, "warehouse": 180, "church": 200, "synagogue": 200,
    "cathedral": 200, "chapel": 200, "mosque": 200,
}
DEFAULT_DENSITY = 50

# Per-industry overrides, applied where the class density is clearly wrong for
# the business that is actually in the unit. A car repair shop is a big shed
# with four people in it, and a hair salon is a small room with three; sizing
# either off `building=commercial` at 30 m² a head triples them.
INDUSTRY_DENSITY = {
    "8770": 120,  # SRV-Automotive Repair — workshop floor, not desks
    "8980": 45,   # SRV-Beauty Salons
    "8990": 45,   # SRV-Nail Salons And Other Personal Care
    "9070": 60,   # SRV-Drycleaning And Laundry
    "9160": 400,  # SRV-Religious Organizations — a congregation is not staff
    "6390": 250,  # TRN-Warehousing And Storage
    "4670": 150,  # RET-Automobile Dealers — the lot is most of the floor area
}

# OSM tag -> INDP. Only what is worth naming: these cover the POI types and
# building tags that actually occur here in quantity. Anything unmatched falls
# through to the class-level inference, which is the designed path, not a
# failure — no table over `shop=*` would ever be complete.
TAG_INDUSTRY = {
    # Food service. ACS puts every sit-down, counter and bar operation in one
    # industry, so the nine OSM food types collapse to a single code.
    "amenity=restaurant": "8680", "amenity=fast_food": "8680",
    "amenity=bar": "8680", "amenity=pub": "8680", "amenity=cafe": "8680",
    "amenity=ice_cream": "8680", "amenity=nightclub": "8680",
    "amenity=hookah_lounge": "8680", "amenity=stripclub": "8680",
    "amenity=food_court": "8680", "amenity=biergarten": "8680",

    # Retail
    "shop=supermarket": "4971", "shop=greengrocer": "4971",
    "shop=convenience": "4973", "shop=kiosk": "4973",
    "shop=department_store": "5382", "shop=mall": "5392",
    "shop=wholesale": "5392", "shop=variety_store": "5392",
    "shop=clothes": "5171", "shop=boutique": "5171", "shop=fashion": "5171",
    "shop=shoes": "5181", "shop=jewelry": "5191", "shop=bag": "5191",
    "shop=chemist": "5071", "amenity=pharmacy": "5071",
    "shop=beauty": "5081", "shop=perfumery": "5081",
    "shop=health_food": "4981", "shop=deli": "4981", "shop=butcher": "4981",
    "shop=bakery": "1190", "shop=seafood": "4981", "shop=dairy": "4981",
    "shop=beverages": "4991", "shop=alcohol": "4991", "shop=wine": "4991",
    "shop=car": "4670", "shop=motorcycle": "4670", "shop=caravan": "4670",
    "shop=car_parts": "4691", "shop=tyres": "4691",
    "shop=car_repair": "8770", "shop=motorcycle_repair": "8770",
    "shop=hvac": "8770", "shop=repair": "8770",
    "shop=furniture": "4771", "shop=bed": "4771", "shop=kitchen": "4771",
    "shop=interior_decoration": "4771", "shop=carpet": "4771",
    "shop=flooring": "4771", "shop=lighting": "4771", "shop=curtain": "4771",
    "shop=electronics": "4796", "shop=appliance": "4796",
    "shop=computer": "4796", "shop=mobile_phone": "4796",
    "shop=radiotechnics": "4796", "shop=vacuum_cleaner": "4796",
    "shop=hardware": "4881", "shop=doityourself": "4871",
    "shop=paint": "4871", "shop=tiles": "4871", "shop=doors": "4871",
    "shop=trade": "4871", "shop=garden_centre": "4871",
    "shop=bathroom_furnishing": "4871", "shop=window_blind": "4871",
    "shop=electrical": "4871",
    "shop=sports": "5276", "shop=fishing": "5276", "shop=games": "5276",
    "shop=video_games": "5276", "shop=toys": "5276", "shop=bicycle": "5276",
    "shop=books": "5581", "shop=stationery": "5481", "shop=copyshop": "5481",
    "shop=gift": "5571", "shop=party": "5571", "shop=florist": "5571",
    "shop=second_hand": "5491", "shop=antiques": "5491",
    "shop=charity": "5491", "shop=pawnbroker": "5491",
    "shop=collector": "5491", "shop=frame": "5581", "shop=music": "5581",
    "shop=pet": "5581", "shop=tobacco": "5581", "shop=e-cigarette": "5581",
    "shop=cannabis": "5581", "shop=erotic": "5581", "shop=craft": "5581",
    "shop=fabric": "5581", "shop=sewing": "5581", "shop=watches": "5581",
    "shop=medical_supply": "5081", "shop=optician": "8070",
    "amenity=fuel": "5090", "shop=gas": "5090", "shop=fuel": "5090",
    "shop=yes": "5791", "shop=general": "5791", "shop=marketplace": "5791",
    "shop=boat": "5581",

    # Personal and repair services
    "shop=hairdresser": "8980", "shop=hairdresser_supply": "8980",
    "shop=massage": "8990", "shop=tattoo": "8990",
    "shop=pet_grooming": "8990", "shop=nail": "8990",
    "shop=laundry": "9070", "shop=dry_cleaning": "9070",
    "shop=tailor": "9070", "shop=shoe_repair": "8770",
    "shop=locksmith": "8770", "shop=storage_rental": "6390",
    "shop=rental": "7080", "shop=plant_hire": "7190",
    "shop=travel_agency": "7670", "shop=ticket": "7670",
    "shop=money_lender": "6890", "shop=religion": "9160",
    "amenity=car_wash": "8770", "amenity=car_rental": "7080",
    "amenity=funeral_directors": "9080",

    # Health
    "amenity=hospital": "8191", "building=hospital": "8191",
    "healthcare=hospital": "8191",
    "amenity=doctors": "7970", "healthcare=doctor": "7970",
    "amenity=clinic": "8090", "healthcare=clinic": "8090",
    "amenity=dentist": "7980", "healthcare=dentist": "7980",
    "healthcare=physiotherapist": "8080",
    "healthcare=alternative": "8080", "healthcare=psychotherapist": "8080",
    "amenity=veterinary": "7490", "amenity=nursing_home": "8270",
    "healthcare=nurse": "8180", "healthcare=laboratory": "8180",

    # Education
    "amenity=school": "7860", "building=school": "7860",
    "amenity=college": "7870", "amenity=university": "7870",
    "building=college": "7870", "building=university": "7870",
    "amenity=kindergarten": "8470", "amenity=childcare": "8470",
    "amenity=music_school": "7890", "amenity=dancing_school": "7890",
    "amenity=driving_school": "7890", "amenity=dojo": "7890",
    "amenity=library": "6770", "amenity=library_dropoff": "6770",

    # Finance, professional, office
    "amenity=bank": "6871", "building=bank": "6871", "office=financial": "6871",
    "office=bank": "6871",
    "office=insurance": "6991", "office=financial_advisor": "6970",
    "office=lawyer": "7270", "office=notary": "7270",
    "office=bail_bond_agent": "7270",
    "office=accountant": "7280", "office=tax_advisor": "7280",
    "office=estate_agent": "7071", "office=property_management": "7072",
    "office=architect": "7290", "office=engineer": "7290",
    "office=surveyor": "7290", "office=it": "7380",
    "office=telecommunication": "6680", "office=advertising_agency": "7470",
    "office=graphic_design": "7370", "office=employment_agency": "7580",
    "office=security": "7680", "office=company": "7390",
    "office=consulting": "7390", "office=research": "7460",
    "office=energy_supplier": "0570", "office=water_utility": "0680",
    "office=yes": "7390",
    "office=association": "9190", "office=union": "9190",
    "office=charity": "9170", "office=ngo": "9170",
    "office=adoption_agency": "8370", "office=money_transfer": "6890",
    "office=post_depot": "6370", "amenity=post_office": "6370",

    # Civic and public administration
    "amenity=place_of_worship": "9160", "building=church": "9160",
    "building=synagogue": "9160", "building=mosque": "9160",
    "building=chapel": "9160", "building=cathedral": "9160",
    "amenity=police": "9470", "amenity=fire_station": "9470",
    "amenity=courthouse": "9470", "amenity=prison": "9470",
    "building=fire_station": "9470",
    "amenity=townhall": "9370", "amenity=government": "9370",
    "building=government": "9370", "office=government": "9370",
    "amenity=social_facility": "8370", "amenity=social_centre": "8370",
    "amenity=community_centre": "9170", "amenity=animal_shelter": "9170",
    "amenity=animal_boarding": "9090",

    # Lodging, leisure, culture
    "tourism=hotel": "8660", "tourism=motel": "8660",
    "tourism=guest_house": "8660", "building=hotel": "8660",
    "amenity=events_venue": "8563", "amenity=conference_centre": "8563",
    "amenity=exhibition_centre": "8570", "tourism=museum": "8570",
    "amenity=theatre": "8561", "amenity=arts_centre": "8561",
    "amenity=studio": "8564", "tourism=gallery": "8564",
    "leisure=fitness_centre": "8590", "leisure=sports_centre": "8590",
    "leisure=bowling_alley": "8580", "leisure=golf_course": "8590",
    "leisure=stadium": "8562", "leisure=adult_gaming_centre": "8590",
    "leisure=marina": "8590",

    # Transport, utilities, industry
    "amenity=bus_station": "6180",
    "craft=carpenter": "0770", "craft=plumber": "0770",
    "craft=electrician": "0770", "craft=builder": "0770",
    "craft=roofer": "0770", "craft=hvac": "0770", "craft=painter": "0770",
    "craft=brewery": "1370", "craft=bakery": "1190",
    "craft=photographer": "7370", "craft=signmaker": "1990",
    "craft=printer": "1990", "craft=upholsterer": "3895",
}

# What an unlabelled building of each class could hold, as sector weights. This
# is the prior the residual allocation samples against: it says a warehouse is
# overwhelmingly logistics but might be light manufacturing, and that
# `building=yes` says nothing and so takes the citywide mix.
CLASS_SECTORS = {
    "warehouse": {"TRN": 5, "WHL": 3, "MFG": 1, "RET": 1},
    "industrial": {"MFG": 6, "TRN": 1, "WHL": 1, "UTL": 1, "CON": 1},
    "manufacture": {"MFG": 8, "WHL": 1},
    "office": {"PRF": 5, "FIN": 3, "INF": 2, "ADM": 1, "MED": 1, "SRV": 1},
    "commercial": {"RET": 4, "ENT": 2, "SRV": 2, "PRF": 2, "FIN": 1, "MED": 1},
    "retail": {"RET": 8, "ENT": 2, "SRV": 1},
    "school": {"EDU": 9, "SCA": 1},
    "college": {"EDU": 9, "SCA": 1},
    "university": {"EDU": 9},
    "hospital": {"MED": 9, "SCA": 1},
    "government": {"ADM": 8, "SRV": 1},
    "civic": {"ADM": 4, "SRV": 3, "SCA": 2},
    "public": {"ADM": 4, "SRV": 3, "SCA": 2},
    "church": {"SRV": 9},
    "hotel": {"ENT": 9},
    "construction": {"CON": 9},
    "service": {"SRV": 3, "TRN": 2, "UTL": 2, "PRF": 1},
    # The default, and the largest single class. Deliberately flat: a
    # `building=yes` is a building, and anything the survey says works
    # somewhere could be inside it.
    "yes": None,
}


def ring(element, nodes):
    """The closed lat/lon ring of a way, however the extract stored it."""
    if element["type"] == "node":
        return [(element["lat"], element["lon"])]
    if element.get("geometry"):
        return [(p["lat"], p["lon"]) for p in element["geometry"]]
    return [nodes[n] for n in element.get("nodes", []) if n in nodes]


def tags_industry(tags):
    """INDP implied by a tag set, or None. First match wins, most specific first."""
    for key in ("healthcare", "amenity", "shop", "office", "craft",
                "tourism", "leisure", "building"):
        value = tags.get(key)
        if value and f"{key}={value}" in TAG_INDUSTRY:
            return TAG_INDUSTRY[f"{key}={value}"]
    return None


def sites():
    """Every non-residential building, with floor area, class and any own label."""
    elements = json.loads(GEOMETRY.read_text())["elements"]
    nodes = {e["id"]: (e["lat"], e["lon"])
             for e in elements if e["type"] == "node"}

    out = []
    for element in elements:
        tags = element.get("tags") or {}
        kind = tags.get("building")
        if not kind or kind in RESIDENTIAL:
            continue
        shape = ring(element, nodes)
        if len(shape) < 3:
            continue

        levels = tags.get("building:levels") or tags.get("levels") or ""
        levels = int(levels) if str(levels).isdigit() else 0
        area = facilities.footprint(shape) * max(levels, 1)
        if area < 20:
            # Sheds, sheds mislabelled, and geometry errors. Too small to hold
            # a worker at any density anyone would defend.
            continue

        industry = tags_industry(tags)
        out.append({
            "id": f"{element['type']}/{element['id']}",
            "lat": round(sum(p[0] for p in shape) / len(shape), 6),
            "lon": round(sum(p[1] for p in shape) / len(shape), 6),
            "class": kind,
            "name": tags.get("name", ""),
            # Prefer the address carried by the building itself. `attach()`
            # below still fills this from a nearby POI when the shell has no
            # addr:* tags of its own.
            "address": address_from_tags(tags),
            "levels": levels,
            "floor": round(area),
            "industries": [industry] if industry else [],
            "evidence": "tag" if industry else "",
        })
    return out


def grid(items, size=0.002):
    """Spatial index over (lat, lon), ~200 m cells."""
    index = defaultdict(list)
    for i, item in enumerate(items):
        index[(int(item["lat"] / size), int(item["lon"] / size))].append(i)
    return index, size


def attach(catalogue):
    """Join POIs onto sites, labelling them and returning what did not land.

    A POI that matches nothing is not discarded — it is a real business at a
    real address that OSM has no building for, so it becomes a site in its own
    right at the class median floor area.
    """
    data = json.loads(POIS.read_text())
    types = {t["i"]: (g["id"], t["id"])
             for g in data["groups"] for t in g["types"]}
    # Parking bays, benches, street furniture and private driveways. Nobody is
    # employed at them and they outnumber the real POIs three to one.
    skip = {"parking", "furniture", "fixture", "private"}

    index, size = grid(catalogue)
    orphans, joined = [], 0
    for lat, lon, _group, type_index, name, address, *_rest in data["points"]:
        group, tag = types.get(type_index, (None, None))
        if group in skip or not tag:
            continue
        industry = TAG_INDUSTRY.get(tag)

        best, distance = None, MATCH_METRES
        cell = (int(lat / size), int(lon / size))
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for i in index.get((cell[0] + di, cell[1] + dj), ()):
                    site = catalogue[i]
                    metres = facilities.metres((lat, lon),
                                               (site["lat"], site["lon"]))
                    if metres < distance:
                        best, distance = i, metres

        if best is None:
            if industry:
                orphans.append({"lat": lat, "lon": lon, "name": name,
                                "address": address, "industry": industry,
                                "tag": tag})
            continue

        joined += 1
        site = catalogue[best]
        site["address"] = site["address"] or address
        site["name"] = site["name"] or name
        if industry and industry not in site["industries"]:
            # A building can hold more than one business, and downtown here
            # routinely does. Both codes stay; assignment picks between them.
            site["industries"].append(industry)
            site["evidence"] = site["evidence"] or "poi"
    return joined, orphans


def adopt(catalogue, orphans):
    """Turn unmatched POIs into sites of their own, at the median floor area.

    Ids come from the name, and names are not unique — Dollar General has four
    branches here, Wells Fargo two. A collision is not cosmetic: employment
    rows key on the site id, so two branches sharing one would read as a single
    shop with twice the staff and no way to tell which building anyone is in.
    Taken ids get a suffix.
    """
    known = sorted(s["floor"] for s in catalogue if s["evidence"])
    median = known[len(known) // 2] if known else 200
    taken = Counter(s["id"] for s in catalogue)

    for orphan in orphans:
        key = "poi/" + "_".join(orphan["name"].lower().split())[:40] \
              or f"poi/{orphan['lat']:.5f}_{orphan['lon']:.5f}"
        taken[key] += 1
        if taken[key] > 1:
            key = f"{key}#{taken[key]}"
        catalogue.append({
            "id": key,
            "lat": orphan["lat"], "lon": orphan["lon"],
            "class": "commercial", "name": orphan["name"],
            "address": orphan["address"], "levels": 0, "floor": median,
            "industries": [orphan["industry"]], "evidence": "poi",
            "estimated": True,
        })
    return median


def capacity(site):
    """How many workers a site holds, from floor area and density.

    The industry override wins over the class where one exists, because it is
    the more specific statement: `building=commercial` describes the shell, the
    industry describes what fills it.
    """
    per_head = DENSITY.get(site["class"], DEFAULT_DENSITY)
    for industry in site["industries"]:
        if industry in INDUSTRY_DENSITY:
            per_head = max(per_head, INDUSTRY_DENSITY[industry])
    return max(1, round(site["floor"] / per_head))


def demand(sectors):
    """{industry: workers} for everyone who needs a workplace in the city.

    Excludes the three groups that need no site: people who worked from home,
    people whose POWPUMA is outside the region, and the emergency services and
    cab drivers that init_work has already posted. Group-quarters residents are
    included — they hold jobs like anyone else.
    """
    population = json.loads(POPULATION.read_text())
    people = population["person_records"] + population["quarters_records"]

    posted = set()
    employment = SIM_DATA / "employment.json"
    if employment.exists():
        posted = {a["person"] for a in json.loads(employment.read_text())
                  ["assignments"] if a["class"] == "primary"}

    counts, home, external, skipped = Counter(), 0, 0, 0
    for person in people:
        if person["employment"] not in (1, 2) or not person.get("industry"):
            continue
        if person["id"] in posted and "household" in person:
            skipped += 1
            continue
        if person.get("transport") == pums.WORKED_FROM_HOME:
            home += 1
            continue
        if person.get("work_puma") not in (pums.HOME_POWPUMA, None):
            external += 1
            continue
        counts[person["industry"]] += 1
    return counts, {"home": home, "external": external, "primary": skipped}


def sectors():
    """{industry: sector}, read off the INDP label prefix in the codebook."""
    labels = json.loads(CODEBOOK.read_text())["variables"]["INDP"]["values"]["item"]
    return ({code: label.split("-", 1)[0].strip()
             for code, label in labels.items()}, labels)


def infer(catalogue, wanted, sector_of, rng):
    """Label the unlabelled sites with whatever industry still needs the room.

    Walks the anonymous buildings largest first, because a 40,000 m² warehouse
    settling a deficit outright is a better outcome than the same area arriving
    as fifty scattered shops. Each site draws an industry weighted by unmet
    demand and by whether its class could plausibly hold that sector.
    """
    residual = Counter(wanted)
    for site in catalogue:
        for industry in site["industries"]:
            residual[industry] -= capacity(site) / len(site["industries"])

    blank = sorted((s for s in catalogue if not s["industries"]),
                   key=lambda s: -s["floor"])
    by_sector = defaultdict(list)
    for industry in wanted:
        by_sector[sector_of.get(industry, "?")].append(industry)

    for site in blank:
        affinity = CLASS_SECTORS.get(site["class"], CLASS_SECTORS["yes"])
        room = capacity(site)
        pool = []
        for industry in wanted:
            short = residual[industry]
            if short <= 0:
                continue
            weight = short * (affinity.get(sector_of.get(industry, "?"), 0.05)
                              if affinity else 1.0)
            # Penalise overshoot. Without this a single 40,000 m² warehouse
            # walking the list first can settle a 30-person deficit and leave
            # that industry at six times its surveyed size — which is exactly
            # what put INF and UTL at 6× on the first run.
            pool.append((industry, weight * min(1.0, short / room)))
        pool = [(industry, weight) for industry, weight in pool if weight > 0]
        if not pool:
            # Every industry is satisfied. The remaining floor area is genuine
            # slack — vacant units, storage, over-generous density — and gets
            # left unlabelled rather than filled for the sake of it.
            continue
        total = sum(w for _, w in pool)
        draw = rng.random() * total
        for industry, weight in pool:
            draw -= weight
            if draw <= 0:
                break
        site["industries"] = [industry]
        site["evidence"] = "inferred"
        residual[industry] -= capacity(site)
    return residual


def stretch(catalogue, residual, wanted):
    """Scale capacity where an industry still has more workers than room.

    Nothing here can add a building the survey did not see, so the shortfall
    lands on the density constant instead: the industry's sites each hold
    proportionally more. That is the assumption most likely to be wrong anyway
    — a call centre and a law firm are both `building=office` at wildly
    different m² per head — and putting the error there keeps the geometry
    honest and makes the size of the fudge visible in the report.
    """
    holders = defaultdict(list)
    for site in catalogue:
        for industry in site["industries"]:
            holders[industry].append(site)

    stretched = {}
    for industry, short in residual.items():
        if short <= 0 or not holders.get(industry):
            continue
        room = sum(capacity(s) / len(s["industries"]) for s in holders[industry])
        factor = (room + short) / room if room else 1.0
        stretched[industry] = factor
        for site in holders[industry]:
            site.setdefault("stretch", {})[industry] = round(factor, 3)
    return stretched


def portals(catalogue, external):
    """Boundary nodes for the workers who leave the region.

    Eight compass points on the built-up extent, sharing the outbound flow
    equally. Provisional by construction — see the module docstring.
    """
    lats = [s["lat"] for s in catalogue]
    lons = [s["lon"] for s in catalogue]
    north, south = max(lats), min(lats)
    east, west = max(lons), min(lons)
    mid_lat, mid_lon = (north + south) / 2, (east + west) / 2

    points = {
        "n": (north, mid_lon), "s": (south, mid_lon),
        "e": (mid_lat, east), "w": (mid_lat, west),
        "ne": (north, east), "nw": (north, west),
        "se": (south, east), "sw": (south, west),
    }
    share = external / len(points)
    return [{"id": f"portal/{name}", "lat": round(lat, 6), "lon": round(lon, 6),
             "workers": round(share), "provisional": True}
            for name, (lat, lon) in points.items()]


def report(catalogue, wanted, counts, joined, orphans, residual, stretched,
           labels, sector_of, excluded):
    total = sum(capacity(s) for s in catalogue)
    print(f"{len(catalogue):,} sites  {sum(s['floor'] for s in catalogue):,.0f} m²  "
          f"{total:,} places")
    print(f"{sum(wanted.values()):,} workers need one "
          f"({excluded['home']:,} work from home, {excluded['external']:,} "
          f"commute out, {excluded['primary']:,} already posted)")

    print("\nsite industry source:")
    evidence = Counter(s["evidence"] or "none" for s in catalogue)
    for kind in ("tag", "poi", "inferred", "none"):
        if not evidence[kind]:
            continue
        area = sum(s["floor"] for s in catalogue if (s["evidence"] or "none") == kind)
        print(f"  {kind:<9} {evidence[kind]:>5,} sites  {area:>11,.0f} m²  "
              f"{area / sum(s['floor'] for s in catalogue) * 100:5.1f}%")
    print(f"  {joined:,} POIs joined to a building, "
          f"{len(orphans):,} became sites of their own")

    print("\nsupply against demand by sector:")
    supply, need = Counter(), Counter()
    for site in catalogue:
        for industry in site["industries"]:
            supply[sector_of.get(industry, "?")] += (
                capacity(site) / len(site["industries"]))
    for industry, count in wanted.items():
        need[sector_of.get(industry, "?")] += count
    for sector in sorted(need, key=lambda s: -need[s]):
        ratio = supply[sector] / need[sector] if need[sector] else 0
        flag = "  short" if ratio < 0.98 else ""
        print(f"  {sector:<5} {need[sector]:>7,} workers  "
              f"{supply[sector]:>8,.0f} places  {ratio:>5.2f}×{flag}")

    if stretched:
        worst = sorted(stretched.items(), key=lambda kv: -kv[1])[:8]
        print(f"\n{len(stretched)} industries with more workers than floor "
              f"area, density stretched:")
        for industry, factor in worst:
            print(f"  {factor:>5.2f}×  {industry}  "
                  f"{labels.get(industry, '?')[:56]}")
        print("  (large factor: wrong m²-per-worker constant for the class, "
              "or unsurveyed work sites)")

    unplaced = {i: -n for i, n in residual.items() if n < -1}
    if unplaced:
        print(f"\n{len(unplaced)} industries with spare capacity")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="inference seed; recorded in the output")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    catalogue = sites()
    joined, orphans = attach(catalogue)
    adopt(catalogue, orphans)

    sector_of, labels = sectors()
    wanted, excluded = demand(sector_of)

    residual = infer(catalogue, wanted, sector_of, rng)
    stretched = stretch(catalogue, residual, wanted)

    for site in catalogue:
        site["capacity"] = capacity(site)

    SIM_DATA.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "source": [GEOMETRY.name, POIS.name],
        "seed": args.seed,
        "match_metres": MATCH_METRES,
        "sites": len(catalogue),
        "places": sum(s["capacity"] for s in catalogue),
        "excluded": excluded,
        # Which industries had to have their density bent, and by how much.
        # Anything reading capacity as measured needs to know it is not.
        "stretched": {k: round(v, 3) for k, v in stretched.items()},
        "site_records": catalogue,
        "portals": portals(catalogue, excluded["external"]),
    }, separators=(",", ":")))

    report(catalogue, wanted, None, joined, orphans, residual, stretched,
           labels, sector_of, excluded)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
