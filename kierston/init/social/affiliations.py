"""Assign every person to organizations, and to a unit within each.

One row per person per org. The rows come from four places and only one of them
involves a decision:

    work     read from employment.json. assign_work already chose the site.
    school   read from enrollment.json. assign_school already chose the school.
    union    drawn per person from the density of their INDP sector.
    joined   drawn here — congregation, club, gym, lodge, community centre.

Why a unit
----------
Membership on its own does not produce an acquaintance. A parish of eight
hundred is eight hundred strangers, and a graph built by joining everyone who
shares an org to everyone else would give this city a clustering coefficient
nothing like a real one and a handful of 800-cliques where the churches are.
Every row therefore carries a unit: the cohort inside the org that actually
sees each other — a section of a grade, a team, a shift, a small group. Units
are sized so that a within-unit pass is a sensible default edge rule and a
within-org, cross-unit pass is a weak one.

A unit is a partition, not a schedule. What night it meets does not change who
is in it, and the graph does not need to know.

Where the cut falls at work
---------------------------
A thousand-person warehouse cut into eighty-three arbitrary twelves is the same
mistake as the eight-hundred-person parish, one order of magnitude down: the
groups are the right size and the wrong people. So the cut follows the two
things that decide who a worker actually stands next to.

    shift        from the surveyed departure time. Two people on the same site
                 and opposite shifts pass each other at handover and nowhere
                 else, and no amount of shared employer changes that.
    occupation   the OCCP major group. Pickers work with pickers. The cut runs
                 through the shift, so a unit is contiguous in occupation and
                 splits only where a family runs longer than one unit.

Emergency roles already carry the partition in employment.json and it is finer
than anything derivable: police get platoon and duty, medics get the ambulance
crew. A crew is two people for twelve hours and is its own unit, sized 3, not a
slice of a station roster.

Nobody sits in exactly one box
------------------------------
A partition alone leaves a big site as a set of islands with nothing crossing
between them, which is wrong in a way that matters — it is the second unit that
carries anything across a building. So a share of members hold a second unit in
the same org, and leaders hold up to three. They are drawn within the same
shift first, because that is who you can actually overlap with.

Why households, not people, join things
---------------------------------------
For worship and for the youth clubs the household is the unit of decision, and
modelling it per person would be the difference between a city where families
attend together and one where they scatter. The household draws once, picks one
org, and its members follow at their own rates; the people who go somewhere
their household does not are drawn separately, at STRAY, because that case is
real and is exactly where an interesting edge comes from.

Gyms, clubs and lodges are drawn per person. Nobody joins a gym as a family.

Calibration
-----------
Rates are national or PA figures graded by age, sex, ethnicity and household
income, and the achieved marginals are printed every run against the targets
they were set from. Two known simplifications: attendance is treated as
membership, which overstates the loose end of congregation rolls, and a person
may join at most one org per class, which understates the handful of people who
belong to three clubs.
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

from personal_records import registries
from social import orgs as catalogue


from paths import DWELLINGS, PUMS_CODEBOOK as CODEBOOK, SIM_DATA  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
POPULATION = SIM_DATA / "population.json"
ORGS = SIM_DATA / "orgs.json"
EMPLOYMENT = SIM_DATA / "employment.json"
ENROLLMENT = SIM_DATA / "enrollment.json"
AFFILIATIONS = SIM_DATA / "affiliations.json"

DEFAULT_SEED = 20260730
YEAR = registries.REFERENCE_YEAR

# Target membership rate per class, and the population it is a rate *over*.
# Sources, in order: ~33% of US adults attend religious services monthly or
# more; 21% of working-age adults hold a gym membership; ~35% of children 6-17
# play organised sport in a given year; fraternal and veterans' orders are
# ~2.5% of the over-45s and falling; ~8% of adults belong to a civic, arts or
# neighbourhood organisation; ~9% of children are in an after-school club; PA
# union density is 12.3% of wage and salary workers.
#
# The rate is over the reference population and not over whoever the grading
# below happens to touch, which is the distinction that makes these numbers
# checkable: `calibrate` rescales each class so the achieved rate over exactly
# this population is the target, and `report` prints the same pair back.
TARGET = {"worship": 0.33, "gym": 0.21, "sports": 0.35, "fraternal": 0.025,
          "civic": 0.08, "youth": 0.09, "union": 0.123}

REFERENCE = {
    "worship": lambda p: p["age"] >= 18,
    "gym": lambda p: 18 <= p["age"] <= 64,
    "sports": lambda p: 6 <= p["age"] <= 17,
    "fraternal": lambda p: p["age"] >= 45,
    "civic": lambda p: p["age"] >= 21,
    "youth": lambda p: 5 <= p["age"] <= 17,
    "union": lambda p: (p["employment"] in (1, 2) and p["industry"]
                        and p["worker_class"] in WAGE_CLASSES),
}

# The classes drawn here rather than read from an earlier stage.
BASE = {"worship", "gym", "sports", "fraternal", "civic", "youth"}

# The age band each class applies to. Outside it the rate is zero, which is the
# honest model for the ones with a hard edge — a youth club has no forty-year-
# old members — and close enough for the rest.
AGES = {"worship": (18, 120), "gym": (14, 90), "sports": (6, 75),
        "fraternal": (35, 100), "civic": (21, 100), "youth": (5, 18)}

# Age grading, as a multiplier on the base rate by band. Religious attendance
# rises monotonically with age and is the strongest of these; gym membership
# does the reverse; organised sport is overwhelmingly a childhood activity and
# the adult rec-league tail is thin.
AGE_FACTOR = {
    "worship": ((29, 0.68), (49, 0.90), (64, 1.15), (120, 1.36)),
    "gym": ((29, 1.30), (49, 1.15), (64, 0.75), (120, 0.35)),
    "sports": ((17, 1.00), (34, 0.22), (49, 0.16), (120, 0.07)),
    "fraternal": ((44, 0.35), (64, 1.00), (120, 1.70)),
    "civic": ((34, 0.70), (54, 1.00), (120, 1.45)),
    "youth": ((12, 1.20), (18, 0.75), (120, 0.0)),
}

# Ethnicity grading. Only worship carries a strong one — Black and Hispanic
# attendance both run well above the national average and it is a majority of
# this city — and the rest are near enough flat to leave alone.
ETHNICITY_FACTOR = {
    "worship": {"nh_black": 1.25, "hispanic": 1.08, "nh_white": 0.92,
                "nh_asian": 0.75, "nh_two_or_more": 0.90, "nh_other": 0.90},
    "civic": {"nh_white": 1.20, "nh_black": 1.05, "hispanic": 0.80,
              "nh_asian": 0.85},
}

# Sex grading, indexed by PUMS SEX (1 male, 2 female). The lodges are the
# extreme case and mostly by constitution; women attend worship more than men
# by a consistent eight points.
SEX_FACTOR = {"fraternal": {1: 2.6, 2: 0.4}, "worship": {1: 0.86, 2: 1.13},
              "sports": {1: 1.20, 2: 0.82}, "gym": {1: 1.0, 2: 1.0}}

# Household income quartile grading. A gym membership is a discretionary
# monthly cost and the gradient is steep; club sport carries fees too. Worship
# is famously flat across income and is left alone.
INCOME_FACTOR = {"gym": (0.50, 0.85, 1.15, 1.50),
                 "sports": (0.62, 0.90, 1.15, 1.35),
                 "civic": (0.65, 0.90, 1.15, 1.30)}

# Household income quartile cuts, from the generated population.
INCOME_CUTS = (24900, 47406, 78824)

# Classes the household decides for. Everything else is drawn per person.
HOUSEHOLD_CLASSES = {"worship", "youth"}

# Once a household has picked a congregation, the youngest age that follows it
# and how often a child under 18 does. Higher than any adult rate — children go
# where they are taken — and applied only where the adults did the deciding. A
# youth club is decided by the children themselves, so it is not here and their
# own rate governs.
CHILD_FOLLOW = {"worship": (4, 0.82)}

# The share of an individual's own rate that still applies when their household
# has not affiliated. These are the people who go somewhere alone, and they are
# worth having precisely because their tie does not overlap their family's.
STRAY = 0.18

# Distance decay for choosing between orgs of a class, in km. A congregation is
# chosen from further away than a gym is — people pass three churches to reach
# their own — and the lodges draw from the whole city.
SCALE_KM = {"worship": 2.4, "gym": 2.6, "sports": 2.0, "fraternal": 3.6,
            "civic": 3.0, "youth": 1.8}

# How many orgs of a class are scored per decision. Sampling of alternatives:
# the choice within the sample is unbiased for the choice within the whole, and
# the classes with hundreds of venues stop costing more than the ones with ten.
CANDIDATES = 40

# Target unit size by class — the cohort inside an org that actually knows each
# other. A grade section, a team, a shift, a small group. These are the numbers
# the eventual graph's degree distribution rests on, so they are set to real
# group sizes rather than to anything convenient.
UNIT_SIZE = {"work": 12, "school": 22, "worship": 25, "sports": 14, "gym": 20,
             "fraternal": 18, "civic": 15, "youth": 16, "union": 25}
DEFAULT_UNIT_SIZE = 18

# Shift bands, cut from the surveyed departure minute (JWDP). The bounds are
# where the three humps in the departure histogram actually fall rather than
# where a rota would put them: the morning mass runs 04:00-11:00, the swing
# shift leaves early afternoon, and everything after six in the evening is
# working nights. A person with no departure time is drawn into their own
# site's observed mix.
SHIFTS = (("day", 4 * 60, 11 * 60), ("evening", 11 * 60, 18 * 60))
NIGHT = "night"
CITY_SHIFT_MIX = {"day": 0.68, "evening": 0.19, "night": 0.13}

# Roles whose partition employment.json already carries, and the unit size that
# partition implies. An ambulance crew is two people and a squad is four; these
# are the tightest units in the city and they are meant to be.
CREW_SIZE = {"paramedic": 3, "emt": 3, "police_officer": 5}

# The share of members who also sit in a second unit of the same org — moved
# department last year, covers another line, sits on two committees. Without
# them a large org is a set of islands and nothing crosses the building. A
# leader gets one to three, which is what being a leader means here.
SECOND_UNIT = {"work": 0.15, "school": 0.12, "worship": 0.10, "sports": 0.08,
               "civic": 0.08, "fraternal": 0.08, "youth": 0.06, "union": 0.05,
               "gym": 0.02}
DEFAULT_SECOND_UNIT = 0.06
LEADER_UNITS = (1, 3)

# How often a second unit is drawn from inside the member's own shift or grade
# rather than anywhere in the org. Mostly, but not always: the handover overlap
# is real and is how a night shift knows anyone on days at all.
SECOND_WITHIN_KEY = 0.75

# The share of members who hold some office — deacon, coach, steward, shop
# lead. Not modelled in detail; it exists so the graph can weight a person who
# knows everyone in the org above one who knows their own unit.
LEADERS = {"worship": 0.05, "sports": 0.09, "fraternal": 0.12, "civic": 0.10,
           "youth": 0.08, "gym": 0.0, "union": 0.03, "work": 0.08,
           "school": 0.0}

# Mean tenure in years by class, as the mean of a geometric draw. Bounded below
# by the age a person could have joined at and above by the org existing.
TENURE = {"worship": 11.0, "gym": 2.5, "sports": 3.0, "fraternal": 14.0,
          "civic": 6.0, "youth": 2.5, "union": 7.0, "work": 5.0, "school": 2.5}

# COW values that are wage and salary work. The self-employed, unpaid family
# workers and the never-employed do not carry a union card.
WAGE_CLASSES = {"1", "2", "3", "4", "5"}


def km(a, b):
    """Equirectangular distance in km — good to a metre at this latitude, and
    the only distance in this stage, called several million times."""
    x = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    y = math.radians(b[0] - a[0])
    return 6371.0 * math.hypot(x, y)


def quartile(income):
    """Household income quartile, 0-3."""
    for index, cut in enumerate(INCOME_CUTS):
        if income < cut:
            return index
    return 3


def band(table, age):
    """The factor whose upper bound this age falls under."""
    for top, factor in table:
        if age <= top:
            return factor
    return table[-1][1]


def grading(person, org_class, income_quartile):
    """The product of every factor that grades this class, ungraded by scale.

    Zero outside the class's age band, which is the honest model for the ones
    with a hard edge — a youth club has no forty-year-old members — and close
    enough for the rest.
    """
    low, high = AGES[org_class]
    age = person["age"]
    if not low <= age <= high:
        return 0.0
    value = band(AGE_FACTOR[org_class], age)
    value *= ETHNICITY_FACTOR.get(org_class, {}).get(
        person["race_ethnicity"], 1.0)
    value *= SEX_FACTOR.get(org_class, {}).get(person["sex"], 1.0)
    if org_class in INCOME_FACTOR:
        value *= INCOME_FACTOR[org_class][income_quartile]
    return value


def calibrate(people):
    """The scale that makes each class hit its target over its own reference.

    Without this, TARGET is only a target for whoever happens to sit at the
    middle of the grading. The gym factors run 1.30 down to 0.35 across the age
    bands and none of them is 1.0 for the median member, so a base rate of 0.21
    produces something else entirely; the achieved figure was 21.5% over one
    population and would have been 26% over the one the number came from. The
    factors decide who joins relative to whom, and this decides how many.
    """
    scales = {}
    for org_class in sorted(BASE):
        reference = [p for p in people.values() if REFERENCE[org_class](p)]
        weight = sum(grading(p, org_class, quartile(p["_income"]))
                     for p in reference)
        scales[org_class] = (TARGET[org_class] * len(reference) / weight
                             if weight else 0.0)
    return scales


def rate(person, org_class, income_quartile, scales):
    """A person's propensity to belong to a class of org, or zero."""
    return min(scales[org_class]
               * grading(person, org_class, income_quartile), 0.95)


