"""OSM tag conventions the intake stages share.

These were spread across the three aggregation scripts and imported sideways —
`extract_dwellings` reached into `aggregate_buildings` for `to_int` and into
`aggregate_pois` for the address builder, which made the dependency between
them look like an accident rather than a decision. They are conventions about
how OSM is tagged, not facts about any city, so they live together and none of
the stages import each other any more.

`POI_KEYS` is the one worth reading twice. A building carrying any of these is
a storefront rather than a home, however it is tagged in `building` — a house
with `shop=hairdresser` is a hairdresser. It deliberately omits `building`
itself, which every building has.
"""

# The tag keys that make a building something other than somewhere people live.
POI_KEYS = (
    "amenity", "shop", "office", "healthcare", "craft", "leisure", "tourism",
    "historic", "emergency", "public_transport", "man_made", "military",
    "club", "sport", "landuse", "natural", "highway",
)


def is_poi(tags):
    return any(key in tags for key in POI_KEYS)


def to_int(value):
    """OSM level counts are free text: '2', '2.5' and '2;3' all occur."""
    if not value:
        return 0
    head = str(value).split(";")[0].strip()
    try:
        return int(float(head))
    except ValueError:
        return 0


def join_address(house_number, street, unit, city, state, postcode):
    """Render US-style address parts, dropping whatever is missing."""
    street_line = " ".join(part for part in (house_number, street) if part)
    if unit:
        street_line = f"{street_line} {unit}".strip() if street_line else unit
    locality = " ".join(part for part in (state, postcode) if part)
    locality = ", ".join(part for part in (city, locality) if part)
    return ", ".join(part for part in (street_line, locality) if part)


def address_from_tags(tags):
    return join_address(
        tags.get("addr:housenumber", ""), tags.get("addr:street", ""),
        tags.get("addr:unit", ""), tags.get("addr:city", ""),
        tags.get("addr:state", ""), tags.get("addr:postcode", ""),
    )


def address_from_geocode(entry):
    return join_address(
        entry.get("house_number", ""), entry.get("road", ""), "",
        entry.get("city", ""), entry.get("state", ""), entry.get("postcode", ""),
    )
