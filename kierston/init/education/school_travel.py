"""Assign each student a travel mode to school and build the school bus runs.

`assign_school.py` answers where a student goes and how long the door-to-door
trip takes. It does not answer *how*, and until it does the whole population of
students is invisible to the simulation: the runtime's roster is keyed on a work
assignment, so a child with no job has no compulsory block, no journey, and no
place to be at nine in the morning.

This stage supplies the missing half. Two questions, in this order:

    mode    bus, a lift from a parent, walking, the student's own car, or the
            public network. Decided per student and per direction.
    runs    for the ones on a bus, which bus, in what order, with whom.

Morning and afternoon are decided separately
--------------------------------------------
Not symmetry for its own sake. Bus out and a lift home is one of the most
common real patterns in American school travel, and the reason is scheduling:
the 08:00 drop and the 15:00 collection suit different shifts, so they are
often done by different adults or not by an adult at all. Modelling one mode
for the whole day would erase the afternoon parent, who is a different person
from the morning one about a third of the time.

Why the escort is nominated here and resolved at runtime
--------------------------------------------------------
A lift is the only thing in the simulation so far that couples two people's
days. The runtime is per-person parallel by construction — `roster.ts` says
"nothing here reads another person" and means it — so a layer that had to plan
the parent's day before it could plan the child's would give that up.

The split that keeps it: this stage nominates *who* would drive, weekday
invariant, and writes a fallback beside it. The runtime asks one pure question
of the nominated adult — does their roster put them at work at that hour on
this date — which is a function of that adult's own static assignment and the
date, and needs nothing else planned. Child and parent both read the same
nomination and both evaluate the same predicate, so they agree without either
having been computed first. That is the same device `affiliations.py` uses for
occurrences: keyed on the org and the week, never on the person.

The fallback is not a repair. A parent who works Tuesday mornings does not
drive on Tuesday mornings, and the child rides the bus that day — so the
child's seat on that run is real capacity that has to exist whether or not it
is used. Run manifests are therefore sized on everyone who *could* board, which
is why a run's occupancy report has a potential figure and a typical one.

What decides the mode
---------------------
Gates first, then a habit. The gates are facts and they are hard: a bus does
not stop for a student inside the walk zone, a lift needs an adult with a car,
a student cannot drive without one of their own. What survives the gates is
drawn against per-band weights, which are a habit fitted to the national mode
split and are the part of this file most likely to want changing.

Distance is straight-line times the same detour factor `assign_school.py` uses.
There is no road graph in this stage and there should not be one: what init
decides is structure — who rides which run, in what order — and what the
runtime decides is minutes. The bus's real path and its real stop times are
routed over the car graph by the simulation, backwards from the bell, exactly
the way a commute is. Writing estimated pickup times here would put a second,
worse answer in the file next to the one the runtime computes.

Ordering: after `assign_school.py`, which says who goes where, and after
`vehicles.py`, which registers both the household cars a lift depends on and
the fleet these runs are assigned to.
"""

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "personal_records"))

from assign_school import DETOUR, LENGTH_MIN, START_MIN, metres
from fleet import BUSED_BANDS, SCHOOL_OPERATORS
from registries import keyed

from paths import SIM_DATA
POPULATION = SIM_DATA / "population.json"
SCHOOLS = SIM_DATA / "schools.json"
DWELLINGS = SIM_DATA / "dwellings.json"
ENROLLMENT = SIM_DATA / "enrollment.json"
EMPLOYMENT = SIM_DATA / "employment.json"
VEHICLES = SIM_DATA / "vehicles.json"
FLEET = SIM_DATA / "fleet.json"
KINSHIP = SIM_DATA / "kinship.json"
OUTPUT = SIM_DATA / "school_travel.json"
OPERATORS = SCHOOL_OPERATORS

# What the simulation measured last time it routed these runs, if it ever has.
#
# The one place this pipeline runs backwards. Deciding which bus covers which
# runs needs each run's duration, and this stage has no road graph — that lives
# in the simulation, deliberately, because init decides structure and the
# runtime decides minutes. So the first pass estimates from straight-line
# distance at an assumed speed, `bun run day --measure-runs` routes every run
# properly and writes the answer here, and the next pass schedules against real
# numbers instead of a guess.
#
# One pass is enough, and that is a property worth stating rather than hoping
# for: a run's stops, their order and its manifest come from the riders alone,
# and nothing in `build_runs` consults the fleet. Only `assign_fleet` uses the
# duration. So feeding measurements back cannot change the runs that were
# measured — the second pass reschedules the same routes honestly, and a third
# pass would change nothing.
#
# Missing or stale is not an error. The ids miss, every run falls back to its
# estimate, and the report says how many did.
MEASURED = SIM_DATA / "school_runs_measured.json"

DEFAULT_SEED = 20260801

# The walk zone, in kilometres, by band.
#
# 24 P.S. § 13-1361 obliges a Pennsylvania district to transport a student who
# lives beyond 1.5 miles of an elementary school or 2 miles of a secondary one.
# Inside that radius transport is discretionary and most districts do not
# provide it, which is what makes this a gate rather than a preference: a child
# eight hundred metres from their school has no bus to take, whatever their
# family would prefer.
WALK_ZONE_KM = {"elem": 2.4, "middle": 3.2, "high": 3.2}

# Below this, the public network is not a school trip. LANta's own service is
# not dense enough to beat walking a kilometre, and a student who lives that
# close is not waiting at a stop for it.
TRANSIT_FLOOR_KM = 1.6

# Beyond this, nobody walks whatever the zone says. The walk zone is a busing
# obligation, not a claim about what is walkable; a 2.4 km walk is at the edge
# of what an eleven-year-old does twice a day and past it for a six-year-old.
WALK_LIMIT_KM = {"prek": 0.8, "elem": 1.4, "middle": 2.0, "high": 2.4, "college": 2.4}

# Preference among the modes a student is actually eligible for, by band.
#
# A habit, not a measurement. The gates above decide what is possible and these
# decide what is chosen from it, so the realised shares are always lower than
# these weights imply — most obviously for `bus`, which two thirds of the
# elementary cohort are not eligible for at all. The realised split is what the
# report prints and what should be compared against the NHTS school-trip
# shares, not these numbers.
#
# `self` is a student driving their own car and exists only for `high`. `lift`
# is a ride from an adult in the household. `transit` is the public network,
# which for a school trip is a high-school and college phenomenon and close to
# absent below it.
MODE_WEIGHTS = {
    "prek":    {"lift": 88, "walk": 12, "bus": 0,  "transit": 0,  "self": 0},
    "elem":    {"lift": 52, "walk": 12, "bus": 35, "transit": 1,  "self": 0},
    "middle":  {"lift": 40, "walk": 15, "bus": 42, "transit": 3,  "self": 0},
    "high":    {"lift": 30, "walk": 13, "bus": 36, "transit": 9,  "self": 12},
    "college": {"lift": 8,  "walk": 14, "bus": 0,  "transit": 18, "self": 60},
}

