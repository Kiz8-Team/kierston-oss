"""Operational fleets, keyed back to the canonical vehicle registry by VIN.

`vehicles.py` is the only place that creates a registered vehicle.  This stage
does the other half of the job: it says which legal entity operates it, where
the vehicle is based, and which taxi drivers belong to which pool.  Nothing in
fleet.json repeats a plate, make, model, colour, capacity or registration fact;
those are obtained by joining the VIN to vehicles.json.

Four fleets so far, and the police and EMS ones are shaped differently from
the other two.  A cab belongs to a pool and a bus to a depot; a patrol car belongs to the
station it is kept at, because a unit turning out of the substation collects a
car standing in the substation yard and not one across town at headquarters.
So a police vehicle carries a `base` — the facility key its shift starts and
ends at — and the runtime parks it there overnight.

Which car sits at which station is not a fact the registry has and not one this
stage can discover: the vehicles are minted in one pass and the establishment
is counted in another.  So the bases are allocated here, by walking the police
VINs in sorted order against each station's quota.  That is as arbitrary as
creation order and has the property creation order does not: it is stable
against anything that changes the order vehicles.py happens to mint them in.
"""

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import SIM_DATA  # noqa: E402
import city_data  # noqa: E402

POPULATION = SIM_DATA / "population.json"
EMPLOYMENT = SIM_DATA / "employment.json"
WORKPLACES = SIM_DATA / "workplaces.json"
DWELLINGS = SIM_DATA / "dwellings.json"
SCHOOLS = SIM_DATA / "schools.json"
ENROLLMENT = SIM_DATA / "enrollment.json"
VEHICLES = SIM_DATA / "vehicles.json"
OUT = SIM_DATA / "fleet.json"

FLEET_BASE = 2_000_000
BUSED_BANDS = ("elem", "middle", "high")

# Who runs the school buses: the district for the public schools and a
# contractor for the charter and private ones, from the city's
# school_transport.csv (ids are offsets from FLEET_BASE).
SCHOOL_OPERATORS = city_data.school_transport(FLEET_BASE)

# The cab firms, from the city's taxi_operators.csv: each is sited at one of
# the ground-passenger-transport sites the workplace stage inferred, with a
# fallback position and floor for a build where that site is missing. Their
# names are modelled because the extract names neither.
TAXI_OPERATORS = city_data.taxi_operators(FLEET_BASE)


# The city's own vehicles.  One legal entity — the department — with cars kept
# at each of its premises, which is why this has no per-site operator the way
# the two cab pools do: a substation is a detachment of the same force and not
# a company of its own.
POLICE_OPERATOR = {
    "id": FLEET_BASE + 200, "name": "Kierston Police Department",
    "kind": "police", "legal_form": "local_government",
}

# EMS: one legal entity, ambulances based at the fire houses the crews are posted to.
EMS_OPERATOR = {
    "id": FLEET_BASE + 300, "name": "Kierston Emergency Medical Services",
    "kind": "ems", "legal_form": "local_government",
}

# What share of a watch's patrol-duty officers is actually in a car.
#
# `init_work.py` posts every officer at a station or the substation to "patrol"
# duty, which is where they are assigned and not what they are doing at 14:00:
# the same establishment covers the desk, the booking room, court, warrant
# service, the school details and the supervisors who are in an office rather
# than a unit.  So a share of it is on the road, and the share is not flat
# across the clock — the daytime watch carries nearly all the administrative
# posts and the night watch almost none.
#
# The shares are set so the city fields around twenty units a watch, which is
# roughly 1.6 marked cars per ten thousand residents on duty at any moment and
# is what a department of this size in a city of this size actually puts out.
# Raising them is the single lever on how much police movement the simulation
# contains; the runtime never exceeds the cars this file registers.
PATROL_SHARE = {"day": 0.36, "evening": 0.45, "night": 0.55}

# A 5-2 rota is five sevenths of a watch present on any given day.
ON_DUTY = 5 / 7

# Cars against peak units.  A fleet sized exactly to the busiest watch has
# nothing off the road for servicing, nothing held for the traffic detail, and
# no car to give the officer whose own is in the shop.
SPARE_RATIO = 1.35

# A station with a patrol establishment at all keeps at least this many, which
# only binds on the substation.
MIN_CARS = 2


def kilometres(a, b):
    """Approximate great-circle distance, sufficient for choosing a depot."""
    lat = math.radians((a[0] + b[0]) / 2)
    dy = (a[0] - b[0]) * 111.2
    dx = (a[1] - b[1]) * 111.2 * math.cos(lat)
    return math.hypot(dx, dy)


def taxi_depots(workplaces):
    sites = {row["id"]: row for row in workplaces.get("site_records", [])}
    out = []
    for configured in TAXI_OPERATORS:
        site = sites.get(configured["site"], {})
        lat, lon = configured["fallback"]
        out.append({
            "id": configured["id"], "name": configured["name"],
            "kind": configured["kind"], "legal_form": configured["legal_form"],
            "depot": {
                "site": configured["site"],
                "lat": site.get("lat", lat), "lon": site.get("lon", lon),
                "evidence": site.get("evidence", "configured workplace"),
            },
            "floor": site.get("floor", configured["fallback_floor"]),
        })
    return out


