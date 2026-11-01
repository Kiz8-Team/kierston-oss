"""Build the social graph: who knows whom, and tie strength.

Two numbers, not one
--------------------
Every tie carries an exposure and an affinity, and the whole design rests on
their being independent.

    exposure   how often the two are in the same room. Set almost entirely by
               the focus that produced the tie — a shift is daily, a
               congregation is weekly, an old friend across town is never.
    affinity   how much they actually like each other. Set by homophily,
               tenure overlap, multiplexity and temperament, and largely
               unrelated to how often they are forced into a room together.

One blended strength cannot express the case the city is mostly made of: the
man on the next pick line, seen eight hours a day for six years, whose second
name you would have to think about. High exposure, low affinity. He looks
identical to a golf partner under a single number and behaves nothing like him
— he generates a great deal of shared location and no phone calls at all,
where the golf partner generates a text about a tee time and no location.
Downstream this is the whole point: exposure drives co-presence and travel,
affinity drives calls, texts and money.

So a work unit realises at 0.95 — you do know your twelve — and only a small
share of those ties are ever promoted past acquaintance. Being at work with
someone is not a friendship and the model should not quietly make it one.

How the graph is built
----------------------
Four passes.

    foci       every unit from affiliations.py, every household, every kin
               edge, every building. Nobody is searched for; the groups that
               already exist supply the candidate pairs, which is what keeps
               this an O(pairs-in-groups) problem rather than an O(n^2) one.
    draw       each candidate is realised or not at a rate set by its focus
               class, then scored. Homophily moves affinity, never existence:
               you meet everyone in your section regardless, and you get close
               to few of them.
    closure    friends of friends, once. This is what turns a pile of pairwise
               ties into an actual friend group and lets a tie escape the
               group that produced it.
    budget     affinity is trimmed to a per-person capacity; exposure is not.
               Time is finite and circumstance is not — you cannot drop the
               colleague you dislike, you are at work either way.

The trim is a budget and not a cap because the failure it exists to prevent is
the one kinship.py hit with parity: every individual edge defensible, the pile
of them absurd. A gregarious barman ends up plausibly close to four hundred
people, each of whom he was individually a reasonable answer for.

Anti-ties
---------
A negative tie is the same record with a negative valence, not a deleted one.
Estranged kin and ex-partners keep an edge that says the relation exists and
the contact does not, which is a fact about a person and not missing data. Two
sources here — dissolution, and the quarter of adults estranged from a close
relative with no docket anywhere to explain it. The adversarial ones that do
have paper (PFA, victim-offender, judgment) belong to dockets.py, which runs
after this and can draw its counterparties out of this graph rather than
inventing strangers.

Where a co-parented child exists the ex-partner tie survives at low affinity
and stubbornly nonzero contact, because that is the real case and it is the
one that matters for a pattern of life.

Known gaps: the ~9,700 workers who work from home or commute out of the region
hold no work affiliation, so they take no colleague ties and sit low in the
degree distribution. That is a hole in affiliations.py, not here.
"""

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from personal_records import registries


from paths import SIM_DATA  # noqa: E402
POPULATION = SIM_DATA / "population.json"
DWELLINGS = SIM_DATA / "dwellings.json"
AFFILIATIONS = SIM_DATA / "affiliations.json"
KINSHIP = SIM_DATA / "kinship.json"
IDENTITY = SIM_DATA / "identity.json"
TIES = SIM_DATA / "ties.bin"

DEFAULT_SEED = 20260731
YEAR = registries.REFERENCE_YEAR

# Node id space. Residents are their population id; everyone else is a stub
# with a base, the same shape kinship.py gives absent parents.
EXTERNAL_BASE = 1_000_000          # kinship's own absent parents
ABROAD_BASE = 3_000_000            # family and friends left behind
FORMER_BASE = 4_000_000            # colleagues from a job since left

# How a tie came to exist. This is provenance and not intensity — a colleague
# who became a close friend is still a colleague by provenance, and the tier
# is read off affinity rather than stored twice.
KINDS = ("household", "parent", "child", "sibling", "partner", "ex_partner",
         "coparent", "grandparent", "kin_ext", "colleague", "ex_colleague",
         "classmate", "clubmate", "congregant", "neighbour", "elsewhere",
         "abroad")
KIND = {name: i for i, name in enumerate(KINDS)}

# The focus classes a tie can carry, as a bitmask. Two people who work
# together and worship together have two bits set, and that multiplexity is
# the strongest single predictor the model has of a real friendship.
FOCI = ("work", "school", "worship", "gym", "sports", "civic", "fraternal",
        "youth", "union", "household", "kin", "neighbour", "elsewhere",
        "abroad")
FOCUS = {name: 1 << i for i, name in enumerate(FOCI)}

# Realisation: given a shared unit, the chance the two know each other at all.
# Work and school are near-total — a unit is twelve people and you know your
# twelve. A gym is the opposite and should mostly produce nothing: the point
# of a gym membership is not to meet anyone.
REALIZE = {"work": 0.95, "school": 0.90, "worship": 0.55, "gym": 0.15,
           "sports": 0.70, "civic": 0.60, "fraternal": 0.70, "youth": 0.75,
           "union": 0.30, "neighbour": 0.45}

# Exposure by focus, as a share of days on which the two are in the same room.
# A shift is daily; a congregation is weekly and lands near 0.14; a lodge
# meets monthly. These are the numbers the co-presence layer will read.
EXPOSURE = {"work": 0.88, "school": 0.90, "worship": 0.16, "gym": 0.11,
            "sports": 0.14, "civic": 0.07, "fraternal": 0.04, "youth": 0.13,
            "union": 0.02, "neighbour": 0.22, "household": 1.0}

# Neighbours. The day is cut into six four-hour segments, and each carries the
# weight of how much neighbouring actually happens in it: the morning leaving
# and the evening returning are when two people meet on a path, the small hours
# are when nobody meets anybody.
SEGMENTS = 6
MEET_WEIGHT = (0.05, 0.70, 0.50, 0.50, 1.00, 0.35)

# Proximity bands in metres, and the exposure and realisation each carries at
# full schedule overlap. Sharing a building is a different relation from living
# on the same street and the old flat rate collapsed them into one.
PROXIMITY = ((0.0, 0.52, 0.62),        # the same building
             (60.0, 0.34, 0.46),       # next door, across the path
             (150.0, 0.20, 0.26),      # the same street
             (1e9, 0.11, 0.13))        # round the corner

