"""Send every remaining worker to a workplace, and record the commute.

`init_work.py` posts the 404 people whose jobs are simulated in detail. This
takes the other 44,728 — the filler class, whose entire working day is "go to
a place and stay there" — and decides which place. Output is appended to the
same `employment.json`, because it is the same relation: one row per person
saying where they work. The `class` field is what tells them apart, and taxi
drivers already prove the two shapes are one, being home-based and itinerant
inside the primary table.

Matching
--------
On INDP, with the sector prefix as the fallback rung. A worker takes a seat in
their exact industry if one is free, in their sector if not, and anywhere if
still not — recorded per assignment in `match`, so a run where the third rung
carries real volume is visible rather than silent.

Choosing between sites
----------------------
Not a plain gravity model. Every worker in the PUMS sample reported how long
their commute actually takes, and that number rides along on the person record
through cloning, so the assignment can aim at it directly: a site is scored by
how close its implied travel time is to the one this person reported, not by
generic distance decay. The commute distribution then reproduces itself
without a decay coefficient to tune, which is the difference between matching a
target and being calibrated against one.

Workers with no reported time — 12%, mostly ESR 2, employed but absent — fall
back to exponential distance decay with BETA.

Candidate sampling
------------------
Retail alone offers hundreds of eligible sites, and scoring every one for every
worker is 35M distance computations. Each worker instead scores a random
CANDIDATES-sized draw from the eligible set, which is sampling of alternatives:
the choice within the sample is unbiased for the choice within the whole, and
the cost stops depending on how common the industry is.

Unbiased for the choice, but not for the choice's *range*. A draw taken across
the town is only useful if the town is inside the worker's range, and for
someone who walks it is not: the nearest of 60 sites picked at random from
Kierston is 1.5 km from their door, and the scoring step below, however
carefully it weighs the reported commute, cannot pick something that is not on
the list. So a worker whose reach is under NEAR_REACH_M draws their shortlist
from within that reach instead. Drivers are unaffected, and not by exemption —
20 reported minutes buys 8 km here, which is most of the county, so the filter
has nothing to remove.

Modes
-----
Four, and only the first needs a site chosen for it:

    sited      goes to a workplace and stays
    itinerant  starts somewhere and moves all day — construction, couriers,
               home health, landscaping. ~12% of the workforce, and giving
               them a desk to sit at would be the wrong simulation entirely.
    home       JWTRNS says worked from home; the workplace is the dwelling
    external   POWPUMA is outside the region; they drive to a boundary portal

Nobody is assigned twice: the primary roster is read first and its people are
excluded, so a police officer does not also draw a warehouse shift.
"""

import argparse
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population import pums


from paths import DWELLINGS, PUMS_CODEBOOK as CODEBOOK, SIM_DATA  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
POPULATION = SIM_DATA / "population.json"
WORKPLACES = SIM_DATA / "workplaces.json"
EMPLOYMENT = SIM_DATA / "employment.json"

DEFAULT_SEED = 20260729

# How many eligible sites each worker actually scores. 60 is where the achieved
# commute distribution stops moving; higher only costs time.
CANDIDATES = 60

# Straight-line distance is not road distance, and road distance is not time.
# These turn one into the other well enough to rank sites against a reported
# commute: a detour factor for the street grid, an effective speed that already
# includes signals and congestion, and a fixed cost for getting to and from the
# vehicle at both ends. Calibrated against the surveyed internal commute —
# median 20 min, p90 30 — and the achieved figures are printed every run.
DETOUR = 1.35
SPEED_KMH = {"1": 24, "2": 14, "5": 14, "10": 4.5, "9": 13, "7": 22}
DEFAULT_SPEED_KMH = 22
OVERHEAD_MIN = {"1": 6, "10": 1, "2": 8}
DEFAULT_OVERHEAD_MIN = 5

