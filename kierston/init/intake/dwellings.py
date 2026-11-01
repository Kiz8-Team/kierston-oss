"""Reduce the OSM building export to the dwelling stock of the city.

The export carries a `living` flag, but it means "residential or outbuilding,
not a POI" (see `buildings.py`) — so it counts 9k garages and 9k sheds as
living space. Household synthesis needs the opposite: only buildings people
sleep in, each with an estimate of how many separate dwelling units it holds.

No city boundary is applied. The extract is treated as one city; for Kierston
that means the reference city proper is only the calibration baseline and the
surrounding Whitehall/Catasauqua stock is extrapolated into the same place.

Two populations come out, because they synthesise differently:
  dwellings — units occupied by households, drawn from PUMS household records
  quarters  — dormitories and the like, group quarters, NOT households

Unit counts come from `building:flats` where OSM has it. Everything else is
estimated, and what it is estimated *from* is now measured on this city's own
stock rather than carried over from Kierston's — see `fit.py`, which also says
which two of the four numbers involved are honestly measurable and which two
are judgements.
"""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import profile as city_profile  # noqa: E402
from paths import BUILDINGS_GEOM, DWELLINGS, SIM_DATA, require  # noqa: E402
from intake import fit  # noqa: E402
from intake.geometry import footprint  # noqa: E402
from intake.manifest import record  # noqa: E402
from intake.tags import address_from_tags, is_poi, to_int  # noqa: E402


# Residential `building` values, split by how they hold people. Single-unit
# kinds get one household each; MULTI_UNIT needs the unit count estimated.
SINGLE_UNIT = {
    "house", "semidetached_house", "detached", "terrace", "bungalow",
    "static_caravan", "houseboat", "residential",
}
MULTI_UNIT = {"apartments", "duplex"}
# Group quarters: people live here but not as households, so PUMS household
# records do not apply. Kept in a separate list rather than dropped.
QUARTERS = {"dormitory"}

# Institutional group quarters: the census's institutionalized population
# (RELSHIPP 37) lives in nursing homes and correctional facilities, not in
# dormitories. Recognized by tag whatever the `building` value, and kept even
# when the building carries POI tags, which these almost always do.
NURSING_HOME = "nursing_home"
CORRECTIONAL = "correctional"
INSTITUTIONAL = (NURSING_HOME, CORRECTIONAL)
# Gross floor area, in m², given to an institution synthesized because the
# extract has none of that kind. Sized for a few hundred residents.
SYNTHETIC_INSTITUTION_AREA = 6000.0
SYNTHETIC_INSTITUTION_LEVELS = 3


def institutional_kind(tags):
    """NURSING_HOME, CORRECTIONAL, or None for a building's tags."""
    if tags.get("amenity") == "prison" or tags.get("building") == "prison":
        return CORRECTIONAL
    if tags.get("building") == "nursing_home" \
            or tags.get("social_facility") == "nursing_home":
        return NURSING_HOME
    return None


def synthesize_institutions(quarters, dwellings):
    """One institution of each kind the extract lacks, at the stock centroid.

    The institutional population has to live somewhere that is an
    institution; a dormitory is the wrong answer even when the map has no
    better one. The record is marked `synthetic` so nothing mistakes it for
    a mapped building.
    """
    present = {q["kind"] for q in quarters}
    if not dwellings:
        return []
    lat = round(sum(d["lat"] for d in dwellings) / len(dwellings), 6)
    lon = round(sum(d["lon"] for d in dwellings) / len(dwellings), 6)
    added = []
    for kind in INSTITUTIONAL:
        if kind in present:
            continue
        added.append({
            "id": f"synthetic/{kind}",
            "lat": lat,
            "lon": lon,
            "kind": kind,
            "levels": SYNTHETIC_INSTITUTION_LEVELS,
            "area": SYNTHETIC_INSTITUTION_AREA / SYNTHETIC_INSTITUTION_LEVELS,
            "address": "",
            "street": "",
            "synthetic": True,
        })
    return added


class Params:
    """The four numbers unit estimation runs on, and where each came from."""

    def __init__(self, housing, profile):
        self.area_per_unit = housing.area_per_unit.value
        self.flats_by_level = housing.flats_by_level.value
        # Not fitted, and `fit.py` says at length why not.
        self.flats_default = profile.housing.flats_default
        self.flats_per_tall_level = profile.housing.flats_per_tall_level


def estimate_units(tags, area, params):
    """Return (units, source) for one building.

    Sources, most trustworthy first:
      tagged      building:flats from OSM
      area        footprint x levels / area_per_unit
      levels      median flats among tagged apartments of the same height
      levels-tall same, but above where the tagged sample supports it
      default     an apartment block with no height information
      single      a house, one household by definition
    """
    kind = tags.get("building")
    if kind in SINGLE_UNIT:
        return 1, "single"

    flats = to_int(tags.get("building:flats"))
    if flats > 0:
        return flats, "tagged"

    levels = to_int(tags.get("building:levels"))
    if area and levels > 0:
        return max(2, round(area * levels / params.area_per_unit)), "area"

    if levels <= 0:
        return params.flats_default, "default"
    if levels in params.flats_by_level:
        return params.flats_by_level[levels], "levels"
    return levels * params.flats_per_tall_level, "levels-tall"