# Even neighbours whose weekdays never overlap meet sometimes. A weekday
# schedule is not a life.
NEIGHBOUR_FLOOR = 0.30

CELL_M = 150.0
DECAY_M = 80.0
NEIGHBOUR_DRAW = 7.0
SAME_BUILDING = 0.55

# The same org but not the same unit. A different shift is nearly a different
# building; a different unit on your own shift is the person you queue behind
# at the canteen.
CROSS_UNIT = {"same_key": (0.30, 0.20), "other_key": (0.06, 0.03)}

# How many cross-unit acquaintances a member draws inside their own org, as
# the mean of a Poisson. Sampled rather than enumerated: a 900-person site has
# 400,000 pairs in it and perhaps three thousand of them are anything.
CROSS_DRAW = {"work": 22.0, "school": 24.0, "worship": 14.0, "sports": 7.0,
              "gym": 3.0, "civic": 6.0, "fraternal": 7.0, "youth": 7.0,
              "union": 2.0}

# Target share of realised ties in a class that reach the friend tier. Work is
# deliberately low: a third of Americans report a close friend at work, but per
# *colleague pair* the rate is small, and it is pairs this is a rate over.
# School is the outlier and should be — adolescent networks are dense, and a
# classmate is a candidate friend in a way a colleague is not.
PROMOTE = {"work": 0.15, "school": 0.32, "worship": 0.22, "gym": 0.03,
           "sports": 0.25, "civic": 0.20, "fraternal": 0.22, "youth": 0.28,
           "union": 0.06, "neighbour": 0.12}

# The layers, as people per person, cumulative. These are the Dunbar numbers
# and they are the only external anchor this file has, so the tier cuts are
# solved from them rather than picked: the close-friend cut is wherever the
# affinity distribution has to be sliced to give the average person five. Fixed
# thresholds were tried first and produced more close friends than friends,
# which is the shape of no social network anywhere.
LAYERS = (("close_friend", 5.0), ("friend", 15.0), ("friendly", 45.0),
          ("acquaintance", 150.0))

# Homophily, in log-odds added to a tie's score. Age is the strongest of these
# in every friendship survey there is; sex homophily is real but weaker than
# people expect; ethnic homophily in a city this mixed is strong.
AGE_DECAY = 11.0
SAME_ETHNICITY = 0.42
SAME_SEX = 0.24
INCOME_DECAY = 0.22
TENURE_TOGETHER = 0.45      # joined within three years of each other
MULTIPLEX = 1.05            # per focus beyond the first

# Temperament. One draw per person, added to the score of every tie they hold,
# and the reason the degree distribution has a tail at all. Without it every
# person ends up with the same number of friends, which is the clearest tell
# of a graph nobody thought about.
SOCIABILITY_SD = 0.62

# The affinity a person can hold at once, as a mean and spread of a lognormal
# over the *sum* of their affinities. Beyond it, ties are demoted rather than
# cut: you keep seeing the colleague you have no time for.
CAPACITY_MEAN = 26.0
CAPACITY_SD = 0.55

# Triadic closure. Of the paths a-b-c where both legs are friendships and a-c
# does not exist, this share close. The resulting tie has no focus of its own
# and inherits a weak exposure, because meeting through a friend is exactly how
# you come to know somebody you share no institution with.
CLOSURE = 0.10
CLOSURE_EXPOSURE = 0.05

# Ties to people the model does not otherwise represent: an old town, a bar,
# the army, the internet. Few, and structurally indispensable — without them
# the graph's diameter is set by how far apart two workplaces are and nothing
# is ever reachable.
LONG_TIE = 0.06

# Estrangement. Roughly a quarter of US adults report being estranged from a
# close relative; applied to adult kin edges outside the household, since the
# people you live with are a different question.
ESTRANGED = {"parent": 0.11, "sibling": 0.14, "kin_ext": 0.19}

# Ex-partners. Drawn for the divorced and separated, matched against nobody —
# most ex-partners of Kierston residents do not live in Kierston, and the ones
# who do are the interesting minority.
EX_PARTNER_IN_CITY = 0.22
COPARENT_AFFINITY = 0.30

# A tiny fraction of retained ex-colleagues, for people with enough job history
# to have had one. They are a rounding error in the graph and a real share of
# anybody's phone, and they are the only ties that sit inside no current group.
EX_COLLEAGUE_RATE = 0.25
EX_COLLEAGUE_TENURE = 3

# Family and friends left behind, for the foreign-born. Weighted to recent
# arrivals, and the only plausible other end of a remittance or an
# international call.
ABROAD_RATE = {"noncitizen": 1.5, "naturalized": 0.9,
               "born_territory": 0.7, "born_abroad_us_parent": 0.3}
ABROAD_RECENT = 12          # years since entry that still count as recent


# --------------------------------------------------------------------------
# loading


def load_people():
    """Person attributes as parallel arrays, indexed by population id."""
    population = json.loads(POPULATION.read_text())
    households = {h["id"]: h for h in population["household_records"]}

    rows = []
    for person in population["person_records"]:
        household = households[person["household"]]
        rows.append((person, f"h{household['id']}", household["dwelling"],
                     household["income"] or 0))
    for person in population["quarters_records"]:
        rows.append((person, f"q{person['id']}", person["dwelling"],
                     person["income"] or 0))

    size = max(p["id"] for p, *_ in rows) + 1
    people = {
        "age": np.zeros(size, np.int16),
        "sex": np.zeros(size, np.int8),
        "eth": np.zeros(size, np.int8),
        "income": np.zeros(size, np.float32),
        "dwelling": np.full(size, -1, np.int64),
        "present": np.zeros(size, bool),
        "depart": np.full(size, -1, np.int32),
        "arrive": np.full(size, -1, np.int32),
        "travel": np.zeros(size, np.int32),
        "hours": np.zeros(size, np.int32),
        "student": np.zeros(size, bool),
    }
    # Dwellings and households are OSM ids and strings; everything downstream
    # only ever compares them, so intern both to a dense integer.
    ethnicities, dwellings_seen, households_seen = {}, {}, {}
    household_of = np.full(size, -1, np.int64)
    for person, household, dwelling, income in rows:
        i = person["id"]
        people["age"][i] = person["age"]
        people["sex"][i] = person["sex"]
        people["eth"][i] = ethnicities.setdefault(
            person["race_ethnicity"], len(ethnicities))
        people["income"][i] = income
        people["dwelling"][i] = dwellings_seen.setdefault(
            dwelling, len(dwellings_seen))
        people["present"][i] = True
        for field in ("depart", "arrive", "travel", "hours"):
            if person.get(field) is not None:
                people[field][i] = person[field]
        people["student"][i] = (person.get("enrolled") in (2, 3)
                                and 5 <= person["age"] <= 18)
        household_of[i] = households_seen.setdefault(
            household, len(households_seen))
    people["household"] = household_of
    people["dwelling_id"] = {v: k for k, v in dwellings_seen.items()}
    return people