def school_depots(enrollment, schools):
    by_id = {row["id"]: row for row in schools["school_records"]}
    out = []
    for configured in SCHOOL_OPERATORS:
        served = {
            row.get("school") for row in enrollment["assignments"]
            if row.get("mode") == "enrolled"
            and row.get("band") in BUSED_BANDS
            and row.get("sector") in configured["sectors"]
            and row.get("school") in by_id
        }
        if not served:
            continue
        points = [(by_id[s]["lat"], by_id[s]["lon"]) for s in served]
        out.append({
            "id": configured["id"], "name": configured["name"],
            "kind": configured["kind"], "legal_form": configured["legal_form"],
            "depot": {
                "site": f"depot/{configured['id']}",
                "lat": round(sum(p[0] for p in points) / len(points), 6),
                "lon": round(sum(p[1] for p in points) / len(points), 6),
                "evidence": "centroid of served schools; no yard in the extract",
            },
        })
    return out


def patrol_posts(employment):
    """[(facility key, cars)] — how many marked cars each police site keeps.

    Sized on the busiest watch rather than on the establishment, because a car
    is not issued to an officer: three watches share one fleet, and what the
    city has to own is enough for whichever watch puts the most units out.
    """
    posted = defaultdict(Counter)
    for row in employment["assignments"]:
        if row.get("role") != "police_officer" or row.get("duty") != "patrol":
            continue
        watch = (row.get("shift") or {}).get("watch") or row.get("platoon")
        posted[row["site"]][watch] += 1

    out = []
    for site in sorted(posted):
        peak = max(count * ON_DUTY * PATROL_SHARE.get(watch, 0.4)
                   for watch, count in posted[site].items())
        out.append((site, max(MIN_CARS, math.ceil(peak * SPARE_RATIO))))
    return out


def patrol_fleet_size(employment):
    """How many marked cars to register.  vehicles.py asks; this answers."""
    return sum(cars for _, cars in patrol_posts(employment))


def ambulance_posts(employment):
    """[(facility key, ambulances)] — one per crew on the house's busiest platoon."""
    crews = defaultdict(lambda: defaultdict(set))
    for row in employment["assignments"]:
        if row.get("role") not in ("paramedic", "emt") or not row.get("crew"):
            continue
        crews[row["site"]][row.get("platoon")].add(row["crew"])
    return [(site, max(len(members) for members in crews[site].values()))
            for site in sorted(crews)]


def ambulance_fleet_size(employment):
    return sum(count for _, count in ambulance_posts(employment))


def ems_operator(employment):
    """The service, based at the fire house with the most crews."""
    posts = ambulance_posts(employment)
    facilities = {f["key"]: f for f in employment.get("facilities", [])}
    if not posts:
        return []
    site, _ = max(posts, key=lambda post: (post[1], post[0]))
    house = facilities.get(site)
    if not house:
        return []
    return [{
        **EMS_OPERATOR,
        "depot": {
            "site": site, "lat": house["lat"], "lon": house["lon"],
            "evidence": "fire facility from the extract",
        },
    }]


def police_operator(employment):
    """The department, based at its largest station.

    The depot is where a car with no station of its own would be parked, which
    for the police is nowhere — every patrol car has a `base`.  It is still
    written, because an operator without premises is an operator nothing can
    place on a map, and headquarters is the honest answer.
    """
    facilities = [f for f in employment.get("facilities", [])
                  if f.get("kind") == "police"]
    if not facilities:
        return []
    headquarters = max(facilities, key=lambda f: (f.get("role") == "station",
                                                  f.get("floor", 0)))
    return [{
        **POLICE_OPERATOR,
        "depot": {
            "site": headquarters["key"],
            "lat": headquarters["lat"], "lon": headquarters["lon"],
            "evidence": "police facility from the extract",
        },
    }]