def affinity(org, ethnicity):
    """How much more likely this ethnicity is to pick this particular org.

    Only worship has one. A denomination is not a neutral label — it is the
    strongest single predictor of which of 112 doors a person walks through,
    and a draw that ignored it would put the same mix in the Spanish-language
    Pentecostal church as in the Moravian one.
    """
    if org["class"] != "worship":
        return 1.0
    return catalogue.DENOMINATION_AFFINITY.get(
        org["subclass"], {}).get(ethnicity, 1.0)


def choose(pool, home, ethnicity, org_class, rng):
    """Pick one org by pull, ethnic affinity and distance decay."""
    sample = pool if len(pool) <= CANDIDATES else rng.sample(pool, CANDIDATES)
    scale = SCALE_KM[org_class]
    weights = [org["pull"] * affinity(org, ethnicity)
               * math.exp(-km(home, (org["lat"], org["lon"])) / scale)
               for org in sample]
    total = sum(weights)
    if total <= 0:
        return rng.choice(sample)
    return rng.choices(sample, weights=weights, k=1)[0]


def tenure(org_class, age, rng):
    """The year a membership started."""
    mean = TENURE[org_class]
    years = min(int(rng.expovariate(1 / mean)), max(0, age - 5), 45)
    return YEAR - years


def row(person, org, org_class, rng, unit_key=None, subkey=None, target=None):
    leader = rng.random() < LEADERS.get(org_class, 0.0)
    return {
        "person": person["id"],
        "org": org,
        "class": org_class,
        "unit_key": unit_key,
        "role": "leader" if leader else "member",
        "since": tenure(org_class, person["age"], rng),
        "_household": person["_household"],
        "_subkey": subkey,
        "_target": target,
    }


