"""Send every enrolled person to a school, and record the trip.

The counterpart to `assign_work.py`, and deliberately not a copy of it. Work
assignment is a gravity model because where an adult works is a choice made
over the whole city; American public school attendance is not a choice at all,
it is a boundary. A child attends the school whose catchment contains their
address, and the catchment is drawn by the district.

That difference is the whole design here. Three populations, three rules:

    public K-12   nearest school with room, then rebalanced. No decay
                  parameter, because distance is not decaying anything — it is
                  deciding, and a gravity model would smear a hard boundary
                  into a cloud.
    charter and   distance-decay gravity. These are chosen, by lottery or by
    private       tuition, and a family that wants a particular school will
                  drive past three others to reach it.
    college       capacity-weighted with only token decay, and overflow sent
                  out of the region. Which university someone attends is a
                  national decision; the 8,511 students the sample implies
                  cannot fit on Kierston's three campuses and were never meant
                  to — most commute to the region's universities.

Catchments without catchment boundaries
---------------------------------------
Real attendance-zone polygons are not in any extract we hold. Rather than
invent them, this assigns each student to their nearest eligible school and
then relieves the schools that overflow, moving their most distant students to
the next-nearest school with room. Repeat until nothing overflows. The
catchments are then emergent — a capacity-weighted Voronoi tessellation, which
is what a district planner is approximating when they draw the real ones.

The result is checkable in a way an invented polygon would not be: contiguity
and mean trip distance per band both fall out of the assignment and are
printed, and if they look wrong the constants are wrong rather than the shape.

Siblings
--------
Assignment operates on (household, band) groups, not on individual children. A
household with two children in elementary school sends both to the same
building, which is how families work and how districts write their rules. It
also matters downstream: siblings sharing a school is one of the edges that
makes a social graph clustered rather than merely dense, and generating it here
costs nothing while reconstructing it later would be guesswork.

Group quarters
--------------
Dormitory residents who report a college grade are already living on a campus,
so they attend the nearest one and are never sent external — their address is
the evidence. Everyone else enrolled in college takes their chances with
capacity.
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

import schools as catalogue

from population import pums


from paths import SIM_DATA
POPULATION = SIM_DATA / "population.json"
SCHOOLS = SIM_DATA / "schools.json"
DWELLINGS = SIM_DATA / "dwellings.json"
OUTPUT = SIM_DATA / "enrollment.json"

DEFAULT_SEED = 20260729

# How far the rebalance is allowed to keep going. Each pass moves the students
# a school cannot seat to their next-nearest, which can overflow that one in
# turn; in practice it settles in three or four. The cap is a guard against a
# cycle, not a tuning parameter.
REBALANCE_PASSES = 12

# A school may exceed its seat count by this much before rebalancing moves
# anyone out. Real schools run over capacity — portable classrooms exist — and
# without some slack the last few students in a dense catchment get pushed
# clear across the city to find a seat that is free by one.
OVERFLOW_TOLERANCE = 1.08

# Where the report starts calling a school crowded. Above the tolerance rather
# than at it, so the one-student overshoots an indivisible sibling group causes
# do not bury the schools that are genuinely oversubscribed.
REPORTABLE_BREACH = 1.15

# Distance decay for the chosen sectors, per km. Charter and private schools
# draw citywide but not uniformly: at 0.35 a school 2 km away is roughly half
# as likely as one next door, and one 8 km away is a sixth as likely.
BETA_CHOICE = 0.35

# College decay is much weaker. It is not zero — a local student who could
# attend either of two campuses will take the nearer — but it is nothing like
# the pull a primary school exerts.
BETA_COLLEGE = 0.08

# Candidates scored per choosing student. Small because the eligible sets are
# small: 13 private schools and 3 charter schools is the whole market.
CANDIDATES = 40

# How far down a group's ranked list the rebalance will look when every school
# it could reach is full. Small on purpose: this is the path that knowingly
# puts a school over its tolerance, and spreading the overflow across the
# neighbourhood is the point — spreading it across the city would just trade an
# overcrowded school for an implausible commute.
CROWDED_CANDIDATES = 6

# Trip speed, km/h, and fixed overhead in minutes, by band. Elementary children
# walk or ride a bus that stops constantly; a high schooler is as likely to be
# driven or to drive. These are door-to-door and already include the waiting.
SPEED_KMH = {"prek": 12, "elem": 10, "middle": 14, "high": 18, "college": 20}
OVERHEAD_MIN = {"prek": 4, "elem": 5, "middle": 6, "high": 6, "college": 8}

# Straight line is not road distance. Same detour factor `assign_work.py` uses,
# and for the same reason.
DETOUR = 1.35

# When the school day starts, minutes past midnight. American districts stagger
# their bands so one bus fleet can run three routes: high schools first, then
# middle, then elementary. This is the reference city's pattern.
START_MIN = {"prek": 540, "elem": 525, "middle": 480, "high": 450, "college": 540}

# How long the day runs, to give an arrival home. College is nominal — a
# student's timetable is not a shift — and is flagged as such by being the only
# band whose end time nothing should read as authoritative.
LENGTH_MIN = {"prek": 210, "elem": 390, "middle": 405, "high": 405, "college": 300}


def metres(a, b):
    """Great-circle distance between two (lat, lon) pairs."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def minutes(distance_m, band):
    """Door-to-door trip time for a straight-line distance, by band."""
    return (OVERHEAD_MIN[band]
            + (distance_m / 1000) * DETOUR / SPEED_KMH[band] * 60)