# Busing by sector, as a multiplier on the bus and lift weights.
#
# A public school has a catchment, so its riders live near each other and near
# it, and a bus route through them is efficient. A private school draws from
# the whole city: the same sixty riders are spread over sixty neighbourhoods,
# and a route collecting them is not a route, it is a tour.
#
# That geometry is why private-school busing is rare in reality and it is worth
# stating the mechanism rather than just the number. Pennsylvania obliges a
# district to carry non-public students only on the routes it already runs, out
# to ten miles past its boundary; beyond that a family drives, and most do.
#
# This constant was found by building the routes without it. Weighting private
# riders onto buses at the public rate produced 183 buses for a contractor with
# forty, on runs with a median of six children aboard, because a forty-five
# minute route through scattered addresses cannot fill up. Six children per bus
# is not a fleet that is too small; it is a mode share that is wrong.
SECTOR_BUS_DRAG = {"public": 1.0, "charter": 0.45, "private": 0.2}
SECTOR_LIFT_PULL = {"public": 1.0, "charter": 1.35, "private": 1.7}

# How far from their school a student may live and still be bused, by sector.
#
# For a public school this is unbounded in practice: the catchment *is* the
# route, so a rider at the edge of it is on the way in by construction.
#
# For a non-public school it is the binding constraint and the drag above is not
# enough on its own. § 13-1361 obliges a district to carry non-public students
# along the routes it already runs — not to invent a route for them — so the
# ones who ride are the ones who happen to live near a school the bus already
# passes. Without this gate the 420 private riders were spread over the whole
# city, five to a bus, and the contractor needed ninety-seven vehicles to carry
# fewer children than the district fits on eight.
BUS_RANGE_KM = {"public": 99.0, "charter": 6.0, "private": 5.0}

# The afternoon is not the morning reversed. A student bused out is more likely
# to be collected by car than to ride home — the collection is a single errand
# an adult can make, where the drop competes with the start of their own working
# day — and a student who walked in the morning very largely walks home.
PM_LIFT_PULL = 1.35
PM_BUS_DRAG = 0.78

# How far a student will walk to a bus stop. Real districts place stops so that
# no child in the served area walks much beyond a quarter mile; past that the
# stop is not serving them and they should be on a different one.
STOP_WALK_KM = 0.40

# Stops are formed by clustering rider homes. A cluster's radius is half the
# walk allowance, so two riders on the same stop are never more than the
# allowance apart from each other or from the stop that serves them.
STOP_RADIUS_KM = STOP_WALK_KM / 2

# A manifest is built against the standard full-size bus, not against whatever
# vehicle happens to be free. Type C is what a district buys to run routes;
# fleet.py's type A cutaways are the special-education and scattered-route
# vehicles and are not what a neighbourhood collection is planned around.
STANDARD_SEATS = 71

# Estimating how long a run takes, which the fleet assignment needs and cannot
# get from the road graph — that lives in the simulation, and this stage
# deliberately has no router. Straight-line distance times the usual detour
# factor, at a speed a bus keeps on residential streets, plus the dwell.
#
# It only has to be good enough to answer one question: can this bus be back in
# time to start the next band's run. The runtime prices the run properly and
# reports when the estimate was optimistic.
BUS_SPEED_KMH = 24
BUS_DWELL_MIN = 0.9
SCHOOL_DWELL_MIN = 3

# Slack between one run finishing and the next band's bell.
#
# This is the drive from the last school of one route to the first stop of the
# next, and it is the one gap the measurements cannot supply: it depends on
# which runs end up chained onto the same bus, which is what the schedule
# decides, so measuring it would need the schedule that needs it.
#
# 15 is a plain allowance and is not claimed to be more. Raising it to 25 was
# tried against the runtime's own lateness figures and bought nothing: drivers
# still came out twenty to thirty-five minutes behind by the end of the morning,
# and the wider windows cost nine more buses and nine more drivers the city does
# not have. So the residual lateness is not the turnaround, and padding this
# further would only hide where it does come from.
TURNAROUND_MIN = 15

# The drive between the yard and the end of a route, each way, before anything
# has been measured. Only used on a first pass — once the simulation has routed
# the runs, the real figure is the gap between its `depart` and `ret`.
DEADHEAD_MIN = 10

# What the raw estimate has to be multiplied by to land on what the simulation
# measures. Fitted, not chosen: the first measurement pass found runs taking 19
# minutes longer than a 32-minute estimate, which is this factor.
#
# The error is in the distance and not the speed, which is why it is a
# multiplier rather than a slower bus. `DETOUR` is 1.35 — the factor
# `assign_work.py` uses to turn a crow-flies commute into a road distance — and
# it is about right for a five-kilometre trip across town. It is badly wrong for
# the two-hundred-metre hop between one bus stop and the next, where the road
# distance is routinely two or three times the straight line because the bus has
# to go round the block. A bus route is forty of those hops end to end, so the
# understatement compounds all the way along it.
#
# This still matters with the measurements in hand, because the estimate is what
# *splits* a manifest and the split happens before a run has an id to look a
# measurement up by. Getting the schedule right afterwards does not shorten a
# run that was built too long in the first place.
ESTIMATE_CALIBRATION = 1.6

# How long a run may take, first stop to last bell.
#
# Seats are not the only thing that ends a run and they are not even the usual
# one. A bus that has collected sixty children forty minutes from the school has
# a legal problem and a mutinous one: the youngest riders would be aboard for
# over an hour. Real districts hold routes to roughly this and split them when
# they cannot.
# Longer for a contractor, and this is not a fudge to make the fleet fit. A
# public route runs through a catchment and is short because the catchment is
# small. A non-public route collects children who chose a school across town,
# and the ride is correspondingly long — which is one of the reasons families
# who can drive do, and is why the mode share above is a fifth of the public
# one. Holding both to the same fifty minutes split the contractor's routes into
# fragments carrying four children each.
MAX_RUN_MINUTES = {"district": 50, "contractor": 80}

# How many schools one run may deliver to, and how far apart they may be.
#
# Combining schools onto one route is what makes a contractor's scattered
# enrolment routable at all — see build_runs — but unbounded it is worse than
# the problem it solves. The first version had no cap and produced contractor
# runs serving eleven schools over ninety-five kilometres, six hours on the
# road, because every private school in the city drew from every neighbourhood
# and one manifest could contain a child for each of them. A real combined route
# serves a handful of neighbouring schools, so riders are grouped by a cluster
# of destinations rather than by the whole operator.
MAX_SCHOOLS_PER_RUN = 3
SCHOOL_CLUSTER_KM = 4.0