def shift_of(depart):
    """The shift band a departure minute falls in, or None if unstated."""
    if depart is None:
        return None
    minute = depart % (24 * 60)
    for name, start, end in SHIFTS:
        if start <= minute < end:
            return name
    return NIGHT


def from_work(people, org_ids, rng):
    """Affiliations that assign_work already decided.

    The unit key is the shift and the subkey the occupation major group, so a
    unit is a run of one occupation inside one shift. Emergency roles override
    both with the partition they already carry — platoon and duty for police,
    the ambulance crew for medics — and carry a unit size to match.
    """
    families = occupations()
    rows, pending = [], []
    mix = defaultdict(Counter)
    for assignment in json.loads(EMPLOYMENT.read_text())["assignments"]:
        site = assignment.get("site")
        person = people.get(assignment["person"])
        if not person or not site or assignment.get("mode") not in (
                "sited", "itinerant"):
            continue
        org = f"w:{site}"
        if org not in org_ids:
            continue

        role = assignment.get("role")
        if role in CREW_SIZE:
            # The roster is the authority here and there is nothing to infer.
            key = "/".join(str(assignment.get(f) or "")
                           for f in ("platoon", "duty"))
            rows.append(row(person, org, "work", rng, unit_key=key,
                            subkey=assignment.get("crew"),
                            target=CREW_SIZE[role]))
            continue

        band = shift_of(person.get("depart"))
        family = families.get(person.get("occupation") or "", "?")
        if band is None:
            pending.append((person, org, family))
            continue
        mix[org][band] += 1
        rows.append(row(person, org, "work", rng, unit_key=band, subkey=family))

    # A missing departure time is a gap in the survey row, not a person who
    # works no hours. Draw them into their own site's observed mix so they land
    # where that site's colleagues actually are, and fall back to the city's.
    for person, org, family in pending:
        weights = mix.get(org) or CITY_SHIFT_MIX
        bands = list(weights)
        band = rng.choices(bands, weights=[weights[b] for b in bands], k=1)[0]
        rows.append(row(person, org, "work", rng, unit_key=band, subkey=family))
    return rows


