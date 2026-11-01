"""Aggregate the Overpass building export into a compact file for the map.

Each building is reduced to its centroid plus the tags worth showing on click;
the map draws points, not footprints, so the rings are resolved here and
discarded.
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import BUILDINGS, BUILDINGS_GEOM, DWELLINGS, SIM_DATA, require  # noqa: E402
from intake.geometry import footprint  # noqa: E402
from intake.manifest import record  # noqa: E402
from intake.tags import POI_KEYS, address_from_tags, is_poi, to_int  # noqa: E402

# Categories are coarse on purpose: with ~63k buildings the useful distinction
# is dwelling vs. shed vs. business, not the long tail of `building` values.
CATEGORIES = (
    ("residential", "Homes",        "#b5651d"),
    ("outbuilding", "Outbuildings", "#a9a196"),
    ("commercial",  "Commercial",   "#2b7a8c"),
    ("civic",       "Civic",        "#4a7d3f"),
    ("other",       "Other",        "#7d8b99"),
)

VALUE_CATEGORY = {
    "house": "residential", "semidetached_house": "residential",
    "detached": "residential", "terrace": "residential", "apartments": "residential",
    "residential": "residential", "dormitory": "residential", "bungalow": "residential",
    "static_caravan": "residential", "houseboat": "residential", "duplex": "residential",

    "garage": "outbuilding", "garages": "outbuilding", "shed": "outbuilding",
    "carport": "outbuilding", "roof": "outbuilding", "outbuilding": "outbuilding",
    "hut": "outbuilding", "barn": "outbuilding", "farm_auxiliary": "outbuilding",
    "greenhouse": "outbuilding", "container": "outbuilding",

    "commercial": "commercial", "retail": "commercial", "office": "commercial",
    "bank": "commercial", "warehouse": "commercial", "industrial": "commercial",
    "service": "commercial", "supermarket": "commercial", "hotel": "commercial",
    "kiosk": "commercial", "manufacture": "commercial", "factory": "commercial",

    "church": "civic", "chapel": "civic", "cathedral": "civic", "mosque": "civic",
    "synagogue": "civic", "temple": "civic", "school": "civic", "college": "civic",
    "university": "civic", "kindergarten": "civic", "government": "civic",
    "public": "civic", "hospital": "civic", "civic": "civic", "fire_station": "civic",
    "train_station": "civic", "transportation": "civic", "sports_hall": "civic",
    "stadium": "civic",
}

# Homes / Outbuildings that are not also tagged as a POI (amenity, shop, …).
# Note this counts sheds and garages as "living": it means "somewhere on a
# residential plot", not "somewhere people sleep". For the latter use the
# dwelling unit count joined in from DWELLINGS.
LIVING_CATEGORIES = {"residential", "outbuilding"}


def is_living(tags, category):
    return category in LIVING_CATEGORIES and not is_poi(tags)


def load_dwellings():
    """Return {osm id: (units, source)} for every building people live in."""
    if not DWELLINGS.exists():
        return {}
    data = json.loads(DWELLINGS.read_text())
    return {
        dwelling["id"]: (dwelling["units"], dwelling["units_source"])
        for dwelling in data["dwellings"]
    }


def main() -> None:
    require(BUILDINGS_GEOM, "the OSM building export with `out geom` footprints")
    elements = json.loads(BUILDINGS_GEOM.read_text())["elements"]
    dwellings = load_dwellings()

    category_index = {id: i for i, (id, _, _) in enumerate(CATEGORIES)}
    counts = Counter()
    kinds = Counter()
    points = []
    living_count = 0
    unit_total = 0
    dwelling_count = 0
    skipped = 0

    for element in elements:
        shape = footprint(element)
        if shape is None:
            skipped += 1
            continue
        _, where = shape
        tags = element.get("tags") or {}
        kind = tags.get("building") or "yes"
        category = VALUE_CATEGORY.get(kind, "other")
        counts[category] += 1
        kinds[kind] += 1
        living = is_living(tags, category)
        if living:
            living_count += 1
        osm_id = f"{element['type']}/{element['id']}"
        units, units_source = dwellings.get(osm_id, (0, ""))
        if units:
            dwelling_count += 1
            unit_total += units
        lat, lon = where
        # Keep every OSM tag so the map popup can show the full record, not
        # just the handful of fields used for legend/summary rendering.
        points.append([
            round(lat, 6), round(lon, 6), category_index[category],
            kind.replace("_", " "),
            to_int(tags.get("building:levels")),
            to_int(tags.get("building:flats")),
            tags.get("name", ""),
            address_from_tags(tags),
            tags,
            osm_id,
            living,
            units,
            units_source,
        ])

    SIM_DATA.mkdir(exist_ok=True)
    BUILDINGS.write_text(json.dumps({
        "source": BUILDINGS_GEOM.name,
        "count": len(points),
        "living": living_count,
        "dwellings": dwelling_count,
        "units": unit_total,
        "categories": [
            {"id": id, "label": label, "color": color, "count": counts[id]}
            for id, label, color in CATEGORIES if counts[id]
        ],
        # [lat, lon, category, kind, levels, flats, name, address, tags, osmId,
        #  living, units, unitsSource].
        # Levels and flats are 0 when untagged; tags is the full OSM tag dict.
        # units is how many households the building can hold, 0 for anything
        # that is not a dwelling; unitsSource records how it was derived.
        "points": points,
    }, separators=(",", ":")))

    addressed = sum(1 for point in points if point[7])
    levelled = sum(1 for point in points if point[4])
    tagged = sum(1 for point in points if len(point[8]) > 1)
    width = max(len(label) for _, label, _ in CATEGORIES)
    print(f"{len(points):,} buildings in {len(kinds)} kinds ({skipped} without a position)")
    print(f"{living_count:,} living (Homes/Outbuildings, not a POI)")
    if dwellings:
        print(f"{dwelling_count:,} dwellings holding {unit_total:,} units")
    else:
        print(f"no {DWELLINGS.name}: run intake/dwellings.py for unit counts")
    print(f"{addressed:,} with an address, {levelled:,} with a level count, "
          f"{tagged:,} with extra tags\n")
    for id, label, _ in CATEGORIES:
        if not counts[id]:
            continue
        head = ", ".join(
            f"{kind} {count:,}" for kind, count in kinds.most_common()
            if VALUE_CATEGORY.get(kind, "other") == id
        )
        print(f"  {label:<{width}}  {counts[id]:>6,}  {head[:64]}")
    inputs = [BUILDINGS_GEOM] + ([DWELLINGS] if DWELLINGS.exists() else [])
    record("buildings", inputs=inputs, outputs=[BUILDINGS])

    print(f"\nWrote {BUILDINGS} ({BUILDINGS.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