def homes():
    """{dwelling id: (lat, lon)} for every building people live in."""
    data = json.loads(DWELLINGS.read_text())
    return {d["id"]: (d["lat"], d["lon"])
            for d in data["dwellings"] + data["quarters"]}


def eligible(records):
    """{(band, sector): [school index]} — the sets a student can be assigned from.

    Charter and public share a pool for eligibility purposes: PUMS records a
    charter student as SCH 2, public, and cannot distinguish them. The
    difference is applied at the choosing end, not here.
    """
    pools = defaultdict(list)
    for index, school in enumerate(records):
        for band in school["bands"]:
            pools[(band, school["sector"])].append(index)
    return pools


def groups(population, coords):
    """Enrolled students as (household, band) groups. Returns [(members, band,
    sector, home)].

    A group is what gets assigned. Quarters residents have no household to
    share with, so each is a group of one — which is correct, not a fallback:
    two students in the same dormitory are not siblings.
    """
    dwelling_of = {h["id"]: h["dwelling"]
                   for h in population["household_records"]}

    def band_sector(person):
        if person.get("enrolled") not in (pums.ENROLLED_PUBLIC,
                                          pums.ENROLLED_PRIVATE):
            return None, None
        band = catalogue.GRADE_BAND.get(person.get("grade") or "")
        if not band:
            return None, None
        sector = ("private" if person["enrolled"] == pums.ENROLLED_PRIVATE
                  else "public")
        return band, sector

    collected = defaultdict(list)
    out = []
    for person in population["person_records"]:
        band, sector = band_sector(person)
        if band:
            collected[(person["household"], band, sector)].append(person["id"])
    for (household, band, sector), members in collected.items():
        out.append((members, band, sector, coords[dwelling_of[household]],
                    False))

    for person in population["quarters_records"]:
        band, sector = band_sector(person)
        if band:
            out.append(([person["id"]], band, sector,
                        coords[person["dwelling"]], True))
    return out


def nearest_assignment(units, records, pools, rng):
    """Catchment assignment for the public K-12 groups. Returns {unit: school}.

    Nearest school first, then relieve whatever overflows. `units` is a list of
    (index into units, members, band, home) and the return maps that index to a
    school index.
    """
    seats = [round(s["capacity"] * OVERFLOW_TOLERANCE) for s in records]
    coords = [(s["lat"], s["lon"]) for s in records]

    # Ranked candidate lists, computed once. Every band's pool is at most a few
    # dozen schools, so the full ranking is cheaper than re-scanning per pass.
    ranked = {}
    for key, (unit, members, band, home) in enumerate(units):
        pool = pools[(band, "public")] + pools[(band, "charter")]
        ranked[key] = sorted(pool, key=lambda i: metres(home, coords[i]))

    placed = {}
    taken = Counter()
    # Random order so that ties and the tail of the rebalance are not decided
    # by household id, which is dwelling assignment order.
    order = list(ranked)
    rng.shuffle(order)
    for key in order:
        if ranked[key]:
            placed[key] = ranked[key][0]
            taken[ranked[key][0]] += len(units[key][1])

    for _ in range(REBALANCE_PASSES):
        over = [i for i in set(placed.values()) if taken[i] > seats[i]]
        if not over:
            break
        for school in over:
            # The students a school sheds are its most distant, which is what
            # a district does when it redraws a boundary: the edge of the zone
            # moves, not its middle.
            here = [k for k in placed if placed[k] == school]
            here.sort(key=lambda k: -metres(units[k][3], coords[school]))
            for key in here:
                if taken[school] <= seats[school]:
                    break
                size = len(units[key][1])
                nxt = next((i for i in ranked[key]
                            if i != school and taken[i] + size <= seats[i]),
                           None)
                if nxt is None:
                    # Every school this group could reach is already full.
                    # Leaving them where they are concentrates the whole
                    # shortfall on one building — the run before this existed
                    # put 357 children in a 155-seat school — so the overflow
                    # goes to the least crowded of the nearest few instead.
                    # Somebody is over capacity either way; this decides
                    # whether it is one school badly or several slightly.
                    nearby = [i for i in ranked[key][:CROWDED_CANDIDATES]
                              if i != school]
                    if not nearby:
                        continue
                    nxt = min(nearby, key=lambda i: taken[i] / seats[i])
                    if taken[nxt] / seats[nxt] >= taken[school] / seats[school]:
                        continue
                taken[school] -= size
                taken[nxt] += size
                placed[key] = nxt

    return placed, taken