# A run is capped below the seat count. A manifest sized to the last seat has
# no room for the fallback riders whose lift falls through on a given day, and
# the capacity that absorbs them is the reason to leave it.
LOAD_FACTOR = 0.85

# College students are not bused and are not children. Where their school is
# outside the extract `assign_school.py` has already marked them external; the
# ones placed on a Kierston campus travel like the adults most of them are.
UNBUSED_BANDS = ("prek", "college")

# An adult is somebody who could hold a licence and be responsible for a child.
ADULT_AGE = 18

# A student may drive themselves at the age Pennsylvania issues a junior
# licence, and only if a vehicle is actually registered to them. `vehicles.py`
# marks each household vehicle `owner_licensed`, true only when the owner holds
# a usable licence, so a licensed owner is the licence test as well as the car
# test, and reading holdings.json again to ask the same question would be a
# second answer to it.
DRIVING_AGE = 16

# Slack around the bell for judging whether an adult could make the trip.
#
# Deliberately coarse. This decides who is *nominated*, not whether the drop
# happens on any particular day — the runtime settles that against the parent's
# actual roster for the date. What it has to get right is the difference
# between a parent who plausibly could and one who plainly could not.
DROP_SLACK_MIN = 20
PICKUP_SLACK_MIN = 25

# A shift starting after this is an afternoon or night one, and its holder is
# at home in the morning.
LATE_SHIFT_MIN = 12 * 60

# Estimated length of a filler worker's day, from WKHP over a five-day week.
# The runtime derives this properly in `roster.ts`; here it only has to place a
# work end on the right side of the afternoon bell.
FILLER_DAY_HOURS = (4.0, 11.0)


def km(a, b):
    """Road-ish distance between two (lat, lon) pairs."""
    return metres(a, b) / 1000 * DETOUR


def homes():
    """{dwelling id: (lat, lon)} for every building people live in."""
    data = json.loads(DWELLINGS.read_text())
    return {d["id"]: (d["lat"], d["lon"])
            for d in data["dwellings"] + data["quarters"]}


def work_window(person, assignment):
    """(start, end) minutes for an adult's working day, or None if they have none.

    Coarse by design — see DROP_SLACK_MIN. Working from home returns None,
    because someone at home all day is available for both runs.
    """
    if not assignment:
        return None
    if assignment.get("mode") == "home":
        return None

    # A school bus driver is working at both bells by definition — that is what
    # the job is — so they are the one adult the fallbacks below would get
    # exactly backwards. `init_work.py` gives them no shift, because which half
    # of the day they work is decided further down this file, and without this
    # they would fall through to the WKHP estimate and be nominated to drive
    # their own children to school at the hour they are driving everyone else's.
    if assignment.get("role") == "school_bus_driver":
        return min(START_MIN.values()) - 60, max(
            START_MIN[band] + LENGTH_MIN[band] for band in START_MIN) + 60

    shift = assignment.get("shift")
    if shift:
        return shift["start"] - shift.get("report", 0), shift["end"]

    hours = person.get("hours") or assignment.get("hours") or 0
    if hours <= 0:
        return None
    start = person.get("arrive")
    if start is None:
        start = 9 * 60
    low, high = FILLER_DAY_HOURS
    length = min(high, max(low, hours / 5)) * 60
    return start, start + length


def free_for_drop(window, bell):
    """Could this adult plausibly drop a child at the morning bell?"""
    if window is None:
        return True
    start, _ = window
    # Leaves for work after the school gate, or works an afternoon/night shift
    # and is at home all morning.
    return start >= bell - DROP_SLACK_MIN or start >= LATE_SHIFT_MIN


def free_for_pickup(window, bell_out):
    """Could this adult plausibly collect a child at the afternoon bell?"""
    if window is None:
        return True
    start, end = window
    # Finished before the gate, or has not started yet.
    return end <= bell_out + PICKUP_SLACK_MIN or start >= bell_out + 60


def household_adults(population):
    """{household: [person record]} for everyone old enough to drive a child."""
    out = defaultdict(list)
    for person in population["person_records"]:
        if person["age"] >= ADULT_AGE:
            out[person["household"]].append(person)
    return out


def drivers_and_owners(vehicles):
    """(set of licensed person ids owning a car, {household: cars}).

    `vehicles.py` registers a household's VEH count to its licensed drivers
    where it has any, and otherwise to an unlicensed head with
    `owner_licensed` false. Only licensed owners are returned, so nobody
    without a licence is nominated to drive a child or themselves. A row with
    no flag (a vehicles.json from before the flag existed) counts as
    unlicensed.
    """
    owners = set()
    per_household = Counter()
    for row in vehicles["vehicles"].values():
        if row["household"] is None:
            continue
        if row.get("owner_licensed"):
            owners.add(row["owner"])
        per_household[row["household"]] += 1
    return owners, per_household


def escorts_for(student, band, adults, owners, windows, parents, rng):
    """(morning escort, afternoon escort) — person ids, or None.

    Preference order among the household's licensed adults: a parent of this
    student first, then anyone else old enough. Within that, whoever is free.
    Where two are free the draw is keyed on the student, so a household with
    two available parents does not send the same one on every trip.
    """
    # Nobody in custody is nominated; dockets.py writes `incarcerated` onto
    # the person record.
    candidates = [a for a in adults
                  if a["id"] in owners and not a.get("incarcerated")]
    if not candidates:
        return None, None

    kin = parents.get(student, set())
    candidates.sort(key=lambda a: (a["id"] not in kin, a["id"]))

    bell = START_MIN[band]
    bell_out = bell + LENGTH_MIN[band]

    def choose(test, bell_minute):
        able = [a for a in candidates
                if test(windows.get(a["id"]), bell_minute)]
        if not able:
            return None
        # Parents first, and among equals a stable draw rather than the lowest
        # id — otherwise the eldest adult in every household does every school
        # run in the city.
        best = [a for a in able if a["id"] in kin] or able
        return rng.choice(best)["id"]

    am = choose(free_for_drop, bell)
    pm = choose(free_for_pickup, bell_out)
    return am, pm