def from_school(people, org_ids, rng):
    """Affiliations that assign_school already decided.

    The unit key is the grade. A high school is not one cohort of 1,800; a
    tenth-grader knows their own year and almost nobody in the year below.
    """
    rows = []
    for assignment in json.loads(ENROLLMENT.read_text())["assignments"]:
        school = assignment.get("school")
        person = people.get(assignment["person"])
        if not person or not school or school == "external":
            continue
        org = f"s:{school}"
        if org not in org_ids:
            continue
        rows.append(row(person, org, "school", rng,
                        unit_key=assignment.get("grade") or assignment["band"]))
    return rows


def from_union(people, org_ids, sector_of, work_site, rng):
    """A card drawn from the density of the member's sector.

    The unit is the workplace, not the local. Members of one local are spread
    across every employer in the sector and mostly never meet; the people who
    do are the ones on the same floor.
    """
    rows = []
    for person in people.values():
        if person["employment"] not in (1, 2) or not person["industry"]:
            continue
        if person["worker_class"] not in WAGE_CLASSES:
            continue
        sector = sector_of.get(person["industry"], "?")
        org = f"u:{sector}"
        if org not in org_ids:
            continue
        if rng.random() >= catalogue.UNION_DENSITY.get(
                sector, catalogue.DEFAULT_UNION_DENSITY):
            continue
        rows.append(row(person, org, "union", rng,
                        unit_key=work_site.get(person["id"])))
    return rows