def load_dwelling_coords():
    dwellings = json.loads(DWELLINGS.read_text())
    return {d["id"]: (d["lat"], d["lon"])
            for d in dwellings["dwellings"] + dwellings["quarters"]}


# --------------------------------------------------------------------------
# candidate pairs


class Pairs:
    """Accumulator for candidate pairs and the focus that produced each."""

    def __init__(self):
        self.a, self.b, self.focus, self.kind = [], [], [], []
        self.exposure, self.realize, self.since = [], [], []

    def add(self, pairs, focus, kind, exposure, realize, since=0):
        if pairs is None or len(pairs) == 0:
            return
        block = np.asarray(pairs, np.int64).reshape(-1, 2)
        lo = np.minimum(block[:, 0], block[:, 1])
        hi = np.maximum(block[:, 0], block[:, 1])
        keep = lo != hi
        count = int(keep.sum())
        if not count:
            return
        self.a.append(lo[keep])
        self.b.append(hi[keep])
        self.focus.append(np.full(count, focus, np.uint16))
        self.kind.append(np.full(count, kind, np.uint8))
        self.exposure.append(
            np.asarray(exposure, np.float32)[keep] if np.ndim(exposure)
            else np.full(count, exposure, np.float32))
        self.realize.append(
            np.asarray(realize, np.float32)[keep] if np.ndim(realize)
            else np.full(count, realize, np.float32))
        self.since.append(np.asarray(since, np.int32)[keep] if np.ndim(since)
                          else np.full(count, since, np.int32))

    def stack(self):
        return {
            "a": np.concatenate(self.a),
            "b": np.concatenate(self.b),
            "focus": np.concatenate(self.focus),
            "kind": np.concatenate(self.kind),
            "exposure": np.concatenate(self.exposure),
            "realize": np.concatenate(self.realize),
            "since": np.concatenate(self.since),
        }


def from_households(people, pairs):
    """Everyone under one roof, at full exposure.

    Not a draw. Two people who share a kitchen know each other, and the only
    question a model gets to ask about them is how much they like it.
    """
    members = defaultdict(list)
    for person in np.flatnonzero(people["present"]):
        members[int(people["household"][person])].append(int(person))
    block = []
    for group in members.values():
        if len(group) > 1:
            block.extend(combinations(sorted(group), 2))
    pairs.add(block, FOCUS["household"], KIND["household"],
              EXPOSURE["household"], 1.0)


def from_kinship(people, pairs, rng):
    """Parents, siblings, partners, and one ring beyond.

    kinship.py resolved the hard part. What is left is reading the edges it
    implies but does not store — siblings share a parent, grandparents are two
    hops up, cousins are a hop sideways then down — and deciding which of them
    the city is small enough to contain.
    """
    kinship = json.loads(KINSHIP.read_text())
    parents = {int(child): [p["id"] for p in rows]
               for child, rows in kinship["parents"].items()}
    present = people["present"]

    def resident(i):
        return 0 <= i < len(present) and present[i]

    parent_edges, children_of = [], defaultdict(list)
    for child, rows in parents.items():
        if not resident(child):
            continue
        for parent in rows:
            if resident(parent):
                parent_edges.append((parent, child))
                children_of[parent].append(child)
    pairs.add(parent_edges, FOCUS["kin"], KIND["parent"], 0.30, 1.0)

    # Siblings: everyone who shares a parent, including the ones that parent
    # does not live with. This is where cross-household kin actually comes
    # from — the household pass never sees it.
    sibling_edges = set()
    for kids in children_of.values():
        if 1 < len(kids) <= 12:
            sibling_edges.update(combinations(sorted(kids), 2))
    pairs.add(sorted(sibling_edges), FOCUS["kin"], KIND["sibling"], 0.22, 1.0)

    # Grandparents, two hops up, and cousins, a hop sideways then down. Both
    # are real and both are weaker than the model would make them if they were
    # drawn with the same hand as a parent.
    grandparent_edges, cousin_edges = [], set()
    for child, rows in parents.items():
        if not resident(child):
            continue
        for parent in rows:
            for grandparent in parents.get(parent, []):
                if resident(grandparent):
                    grandparent_edges.append((grandparent, child))
            # The parent's siblings' children.
            for grandparent in parents.get(parent, []):
                for aunt in children_of.get(grandparent, []):
                    if aunt == parent:
                        continue
                    for cousin in children_of.get(aunt, []):
                        if cousin != child:
                            cousin_edges.add(tuple(sorted((child, cousin))))
    pairs.add(grandparent_edges, FOCUS["kin"], KIND["grandparent"], 0.14, 0.92)
    pairs.add(sorted(cousin_edges), FOCUS["kin"], KIND["kin_ext"], 0.06, 0.62)

    partner_edges = [(a, b) for a, b, _ in kinship["partners"]
                     if resident(a) and resident(b)]
    pairs.add(partner_edges, FOCUS["kin"], KIND["partner"], 1.0, 1.0)
    return parents, children_of