def eligible_modes(distance, band, sector, has_escort, has_own_car, in_walk_zone):
    """The modes this student could actually use, as a set."""
    modes = set()

    if distance <= WALK_LIMIT_KM.get(band, 2.0):
        modes.add("walk")
    if has_escort:
        modes.add("lift")
    if has_own_car and band in ("high", "college"):
        modes.add("self")
    # The public network is a real option for an older student and not for a
    # child. It needs a distance floor of its own: nobody waits for a city bus
    # to travel six hundred metres they could walk in eight minutes, and
    # without the floor transit absorbs the whole of the short-trip cohort that
    # the walk zone has already excluded from a school bus.
    if band in ("middle", "high", "college") and distance >= TRANSIT_FLOOR_KM:
        modes.add("transit")
    # A bus exists only outside the walk zone, only for the bands a district
    # buses, only where somebody runs one for that sector, and only within the
    # reach of a route that already exists.
    if (band in BUSED_BANDS and not in_walk_zone
            and distance <= BUS_RANGE_KM.get(sector, 99.0)):
        modes.add("bus")

    # Everyone has to get there somehow. A student outside the walk zone with
    # no bus, no escort and no car walks anyway — a long walk is a real answer
    # and inventing a mode for them would hide it.
    if not modes:
        modes.add("walk")
    return modes


def fallback_mode(modes):
    """What a student does on a day their nominated escort turns out to work.

    Drawn here so the runtime never has to invent one, and cascading in the
    same order the gates do: the bus if one serves them, the walk if not.
    """
    for option in ("bus", "walk", "transit"):
        if option in modes:
            return option
    return "walk"


def pick_mode(modes, band, sector, rng, direction):
    """Draw one of the eligible modes against the band's weights."""
    weights = MODE_WEIGHTS[band]
    options = sorted(modes)
    scores = []
    for mode in options:
        score = weights.get(mode, 0)
        if mode == "bus":
            score *= SECTOR_BUS_DRAG.get(sector, 1.0)
            if direction == "pm":
                score *= PM_BUS_DRAG
        elif mode == "lift":
            score *= SECTOR_LIFT_PULL.get(sector, 1.0)
            if direction == "pm":
                score *= PM_LIFT_PULL
        scores.append(max(score, 0.001))
    return rng.choices(options, weights=scores)[0]


def cluster_stops(riders, coords):
    """Group rider homes into bus stops.

    Greedy and radius-bounded: take the home with the most unserved neighbours
    within the radius, make that the stop, assign everyone inside it, repeat.
    The stop lands on a rider's own address rather than on a computed centroid,
    which keeps every stop on a street somebody actually lives on — a centroid
    can fall in the middle of a block, a river, or a golf course.

    Neighbours come out of a grid bucketed at the cluster radius, so a candidate
    is compared against the handful of homes in the nine cells around it rather
    than against every rider on the run. The naive form of this is three nested
    passes over the manifest and does not finish in a sensible time on the
    larger catchments.
    """
    remaining = {person: coords[person] for person in riders}
    # Degrees per radius, latitude and longitude separately: a degree of
    # longitude is about three quarters of a degree of latitude at this
    # latitude, and a square grid in degrees would be a rectangle on the ground.
    lat_step = STOP_RADIUS_KM / 111.0
    lon_step = STOP_RADIUS_KM / (111.0 * math.cos(math.radians(40.6)))

    cells = defaultdict(set)
    for person, (lat, lon) in remaining.items():
        cells[(int(lat / lat_step), int(lon / lon_step))].add(person)

    def near(point):
        row, col = int(point[0] / lat_step), int(point[1] / lon_step)
        out = []
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                for person in cells.get((row + dr, col + dc), ()):
                    if km(point, remaining[person]) <= STOP_RADIUS_KM:
                        out.append(person)
        return out

    stops = []
    while remaining:
        best = None
        best_members = None
        for person, point in remaining.items():
            members = near(point)
            if best_members is None or len(members) > len(best_members):
                best, best_members = person, members
                # Nothing can beat a cell whose whole neighbourhood is in it.
                if len(members) == len(remaining):
                    break
        stops.append({"at": remaining[best], "riders": sorted(best_members)})
        for member in best_members:
            point = remaining.pop(member)
            cells[(int(point[0] / lat_step), int(point[1] / lon_step))].discard(member)

    return stops


def order_stops(stops, school):
    """Put the stops in the order a bus serves them: farthest first, inward.

    A school bus run is a collection, not a tour between arbitrary points — it
    starts at the edge of its catchment and works toward the building, filling
    as it goes. Nearest-neighbour from the farthest stop reproduces that shape,
    and unlike a general travelling-salesman order it cannot produce the run
    that drives past the school twice.
    """
    if not stops:
        return []
    remaining = list(stops)
    start = max(remaining, key=lambda s: km(s["at"], school))
    remaining.remove(start)
    ordered = [start]
    while remaining:
        here = ordered[-1]["at"]
        nearest = min(remaining, key=lambda s: km(s["at"], here))
        remaining.remove(nearest)
        ordered.append(nearest)
    return ordered


def split_runs(ordered, seats, schools_for, limit):
    """Cut an ordered stop list into runs, on seats or on time, whichever binds.

    Cut sequentially rather than by any balancing rule: the list is already in
    road order, so consecutive stops are neighbours and each run stays a
    contiguous piece of the catchment. A split that balanced the loads would
    produce two runs covering the same streets.

    Time is the second cut and on the long routes it is the one that fires. A
    manifest that fits the seats can still be four hours on the road if its
    stops are spread across the city, which is exactly what happened before this
    existed — the seat cap alone let a sixty-rider run sprawl over ninety
    kilometres because sixty children is sixty children however far apart they
    live.
    """
    cap = max(1, int(seats * LOAD_FACTOR))
    runs = []
    current = []
    load = 0
    for stop in ordered:
        size = len(stop["riders"])
        over_seats = current and load + size > cap
        # Priced against the schools this manifest actually delivers to, not
        # every school in the cluster. Charging the whole cluster's delivery leg
        # against a two-stop partial manifest spent the entire time budget
        # before a single child was aboard, and cut every run down to four.
        proposed = current + [stop]
        over_time = (current
                     and run_minutes(proposed, schools_for(proposed)) > limit)
        if over_seats or over_time:
            runs.append(current)
            current, load = [], 0
        current.append(stop)
        load += size
    if current:
        runs.append(current)
    return runs


def school_clusters(ids, schools):
    """Partition an operator's schools into groups a single run may serve.

    Greedy: take the school with the most neighbours inside the radius, cap the
    group, repeat. The groups are what riders are bucketed by, so a run's
    destinations are a few neighbouring buildings rather than every school the
    operator has a contract with.
    """
    remaining = sorted(ids)
    groups = []
    while remaining:
        best, members = None, None
        for candidate in remaining:
            at = (schools[candidate]["lat"], schools[candidate]["lon"])
            near = sorted(
                (other for other in remaining
                 if km(at, (schools[other]["lat"], schools[other]["lon"]))
                 <= SCHOOL_CLUSTER_KM),
                key=lambda o: km(at, (schools[o]["lat"], schools[o]["lon"])))
            near = near[:MAX_SCHOOLS_PER_RUN]
            if members is None or len(near) > len(members):
                best, members = candidate, near
        groups.append(sorted(members))
        for member in members:
            remaining.remove(member)
    return groups