def taxi_affiliations(population, employment, workplaces, households_with_cars):
    """Taxi drivers with either their own car or an LLC operator.

    COW 6 is an unincorporated owner-driver.  If that person's household has no
    surveyed vehicle, falling back to an LLC preserves the PUMS VEH total.
    """
    people = {p["id"]: p for p in population["person_records"]}
    assignments = sorted(
        (a for a in employment["assignments"] if a.get("role") == "taxi_driver"),
        key=lambda a: a["person"])
    depots = taxi_depots(workplaces)

    personal, company = [], []
    for assignment in assignments:
        person = people.get(assignment["person"])
        if not person:
            continue
        if (person.get("worker_class") == "6"
                and person.get("household") in households_with_cars):
            personal.append({"person": person["id"], "operator": None})
        else:
            home = person.get("household")
            company.append((person["id"], home))

    # Floor-area-proportional quotas, with the largest fractional remainder
    # taking the rounding residue.
    total_floor = sum(max(1, d["floor"]) for d in depots)
    raw = [len(company) * max(1, d["floor"]) / total_floor for d in depots]
    quotas = [math.floor(n) for n in raw]
    for i in sorted(range(len(raw)), key=lambda i: (raw[i] - quotas[i], -i),
                    reverse=True)[:len(company) - sum(quotas)]:
        quotas[i] += 1

    households = {h["id"]: h for h in population["household_records"]}
    dwelling_points = {}
    if DWELLINGS.exists():
        dwellings = json.loads(DWELLINGS.read_text())
        dwelling_points = {row["id"]: (row["lat"], row["lon"])
                           for row in dwellings.get("dwellings", [])}
    candidates = []
    for person, household in company:
        dwelling = households.get(household, {}).get("dwelling")
        point = dwelling_points.get(dwelling)
        distances = ([kilometres(point, (d["depot"]["lat"], d["depot"]["lon"]))
                      for d in depots] if point and None not in point
                     else [abs(person * 2654435761 % 10000 - i * 5000)
                           for i in range(len(depots))])
        candidates.append((-(max(distances) - min(distances)), person, distances))

    # Strong preferences get first claim on their nearer depot; exhausted
    # quotas send the remaining driver to the other pool.
    for _, person, distances in sorted(candidates):
        choices = sorted(range(len(depots)), key=lambda i: (distances[i], i))
        pick = next(i for i in choices if quotas[i] > 0)
        quotas[pick] -= 1
        personal.append({"person": person, "operator": depots[pick]["id"]})
    return sorted(personal, key=lambda row: row["person"]), depots


def build(population, employment, workplaces, schools, enrollment, registry):
    household_cars = {row["household"] for row in registry["vehicles"].values()
                      if row.get("household") is not None}
    drivers, taxi_ops = taxi_affiliations(
        population, employment, workplaces, household_cars)
    operators = (school_depots(enrollment, schools) + taxi_ops
                 + police_operator(employment) + ems_operator(employment))

    by_owner = {}
    for vin, row in registry["vehicles"].items():
        if row.get("service_class") == "taxi" and row["owner_type"] == "person":
            by_owner[row["owner"]] = vin

    driver_rows = [{**row, "vehicle": by_owner.get(row["person"])} for row in drivers]
    # Station by station, in facility order, against the sorted VINs. See the
    # module docstring for why the allocation lives here.
    bases = {}
    cruisers = [vin for vin, row in sorted(registry["vehicles"].items())
                if row.get("service_class") == "police"]
    cursor = 0
    for site, cars in patrol_posts(employment):
        for vin in cruisers[cursor:cursor + cars]:
            bases[vin] = site
        cursor += cars
    if cursor != len(cruisers):
        raise RuntimeError(
            f"{len(cruisers)} police vehicles registered against {cursor} posts")
    boxes = [vin for vin, row in sorted(registry["vehicles"].items())
             if row.get("service_class") == "ems"]
    cursor = 0
    for site, count in ambulance_posts(employment):
        for vin in boxes[cursor:cursor + count]:
            bases[vin] = site
        cursor += count
    if cursor != len(boxes):
        raise RuntimeError(
            f"{len(boxes)} ambulances registered against {cursor} posts")

    refs = []
    for vin, row in sorted(registry["vehicles"].items()):
        service = row.get("service_class")
        if service is None:
            continue
        refs.append({
            "vin": vin, "service_class": service,
            "operator": row["owner"] if row["owner_type"] == "organization" else None,
            "owner_driver": row["owner"] if service == "taxi" and row["owner_type"] == "person" else None,
            **({"base": bases[vin]} if vin in bases else {}),
        })
    if len({row["vin"] for row in refs}) != len(refs):
        raise RuntimeError("fleet contains duplicate VIN references")
    if any(row["vin"] not in registry["vehicles"] for row in refs):
        raise RuntimeError("fleet references a VIN outside vehicles.json")
    forbidden = {"plate", "make", "model", "body", "colour", "seats"}
    if any(forbidden.intersection(row) for row in refs):
        raise RuntimeError("fleet duplicates canonical vehicle attributes")
    return operators, refs, driver_rows


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=20260728)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    required = (POPULATION, EMPLOYMENT, WORKPLACES, SCHOOLS, ENROLLMENT, VEHICLES)
    for path in required:
        if not path.exists():
            raise SystemExit(f"{path.name} is missing — run the earlier stages first")
    loads = [json.loads(path.read_text()) for path in required]
    operators, vehicles, drivers = build(*loads)
    args.out.write_text(json.dumps({
        "source": VEHICLES.name, "seed": args.seed,
        "reference_year": loads[-1]["reference_year"],
        "operators": operators, "vehicles": vehicles, "drivers": drivers,
    }, separators=(",", ":")))
    print(f"fleet.json: {len(operators)} operators, {len(vehicles)} vehicles, "
          f"{len(drivers)} taxi drivers")
    print(f"Wrote {args.out} ({args.out.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