def from_affiliations(people, pairs, rng):
    """Every unit is a set of candidates; every org is a weaker one.

    Within a unit the pairs are enumerated — units are small on purpose and
    the whole of affiliations.py exists to keep them that way. Across units
    they are sampled, because a 900-person worksite holds 400,000 pairs and
    perhaps three thousand of them mean anything.
    """
    records = json.loads(AFFILIATIONS.read_text())["affiliation_records"]

    units = defaultdict(list)
    orgs = defaultdict(list)
    key_of = {}
    for record in records:
        person = record["person"]
        org, org_class = record["org"], record["class"]
        key = record.get("shift")
        for unit in [record["unit"]] + list(record.get("also") or ()):
            units[(org, unit)].append((person, record["since"]))
            key_of[(org, unit)] = key
        orgs[org].append((person, record["unit"], key, org_class))

    kind_of = {"work": KIND["colleague"], "school": KIND["classmate"],
               "worship": KIND["congregant"], "union": KIND["colleague"]}
    class_of = {}
    for record in records:
        class_of[record["org"]] = record["class"]

    for (org, unit), members in units.items():
        org_class = class_of[org]
        if len(members) < 2:
            continue
        block, since = [], []
        for (a, since_a), (b, since_b) in combinations(sorted(members), 2):
            block.append((a, b))
            since.append(max(since_a, since_b))
        pairs.add(block, FOCUS[org_class],
                  kind_of.get(org_class, KIND["clubmate"]),
                  EXPOSURE[org_class], REALIZE[org_class],
                  since=np.asarray(since, np.int32))

    # Cross-unit, inside one org. Drawn per member rather than enumerated.
    for org, roster in orgs.items():
        if len(roster) < 3:
            continue
        org_class = class_of[org]
        mean = CROSS_DRAW.get(org_class, 1.0)
        by_key = defaultdict(list)
        for entry in roster:
            by_key[entry[2]].append(entry)
        every = roster
        block_same, block_other = [], []
        for person, unit, key, _ in roster:
            for _ in range(rng.poisson(mean)):
                same = rng.random() < 0.72
                pool = by_key[key] if same and len(by_key[key]) > 1 else every
                other, other_unit, _, _ = pool[rng.integers(len(pool))]
                if other == person or other_unit == unit:
                    continue
                (block_same if same else block_other).append((person, other))
        for block, band in ((block_same, "same_key"), (block_other, "other_key")):
            exposure, realize = CROSS_UNIT[band]
            pairs.add(block, FOCUS[org_class],
                      kind_of.get(org_class, KIND["clubmate"]),
                      exposure, realize)
    return records


def at_home(people):
    """When each person is at their own address, in six four-hour segments.

    A neighbour tie is the only one in the city whose exposure is not set by an
    institution, because there is no institution — there is a wall, and two
    schedules. Two people who both leave at seven and come back at six pass
    each other constantly. A night-shift worker and a day-shift worker on the
    same landing can go a year without meeting, and a flat exposure for both is
    the assumption this function exists to remove.

    The commute is surveyed (JWDP, JWAP, JWMNP) so the leaving is real; the
    coming back is the arrival plus a day's worth of the surveyed weekly hours
    plus the trip home. Students are out on a school day. Everybody else — the
    retired, the unemployed, the 4,400 who work from home — is in all day, and
    they are the ones who actually know their neighbours.
    """
    size = len(people["age"])
    home = np.ones((size, SEGMENTS), np.float32)
    span = 24 * 60 / SEGMENTS

    daily = np.clip(people["hours"] / 5.0, 4, 12) * 60
    out_from = people["depart"].astype(np.float32)
    out_to = np.where(people["arrive"] > 0, people["arrive"], people["depart"])
    out_to = out_to + daily + people["travel"]
    worker = people["depart"] >= 0

    student = people["student"] & ~worker
    out_from = np.where(student, 8 * 60.0, out_from)
    out_to = np.where(student, 15 * 60.0, out_to)
    away = worker | student

    for segment in range(SEGMENTS):
        lo, hi = segment * span, (segment + 1) * span
        overlap = np.clip(np.minimum(out_to, hi) - np.maximum(out_from, lo),
                          0, span)
        home[:, segment] = np.where(away, 1 - overlap / span, 1.0)
    return home