def run_minutes(stops, schools_at):
    """Roughly how long a run takes, door of the first stop to the last bell."""
    points = [tuple(s["at"]) for s in stops] + list(schools_at)
    travel = sum(km(points[i], points[i + 1]) for i in range(len(points) - 1))
    return (travel / BUS_SPEED_KMH * 60
            + len(stops) * BUS_DWELL_MIN
            + len(schools_at) * SCHOOL_DWELL_MIN) * ESTIMATE_CALIBRATION


def operator_for(sector):
    for operator in OPERATORS:
        if sector in operator["sectors"]:
            return operator
    return None


def fingerprint(band, direction, stops, schools):
    """A run's identity, from what it actually does rather than where it sits.

    Keyed on the manifest and not on the run id, and the difference is a bug
    that already bit. Ids carry a positional index — `...-elem-am-3` — so when a
    change to the splitting produces a different set of runs, id 3 still exists
    and still resolves, but it is a *different* run. Stale measurements were
    therefore not missed, which would have been safe; they were silently applied
    to routes they were never taken from.

    A fingerprint cannot do that. Change what a run picks up, where it goes, or
    in what order, and it no longer matches anything measured — so the estimate
    is used and the report says so.
    """
    body = "|".join([
        band, direction,
        ";".join(f"{s['lat']:.5f},{s['lon']:.5f}:"
                 + ",".join(str(p) for p in s["riders"]) for s in stops),
        ";".join(schools),
    ])
    return hashlib.blake2b(body.encode(), digest_size=8).hexdigest()


def measured_spans():
    """{fingerprint: measurement} from the last simulation measurement, or empty."""
    if not MEASURED.exists():
        return {}
    data = json.loads(MEASURED.read_text())
    return {row["fingerprint"]: row
            for row in data.get("runs", {}).values()
            if "fingerprint" in row}


def build_runs(bused, coords, schools):
    """Every bus run in the city: the manifests, in order, unpriced.

    Grouped by (operator, band, direction) and *not* by school. That is the one
    decision in this function worth arguing, and the argument is that a run
    serves a neighbourhood rather than a building. A district bus collects along
    a corridor and delivers to whichever school of that band the corridor's
    children attend, which for public K-12 is nearly always one school — the
    catchments are geographic, so a geographically contiguous manifest is a
    single-school manifest almost by construction.

    Where it stops being one school is exactly where it should. Charter and
    private schools draw citywide, so their riders are scattered thin; grouped
    per school they produce dozens of near-empty runs, which is what a first
    version of this did — 83 runs for a contractor with seven buses. Real
    contractors combine them, one bus collecting for three private schools
    along one route, and that is only expressible if a run may end at more than
    one building. It is also why the run carries an ordered `schools` list
    rather than a `school` field, and why the runtime routes it as a
    multi-waypoint path rather than a pair of points.

    Bands never mix, so the bell is unambiguous: `START_MIN` is keyed on band,
    every school of a band rings at the same minute, and a run that mixed bands
    would have no arrival time to be solved against.
    """
    # Which cluster of schools each operator's buildings fall into, so riders
    # are grouped by a handful of neighbouring destinations rather than by every
    # school their operator serves.
    by_operator = defaultdict(set)
    for row in bused.values():
        school = schools.get(row["school"])
        operator = operator_for(school["sector"]) if school else None
        if operator:
            by_operator[operator["id"]].add(row["school"])

    cluster_of = {}
    for operator_id, ids in by_operator.items():
        for index, group in enumerate(school_clusters(ids, schools)):
            for school_id in group:
                cluster_of[school_id] = (operator_id, index)

    by_run = defaultdict(list)
    for person, row in bused.items():
        cluster = cluster_of.get(row["school"])
        if cluster is None:
            continue
        for direction in ("am", "pm"):
            if row[direction] == "bus":
                by_run[(cluster, row["band"], direction)].append(person)

    school_of = {person: row["school"] for person, row in bused.items()}
    runs = []

    for ((operator_id, cluster), band, direction), riders in sorted(by_run.items()):
        # The far end of the operator's territory, which is where a collection
        # run starts and a delivery run finishes.
        points = [coords[p] for p in riders]
        centre = (sum(p[0] for p in points) / len(points),
                  sum(p[1] for p in points) / len(points))

        stops = order_stops(cluster_stops(riders, coords), centre)

        def schools_for(manifest):
            """Where a partial manifest would have to deliver to."""
            aboard = {school_of[p] for stop in manifest
                      for p in stop["riders"]}
            return [(schools[s]["lat"], schools[s]["lon"]) for s in sorted(aboard)]

        kind = next(o["kind"] for o in OPERATORS if o["id"] == operator_id)
        for index, manifest in enumerate(
                split_runs(stops, STANDARD_SEATS, schools_for,
                           MAX_RUN_MINUTES[kind])):
            aboard = [person for stop in manifest for person in stop["riders"]]
            served = order_schools(
                {school_of[p] for p in aboard}, schools, manifest[-1]["at"])
            at = [(schools[s]["lat"], schools[s]["lon"]) for s in served]
            run_id = f"run/{operator_id}-{cluster}-{band}-{direction}-{index}"
            stop_rows = [{"lat": s["at"][0], "lon": s["at"][1],
                          "riders": s["riders"]} for s in manifest]
            runs.append({
                "id": run_id,
                "operator": operator_id,
                "band": band,
                "direction": direction,
                # The minute the last school on the run must be reached (am) or
                # the minute the first one releases (pm). Everything else about
                # the run's timing is solved backwards from it by the runtime.
                "bell": START_MIN[band] if direction == "am"
                        else START_MIN[band] + LENGTH_MIN[band],
                "schools": served,
                "stops": stop_rows,
                "riders": len(aboard),
                # The estimate is what splits a manifest, because the split
                # happens before the manifest is final. The measurement is what
                # schedules it, and is resolved in `apply_measured` once the
                # fallback riders have been attached and the run is settled.
                "estimated_minutes": round(run_minutes(manifest, at)),
            })
    return runs


def order_schools(ids, schools, from_point):
    """The run's destinations, nearest first from where the last pickup was.

    Almost always a list of one. Where it is not — a contractor's combined run
    — the order is the order a driver would take them in, which matters because
    the children for the second school are still on the bus when it reaches the
    first.
    """
    remaining = sorted(ids)
    ordered = []
    here = from_point
    while remaining:
        nearest = min(remaining,
                      key=lambda s: km(here, (schools[s]["lat"], schools[s]["lon"])))
        remaining.remove(nearest)
        ordered.append(nearest)
        here = (schools[nearest]["lat"], schools[nearest]["lon"])
    return ordered