def street_key(tags):
    """Coarse locality key: everything on one street in one ZIP.

    A single-PUMA microdata sample carries no within-city geography at all.
    Until block groups are joined in, this is the only spatial handle the
    building stock offers for varying households across the map.
    """
    return "|".join((
        tags.get("addr:street", ""),
        tags.get("addr:postcode", ""),
        tags.get("addr:city", ""),
    )).strip("|")


def stage(elements):
    """One pass: the buildings that survive, and the sample the fit runs on.

    The fit population is every multi-unit block with a usable footprint,
    including the ones carrying POI tags that the stock itself excludes. That
    is not tidy, and it is deliberate: it is the population the shipped
    constants were derived from, and narrowing it here would move Kierston's
    area-per-unit off the 106.0 it has always used for the sake of five
    buildings. Recorded rather than quietly corrected.
    """
    staged, quarters, samples = [], [], []
    dropped = Counter()

    for element in elements:
        tags = element.get("tags") or {}
        kind = tags.get("building")
        institution = institutional_kind(tags)
        if institution:
            shape = footprint(element)
            if shape is None:
                dropped["institution, no usable footprint"] += 1
                continue
            area, (lat, lon) = shape
            quarters.append({
                "id": f"{element['type']}/{element['id']}",
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "kind": institution,
                "levels": to_int(tags.get("building:levels")),
                "area": round(area, 1) if area else 0,
                "address": address_from_tags(tags),
                "street": street_key(tags),
            })
            continue
        if kind not in SINGLE_UNIT and kind not in MULTI_UNIT and kind not in QUARTERS:
            dropped["not residential"] += 1
            continue

        shape = footprint(element)
        if kind in MULTI_UNIT and shape is not None:
            samples.append((to_int(tags.get("building:flats")),
                            to_int(tags.get("building:levels")), shape[0]))

        if is_poi(tags):
            dropped["residential shell, POI tags"] += 1
            continue
        if shape is None:
            dropped["no usable footprint"] += 1
            continue

        area, (lat, lon) = shape
        record_ = {
            "id": f"{element['type']}/{element['id']}",
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "kind": kind,
            "levels": to_int(tags.get("building:levels")),
            "area": round(area, 1) if area else 0,
            "address": address_from_tags(tags),
            "street": street_key(tags),
        }
        if kind in QUARTERS:
            quarters.append(record_)
        else:
            staged.append((record_, tags, area))

    return staged, quarters, samples, dropped


def main() -> None:
    profile = city_profile.load()
    require(BUILDINGS_GEOM, "the OSM building export with `out geom` footprints")
    elements = json.loads(BUILDINGS_GEOM.read_text())["elements"]

    staged, quarters, samples, dropped = stage(elements)

    housing = fit.fit_housing(samples, profile.housing.min_sample)
    fit.report(housing, profile.housing.min_sample)
    print()
    params = Params(housing, profile)

    dwellings = []
    kinds, sources, units_by_source = Counter(), Counter(), Counter()
    for record_, tags, area in staged:
        units, source = estimate_units(tags, area, params)
        record_["units"] = units
        record_["units_source"] = source
        kinds[record_["kind"]] += 1
        sources[source] += 1
        units_by_source[source] += units
        dwellings.append(record_)

    quarters += synthesize_institutions(quarters, dwellings)

    total_units = sum(d["units"] for d in dwellings)
    SIM_DATA.mkdir(exist_ok=True)
    DWELLINGS.write_text(json.dumps({
        "source": BUILDINGS_GEOM.name,
        # The extract is the whole city; no municipal clipping is applied.
        "buildings": len(dwellings),
        "units": total_units,
        "quarters_buildings": len(quarters),
        "units_source_counts": dict(sources),
        "area_per_unit": params.area_per_unit,
        # One entry per building. `units` is how many households it can hold;
        # `units_source` records how that number was arrived at, so the
        # estimated ones can be revisited when footprint geometry lands.
        "dwellings": dwellings,
        # Group quarters: dormitories for the noninstitutional population,
        # nursing homes and correctional facilities for the institutional.
        # Not households; excluded from the PUMS household draw and
        # populated separately.
        "quarters": quarters,
    }, separators=(",", ":")))

    record("dwellings", inputs=[BUILDINGS_GEOM], outputs=[DWELLINGS], fitted={
        "housing": housing.manifest(),
        "conventions": {
            "flats_default": params.flats_default,
            "flats_per_tall_level": params.flats_per_tall_level,
        },
    })

    print(f"{len(dwellings):,} dwelling buildings holding {total_units:,} units")
    print(f"{len(quarters):,} group-quarters buildings held separately "
          f"({', '.join(f'{n} {k}' for k, n in Counter(q['kind'] for q in quarters).most_common())})\n")

    print("dropped:")
    for reason, count in dropped.most_common():
        print(f"  {count:>7,}  {reason}")

    print("\nbuilding kinds:")
    for kind, count in kinds.most_common():
        print(f"  {count:>7,}  {kind}")

    print("\nunit counts by how they were derived:")
    width = max(len(s) for s in sources)
    for source, count in sources.most_common():
        share = units_by_source[source] / total_units * 100
        print(f"  {count:>7,} buildings  {source:<{width}}  "
              f"{units_by_source[source]:>7,} units  {share:5.1f}% of stock")

    soft = sum(units_by_source[s] for s in ("levels", "levels-tall", "default"))
    if soft:
        print(f"\n{soft:,} units ({soft / total_units * 100:.1f}% of stock) estimated "
              f"from level counts only (no flat count, no usable footprint)")
    print(f"\nWrote {DWELLINGS} ({DWELLINGS.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