def from_neighbours(people, coords, pairs, rng):
    """The building, and the buildings either side of it.

    Weak, numerous, and the only tie in the city with nothing behind it but a
    wall. Two things set it, and neither is a constant: how far apart the two
    doors are, and whether the two schedules ever put both people on the street
    at the same time.

    Sampled rather than enumerated. A tower with two hundred units in it does
    not contain twenty thousand acquaintances, and the people in it know the
    ones on their own landing.
    """
    home = at_home(people)
    weights = np.asarray(MEET_WEIGHT, np.float32)
    names = people["dwelling_id"]

    residents = defaultdict(list)
    for person in np.flatnonzero(people["present"]):
        if people["age"][person] >= 16:
            residents[int(people["dwelling"][person])].append(int(person))

    keys = sorted(residents)
    where = np.array([coords[names[d]] for d in keys], np.float64)
    # Metres per degree at this latitude, so the grid and the decay are in the
    # same units as the constants that describe them.
    metres = np.array([111_320.0, 111_320.0 * math.cos(math.radians(
        float(where[:, 0].mean())))])
    local = (where - where.min(axis=0)) * metres

    cells = defaultdict(list)
    for index, (y, x) in enumerate(local):
        cells[(int(y // CELL_M), int(x // CELL_M))].append(index)

    block, exposure, realize = [], [], []

    def emit(a, b, distance):
        for tier, (limit, exp_base, real_base) in enumerate(PROXIMITY):
            if distance <= limit:
                break
        share = float(np.dot(weights, np.minimum(home[a], home[b]))
                      / weights.sum())
        block.append((a, b))
        # A floor, because a weekday schedule is not a life: two neighbours who
        # never overlap on a Tuesday still both put the bins out on Sunday.
        exposure.append(exp_base * (NEIGHBOUR_FLOOR
                                    + (1 - NEIGHBOUR_FLOOR) * share))
        realize.append(real_base * (0.45 + 0.55 * share))

    for (cy, cx), here in cells.items():
        near = [i for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                for i in cells.get((cy + dy, cx + dx), ())]
        if len(near) < 2:
            continue
        spot = local[near]
        for index in here:
            dwelling = keys[index]
            inside = residents[dwelling]
            distances = np.hypot(*(spot - local[index]).T)
            # Everything on the same landing, then a distance-weighted draw
            # from the streets around it.
            decay = np.exp(-distances / DECAY_M)
            decay[distances == 0] = 0.0
            total = decay.sum()
            for person in inside:
                for other in inside:
                    if other > person and rng.random() < SAME_BUILDING:
                        emit(person, other, 0.0)
                if total <= 0:
                    continue
                picks = rng.choice(len(near), size=rng.poisson(NEIGHBOUR_DRAW),
                                   p=decay / total)
                for pick in picks:
                    pool = residents[keys[near[pick]]]
                    other = int(pool[rng.integers(len(pool))])
                    if other != person:
                        emit(person, other, float(distances[pick]))

    pairs.add(block, FOCUS["neighbour"], KIND["neighbour"],
              np.asarray(exposure, np.float32), np.asarray(realize, np.float32))


def from_elsewhere(people, pairs, rng):
    """Ties to people the model shares no institution with.

    A bar, an old town, the army, the internet. Their share is small and their
    structural job is large: they are what keeps the city's diameter down to
    something a real one would recognise instead of the distance between two
    workplaces.
    """
    ids = np.flatnonzero(people["present"] & (people["age"] >= 15))
    count = int(len(ids) * LONG_TIE)
    a = rng.choice(ids, count)
    b = rng.choice(ids, count)
    pairs.add(np.stack([a, b], axis=1), FOCUS["elsewhere"], KIND["elsewhere"],
              0.02, 1.0)


# --------------------------------------------------------------------------
# scoring


def merge(raw):
    """Collapse duplicate pairs, keeping the strongest of everything.

    A pair produced by two foci is one tie with two bits set. Exposure takes
    the max — being at work together is not made rarer by also being cousins —
    and the multiplex count is what the score will later reward.
    """
    key = raw["a"] * (1 << 23) + raw["b"]
    order = np.argsort(key, kind="stable")
    key = key[order]
    edges = {name: column[order] for name, column in raw.items()}

    start = np.empty(len(key), bool)
    start[0] = True
    np.not_equal(key[1:], key[:-1], out=start[1:])
    group = np.cumsum(start) - 1
    count = int(group[-1]) + 1

    merged = {"a": edges["a"][start], "b": edges["b"][start]}
    merged["focus"] = np.zeros(count, np.uint16)
    np.bitwise_or.at(merged["focus"], group, edges["focus"])
    merged["exposure"] = np.zeros(count, np.float32)
    np.maximum.at(merged["exposure"], group, edges["exposure"])
    merged["realize"] = np.zeros(count, np.float32)
    np.maximum.at(merged["realize"], group, edges["realize"])
    merged["since"] = np.zeros(count, np.int32)
    np.maximum.at(merged["since"], group, edges["since"])
    # The provenance of the strongest-exposure focus wins the label.
    best = np.zeros(count, np.float32)
    np.maximum.at(best, group, edges["exposure"])
    pick = edges["exposure"] >= best[group]
    merged["kind"] = np.zeros(count, np.uint8)
    merged["kind"][group[pick]] = edges["kind"][pick]
    merged["multiplex"] = np.bincount(
        group, weights=np.ones(len(group)), minlength=count).astype(np.int16)
    return merged


def homophily(edges, people, sociability):
    """Log-odds on affinity. Moves how well, never whether."""
    a, b = edges["a"], edges["b"]
    age = np.abs(people["age"][a].astype(np.float32)
                 - people["age"][b].astype(np.float32))
    score = -age / AGE_DECAY
    score += SAME_ETHNICITY * (people["eth"][a] == people["eth"][b])
    score += SAME_SEX * (people["sex"][a] == people["sex"][b])

    income_a = np.log1p(np.maximum(people["income"][a], 0))
    income_b = np.log1p(np.maximum(people["income"][b], 0))
    score -= INCOME_DECAY * np.abs(income_a - income_b)

    # Joined at the same time. The single most under-weighted predictor there
    # is: two people nineteen years apart in the same local are not friends.
    both = edges["since"] > 0
    score += TENURE_TOGETHER * both
    score += MULTIPLEX * np.maximum(edges["multiplex"] - 1, 0)
    score += sociability[a] + sociability[b]
    return score


def calibrate(edges, score, focus, target, floor, rng):
    """Solve the intercept that puts the right share of a class over the line.

    The alternative is hand-tuning a base rate per class until the printed
    number looks right, which is the same work done worse and without a record
    of what it was aimed at.
    """
    mask = (edges["focus"] & focus).astype(bool)
    if not mask.any():
        return 0.0
    sample = score[mask]
    if len(sample) > 400_000:
        sample = rng.choice(sample, 400_000, replace=False)
    lo, hi = -12.0, 12.0
    for _ in range(40):
        mid = (lo + hi) / 2
        share = float(np.mean(1 / (1 + np.exp(-(sample + mid))) > floor))
        if share < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def retune(edges, size, rng):
    """Re-solve the class intercepts against the finished graph.

    The first solve happens before closure and the stub passes, which between
    them move a third of the edges and drag every quantile with them. Rather
    than calibrate against a distribution that is about to change, the class
    targets are enforced once at the end, on the graph that will be written.
    """
    logit = np.log(np.clip(edges["affinity"], 1e-6, 1 - 1e-6)
                   / np.clip(1 - edges["affinity"], 1e-6, 1))
    kin = (edges["focus"] & (FOCUS["household"] | FOCUS["kin"])).astype(bool)
    achieved = {}
    for _ in range(3):
        friend = [cut for cut, name in cuts(edges["affinity"], size)
                  if name == "friend"][0]
        threshold = math.log(friend / (1 - friend))
        # -inf, not zero: a class whose natural rate is above target needs a
        # negative intercept, and a max() against zero silently discards it.
        shift = np.full(len(logit), -np.inf, np.float32)
        for name, target in PROMOTE.items():
            mask = (edges["focus"] & FOCUS[name]).astype(bool) & ~kin
            if not mask.any():
                continue
            sample = logit[mask]
            lo, hi = -12.0, 12.0
            for _ in range(36):
                mid = (lo + hi) / 2
                if float(np.mean(sample + mid > threshold)) < target:
                    lo = mid
                else:
                    hi = mid
            value = (lo + hi) / 2
            shift = np.where(mask, np.maximum(shift, value), shift)
            achieved[name] = value
        shift = np.where(np.isfinite(shift), shift, 0.0).astype(np.float32)
        edges["affinity"] = (1 / (1 + np.exp(-(logit + shift)))).astype(np.float32)
    return achieved


def cuts(affinity, size):
    """Solve the tier boundaries from the layer targets.

    A layer is a count per person, so its boundary is wherever the affinity
    distribution has to be sliced to hand out that many. Doing it the other way
    round — fixing the thresholds and reporting what falls in them — is what
    produced more close friends than friends on the first run.
    """
    order = np.sort(affinity)[::-1]
    solved = []
    for name, per_person in LAYERS:
        wanted = min(int(per_person * size / 2), len(order) - 1)
        solved.append((float(order[wanted]), name))
    return solved + [(0.0, "known_of")]


def draw(edges, people, sociability, rng):
    """Realise, score, and set affinity on every candidate.

    Residents only. A tie to a stub — a cousin in Santo Domingo, somebody from
    a job three years ago — has no attributes on the far side to be homophilous
    with, so it is given its affinity directly rather than scored.
    """
    size = len(people["age"])
    keep = rng.random(len(edges["a"])) < edges["realize"]
    edges = {name: column[keep] for name, column in edges.items()}

    score = homophily(edges, people, sociability)
    score += rng.gumbel(0, 0.9, len(score)).astype(np.float32)
    kin = (edges["focus"] & (FOCUS["household"] | FOCUS["kin"])).astype(bool)
    floor = rng.beta(5.0, 2.2, len(score))

    # The class intercepts and the tier cuts each depend on the other: a cut is
    # a quantile of the affinities the intercepts produce, and an intercept is
    # solved against a cut. Three rounds is well past where it settles.
    intercepts = {name: 0.0 for name in PROMOTE}
    friend = 0.62
    for _ in range(3):
        shift = np.full(len(score), -np.inf, np.float32)
        for name, value in intercepts.items():
            mask = (edges["focus"] & FOCUS[name]).astype(bool)
            shift = np.where(mask, np.maximum(shift, value), shift)
        shift = np.where(np.isfinite(shift), shift, 0.0).astype(np.float32)
        # Kin are not drawn against a promotion target — a mother is not a
        # candidate friend who cleared a bar — so they take a floor instead.
        affinity = 1 / (1 + np.exp(-(score + shift)))
        affinity = np.where(kin, np.maximum(affinity, floor), affinity)
        friend = [cut for cut, name in cuts(affinity, size)
                  if name == "friend"][0]
        for name, target in PROMOTE.items():
            intercepts[name] = calibrate(
                edges, score, FOCUS[name], target, friend, rng)

    edges["affinity"] = affinity.astype(np.float32)
    return edges, intercepts


def draw_stubs(edges, rng):
    """Affinity for a tie whose far end is not a person in this city.

    Kept deliberately high and narrow. Somebody keeps a number for three years
    after leaving a job, or calls a sister in another country, because the tie
    is strong — the weak ones do not survive the distance, and the model would
    be wrong to hold on to them.
    """
    count = len(edges["a"])
    edges["affinity"] = rng.beta(4.0, 2.4, count).astype(np.float32)
    edges["multiplex"] = np.ones(count, np.int16)
    return edges


# --------------------------------------------------------------------------
# closure and budget


def adjacency(edges, size, floor):
    """CSR over the friendship subgraph, both directions."""
    # Residents only: a stub has no neighbours to close a triangle through.
    strong = ((edges["affinity"] >= floor)
              & (edges["a"] < size) & (edges["b"] < size))
    a = np.concatenate([edges["a"][strong], edges["b"][strong]])
    b = np.concatenate([edges["b"][strong], edges["a"][strong]])
    order = np.argsort(a, kind="stable")
    a, b = a[order], b[order]
    start = np.searchsorted(a, np.arange(size + 1))
    return start, b


def closure(edges, people, floor, rng):
    """Friends of friends, one pass.

    Without this the graph is a set of institutional blocks with the right
    sizes and no group structure. With it, co-membership becomes a friend
    group, and — the part that matters — a tie escapes the org that made it.
    """
    size = len(people["age"])
    start, neighbours = adjacency(edges, size, floor)
    degree = np.diff(start)
    hubs = np.flatnonzero(degree >= 2)
    if not len(hubs):
        return None

    # One candidate triangle per pair of a hub's friends, sampled.
    wanted = (degree[hubs] * (degree[hubs] - 1) / 2 * CLOSURE).astype(np.int64)
    wanted = np.minimum(wanted, 40)
    total = int(wanted.sum())
    if not total:
        return None
    hub = np.repeat(hubs, wanted)
    span = degree[hub]
    left = neighbours[start[hub] + (rng.random(total) * span).astype(np.int64)]
    right = neighbours[start[hub] + (rng.random(total) * span).astype(np.int64)]
    keep = left != right
    return np.stack([left[keep], right[keep]], axis=1)


def budget(edges, people, rng):
    """Trim affinity to a capacity; leave exposure alone.

    The distinction is the point. Affinity costs time and is budgeted, so the
    fortieth friend displaces the thirty-ninth. Exposure is circumstance and
    is not: you do not stop running into the man on the next line because your
    week is full. Over budget, a tie is demoted, never deleted — the relation
    survives as an acquaintance, which is what actually happens.
    """
    size = len(people["age"])
    capacity = rng.lognormal(math.log(CAPACITY_MEAN), CAPACITY_SD, size)
    demoted = np.zeros(len(edges["a"]), bool)
    for side in ("a", "b"):
        # A stub has no week to fill. Only the resident end of an outward tie
        # is budgeted, and it always sorts low, so it is always the `a` end.
        resident = np.flatnonzero(edges[side] < size)
        order = resident[np.lexsort((-edges["affinity"][resident],
                                     edges[side][resident]))]
        person = edges[side][order]
        running = np.cumsum(edges["affinity"][order])
        start = np.empty(len(order), bool)
        start[0] = True
        np.not_equal(person[1:], person[:-1], out=start[1:])
        base = np.maximum.accumulate(np.where(start, running - edges["affinity"][order], 0))
        used = running - base
        demoted[order] |= used > capacity[person]
    edges["affinity"] = np.where(
        demoted, edges["affinity"] * 0.35, edges["affinity"]).astype(np.float32)
    return int(demoted.sum())


# --------------------------------------------------------------------------
# negative ties and stubs


def estrange(edges, people, rng):
    """Kin who no longer speak, with nothing on paper to say why."""
    size = len(people["age"])
    valence = np.ones(len(edges["a"]), np.int8)
    # Kin ties never reach a stub, so clamp the index and mask on residency
    # rather than branching the whole pass.
    both = (edges["a"] < size) & (edges["b"] < size)
    a = np.where(both, edges["a"], 0)
    b = np.where(both, edges["b"], 0)
    at_home = both & (people["household"][a] == people["household"][b])
    adult = both & (people["age"][a] >= 21) & (people["age"][b] >= 21)
    for kind, rate in ESTRANGED.items():
        mask = (edges["kind"] == KIND[kind]) & ~at_home & adult
        hit = mask & (rng.random(len(mask)) < rate)
        valence[hit] = -1
        edges["affinity"][hit] *= 0.06
        edges["exposure"][hit] *= 0.05
    edges["valence"] = valence
    return int((valence < 0).sum())


def dissolutions(people, identities, rng):
    """Ex-partners, and the co-parenting that outlives them.

    Most ex-partners of Kierston residents are not in Kierston, so only a
    fifth resolve to a resident; the rest are stubs. The ones with a child in
    common keep a live tie at low affinity, because logistics do not care how
    the marriage ended.
    """
    block = []
    ids = np.flatnonzero(people["present"])
    pool = ids[(people["age"][ids] >= 24)]
    for person in pool:
        record = identities.get(str(int(person))) or identities.get(int(person))
        if not record:
            continue
        status = record["marital"]["status"]
        if status not in ("divorced", "separated"):
            continue
        if rng.random() >= EX_PARTNER_IN_CITY:
            continue
        # Somebody plausible: an adult of the other sex within a decade.
        window = pool[(np.abs(people["age"][pool].astype(np.int32)
                              - int(people["age"][person])) <= 10)
                      & (people["sex"][pool] != people["sex"][person])]
        if not len(window):
            continue
        other = int(window[rng.integers(len(window))])
        if other != int(person):
            block.append((int(person), other))
    return block


def abroad(people, identities, rng):
    """Family left behind, as stubs. The other end of a remittance."""
    block, stubs = [], []
    node = ABROAD_BASE
    for person in np.flatnonzero(people["present"]):
        record = identities.get(str(int(person)))
        if not record or record["birth_region"] == "us":
            continue
        rate = ABROAD_RATE.get(record["citizenship"], 0.4)
        entry = record.get("entry_year")
        if entry and YEAR - entry <= ABROAD_RECENT:
            rate *= 1.8
        for _ in range(rng.poisson(rate)):
            stubs.append({"id": node, "region": record["birth_region"],
                          "of": int(person)})
            block.append((int(person), node))
            node += 1
    return block, stubs


def former_colleagues(records, people, rng):
    """A retained tie from a job since left, for people with a history."""
    block, stubs = [], []
    node = FORMER_BASE
    tenure = {}
    for record in records:
        if record["class"] == "work":
            tenure[record["person"]] = YEAR - record["since"]
    for person, years in tenure.items():
        if years < EX_COLLEAGUE_TENURE or not people["present"][person]:
            continue
        for _ in range(rng.poisson(EX_COLLEAGUE_RATE)):
            stubs.append({"id": node, "of": person})
            block.append((person, node))
            node += 1
    return block, stubs


# --------------------------------------------------------------------------
# output


def write(edges, stubs, seed, tiers, intercepts):
    columns = {
        "a": edges["a"].astype(np.int32),
        "b": edges["b"].astype(np.int32),
        "kind": edges["kind"].astype(np.uint8),
        "focus": edges["focus"].astype(np.uint16),
        "exposure": np.clip(edges["exposure"] * 255, 0, 255).astype(np.uint8),
        "affinity": np.clip(edges["affinity"] * 255, 0, 255).astype(np.uint8),
        "valence": edges["valence"].astype(np.int8),
        "since": edges["since"].astype(np.uint16),
    }
    header = {
        "magic": "KTIE",
        "seed": seed,
        "reference_year": YEAR,
        "edges": int(len(edges["a"])),
        "kinds": list(KINDS),
        "foci": list(FOCI),
        "tiers": [[round(cut, 4), name] for cut, name in tiers],
        "external_base": EXTERNAL_BASE,
        "abroad_base": ABROAD_BASE,
        "former_base": FORMER_BASE,
        "intercepts": {k: round(v, 3) for k, v in intercepts.items()},
        "stubs": stubs,
        "columns": [{"name": name, "dtype": column.dtype.str}
                    for name, column in columns.items()],
    }
    blob = json.dumps(header, separators=(",", ":")).encode()
    with TIES.open("wb") as out:
        out.write(b"KTIE")
        out.write(len(blob).to_bytes(4, "little"))
        out.write(blob)
        pad = -(8 + len(blob)) % 8
        out.write(b"\0" * pad)
        for column in columns.values():
            out.write(column.tobytes())


def report(edges, people, tiers, intercepts, demoted, negative):
    total = len(edges["a"])
    resident = edges["b"] < EXTERNAL_BASE
    size = len(people["age"])
    print(f"{total:,} ties, {int(resident.sum()):,} between residents")

    degree = np.bincount(edges["a"][resident], minlength=size)
    degree += np.bincount(edges["b"][resident], minlength=size)
    live = degree[people["present"]]
    print(f"degree: mean {live.mean():.1f}, median {np.median(live):.0f}, "
          f"p90 {np.percentile(live, 90):.0f}, max {live.max():,}, "
          f"{int((live == 0).sum()):,} isolated")

    print("\n  tier            ties    per person")
    floors = list(tiers)
    for i, (floor, name) in enumerate(floors):
        ceiling = floors[i - 1][0] if i else 1.01
        band = ((edges["affinity"] >= floor) & (edges["affinity"] < ceiling)
                & (edges["valence"] > 0))
        print(f"  {name:<14}{int(band.sum()):>9,}{band.sum() * 2 / size:>13.1f}")

    friend_cut = [cut for cut, name in tiers if name == "friend"][0]
    print("\n  provenance        ties   mean exp   mean aff   friend+")
    for i, name in enumerate(KINDS):
        mask = edges["kind"] == i
        if not mask.any():
            continue
        friend = float(np.mean(edges["affinity"][mask] >= friend_cut))
        print(f"  {name:<14}{int(mask.sum()):>9,}"
              f"{edges['exposure'][mask].mean():>11.2f}"
              f"{edges['affinity'][mask].mean():>11.2f}{friend:>10.1%}")

    multi = edges["focus"]
    bits = np.zeros(len(multi), np.int8)
    for i in range(len(FOCI)):
        bits += ((multi >> i) & 1).astype(np.int8)
    print(f"\n{int((bits > 1).sum()):,} ties are multiplex "
          f"({(bits > 1).mean():.1%}); "
          f"{demoted:,} demoted over budget; "
          f"{negative:,} negative")

    # Neighbours by schedule. The whole point of at_home() is that these
    # differ, so print them: two people who are in all day should be at the top
    # and a day shift against an evening shift at the bottom, because they
    # overlap for about an hour before either of them is awake.
    band = np.zeros(size, np.int8)
    hour = (people["depart"] % (24 * 60)) // 60
    band = np.where(people["depart"] < 0, 0,
                    np.where(hour < 4, 3, np.where(hour < 11, 1,
                             np.where(hour < 18, 2, 3))))
    labels = ("in all day", "day", "evening", "night")
    near = (edges["kind"] == KIND["neighbour"]) & resident
    a, b = edges["a"][near], edges["b"][near]
    print("\n  neighbors, by pair of schedules")
    rows = []
    for i in range(4):
        for j in range(i, 4):
            pick = (((band[a] == i) & (band[b] == j))
                    | ((band[a] == j) & (band[b] == i)))
            if pick.sum() < 200:
                continue
            rows.append((float(edges["exposure"][near][pick].mean()),
                         f"{labels[i]} / {labels[j]}", int(pick.sum())))
    for mean, label, count in sorted(rows, reverse=True):
        print(f"  {label:<26}{count:>9,}{mean:>9.2f}")

    # Clustering, on a sample. The number every synthetic social graph gets
    # wrong: draw edges independently and it lands near zero, where a real one
    # sits between 0.15 and 0.3. It is the clearest single test of whether the
    # foci and the closure pass did their job.
    friend_cut = [cut for cut, name in tiers if name == "friend"][0]
    start, neighbours = adjacency(edges, size, friend_cut)
    degrees = np.diff(start)
    pool = np.flatnonzero((degrees >= 2) & people["present"])
    if len(pool):
        sample = np.random.default_rng(0).choice(
            pool, min(3000, len(pool)), replace=False)
        local = []
        for person in sample:
            near = set(neighbours[start[person]:start[person + 1]].tolist())
            if len(near) < 2:
                continue
            pairs_here = len(near) * (len(near) - 1) / 2
            closed = sum(
                len(near & set(neighbours[start[o]:start[o + 1]].tolist()))
                for o in near) / 2
            local.append(closed / pairs_here)
        print(f"clustering coefficient {np.mean(local):.3f} "
              f"(friendship subgraph, {len(local):,} sampled)")

    # Homophily, as the correlation the graph achieved rather than the one it
    # was asked for. Both should land positive and moderate.
    strong = (edges["affinity"] >= friend_cut) & resident
    a, b = edges["a"][strong], edges["b"][strong]
    if len(a) > 1:
        age = np.corrcoef(people["age"][a], people["age"][b])[0, 1]
        same = float(np.mean(people["eth"][a] == people["eth"][b]))
        print(f"friendships: age correlation {age:+.2f}, "
              f"same ethnicity {same:.1%}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()
    rng = np.random.default_rng(args.seed)

    people = load_people()
    coords = load_dwelling_coords()
    identities = json.loads(IDENTITY.read_text())["identities"]

    pairs = Pairs()
    from_households(people, pairs)
    from_kinship(people, pairs, rng)
    records = from_affiliations(people, pairs, rng)
    from_neighbours(people, coords, pairs, rng)
    from_elsewhere(people, pairs, rng)

    size = len(people["age"])
    sociability = rng.normal(0, SOCIABILITY_SD, size).astype(np.float32)

    raw = pairs.stack()
    print(f"{len(raw['a']):,} candidate pairs from foci")
    edges = merge(raw)
    edges, intercepts = draw(edges, people, sociability, rng)
    print(f"{len(edges['a']):,} realized")

    # Closure and dissolution are still resident-to-resident and are scored
    # the same way; the stub passes are not.
    extra = Pairs()
    friend_cut = [cut for cut, name in cuts(edges["affinity"], size)
                  if name == "friend"][0]
    triangles = closure(edges, people, friend_cut, rng)
    if triangles is not None:
        extra.add(triangles, FOCUS["elsewhere"], KIND["elsewhere"],
                  CLOSURE_EXPOSURE, 1.0)
    extra.add(dissolutions(people, identities, rng),
              FOCUS["kin"], KIND["ex_partner"], 0.05, 1.0)
    second, _ = draw(merge(extra.stack()), people, sociability, rng)
    print(f"{len(second['a']):,} from closure and dissolution")

    outward = Pairs()
    abroad_block, abroad_stubs = abroad(people, identities, rng)
    outward.add(abroad_block, FOCUS["abroad"], KIND["abroad"], 0.01, 1.0)
    former_block, former_stubs = former_colleagues(records, people, rng)
    outward.add(former_block, FOCUS["elsewhere"], KIND["ex_colleague"],
                0.01, 1.0)
    third = draw_stubs(outward.stack(), rng)
    print(f"{len(third['a']):,} to stubs beyond the city")

    edges = merge_final({
        name: np.concatenate([edges[name], second[name], third[name]])
        for name in ("a", "b", "kind", "focus", "exposure", "affinity",
                     "since", "multiplex")})

    intercepts = retune(edges, size, rng)
    demoted = budget(edges, people, rng)
    negative = estrange(edges, people, rng)

    # An ex-partner is negative by construction, and keeps a live tie only
    # where a child makes one necessary.
    ex = edges["kind"] == KIND["ex_partner"]
    edges["valence"][ex] = -1
    edges["affinity"][ex] = np.minimum(edges["affinity"][ex], COPARENT_AFFINITY)

    tiers = cuts(edges["affinity"], size)
    report(edges, people, tiers, intercepts, demoted, negative)
    write(edges, {"abroad": abroad_stubs, "former": former_stubs},
          args.seed, tiers, intercepts)
    print(f"\nWrote {TIES} ({TIES.stat().st_size / 1e6:.1f} MB)")


def merge_final(edges):
    """Second merge, after closure and the stub passes have added pairs."""
    order = np.lexsort((edges["b"], edges["a"]))
    edges = {name: column[order] for name, column in edges.items()}
    key = edges["a"] * (1 << 23) + edges["b"]
    start = np.empty(len(key), bool)
    start[0] = True
    np.not_equal(key[1:], key[:-1], out=start[1:])
    group = np.cumsum(start) - 1
    count = int(group[-1]) + 1
    out = {"a": edges["a"][start], "b": edges["b"][start],
           "kind": edges["kind"][start], "since": edges["since"][start]}
    for name in ("exposure", "affinity"):
        out[name] = np.zeros(count, np.float32)
        np.maximum.at(out[name], group, edges[name])
    out["focus"] = np.zeros(count, np.uint16)
    np.bitwise_or.at(out["focus"], group, edges["focus"])
    out["multiplex"] = edges["multiplex"][start]
    return out


if __name__ == "__main__":
    main()