def apply_measured(runs, measured):
    """Give each settled run its duration: measured where we have it, else the estimate.

    After `attach_fallbacks`, not before. A run's fingerprint is taken from its
    final manifest, and the fallback riders are part of that — fingerprinting a
    run before they were seated would key a measurement to a route that carried
    fewer children than the one actually driven.
    """
    for run in runs:
        run["fingerprint"] = fingerprint(
            run["band"], run["direction"], run["stops"], run["schools"])
        row = measured.get(run["fingerprint"])
        run["timed"] = row is not None
        run["minutes"] = row["span"] if row else run["estimated_minutes"]
        # How long the bus is gone from the yard, which is what actually decides
        # whether it can take another run. Longer than the span at both ends —
        # the dead-head out to the first stop and back from the last school is
        # real time and real distance, and scheduling on the span alone let two
        # runs overlap by exactly those two trips.
        run["occupied"] = (row["ret"] - row["depart"] if row
                           else run["estimated_minutes"] + 2 * DEADHEAD_MIN)
        run["depot_out"] = row["depart"] if row else None


def attach_fallbacks(runs, riders, coords, schools):
    """Seat the lift riders who would fall back to a bus, where one passes them.

    A fallback is only real if the route exists. This walks each nominated
    lift rider against the runs that already serve their school and their band,
    and puts them on the nearest stop within the walk allowance that still has a
    seat. Where nothing passes them, the fallback is rewritten to a walk — which
    is the honest answer and is why the count of those is reported: a large one
    means a lot of children whose day quietly breaks when a parent picks up a
    shift.

    The seat check is against the bus's real capacity rather than the load
    factor, because absorbing these is precisely what the headroom was left for.
    """
    by_key = defaultdict(list)
    for run in runs:
        by_key[(run["band"], run["direction"])].append(run)

    attached = stranded = 0
    for rider in riders:
        home = coords.get(rider["person"])
        if home is None:
            continue
        for direction in ("am", "pm"):
            if rider[direction] != "lift":
                continue
            if rider[f"fallback_{direction}"] != "bus":
                continue

            best = None
            for run in by_key.get((rider["band"], direction), ()):
                if rider["school"] not in run["schools"]:
                    continue
                if run["riders"] >= STANDARD_SEATS:
                    continue
                for stop in run["stops"]:
                    walk = km(home, (stop["lat"], stop["lon"]))
                    if walk <= STOP_WALK_KM and (best is None or walk < best[0]):
                        best = (walk, run, stop)

            if best is None:
                rider[f"fallback_{direction}"] = "walk"
                stranded += 1
                continue

            _, run, stop = best
            stop["riders"] = sorted(stop["riders"] + [rider["person"]])
            run["riders"] += 1
            attached += 1

    return attached, stranded


def assign_fleet(runs, vehicles, fleet_data, employment):
    """Give every run a bus and a driver.

    A bus serves at most one run per band, which is what the staggered bells
    are for: high school first, then middle, then elementary, one vehicle
    covering all three. Morning and afternoon are the same vehicle and the same
    driver — a split shift, which is what a school bus driver actually works.

    Drivers come from the roster `init_work.py` recruited, which is sized on
    what these routes need — see SCHOOL_BUS_DRIVERS there, and the requirement
    this stage reports back. Reading the role rather than occupation 9121 is the
    point of the change: the 118 people the sample happened to code into that
    occupation were five surveyed households wearing 118 faces, and there were
    26 fewer of them than the afternoon has bus-shifts, so a sixth of the fleet
    left the yard undriven. Nobody is invented here either way — a recruit is an
    existing resident whose occupation was rewritten, the same rule that staffs
    the police and the ambulances.
    """
    fleet = defaultdict(list)
    registry = vehicles["vehicles"]
    for ref in fleet_data["vehicles"]:
        if ref["service_class"] != "school_bus":
            continue
        row = registry.get(ref["vin"])
        if row:
            fleet[ref["operator"]].append(row)
    for buses in fleet.values():
        buses.sort(key=lambda b: (-b["seats"], b["vin"]))

    pool = sorted(
        a["person"] for a in employment["assignments"]
        if a.get("role") == "school_bus_driver")

    # What each bus is already doing, as (start, end) minutes.
    #
    # Booking on (band, direction) alone is not enough and the first version
    # that did it produced drivers in two places at once. The bells are
    # staggered by 30 and 45 minutes and a run takes 40, so a bus cannot always
    # do the next tier however distinct the bands are — the stagger is designed
    # around routes shorter than the ones this city's geography produces. The
    # test has to be against the clock, not against the label.
    booked = defaultdict(list)
    assigned_driver = {}
    busy_in = {"am": set(), "pm": set()}
    shortfall = Counter()
    next_driver = 0
    by_id = {run["id"]: run for run in runs}

    def window(run):
        """When this run occupies its bus, yard to yard.

        Not first stop to last bell. A bus is unavailable from the moment it
        leaves the depot until it is back, and the two dead-head legs at the
        ends are long enough to matter — the yard sits at the centroid of the
        schools served, so it is a real drive from the edge of a catchment.
        Scheduling on the route proper was an earlier version and produced
        drivers who were four hours late by the end of the morning.
        """
        slack = max(0, run["occupied"] - run["minutes"]) / 2
        if run["direction"] == "am":
            return run["bell"] - run["minutes"] - slack, run["bell"] + slack
        return run["bell"] - slack, run["bell"] + run["minutes"] + slack

    def clashes(bus, run):
        start, end = window(run)
        return any(start < b + TURNAROUND_MIN and a - TURNAROUND_MIN < end
                   for a, b in booked[bus["vin"]])

    def place(run, bus):
        booked[bus["vin"]].append(window(run))
        # Drivers are assigned per bus *per half of the day*, not per bus.
        #
        # A driver is not attached to a vehicle, they are attached to a shift,
        # and the morning and the afternoon are separately staffed — which is
        # what a split shift is, and why the job is commonly worked as one half
        # by people who want part-time hours. Tying one driver to one bus for
        # the whole day needed a driver for every vehicle that turned a wheel
        # all day, 171 of them, against the 144 the routes really call for.
        # Staffed by shift those 144 cover both halves, because the peak that
        # matters is the peak of one direction and not the union of both.
        key = (bus["vin"], run["direction"])
        if key not in assigned_driver:
            nonlocal next_driver
            # Whoever drove this bus in the morning takes it out again if they
            # are free, so a driver keeps their vehicle where the roster allows.
            twin = assigned_driver.get(
                (bus["vin"], "am" if run["direction"] == "pm" else "pm"))
            if twin is not None and twin not in busy_in[run["direction"]]:
                assigned_driver[key] = twin
            elif next_driver < len(pool):
                assigned_driver[key] = pool[next_driver]
                next_driver += 1
            else:
                assigned_driver[key] = None
            if assigned_driver[key] is not None:
                busy_in[run["direction"]].add(assigned_driver[key])
        run["vin"] = bus["vin"]
        run["driver"] = assigned_driver[key]
        run["seats"] = bus["seats"]

    # Morning first and biggest first. A 60-rider manifest needs a type C or D
    # and there are few of them, so placing it after the small ones strands it.
    # The afternoon is not placed independently: it takes the vehicle its
    # morning twin already has, because the same driver takes the same bus out
    # again after the middle of the day. Where an afternoon run has no morning
    # twin — the manifests differ, so it happens — it is placed on its own.
    morning = sorted((r for r in runs if r["direction"] == "am"),
                     key=lambda r: -r["riders"])
    afternoon = sorted((r for r in runs if r["direction"] == "pm"),
                       key=lambda r: -r["riders"])

    for run in morning + afternoon:
        if run.get("vin"):
            continue
        twin = by_id.get(run["id"].replace("-pm-", "-am-"))
        twin_bus = (next((b for b in fleet[run["operator"]]
                          if b["vin"] == twin["vin"]), None)
                    if run["direction"] == "pm" and twin and twin.get("vin")
                    else None)
        if (twin_bus and twin_bus["seats"] >= run["riders"]
                and not clashes(twin_bus, run)):
            place(run, twin_bus)
            continue

        chosen = next(
            (bus for bus in fleet.get(run["operator"], [])
             if not clashes(bus, run) and bus["seats"] >= run["riders"]),
            None)
        if chosen is None:
            shortfall[run["operator"]] += 1
            run["vin"] = None
            run["driver"] = None
            run["seats"] = None
            continue
        place(run, chosen)

    # How many drivers the routes actually need, which is what sizes the
    # establishment `init_work.py` recruits. A driver can take one shift in each
    # direction and the two never overlap, so the requirement is the busier
    # half of the day and not the two added together.
    shifts = {direction: len({vin for vin, way in assigned_driver
                              if way == direction})
              for direction in ("am", "pm")}
    return (shortfall, len({vin for vin, _ in assigned_driver}), len(pool),
            shifts)