def from_households(members, pools, homes, scales, rng):
    """The classes a household decides once, for everyone under its roof."""
    rows = []
    for class_name in sorted(HOUSEHOLD_CLASSES):
        pool = pools.get(class_name)
        if not pool:
            continue
        follow_age, follow_rate = CHILD_FOLLOW.get(class_name, (99, 0.0))
        for household, people in members.items():
            home = homes.get(household)
            if not home:
                continue
            quart = quartile(people[0]["_income"])
            rates = {p["id"]: rate(p, class_name, quart, scales) for p in people}

            # Who in this household the decision belongs to. Adults, where any
            # of them could join at all; otherwise the eligible members
            # themselves, which is what makes a children's club work — its
            # members are all under 18 and taking the mean over the adults
            # would give every household a rate of zero.
            adults = [p for p in people if p["age"] >= 18 and rates[p["id"]] > 0]
            deciders = adults or [p for p in people if rates[p["id"]] > 0]
            if not deciders:
                continue
            by_adults = bool(adults)
            household_rate = sum(rates[p["id"]] for p in deciders) / len(deciders)

            if rng.random() < household_rate:
                # One org for the household, chosen on the modal ethnicity of
                # whoever decided — a mixed household still walks through one
                # door together.
                ethnicity = Counter(
                    p["race_ethnicity"] for p in deciders).most_common(1)[0][0]
                org = choose(pool, home, ethnicity, class_name, rng)
                for person in people:
                    if by_adults and person["age"] < 18:
                        # Children follow on the household's decision, not on
                        # a rate of their own; the age band above is about who
                        # chooses a congregation, not who sits in one.
                        joins = (person["age"] >= follow_age
                                 and rng.random() < follow_rate)
                    else:
                        joins = (rates[person["id"]] > 0 and rng.random()
                                 < min(1.0, rates[person["id"]] / household_rate))
                    if joins:
                        rows.append(row(person, org["id"], class_name, rng))
                continue

            # Nobody in the household affiliated together. The people who go
            # anyway go alone, and somewhere else — and that tie is worth more
            # to the graph than any of the ones above, because it is the only
            # one in the household that does not overlap the others.
            for person in people:
                if rng.random() < rates[person["id"]] * STRAY:
                    org = choose(pool, home, person["race_ethnicity"],
                                 class_name, rng)
                    rows.append(row(person, org["id"], class_name, rng))
    return rows