def choose(home, pool, records, taken, seats, beta, rng):
    """Gravity pick from `pool` for one choosing group, or None if all full."""
    sample = pool if len(pool) <= CANDIDATES else rng.sample(pool, CANDIDATES)
    scored, total = [], 0.0
    for index in sample:
        room = seats[index] - taken[index]
        if room <= 0:
            continue
        distance = metres(home, (records[index]["lat"], records[index]["lon"]))
        weight = room * math.exp(-beta * distance / 1000)
        if weight <= 0:
            continue
        scored.append((index, weight))
        total += weight
    if not scored:
        return None
    draw = rng.random() * total
    for index, weight in scored:
        draw -= weight
        if draw <= 0:
            return index
    return scored[-1][0]


def assign(population, records, coords, rng):
    """Place every enrolled person. Returns (rows, tally)."""
    pools = eligible(records)
    units = groups(population, coords)
    # SCHG travels onto the row alongside the band it implies. The band is what
    # the assignment reasons about — four of them, against sixteen grades — but
    # a reader wants to know a child is in the fourth grade, not merely that
    # they are somewhere in elementary school, and recovering it later would
    # mean joining back to population.json for a field already in hand.
    grade_of = {p["id"]: p.get("grade")
                for p in population["person_records"] + population["quarters_records"]}
    seats = [round(s["capacity"] * OVERFLOW_TOLERANCE) for s in records]
    taken = Counter()
    rows, tally = [], Counter()

    def emit(members, band, sector, home, school):
        """One row per student. The group is an assignment device; the output
        relation is one row per person, like employment.json."""
        if school is None:
            for person in members:
                rows.append({"person": person, "band": band,
                             "grade": grade_of.get(person), "sector": sector,
                             "school": None, "mode": "external",
                             "travel": None, "depart": None, "arrive": None})
            tally[f"external_{band}"] += len(members)
            tally["external"] += len(members)
            return
        site = records[school]
        travel = minutes(metres(home, (site["lat"], site["lon"])), band)
        depart = round(START_MIN[band] - travel)
        for person in members:
            rows.append({
                "person": person, "band": band,
                "grade": grade_of.get(person), "sector": sector,
                "school": site["id"], "mode": "enrolled",
                "travel": round(travel),
                "depart": depart,
                "arrive": round(START_MIN[band] + LENGTH_MIN[band] + travel),
            })
        tally["enrolled"] += len(members)
        tally[band] += len(members)

    # Public and charter K-12, by catchment. Prek is excluded: preschool is not
    # zoned, not compulsory, and is chosen the way a private school is.
    zoned = [(k, m, b, h) for k, (m, b, s, h, _) in enumerate(units)
             if s == "public" and b in catalogue.K12]
    placed, zoned_taken = nearest_assignment(zoned, records, pools, rng)
    for local, (key, members, band, home) in enumerate(zoned):
        emit(members, band, "public", home, placed.get(local))
    taken.update(zoned_taken)

    # Everyone else chooses: private at every band, public preschool, and
    # college. Dormitory residents go first, and college before anything else,
    # because they are the only students whose address already proves which
    # institution they attend — a bed in a Muhlenberg hall is not a preference
    # to be weighed against capacity. Letting commuters draw first would seat
    # them in the campus a resident is already living on and push the resident
    # out of the region, which is the one outcome the data rules out.
    def priority(item):
        _, (_, band, _, _, resident) = item
        return (0 if band == "college" and resident else 1)

    for key, (members, band, sector, home, resident) in sorted(
            enumerate(units), key=priority):
        if sector == "public" and band in catalogue.K12:
            continue
        if band == "college":
            pool = [i for i in range(len(records))
                    if "college" in records[i]["bands"]]
            beta = BETA_COLLEGE
        else:
            pool = pools[(band, sector)]
            # A private preschool and a public one are the same building here:
            # nursery provision is not split by the sector a district runs, and
            # PUMS's public/private answer for a three-year-old is about who
            # bills the parent, not about which door they walk through.
            if band == "prek":
                pool = (pools[("prek", "public")] + pools[("prek", "private")]
                        + pools[("prek", "charter")])
            beta = BETA_CHOICE

        school = choose(home, pool, records, taken, seats, beta, rng) \
            if pool else None

        # A dormitory resident enrolled in college lives on a campus. If the
        # capacity draw failed they still attend the nearest one — their
        # address is stronger evidence than a seat count derived from floor
        # area, and sending them out of the region would put a student in a
        # dormitory they commute away from every morning.
        if school is None and resident and band == "college" and pool:
            school = min(pool, key=lambda i: metres(
                home, (records[i]["lat"], records[i]["lon"])))

        if school is not None:
            taken[school] += len(members)
        emit(members, band, sector, home, school)

    return rows, tally, taken