def build(enrollment, population, schools, coords, employment, vehicles, fleet_data,
          kinship, seed):
    """Mode for every student, both directions, plus the runs that follow."""
    schools_by_id = {s["id"]: s for s in schools}
    people = {p["id"]: p for p in population["person_records"]}
    dwelling_of = {h["id"]: h["dwelling"] for h in population["household_records"]}
    adults = household_adults(population)
    owners, _ = drivers_and_owners(vehicles)

    assignments = {a["person"]: a for a in employment["assignments"]}
    windows = {}
    for household in adults.values():
        for adult in household:
            windows[adult["id"]] = work_window(adult, assignments.get(adult["id"]))

    parents = {int(child): {k["id"] for k in kin}
               for child, kin in kinship["parents"].items()}

    riders = []
    home_of = {}
    tally = Counter()

    for row in enrollment["assignments"]:
        person = row["person"]
        if row["mode"] != "enrolled":
            tally["external"] += 1
            continue

        band = row["band"]
        school = schools_by_id.get(row["school"])
        record = people.get(person)
        if school is None or record is None:
            continue
        dwelling = dwelling_of.get(record["household"])
        home = coords.get(dwelling) if dwelling else None
        if home is None:
            # A dormitory resident with no household, or an unplaced address.
            # Their trip is a walk across a campus and needs no mode.
            tally["unplaced"] += 1
            continue

        at = (school["lat"], school["lon"])
        distance = km(home, at)
        in_walk_zone = distance <= WALK_ZONE_KM.get(band, 0)

        rng = keyed(seed, person, "school_travel")
        am_escort, pm_escort = escorts_for(
            person, band, adults.get(record["household"], []),
            owners, windows, parents, rng)

        own_car = (person in owners and record["age"] >= DRIVING_AGE
                   and not record.get("incarcerated"))

        am_modes = eligible_modes(distance, band, row["sector"],
                                  am_escort is not None, own_car, in_walk_zone)
        pm_modes = eligible_modes(distance, band, row["sector"],
                                  pm_escort is not None, own_car, in_walk_zone)
        am = pick_mode(am_modes, band, row["sector"], rng, "am")
        pm = pick_mode(pm_modes, band, row["sector"], rng, "pm")

        riders.append({
            "person": person,
            "band": band,
            "school": row["school"],
            "sector": row["sector"],
            "km": round(distance, 3),
            "am": am,
            "pm": pm,
            "escort_am": am_escort if am == "lift" else None,
            "escort_pm": pm_escort if pm == "lift" else None,
            "fallback_am": fallback_mode(am_modes - {"lift"}) if am == "lift" else None,
            "fallback_pm": fallback_mode(pm_modes - {"lift"}) if pm == "lift" else None,
        })
        home_of[person] = home
        tally[f"am_{am}"] += 1
        tally[f"pm_{pm}"] += 1
        tally[f"band_{band}"] += 1

    # Routes are built from the students who actually ride, and only then are
    # the fallback riders attached to them.
    #
    # Building from everyone who *could* board was the first version and it was
    # wrong in a way that only showed up on the contractor's side. Every student
    # with a lift carries `bus` as their fallback, so the manifests were sized on
    # the whole cohort: 420 real private-school riders became 1,154, scattered
    # across the city, and the routes to collect them came out at four children
    # a bus. A child whose parent turns out to be working does not summon a bus
    # route to their door — they can only take one that already passes them,
    # which is what `attach_fallbacks` tests and what the seat headroom is for.
    bused = {
        rider["person"]: {"school": rider["school"], "band": rider["band"],
                          "am": rider["am"], "pm": rider["pm"]}
        for rider in riders
        if rider["am"] == "bus" or rider["pm"] == "bus"
    }

    runs = build_runs(bused, home_of, schools_by_id)
    attached, stranded = attach_fallbacks(runs, riders, home_of, schools_by_id)
    apply_measured(runs, measured_spans())
    tally["fallback_seated"] = attached
    tally["fallback_walks"] = stranded
    shortfall, buses_used, driver_pool, shifts = assign_fleet(
        runs, vehicles, fleet_data, employment)

    return (riders, runs, tally, shortfall, buses_used, driver_pool, shifts,
            schools_by_id)


