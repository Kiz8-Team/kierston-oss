"""Resolve Kierston's emergency-service facilities from the two extracts.

Neither extract is sufficient alone. `pois.json` knows where the stations are
and what they are called; `buildings_geom.json` knows how big they
are. Neither is complete: three fire stations exist only as buildings, two
police sites only as POIs, and one station is in the POI file twice. This
joins them on proximity and reports what it could not resolve.

The join threshold is 30 m, which is comfortably inside the gap between any
two genuinely distinct facilities here — the closest pair is the Court Street
substation and police headquarters at 354 m — and comfortably outside the
worst POI-to-footprint offset, 6 m at Central Fire Station.

Floor area is footprint × levels, the same estimate `extract_dwellings.py`
makes, and it exists to spread an establishment across sites. Where a facility
has no footprint at all the class median stands in, flagged, so the estimate
never silently reads as measured.

Two facts about this data drive everything downstream:

  Police is centralised. Two buildings, and the three downtown sites sit
  within 1.4 km of each other. There is no precinct network to distribute a
  force across — patrol districts are logical, not physical, and belong in the
  behaviour module rather than here.

  EMS has no premises of its own. There is no `amenity=ambulance_station`
  anywhere in the extract, which is not an omission — the reference city runs
  EMS out of its fire houses. Fire stations are therefore the ambulance origins, and
  the `city` flag matters: three of the nine fire facilities are volunteer
  companies outside the city line that the city's own establishment should
  not be posted to.
"""

import json
import math
import sys
from pathlib import Path
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from paths import BUILDINGS_GEOM as GEOMETRY, POIS  # noqa: E402
import profile as city_profile  # noqa: E402

# How the incorporated city appears in a street address, from [locale].
POSTAL_CITY = city_profile.load().locale.postal_city

# Two records describe one facility if they are closer than this. See the
# module docstring for why 30 m is safe in both directions here.
MATCH_METRES = 30

AMENITIES = {"police": "police", "fire_station": "fire"}

# What a facility is for, read off its name. Establishment does not follow
# floor area alone: a substation is a report-writing room with a desk, not a
# small headquarters, and an investigations bureau is a specialist unit whose
# size has nothing to do with its premises. The factors scale the area-implied
# share; see init_work.py, which is where they are applied and tuned.
POLICE_ROLES = (
    ("substation", ("substation",)),
    ("bureau", ("bureau", "bereau", "investigation", "narcotics")),
    ("station", ()),
)