def from_people(people, pools, homes, scales, rng):
    """The classes a person decides for themselves."""
    rows = []
    for class_name in sorted(BASE - HOUSEHOLD_CLASSES):
        pool = pools.get(class_name)
        if not pool:
            continue
        for person in people.values():
            home = homes.get(person["_household"])
            if not home:
                continue
            if rng.random() < rate(person, class_name,
                                   quartile(person["_income"]), scales):
                org = choose(pool, home, person["race_ethnicity"],
                             class_name, rng)
                rows.append(row(person, org["id"], class_name, rng))
    return rows


def units(rows, rng):
    """Cut every org's roster into units, number them, and hand out seconds.

    The cut is hierarchical. `unit_key` is a hard boundary — a shift, a grade,
    a platoon — and nothing crosses it. `_subkey` is a preference: atoms are
    ordered by it and the buckets are filled in that order, so a unit runs
    contiguous in occupation and a boundary falls where an occupation runs out
    rather than in the middle of one.

    Households stay together inside a unit wherever that is possible. Two
    people who share an address and a congregation are in the same small group,
    and splitting them would throw away the strongest tie in the org.
    """
    by_org = defaultdict(list)
    for record in rows:
        by_org[record["org"]].append(record)

    sizes, seconds = Counter(), Counter()
    for org, roster in by_org.items():
        org_class = roster[0]["class"]
        default = UNIT_SIZE.get(org_class, DEFAULT_UNIT_SIZE)
        by_key = defaultdict(list)
        for record in roster:
            by_key[record["unit_key"]].append(record)

        index = 0
        # {unit_key: [unit index, ...]}, for drawing a second unit that the
        # member could plausibly be in at the same time of day.
        within = defaultdict(list)
        for key in sorted(by_key, key=lambda k: (k is None, str(k))):
            group = by_key[key]
            # A crew carries its own size; everything else takes the class's.
            target = min([r["_target"] or default for r in group])

            atoms = defaultdict(list)
            for record in group:
                atoms[(record["_subkey"], record["_household"])].append(record)
            order = list(atoms.items())
            rng.shuffle(order)
            order.sort(key=lambda item: str(item[0][0]))

            # One unit per target-sized bucket, rounded to at least one, so a
            # roster of three is one unit rather than three of one.
            count = max(1, round(len(group) / target))
            per = len(group) / count
            buckets = [[] for _ in range(count)]
            bucket = 0
            for _, family in order:
                # Advance on the half-atom so a bucket overshoots and
                # undershoots about equally instead of always running long.
                if bucket < count - 1 and len(buckets[bucket]) + len(family) / 2 >= per:
                    bucket += 1
                buckets[bucket].extend(family)

            for bucket in buckets:
                if not bucket:
                    continue
                for record in bucket:
                    record["unit"] = index
                within[key].append(index)
                sizes[len(bucket)] += 1
                index += 1

        if index < 2:
            continue
        every = [i for group in within.values() for i in group]
        rate = SECOND_UNIT.get(org_class, DEFAULT_SECOND_UNIT)
        for record in roster:
            if record["role"] == "leader":
                extra = rng.randint(*LEADER_UNITS)
            elif rng.random() < rate:
                extra = 1
            else:
                continue
            near = within[record["unit_key"]]
            also = set()
            for _ in range(extra):
                pool = (near if len(near) > 1
                        and rng.random() < SECOND_WITHIN_KEY else every)
                pick = rng.choice(pool)
                if pick != record["unit"]:
                    also.add(pick)
            if also:
                record["also"] = sorted(also)
                seconds[len(also)] += 1
    return sizes, seconds