def report(riders, runs, tally, shortfall, buses_used, driver_pool, shifts):
    total = len(riders)
    print(f"\n{total:,} students routed, "
          f"{tally['external']:,} external, {tally['unplaced']:,} unplaced")

    modes = ("lift", "bus", "walk", "transit", "self")
    print("\nmode share")
    print("  " + " " * 10 + "".join(f"{mode:>10}" for mode in modes))
    for direction, label in (("am", "morning"), ("pm", "afternoon")):
        print(f"  {label:<10}" + "".join(
            f"{100 * tally[f'{direction}_{mode}'] / max(1, total):>9.0f}%"
            for mode in modes))

    # The bus share lands well below the national 33% and this is the reason,
    # so it is printed next to it rather than left for somebody to rediscover.
    # Kierston is dense and has 55 schools; most children live within the
    # statutory walk zone of theirs and no district runs a bus to them. The
    # national figure is set by rural districts where almost nobody does.
    k12 = [r for r in riders if r["band"] in BUSED_BANDS]
    inside = sum(1 for r in k12 if r["km"] <= WALK_ZONE_KM[r["band"]])
    print(f"\n{inside:,} of {len(k12):,} K-12 students ({100 * inside / max(1, len(k12)):.0f}%) "
          f"live inside the walk zone (no bus service)")

    print("\nby band")
    for band in ("prek", "elem", "middle", "high", "college"):
        cohort = [r for r in riders if r["band"] == band]
        if not cohort:
            continue
        split = Counter(r["am"] for r in cohort)
        trips = sorted(r["km"] for r in cohort)
        print(f"  {band:<8} {len(cohort):>6,}  "
              + "  ".join(f"{m} {100 * split[m] / len(cohort):>2.0f}%"
                          for m in modes)
              + f"   median {trips[len(trips) // 2]:.1f} km")

    placed = [r for r in runs if r["vin"]]
    print(f"\n{len(runs):,} bus runs, {len(placed):,} with a vehicle, "
          f"{buses_used} buses in service, {driver_pool} drivers available")

    # What the establishment has to be, and whether it is. A driver takes at
    # most one shift in each direction and the two halves never overlap, so the
    # requirement is the busier half — not the sum, and not a count of runs.
    #
    # This is the number `init_work.py` recruits against and the reason it is
    # printed rather than merely checked: that stage runs long before these
    # manifests exist, so SCHOOL_BUS_DRIVERS is a declared constant, and this is
    # where it gets re-derived and where a stale one shows up. The same loop
    # fleet.py's ratios close.
    required = max(shifts.values())
    print(f"  drivers required by the routes: {required} "
          f"({shifts['am']} morning shifts, {shifts['pm']} afternoon), "
          f"{driver_pool} on the roster")

    undriven = [r for r in runs if r["vin"] and r["driver"] is None]
    if undriven:
        vins = len({(r["vin"], r["direction"]) for r in undriven})
        print(f"  \033[33m{vins} shifts have no driver ({len(undriven)} runs) — "
              f"raise SCHOOL_BUS_DRIVERS in init_work.py to {required} and "
              f"rebuild from `work`\033[0m")
    elif driver_pool > required:
        print(f"  {driver_pool - required} rostered drivers without a run "
              f"(relief pool)")

    # Which durations the schedule was built on. An all-estimated run is a
    # schedule built on a guess and should be re-measured; the drift says how
    # wrong the guess was where both numbers exist.
    timed = [r for r in runs if r["timed"]]
    if timed:
        drift = sum(r["minutes"] - r["estimated_minutes"] for r in timed) / len(timed)
        print(f"  {len(timed):,} of {len(runs):,} runs scheduled on measured "
              f"durations, {drift:+.1f} min against the estimate")
    else:
        print("  \033[33mall runs scheduled on the straight-line estimate — run "
              "`bun run day --measure-runs` and re-run this stage\033[0m")

    # What the routes actually need, which is the number fleet.py asked this
    # stage to produce in place of its per-1,000 heuristic.
    #
    # The peak of the clock, not a count of slots. Counting runs per (band,
    # direction) assumes a bus can always take the next tier's run, and it
    # cannot: the bells are 30 and 45 minutes apart and a run here averages
    # nearly forty, so the tiers overlap and the vehicles have to be counted
    # against time. The number below is the most buses simultaneously out.
    print("\nfleet required by the routes")
    for operator in OPERATORS:
        mine = [r for r in runs if r["operator"] == operator["id"]]
        if not mine:
            continue
        edges = []
        for run in mine:
            slack = max(0, run["occupied"] - run["minutes"]) / 2
            if run["direction"] == "am":
                start, end = run["bell"] - run["minutes"] - slack, run["bell"] + slack
            else:
                start, end = run["bell"] - slack, run["bell"] + run["minutes"] + slack
            edges.append((start - TURNAROUND_MIN, 1))
            edges.append((end + TURNAROUND_MIN, -1))
        edges.sort()
        out = needed = 0
        for _, delta in edges:
            out += delta
            needed = max(needed, out)
        have = len({r["vin"] for r in mine if r["vin"]})
        short = shortfall.get(operator["id"], 0)
        flag = "  \033[33m← short\033[0m" if short else ""
        print(f"  {operator['name']:<38} needs {needed:>3}  "
              f"has {have:>3} in service  {short:>3} runs unplaced{flag}")

    for direction in ("am", "pm"):
        mine = [r for r in runs if r["direction"] == direction]
        if not mine:
            continue
        loads = sorted(r["riders"] for r in mine)
        stops = sum(len(r["stops"]) for r in mine)
        print(f"  {direction}: {len(mine):>3} runs  {stops:>5,} stops  "
              f"median load {loads[len(loads) // 2]}  largest {loads[-1]}")

    seated = [r for r in placed if r["riders"] > r["seats"]]
    if seated:
        print(f"  \033[33m{len(seated)} runs are over the seats of the bus "
              f"assigned to them\033[0m")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="mode and route seed; recorded in the output")
    args = parser.parse_args()

    enrollment = json.loads(ENROLLMENT.read_text())
    population = json.loads(POPULATION.read_text())
    schools = json.loads(SCHOOLS.read_text())["school_records"]
    employment = json.loads(EMPLOYMENT.read_text())
    vehicles = json.loads(VEHICLES.read_text())
    fleet_data = json.loads(FLEET.read_text())
    kinship = json.loads(KINSHIP.read_text())
    coords = homes()

    (riders, runs, tally, shortfall, buses_used, driver_pool, shifts,
     schools_by_id) = build(
        enrollment, population, schools, coords, employment, vehicles, fleet_data,
        kinship, args.seed)

    riders.sort(key=lambda r: r["person"])
    OUTPUT.write_text(json.dumps({
        "source": ENROLLMENT.name,
        "seed": args.seed,
        "students": len(riders),
        "start_times": START_MIN,
        "day_length": LENGTH_MIN,
        "runs": runs,
        "riders": riders,
    }, separators=(",", ":")))

    report(riders, runs, tally, shortfall, buses_used, driver_pool, shifts)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