def metres(a, b):
    """Great-circle distance between two (lat, lon) pairs."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def footprint(ring):
    """Planar area of a closed lat/lon ring, in m².

    The shoelace formula on a local equirectangular projection. Over a building
    the projection error is far below the error already in `building:levels`,
    and this avoids a geodesic-area dependency for a few hundred polygons.
    """
    if len(ring) < 3:
        return 0.0
    lat0 = sum(p[0] for p in ring) / len(ring)
    scale = math.cos(math.radians(lat0))
    xy = [(lon * 111320 * scale, lat * 110540) for lat, lon in ring]
    total = 0.0
    for i in range(len(xy)):
        x1, y1 = xy[i]
        x2, y2 = xy[(i + 1) % len(xy)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def buildings():
    """Emergency-service buildings from the geometry extract, with footprints.

    Overpass gives ways either an inline `geometry` or a node reference list
    depending on how the extract was requested; this file carries both forms,
    so both are resolved rather than assuming one.
    """
    elements = json.loads(GEOMETRY.read_text())["elements"]
    nodes = {e["id"]: (e["lat"], e["lon"])
             for e in elements if e["type"] == "node"}

    out = []
    for element in elements:
        tags = element.get("tags") or {}
        kind = AMENITIES.get(tags.get("amenity"))
        if not kind:
            continue

        if element["type"] == "node":
            ring = [(element["lat"], element["lon"])]
        elif element.get("geometry"):
            ring = [(p["lat"], p["lon"]) for p in element["geometry"]]
        else:
            ring = [nodes[n] for n in element.get("nodes", []) if n in nodes]
        if not ring:
            # A relation whose members were not included in the extract. It has
            # no position, so there is nothing to match it to.
            continue

        levels = tags.get("building:levels") or tags.get("levels") or 0
        out.append({
            "id": f"{element['type']}/{element['id']}",
            "kind": kind,
            "name": tags.get("name", ""),
            "lat": round(sum(p[0] for p in ring) / len(ring), 6),
            "lon": round(sum(p[1] for p in ring) / len(ring), 6),
            "footprint": round(footprint(ring)) if len(ring) > 2 else 0,
            "levels": int(levels) if str(levels).isdigit() else 0,
        })
    return out


def points():
    """Emergency-service POIs, de-duplicated.

    `pois.json` stores each point as [lat, lon, group, type, name, address, …]
    where `type` indexes a flat table spanning every group.
    """
    data = json.loads(POIS.read_text())
    kinds = {t["i"]: AMENITIES[t["id"].split("=", 1)[1]]
             for group in data["groups"] for t in group["types"]
             if t["id"].split("=", 1)[1] in AMENITIES}

    out = []
    for lat, lon, _group, type_index, name, address, *_rest in data["points"]:
        kind = kinds.get(type_index)
        if not kind:
            continue
        # West End Fire Station is in the file twice, 2 m apart, under two
        # street names. Collapse on position rather than on name, since the
        # names differ and the positions do not.
        if any(p["kind"] == kind and metres((lat, lon), (p["lat"], p["lon"]))
               < MATCH_METRES for p in out):
            continue
        out.append({"kind": kind, "lat": lat, "lon": lon,
                    "name": name, "address": address})
    return out


def police_role(name):
    for role, keywords in POLICE_ROLES:
        if any(k in name.lower() for k in keywords):
            return role
    return "station"


def load():
    """Return {"police": [...], "fire": [...]}, each facility fully resolved.

    A facility carries `floor` (m², estimated) and `estimated` saying whether
    that number came from a footprint or from the class median standing in for
    a missing one.
    """
    unmatched = buildings()
    facilities = []

    for poi in points():
        match = None
        for building in unmatched:
            if building["kind"] != poi["kind"]:
                continue
            distance = metres((poi["lat"], poi["lon"]),
                              (building["lat"], building["lon"]))
            if distance < MATCH_METRES:
                match = building
                break
        if match:
            unmatched.remove(match)
        facilities.append({**poi, **{k: v for k, v in (match or {}).items()
                                     if k in ("id", "footprint", "levels")}})

    # Buildings with no POI are facilities too — all three are the volunteer
    # companies outside the city, which the POI extract simply does not cover.
    facilities.extend({**b, "address": ""} for b in unmatched)

    for facility in facilities:
        facility.setdefault("id", "")
        facility.setdefault("footprint", 0)
        facility.setdefault("levels", 0)
        # Half these facilities have no OSM id to be keyed by — they exist only
        # as POI points. A name slug keeps every facility addressable by a
        # stable string, which is what a posting has to record.
        facility["key"] = facility["id"] or "poi/" + "_".join(
            facility["name"].lower().split())[:40]
        # An address is the only evidence in this data of which side of the
        # city line a facility sits on, and the outlying companies have none.
        facility["city"] = POSTAL_CITY in facility["address"]
        if facility["kind"] == "police":
            facility["role"] = police_role(facility["name"])

    grouped = {kind: [f for f in facilities if f["kind"] == kind]
               for kind in ("police", "fire")}

    for group in grouped.values():
        known = [f["footprint"] * max(f["levels"], 1)
                 for f in group if f["footprint"]]
        fallback = round(median(known)) if known else 0
        for facility in group:
            area = facility["footprint"] * max(facility["levels"], 1)
            facility["floor"] = area or fallback
            facility["estimated"] = not area
        group.sort(key=lambda f: (not f["city"], -f["floor"]))

    return grouped


def report(grouped):
    """Print the resolved facility table."""
    for kind, group in grouped.items():
        resolved = sum(1 for f in group if not f["estimated"])
        print(f"\n{kind}: {len(group)} facilities, "
              f"{resolved} with a measured footprint")
        width = max(len(f["name"] or "(unnamed)") for f in group)
        for f in group:
            floor = f"{f['floor']:>6,} m²" + ("*" if f["estimated"] else " ")
            flags = " ".join(filter(None, [
                f.get("role") if f.get("role") != "station" else "",
                "" if f["city"] else "outlying"]))
            print(f"  {f['name'] or '(unnamed)':<{width}}  {floor}  "
                  f"{f['lat']:.5f},{f['lon']:.5f}  {flags}")
    print("\n  * floor area is the class median, no footprint in the extract")


if __name__ == "__main__":
    report(load())