# Width of the tolerance around a worker's reported commute, in minutes. Wide
# enough that a site is nearly always available inside it, tight enough that
# the reported time is doing the choosing.
#
# Capped as a share of the reported time as well, because seven minutes means
# something different at either end of the range. On a 20-minute drive it is a
# reasonable margin and stays seven. On a 6-minute walk it is wider than the
# trip, so a site three minutes away and one ten minutes away score almost the
# same and the reported time stops choosing anything — the failure this pair of
# constants exists to prevent. TOLERANCE_FLOOR_MIN keeps the very shortest
# trips from tightening to a point where nothing qualifies.
TOLERANCE_MIN = 7
TOLERANCE_SHARE = 0.5
TOLERANCE_FLOOR_MIN = 3

# Below this reach, the candidate draw has to be taken near the worker rather
# than across the town. See `reach`. 3 km is where the two failure modes cross:
# under it, a citywide draw of 60 reliably contains nothing the worker could
# actually get to, and the scoring step is left choosing the least bad of a set
# of impossibilities; over it, the draw reliably does contain something, and
# scanning the whole eligible pool to prove it costs more than it buys.
#
# In practice this is walkers and nobody else. A driver reporting 20 minutes
# can reach 8 km, which is most of the county, so their shortlist was never the
# thing constraining them — which is also the honest reason their commutes came
# out right while walkers' did not.
NEAR_REACH_M = 3000

# Distance decay for workers with no reported commute, per minute.
BETA = 0.12

# Industries whose work happens away from any fixed address. The site assigned
# is a depot — where the day starts and the vehicle lives — not where the hours
# are spent. Everything here is a job that visits other people's premises.
ITINERANT = {
    "0770",  # CON-Construction
    "6380",  # TRN-Couriers And Messengers
    "6170",  # TRN-Truck Transportation
    "6370",  # TRN-Postal Service
    "6180",  # TRN-Transit And Ground Passenger Transportation
    "8170",  # MED-Home Health Care Services
    "7690",  # PRF-Services To Buildings And Dwellings
    "7770",  # PRF-Landscaping Services
    "7790",  # PRF-Waste Management And Remediation
    "9290",  # SRV-Private Households
    "8370",  # SCA-Individual And Family Services
}