def occupations():
    """{occupation: major group} from the OCCP label prefix.

    The prefix is the SOC major group the census already grades every code
    with — MGR, TRN, PRD — which is the resolution the unit cut wants. Finer
    would put one job title per unit; coarser would put a shift back.
    """
    labels = json.loads(CODEBOOK.read_text())["variables"]["OCCP"]["values"]["item"]
    return {code: label.split("-", 1)[0].strip() for code, label in labels.items()}


def sectors():
    """{industry: sector} from the INDP label prefix."""
    labels = json.loads(CODEBOOK.read_text())["variables"]["INDP"]["values"]["item"]
    return {code: label.split("-", 1)[0].strip() for code, label in labels.items()}


def report_work(rows, org_records):
    """What the shift and occupation cut did to the big sites."""
    work = [r for r in rows if r["class"] == "work"]
    if not work:
        return
    print("\nwork units")
    rostered = [r for r in work if r["_target"]]
    bands = Counter(r["unit_key"] for r in work if not r["_target"])
    total = sum(bands.values())
    print("  shift    " + "  ".join(
        f"{name} {count / total:.1%}" for name, count in bands.most_common()))
    crews = {(r["org"], r["unit"]) for r in rostered}
    print(f"  rostered {len(rostered):,} in {len(crews)} crews and squads "
          f"(platoon and duty from employment.json, not derived)")

    # The point of the cut is that a unit is one occupation, so measure it:
    # the share of each unit that is its own most common major group.
    members = defaultdict(list)
    for record in work:
        members[(record["org"], record["unit"])].append(record)
    pure = [Counter(r["_subkey"] for r in m).most_common(1)[0][1] / len(m)
            for m in members.values()]
    sizes = sorted(len(m) for m in members.values())
    print(f"  {len(members):,} units, median {sizes[len(sizes) // 2]}, "
          f"largest {sizes[-1]}, "
          f"mean occupation purity {sum(pure) / len(pure):.1%}")

    names = {o["id"]: (o["name"] or o["subclass"] or o["class"])
             for o in org_records}
    counts = Counter(r["org"] for r in work)
    print("  largest worksites, by shift:")
    for org, count in counts.most_common(5):
        site = [r for r in work if r["org"] == org]
        split = Counter(r["unit_key"] for r in site)
        cells = len({(r["org"], r["unit"]) for r in site})
        print(f"    {count:>4,} in {cells:>3} units  "
              f"{str(names.get(org))[:30]:<30} "
              + " ".join(f"{k} {v}" for k, v in split.most_common()))


