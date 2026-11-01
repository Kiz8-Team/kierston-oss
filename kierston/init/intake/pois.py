"""Aggregate the Overpass POI export into a compact, class-tagged catalogue.

Read by the map, by `work/workplaces.py` to site jobs, and by `work/facilities.py`
to find the stations the emergency services are staffed from.

The classification below is OSM tagging convention rather than anything about a
particular city, so it ships as-is for every city and is the same file in
Kierston and anywhere else.
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import GEOCODE_CACHE, POIS, POIS_EXPORT, SIM_DATA, require  # noqa: E402
from intake.manifest import record  # noqa: E402
from intake.tags import address_from_geocode, address_from_tags  # noqa: E402

# The tag keys that carry a POI's primary meaning, most specific first. An
# element is classified by the first of these it happens to be tagged with.
PRIMARY_KEYS = (
    "amenity", "shop", "office", "healthcare", "craft", "leisure", "tourism",
    "historic", "emergency", "public_transport", "man_made", "military",
    "club", "sport", "building", "landuse", "natural", "highway",
)

# Groups are ordered by how much signal they usually carry. `keep` seeds the
# map's default filter state: everything below the line is street furniture,
# building interior fixtures and back-yard features that swamp the view.
GROUPS = (
    ("food",      "Food & drink",      "#e8453c", True),
    ("retail",    "Retail",            "#f5691f", True),
    ("services",  "Services & office", "#f0b400", True),
    ("health",    "Health",            "#e0559d", True),
    ("education", "Education",         "#7b5bd6", True),
    ("civic",     "Civic & worship",   "#2fa84f", True),
    ("lodging",   "Lodging",           "#8a4fd0", True),
    ("leisure",   "Leisure & culture", "#00a0a8", True),
    ("transport", "Transport & fuel",  "#1667d8", True),
    ("parking",   "Parking",           "#7d8b99", False),
    ("furniture", "Street furniture",  "#a2926c", False),
    ("fixture",   "Building fixtures", "#9aa5b1", False),
    ("private",   "Private grounds",   "#63a375", False),
    ("other",     "Unclassified",      "#5d6b78", False),
)

# Explicit `key=value` overrides. Anything not listed falls through to KEY_GROUP.
VALUE_GROUP = {
    "amenity=restaurant": "food", "amenity=fast_food": "food", "amenity=cafe": "food",
    "amenity=bar": "food", "amenity=pub": "food", "amenity=biergarten": "food",
    "amenity=ice_cream": "food", "amenity=food_court": "food", "amenity=nightclub": "food",
    "amenity=hookah_lounge": "food", "amenity=stripclub": "food",

    "amenity=marketplace": "retail", "amenity=vending_machine": "retail",

    "amenity=bank": "services", "amenity=atm": "services", "amenity=post_office": "services",
    "amenity=car_wash": "services", "amenity=car_rental": "services", "amenity=studio": "services",
    "amenity=animal_boarding": "services", "amenity=animal_shelter": "services",
    "amenity=conference_centre": "services", "amenity=exhibition_centre": "services",
    "amenity=events_venue": "services", "amenity=coworking_space": "services",

    "amenity=doctors": "health", "amenity=dentist": "health", "amenity=clinic": "health",
    "amenity=hospital": "health", "amenity=pharmacy": "health", "amenity=veterinary": "health",
    "amenity=nursing_home": "health", "shop=medical_supply": "health", "shop=optician": "health",

    "amenity=school": "education", "amenity=college": "education", "amenity=university": "education",
    "amenity=kindergarten": "education", "amenity=childcare": "education",
    "amenity=library": "education", "amenity=driving_school": "education",
    "amenity=music_school": "education", "amenity=library_dropoff": "education",
    "amenity=dojo": "education",

    "amenity=place_of_worship": "civic", "amenity=townhall": "civic", "amenity=courthouse": "civic",
    "amenity=police": "civic", "amenity=fire_station": "civic", "amenity=prison": "civic",
    "amenity=community_centre": "civic", "amenity=social_centre": "civic",
    "amenity=social_facility": "civic", "amenity=grave_yard": "civic",
    "office=government": "civic", "shop=funeral_directors": "civic",

    "amenity=theatre": "leisure", "amenity=cinema": "leisure", "amenity=arts_centre": "leisure",
    "amenity=fountain": "leisure",

    "amenity=fuel": "transport", "amenity=charging_station": "transport",
    "amenity=taxi": "transport", "amenity=bus_station": "transport",
    "amenity=bicycle_rental": "transport", "amenity=ferry_terminal": "transport",

    "amenity=parking": "parking", "amenity=parking_space": "parking",
    "amenity=parking_entrance": "parking", "amenity=motorcycle_parking": "parking",
    "amenity=bicycle_parking": "parking",

    "amenity=bench": "furniture", "amenity=waste_basket": "furniture",
    "amenity=waste_disposal": "furniture", "amenity=recycling": "furniture",
    "amenity=letter_box": "furniture", "amenity=post_box": "furniture",
    "amenity=drinking_water": "furniture", "amenity=shelter": "furniture",
    "amenity=toilets": "furniture", "amenity=bbq": "furniture", "amenity=clock": "furniture",
    "amenity=public_bookcase": "furniture", "amenity=bicycle_repair_station": "furniture",
    "amenity=telephone": "furniture", "amenity=hunting_stand": "furniture",
    "leisure=picnic_table": "furniture", "leisure=firepit": "furniture",

    "amenity=loading_dock": "fixture", "amenity=elevator": "fixture",
    "amenity=security_booth": "fixture", "amenity=dressing_room": "fixture",
    "amenity=disused": "fixture", "amenity=vacant": "fixture", "shop=vacant": "fixture",
    "leisure=outdoor_seating": "fixture", "leisure=bleachers": "fixture",

    "leisure=swimming_pool": "private", "leisure=schoolyard": "private",
    "leisure=slipway": "private",

    "tourism=hotel": "lodging", "tourism=motel": "lodging", "tourism=guest_house": "lodging",
    "tourism=hostel": "lodging", "tourism=apartment": "lodging", "tourism=camp_site": "lodging",
    "tourism=caravan_site": "lodging",
}

# Whole-key fallbacks, applied when the exact `key=value` is not listed above.
KEY_GROUP = {
    "shop": "retail", "office": "services", "craft": "services",
    "healthcare": "health", "emergency": "civic", "military": "civic",
    "leisure": "leisure", "tourism": "leisure", "historic": "leisure",
    "sport": "leisure", "club": "leisure", "public_transport": "transport",
    "highway": "transport", "man_made": "fixture", "building": "fixture",
    "landuse": "private", "natural": "private",
}

# Interior fixtures entered as free text, so they need case-insensitive matching.
FREETEXT_FIXTURES = {
    "lobby", "stairs", "front desk", "waiting area", "ramp", "hallway",
    "reception", "corridor", "restroom",
}


def classify(tags):
    """Return the (type_id, group_id) a tag dictionary belongs to."""
    for key in PRIMARY_KEYS:
        value = tags.get(key)
        if not value:
            continue
        type_id = f"{key}={value}"
        if value.lower() in FREETEXT_FIXTURES:
            return type_id, "fixture"
        group = VALUE_GROUP.get(type_id) or KEY_GROUP.get(key)
        if group:
            return type_id, group
        # An unmapped `amenity` is still a real POI, just an uncommon one.
        return type_id, "services" if key == "amenity" else "other"
    return "untagged", "other"


def position(element):
    if "lat" in element and "lon" in element:
        return element["lat"], element["lon"]
    center = element.get("center")
    if center:
        return center["lat"], center["lon"]
    return None


def label_for(type_id):
    return type_id.split("=", 1)[1].replace("_", " ").capitalize()


def address_for(element, geocoded):
    """Return (address, source) where source is 0 for OSM tags, 1 for geocoded."""
    tagged = address_from_tags(element.get("tags") or {})
    if tagged:
        return tagged, 0
    entry = geocoded.get(f"{element['type']}/{element['id']}")
    if entry:
        return address_from_geocode(entry), 1
    return "", 1


def main() -> None:
    require(POIS_EXPORT, "the Overpass POI export for this city")
    elements = json.loads(POIS_EXPORT.read_text())["elements"]
    # Reverse-geocoded addresses for the elements OSM has no addr:* tags for,
    # filled in by acquire/geocode_pois.py. Optional: without it those POIs
    # just have no address rather than no entry.
    geocoded = json.loads(GEOCODE_CACHE.read_text()) if GEOCODE_CACHE.exists() else {}

    points = []
    skipped = 0
    by_group = defaultdict(Counter)
    for element in elements:
        where = position(element)
        if where is None:
            skipped += 1
            continue
        tags = element.get("tags") or {}
        type_id, group_id = classify(tags)
        by_group[group_id][type_id] += 1
        address, source = address_for(element, geocoded)
        points.append((where, type_id, group_id, tags.get("name", ""), address, source))

    # Types are indexed globally so each point can be stored as a flat tuple.
    type_index = {}
    groups = []
    for group_id, label, color, keep in GROUPS:
        counts = by_group.get(group_id)
        if not counts:
            continue
        types = []
        for type_id, count in counts.most_common():
            type_index[type_id] = len(type_index)
            types.append({
                "i": type_index[type_id],
                "id": type_id,
                "label": label_for(type_id),
                "count": count,
            })
        groups.append({
            "id": group_id, "label": label, "color": color, "default": keep,
            "count": sum(counts.values()), "types": types,
        })

    group_index = {group["id"]: i for i, group in enumerate(groups)}
    SIM_DATA.mkdir(exist_ok=True)
    POIS.write_text(json.dumps({
        "source": POIS_EXPORT.name,
        "count": len(points),
        "groups": groups,
        # [lat, lon, group, type, name, address, addressSource] — arrays rather
        # than objects to keep the payload small enough to parse in one frame.
        # addressSource is 0 for OSM addr:* tags, 1 for a reverse-geocoded guess.
        "points": [
            [round(lat, 6), round(lon, 6), group_index[group_id], type_index[type_id],
             name, address, source]
            for (lat, lon), type_id, group_id, name, address, source in points
        ],
    }, separators=(",", ":")))

    inputs = [POIS_EXPORT] + ([GEOCODE_CACHE] if GEOCODE_CACHE.exists() else [])
    record("pois", inputs=inputs, outputs=[POIS])

    tagged = sum(1 for *_, address, source in points if address and source == 0)
    guessed = sum(1 for *_, address, source in points if address and source == 1)
    missing = len(points) - tagged - guessed

    width = max(len(group["label"]) for group in groups)
    print(f"{len(points):,} POIs in {len(type_index)} types ({skipped} without a position)")
    print(f"addresses: {tagged:,} from OSM tags, {guessed:,} reverse geocoded, "
          f"{missing:,} still missing\n")
    for group in groups:
        flag = " " if group["default"] else "·"
        head = ", ".join(f"{t['label'].lower()} {t['count']}" for t in group["types"][:4])
        print(f"{flag} {group['label']:<{width}}  {group['count']:>5,}  {len(group['types']):>3} types  {head}")
    print(f"\n· = hidden by default. Wrote {POIS}")


if __name__ == "__main__":
    main()