def metres(a, b):
    """Great-circle distance between two (lat, lon) pairs."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def minutes(distance_m, transport):
    """Door-to-door travel time for a straight-line distance, by mode."""
    speed = SPEED_KMH.get(transport, DEFAULT_SPEED_KMH)
    overhead = OVERHEAD_MIN.get(transport, DEFAULT_OVERHEAD_MIN)
    return overhead + (distance_m / 1000) * DETOUR / speed * 60


def narrow(target):
    """The proportional band, before deciding whether this worker gets it."""
    return max(TOLERANCE_FLOOR_MIN, min(TOLERANCE_MIN, TOLERANCE_SHARE * target))


def reach(person):
    """How far this worker's reported commute can actually take them, in metres.

    `minutes` run backwards, at the generous end of the tolerance the scoring
    step will apply. Returns None where there is no reported time to invert —
    those workers are placed by distance decay and have no reach to respect.
    """
    target = person.get("travel")
    if not target:
        return None
    transport = person.get("transport")
    speed = SPEED_KMH.get(transport, DEFAULT_SPEED_KMH)
    overhead = OVERHEAD_MIN.get(transport, DEFAULT_OVERHEAD_MIN)
    spare = target + 2 * narrow(target) - overhead
    if spare <= 0:
        return 0.0
    return spare * speed * 1000 / (60 * DETOUR)


def tolerance(person):
    """Half-width of the acceptable band around a reported commute, in minutes.

    Flat for anyone who can cross the town, proportional for anyone who cannot.

    The flat seven minutes is what the driving distribution was calibrated on
    and it reproduces it well, so it stays. It is only wrong where it is wide
    relative to the trip, and the trips it is wide relative to are exactly the
    ones already being drawn from a radius rather than from the town — so the
    same test decides both, and a driver's band is untouched whatever they
    reported.
    """
    target = person.get("travel")
    if not target:
        return TOLERANCE_MIN
    radius = reach(person)
    if radius is None or radius >= NEAR_REACH_M:
        return TOLERANCE_MIN
    return narrow(target)


def within(pool, catalogue, home, radius):
    """The sites in `pool` within `radius` of home. May be empty."""
    return [index for index in pool
            if metres(home, (catalogue[index]["lat"],
                             catalogue[index]["lon"])) <= radius]


def homes():
    """{dwelling id: (lat, lon)} for every building people live in."""
    data = json.loads(DWELLINGS.read_text())
    return {d["id"]: (d["lat"], d["lon"])
            for d in data["dwellings"] + data["quarters"]}


def sectors():
    """{industry: sector} from the INDP label prefix."""
    labels = json.loads(CODEBOOK.read_text())["variables"]["INDP"]["values"]["item"]
    return {code: label.split("-", 1)[0].strip() for code, label in labels.items()}


def eligible(catalogue, sector_of):
    """Site indices by exact industry and by sector — the two matching rungs."""
    by_industry, by_sector = defaultdict(list), defaultdict(list)
    for index, site in enumerate(catalogue):
        for industry in site["industries"]:
            by_industry[industry].append(index)
            by_sector[sector_of.get(industry, "?")].append(index)
    return by_industry, by_sector


def choose(person, pool, catalogue, remaining, home, rng):
    """Pick a site from `pool` for one worker. Returns (index, travel minutes).

    Scores a random draw from the pool rather than all of it, weights each
    candidate by free capacity, and shapes that weight by how well the site's
    travel time matches what this person reported. Returns (None, None) if
    nothing in the draw has room.
    """
    sample = (pool if len(pool) <= CANDIDATES
              else rng.sample(pool, CANDIDATES))
    transport = person.get("transport")
    target = person.get("travel")
    band = tolerance(person)

    scored, total = [], 0.0
    for index in sample:
        room = remaining[index]
        if room <= 0:
            continue
        site = catalogue[index]
        travel = minutes(metres(home, (site["lat"], site["lon"])), transport)
        if target:
            # Gaussian around the commute this person actually reported.
            weight = room * math.exp(-((travel - target) / band) ** 2 / 2)
        else:
            weight = room * math.exp(-BETA * travel)
        if weight <= 0:
            continue
        scored.append((index, travel, weight))
        total += weight

    if not scored:
        return None, None
    draw = rng.random() * total
    for index, travel, weight in scored:
        draw -= weight
        if draw <= 0:
            return index, travel
    return scored[-1][0], scored[-1][1]


def assign(people, catalogue, by_industry, by_sector, sector_of, coords, rng,
           occupied=()):
    """Walk the workforce and place each one. Returns (rows, tally).

    `occupied` counts workers init_work has already posted, by site key. Police
    headquarters and the fire houses are in this catalogue too — they are
    buildings where people work — so their seats have to be taken off the
    market before the filler class starts drawing on them, or 210 officers and
    the clerical staff of the same building both fit into the same floor area.
    """
    keys = [s["id"] for s in catalogue]
    everywhere = list(range(len(catalogue)))
    remaining = [max(0, s["capacity"] - occupied.get(k, 0))
                 for s, k in zip(catalogue, keys)]
    rows, tally = [], Counter()

    # Shuffled so that arrival order — which decides who gets the scarce seats
    # near home — is not household id, which is dwelling assignment order,
    # which correlates with income.
    order = list(people)
    rng.shuffle(order)

    for person, home in order:
        industry = person["industry"]
        row = {
            "person": person["id"],
            "class": "filler",
            "occupation": person["occupation"],
            "industry": industry,
            "hours": person.get("hours"),
            "depart": person.get("depart"),
            "arrive": person.get("arrive"),
            "transport": person.get("transport"),
        }

        if person.get("transport") == pums.WORKED_FROM_HOME:
            rows.append({**row, "site": person["dwelling"], "mode": "home",
                         "match": "home", "travel": 0})
            tally["home"] += 1
            continue

        if person.get("work_puma") not in (pums.HOME_POWPUMA, None):
            rows.append({**row, "site": None, "mode": "external",
                         "match": "external",
                         "travel": person.get("travel")})
            tally["external"] += 1
            continue

        mode = "itinerant" if industry in ITINERANT else "sited"

        exact = by_industry.get(industry, [])
        sector = by_sector.get(sector_of.get(industry), [])
        rungs = [("exact", exact), ("sector", sector)]

        # A worker who cannot travel far gets geography ranked above industry.
        #
        # The ladder normally reads "their industry, then their sector", which
        # is right for anyone who can cross the town to reach the right kind of
        # employer. Someone walking cannot. Their exact industry offers 16
        # premises in all of Kierston at the median and typically none inside
        # the ten minutes they reported, so holding the industry fixed means
        # sending them 8 km on foot — a match on the field we care less about,
        # bought with a commute that could not happen. Ranking the near rungs
        # first swaps that for a job in the same sector at a walkable address.
        #
        # `near_any` is the rung that bounds the tail. Without it, a walker
        # whose sector has no premises they can reach falls straight through to
        # the citywide rungs and is handed a 40-minute walk, because the
        # scoring step will happily crown the least distant of a set of sites
        # none of which are walkable. Someone who walks to work works at
        # whatever is walkable, so industry is the field that gives way last
        # rather than the field held fixed while the commute becomes fiction.
        #
        # The far rungs stay underneath for the ~130 walkers with nothing at
        # all inside their reach — no premises of any kind. For them the old
        # answer is still the only answer, and it is still wrong.
        radius = reach(person)
        if radius is not None and radius < NEAR_REACH_M:
            rungs = [("near_exact", within(exact, catalogue, home, radius)),
                     ("near_sector", within(sector, catalogue, home, radius)),
                     ("near_any", within(everywhere, catalogue, home, radius)),
                     *rungs]

        index, travel, match = None, None, None
        for rung, pool in rungs:
            if not pool:
                continue
            index, travel = choose(person, pool, catalogue, remaining,
                                   home, rng)
            if index is not None:
                match = rung
                break

        if index is None:
            # Every seat in the sector is taken. An itinerant worker needs no
            # premises anyway, so they base at home; a sited worker without a
            # site is a real shortfall and is counted as one.
            if mode == "itinerant":
                rows.append({**row, "site": person["dwelling"],
                             "mode": "itinerant", "match": "home",
                             "travel": 0})
                tally["itinerant_home"] += 1
                continue
            rows.append({**row, "site": None, "mode": "unplaced",
                         "match": "none", "travel": None})
            tally["unplaced"] += 1
            continue

        remaining[index] -= 1
        rows.append({**row, "site": keys[index], "mode": mode, "match": match,
                     "travel": round(travel)})
        tally[mode] += 1
        tally[f"match_{match}"] += 1

    return rows, tally, remaining


def report(rows, tally, people, catalogue, remaining):
    placed = [r for r in rows if r["mode"] in ("sited", "itinerant")
              and r["site"] and r["travel"]]
    print(f"{len(rows):,} filler assignments")
    for key in ("sited", "itinerant", "home", "external", "itinerant_home",
                "unplaced"):
        if tally[key]:
            print(f"  {key:<15} {tally[key]:>7,}  "
                  f"{tally[key] / len(rows) * 100:5.1f}%")

    rungs = ("near_exact", "near_sector", "near_any", "exact", "sector")
    matched = sum(tally[f"match_{rung}"] for rung in rungs)
    if matched:
        exact = tally["match_exact"] + tally["match_near_exact"]
        sector = tally["match_sector"] + tally["match_near_sector"]
        print(f"\nindustry match: {exact:,} exact "
              f"({exact / matched * 100:.1f}%), "
              f"{sector:,} same sector, "
              f"{tally['match_near_any']:,} neither")
        # Short-reach workers, split by what their own neighbourhood offered.
        # `near_any` is the count that industry was given up for geography, and
        # it is the one to watch: if it grows, the catalogue has too few tagged
        # premises in residential parts of town, which is a fact about the
        # tagging rather than about the town.
        near = sum(tally[f"match_near_{rung}"] for rung in ("exact", "sector", "any"))
        if near:
            print(f"drawn near home: {near:,} "
                  f"({tally['match_near_exact']:,} exact industry, "
                  f"{tally['match_near_sector']:,} same sector, "
                  f"{tally['match_near_any']:,} any industry)")

    if placed:
        times = sorted(r["travel"] for r in placed)
        reported = sorted(p["travel"] for p, _ in people
                          if p.get("travel")
                          and p.get("work_puma") == pums.HOME_POWPUMA
                          and p.get("transport") != pums.WORKED_FROM_HOME)
        print(f"\ncommute minutes, assigned vs surveyed:")
        print(f"  {'':<10}{'assigned':>10}{'surveyed':>10}")
        print(f"  {'mean':<10}{sum(times) / len(times):>10.1f}"
              f"{sum(reported) / len(reported):>10.1f}")
        print(f"  {'median':<10}{median(times):>10.1f}{median(reported):>10.1f}")
        for q in (0.1, 0.9):
            print(f"  {f'p{int(q * 100)}':<10}{times[int(len(times) * q)]:>10.1f}"
                  f"{reported[int(len(reported) * q)]:>10.1f}")

    used = sum(1 for i, s in enumerate(catalogue) if remaining[i] < s["capacity"])
    filled = sum(s["capacity"] - r for s, r in zip(catalogue, remaining))
    print(f"\n{used:,} of {len(catalogue):,} sites have at least one worker; "
          f"{filled:,} of {sum(s['capacity'] for s in catalogue):,} places used "
          f"({filled / sum(s['capacity'] for s in catalogue) * 100:.0f}%)")

    busiest = sorted(range(len(catalogue)),
                     key=lambda i: remaining[i] - catalogue[i]["capacity"])[:8]
    print("\nlargest employers:")
    for i in busiest:
        site = catalogue[i]
        print(f"  {site['capacity'] - remaining[i]:>5,}  "
              f"{(site['name'] or site['class'])[:44]:<44} "
              f"{','.join(site['industries'])}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="assignment seed; recorded in the output")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    population = json.loads(POPULATION.read_text())
    workplaces = json.loads(WORKPLACES.read_text())
    catalogue = workplaces["site_records"]
    coords = homes()
    sector_of = sectors()
    by_industry, by_sector = eligible(catalogue, sector_of)

    employment = json.loads(EMPLOYMENT.read_text())
    primary = [a for a in employment["assignments"] if a["class"] == "primary"]
    posted = {a["person"] for a in primary}

    # Household members reach their dwelling through the household; group
    # quarters residents carry theirs directly.
    dwelling_of = {h["id"]: h["dwelling"] for h in population["household_records"]}
    people = []
    for person in population["person_records"]:
        if person["employment"] in (1, 2) and person["industry"] \
                and person["id"] not in posted:
            person = {**person, "dwelling": dwelling_of[person["household"]]}
            people.append((person, coords[person["dwelling"]]))
    for person in population["quarters_records"]:
        if person["employment"] in (1, 2) and person["industry"]:
            people.append((person, coords[person["dwelling"]]))

    # Home-based primary roles base at a dwelling, which is not in this
    # catalogue; only the ones posted to a real facility take a seat.
    occupied = Counter(a["site"] for a in primary
                       if a.get("mode") == "sited" and a.get("site"))
    rows, tally, remaining = assign(people, catalogue, by_industry, by_sector,
                                    sector_of, coords, rng, occupied)

    employment["assignments"] = primary + rows
    employment["work_assignment_seed"] = args.seed
    employment["workplace_source"] = WORKPLACES.name
    employment["filler"] = {k: v for k, v in tally.items()
                            if not k.startswith("match_")}
    EMPLOYMENT.write_text(json.dumps(employment, separators=(",", ":")))

    report(rows, tally, people, catalogue, remaining)
    print(f"\n{len(primary):,} primary + {len(rows):,} filler = "
          f"{len(employment['assignments']):,} assignments")
    print(f"Wrote {EMPLOYMENT} ({EMPLOYMENT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