def report(rows, people, unit_sizes, seconds, org_records):
    assigned = sum(1 for r in rows if r["class"] in ("work", "school"))
    print(f"{len(rows):,} affiliations over {len(people):,} people "
          f"({len(rows) / len(people):.2f} each); "
          f"{assigned:,} from earlier stages, "
          f"{len(rows) - assigned:,} drawn here")

    # Achieved against target, each over the population its target is a rate
    # over. A class whose reference has no published figure prints neither.
    members = defaultdict(set)
    for record in rows:
        members[record["class"]].add(record["person"])
    print(f"\n  {'class':<10}{'rows':>9}{'people':>9}{'rate':>8}{'target':>8}"
          f"  {'of'}")
    for name, count in Counter(r["class"] for r in rows).most_common():
        test = REFERENCE.get(name)
        if not test:
            print(f"  {name:<10}{count:>9,}{len(members[name]):>9,}")
            continue
        reference = [p for p in people.values() if test(p)]
        # Both sides of the ratio over the same population. A congregation
        # holds children and a rec league holds adults, and counting either
        # against a denominator that excludes them is how a class that is on
        # target reads as 60% of one.
        inside = sum(1 for p in reference if p["id"] in members[name])
        share = inside / len(reference) if reference else 0
        print(f"  {name:<10}{count:>9,}{len(members[name]):>9,}{share:>8.1%}"
              f"{TARGET[name]:>8.1%}  {len(reference):,}")

    unaffiliated = len(people) - len(set(r["person"] for r in rows))
    print(f"\n{unaffiliated:,} people with no affiliation "
          f"({unaffiliated / len(people):.1%})")

    total = sum(unit_sizes.values())
    mean = sum(size * count for size, count in unit_sizes.items()) / total
    print(f"{total:,} units, mean size {mean:.1f}, largest {max(unit_sizes):,}")

    # Units are what the graph will actually join on, so the tail matters:
    # a handful of 60-person units would put cliques in it that nothing in a
    # real city produces.
    over = sum(count for size, count in unit_sizes.items() if size > 40)
    print(f"{over:,} units over 40 people "
          f"({over / total:.2%})")

    # A unit of one produces no edge at all, so it is waste rather than error,
    # but too many of them means the cut is finer than the rosters support.
    alone = unit_sizes.get(1, 0)
    held = sum(seconds.values())
    print(f"{alone:,} units of one ({alone / total:.1%}); "
          f"{held:,} members hold a second unit "
          f"({held / len(rows):.1%}, "
          f"{sum(k * v for k, v in seconds.items()) / max(held, 1):.2f} each)")

    names = {o["id"]: (o["name"] or o["subclass"] or o["class"])
             for o in org_records}
    for org_class, label in (("worship", "largest congregations"),
                             ("sports", "largest clubs")):
        counts = Counter(r["org"] for r in rows if r["class"] == org_class)
        print(f"\n{label}:")
        for org, count in counts.most_common(5):
            print(f"  {count:>5,}  {str(names.get(org))[:46]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="affiliation seed; recorded in the output")
    args = parser.parse_args()
    rng = random.Random(args.seed)

    population = json.loads(POPULATION.read_text())
    dwellings = json.loads(DWELLINGS.read_text())
    coords = {d["id"]: (d["lat"], d["lon"])
              for d in dwellings["dwellings"] + dwellings["quarters"]}

    # Household members reach their dwelling through the household; group
    # quarters residents carry theirs directly and are their own household of
    # one, because for every purpose in this stage that is what they are.
    households = {h["id"]: h for h in population["household_records"]}
    people, homes, members = {}, {}, defaultdict(list)
    for person in population["person_records"]:
        household = households[person["household"]]
        person = {**person, "_household": f"h{household['id']}",
                  "_income": household["income"] or 0}
        people[person["id"]] = person
        homes[person["_household"]] = coords[household["dwelling"]]
        members[person["_household"]].append(person)
    for person in population["quarters_records"]:
        person = {**person, "_household": f"q{person['id']}",
                  "_income": person["income"] or 0}
        people[person["id"]] = person
        homes[person["_household"]] = coords[person["dwelling"]]
        members[person["_household"]].append(person)

    org_records = json.loads(ORGS.read_text())["org_records"]
    org_ids = {o["id"] for o in org_records}
    pools = defaultdict(list)
    for org in org_records:
        if org["class"] in BASE:
            pools[org["class"]].append(org)

    scales = calibrate(people)
    work_rows = from_work(people, org_ids, rng)
    work_site = {r["person"]: r["org"] for r in work_rows}
    rows = (work_rows
            + from_school(people, org_ids, rng)
            + from_union(people, org_ids, sectors(), work_site, rng)
            + from_households(members, pools, homes, scales, rng)
            + from_people(people, pools, homes, scales, rng))

    unit_sizes, seconds = units(rows, rng)
    report(rows, people, unit_sizes, seconds, org_records)
    report_work(rows, org_records)

    # The shift survives into the output because it is the one thing here the
    # graph cannot recover from the unit number: two people in different units
    # of the same shift still overlap, and two on opposite shifts do not.
    records = []
    for record in rows:
        out = {k: v for k, v in record.items()
               if k not in ("_household", "unit_key", "_subkey", "_target")}
        if record["class"] == "work" and record["unit_key"]:
            out["shift"] = record["unit_key"]
        records.append(out)
    AFFILIATIONS.write_text(json.dumps({
        "source": [ORGS.name, EMPLOYMENT.name, ENROLLMENT.name],
        "seed": args.seed,
        "affiliations": len(records),
        "units": sum(unit_sizes.values()),
        "classes": dict(Counter(r["class"] for r in records)),
        "affiliation_records": records,
    }, separators=(",", ":")))
    print(f"\nWrote {AFFILIATIONS} "
          f"({AFFILIATIONS.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