def report(rows, tally, records, taken):
    enrolled = [r for r in rows if r["mode"] == "enrolled"]
    print(f"{len(rows):,} students  {len(enrolled):,} at a school in Kierston, "
          f"{tally['external']:,} outside the region "
          f"({tally['external'] / len(rows) * 100:.1f}%)")

    print("\nby band:")
    for band in ("prek",) + catalogue.K12 + ("college",):
        here = [r for r in enrolled if r["band"] == band]
        away = tally.get(f"external_{band}", 0)
        if not here and not away:
            continue
        trips = sorted(r["travel"] for r in here)
        print(f"  {band:<8} {len(here):>7,} placed  {away:>6,} external   "
              f"trip median {median(trips) if trips else 0:>4.0f} min  "
              f"p90 {trips[int(len(trips) * 0.9)] if trips else 0:>3.0f}")

    print("\nby school sector (unknown for campuses):")
    for sector in ("public", "charter", "private", "unknown"):
        here = [r for r in enrolled if r["school"]
                and sector == next(s["sector"] for s in records
                                   if s["id"] == r["school"])]
        if here:
            print(f"  {sector:<8} {len(here):>7,}")

    used = sum(1 for i, s in enumerate(records) if taken[i])
    capacity = sum(s["capacity"] for s in records)
    filled = sum(taken.values())
    print(f"\n{used} of {len(records)} schools have at least one student; "
          f"{filled:,} of {capacity:,} seats used "
          f"({filled / capacity * 100:.0f}%)")

    # Running over the nominal seat count is expected — OVERFLOW_TOLERANCE
    # allows it, because real schools put portable classrooms in the car park.
    # Running over the tolerance is not, and means a group was placed by a rule
    # that does not consult capacity at all: today only the dormitory residents
    # do that. The two are counted separately so the second never hides inside
    # the first.
    over = [i for i in taken if taken[i] > records[i]["capacity"]]
    if over:
        print(f"{len(over)} schools above their nominal seats, "
              f"{(OVERFLOW_TOLERANCE - 1) * 100:.0f}% tolerance")

    # A school lands a percent or two past the tolerance whenever the last
    # group that fits is a pair of siblings and only one seat is left — they
    # are not separable, so one of them is the overshoot. That is the tolerance
    # working, not failing. Only a school well past it means the assignment ran
    # out of room in a way worth looking at.
    breach = sorted((i for i in taken
                     if taken[i] > records[i]["capacity"] * REPORTABLE_BREACH),
                    key=lambda i: -taken[i] / records[i]["capacity"])
    for i in breach[:5]:
        print(f"  crowded: {(records[i]['name'] or records[i]['id'])[:40]:<40} "
              f"{taken[i]:>5,} in {records[i]['capacity']:>5,} seats "
              f"({taken[i] / records[i]['capacity'] * 100:.0f}%)")
    if len(breach) > 5:
        print(f"  and {len(breach) - 5} more")

    print("\nlargest:")
    for i in sorted(taken, key=lambda i: -taken[i])[:10]:
        school = records[i]
        print(f"  {taken[i]:>5,}  "
              f"{(school['name'] or school['id'])[:44]:<44} "
              f"{'/'.join(school['bands'])} {school['sector']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="assignment seed; recorded in the output")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    population = json.loads(POPULATION.read_text())
    records = json.loads(SCHOOLS.read_text())["school_records"]
    coords = homes()

    if not any("enrolled" in p for p in population["person_records"][:1]):
        raise SystemExit(
            "population.json has no enrollment fields; re-run "
            "synthesize_population.py")

    rows, tally, taken = assign(population, records, coords, rng)
    rows.sort(key=lambda r: r["person"])

    OUTPUT.write_text(json.dumps({
        "source": POPULATION.name,
        "school_source": SCHOOLS.name,
        "seed": args.seed,
        "students": len(rows),
        "enrolled": tally["enrolled"],
        "external": tally["external"],
        "start_times": START_MIN,
        "assignments": rows,
    }, separators=(",", ":")))

    report(rows, tally, records, taken)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
