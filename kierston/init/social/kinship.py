"""Build parent, sibling and partner links for Kierston residents.

PUMS records one relationship per person and it is a relationship to the
householder, not to anybody else. That is a star, not a family: person 4 is the
householder's grandchild and the file never says which of the two adult
children in the room is their mother. So the graph is built in two passes that
do quite different work.

  the household   RELSHIPP resolved into edges. The star is free; everything
                  else is inference over age, sex and sporder — which of the
                  couple is the mother, whether the partner is a birth parent
                  or a stepparent, which resident child the grandchild belongs
                  to, and which siblings share both parents rather than one.
  the city        Everyone still needs the parents they do not live with. Each
                  unfilled slot draws an age at birth, asks a life table
                  whether that person is still alive, and asks whether they
                  live in Kierston at all. Only what survives both is matched
                  against the actual population, under age, ethnicity,
                  proximity and — the constraint that matters — a cap on how
                  many children any one person can absorb.

The cap is the whole reason this is a matching problem rather than a search.
Resolve each child independently against "some plausible woman" and the result
is arithmetically fine and demographically absurd: one 44-year-old ends up the
mother of eleven people scattered across five neighbourhoods, each of whom she
was individually a reasonable answer for. Parity is drawn once per person, the
children they already live with count against it, and the rest is a budget.

Slots are shared before they are matched. Two people the household pass has
already established as full siblings hold one mother slot between them, so
whatever resolves it resolves it for both — matched to the same woman, or
stubbed out to the same absent one. Doing it per person would give brothers
different mothers, which is the failure mode this layer exists to avoid.

Most slots do not resolve in the city, and that is the correct answer rather
than a shortfall. A 70-year-old's parents are dead; a 30-year-old's parents are
usually two towns over. Kierston is five kilometres across and does not contain
its own ancestry. Those become external stubs, the same shape as the boundary
portals assign_work gives the tenth of the workforce that commutes out of the
region — a node that exists, carries a sex and a birth year and a name, and is
not a resident.

This runs before identity.py because names are downstream of it, not evidence
for it. Surnames in names.py are generated *from* RELSHIPP, so mining them for
kinship would recover nothing but the rule that put them there. With the graph
in hand the transmission runs the right way round, and the Hispanic maternal
surname — the child's mother's own paternal name — starts holding across three
generations instead of one household.
"""

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from personal_records import registries
from personal_records.registries import keyed


from paths import SIM_DATA  # noqa: E402
POPULATION = SIM_DATA / "population.json"
DWELLINGS = SIM_DATA / "dwellings.json"
OUTPUT = SIM_DATA / "kinship.json"

DEFAULT_SEED = 20260731
YEAR = registries.REFERENCE_YEAR

# External parents live above every real person id, so a parent reference is
# one integer whichever kind it points at and `id >= EXTERNAL_BASE` is the only
# test anything downstream needs.
EXTERNAL_BASE = 1_000_000

# RELSHIPP, as this stage reads it.
HEAD = 20
SPOUSES = {21, 23}
PARTNERS = {22, 24}
SAME_SEX = {23, 24}
CONSORTS = SPOUSES | PARTNERS
CHILD_KIND = {25: "birth", 26: "adoptive", 27: "step", 35: "foster"}
# Kinds that sit beside a birth parent rather than replacing one. An adoptive
# parent is the only parent the records admit to and holds the primary slot;
# a stepparent or a foster parent does not, and the birth parent they stand in
# for is still out there to be matched or stubbed.
STEP_KINDS = {"step", "foster"}
SIBLING = 28
PARENT = 29
GRANDCHILD = 30
PARENT_IN_LAW = 31
CHILD_IN_LAW = 32

# The smallest parent-child age gap this accepts from the survey. PUMS asserts
# the relationship and is believed, but a handful of rows put ten years between
# a parent and their child, and an edge that implies a nine-year-old mother is
# worse than a missing edge. Below this the edge is dropped and the slot goes
# to the second pass like any other.
MIN_GAP = 13

# Age at birth, for a parent the survey did not record. Weights are the
# national age-specific fertility pattern flattened over the century — the
# distribution has moved later since 1960 and this does not move with it, which
# puts a few too many 1955 mothers in their thirties. Worth the simplification:
# the alternative is a birth-year-conditioned table whose extra fidelity lands
# entirely on people who are dead by the reference year.
MOTHER_AGE = ((15, 19, 0.06), (20, 24, 0.22), (25, 29, 0.29),
              (30, 34, 0.26), (35, 39, 0.13), (40, 45, 0.04))
FATHER_AGE = ((16, 19, 0.02), (20, 24, 0.14), (25, 29, 0.26),
              (30, 34, 0.27), (35, 39, 0.18), (40, 49, 0.11), (50, 60, 0.02))

# Probability of still being alive at an age, by sex. A rough period life
# table; the gap between the two columns after 75 is the reason a grandmother
# is a far more available match than a grandfather.
SURVIVAL = {
    1: ((40, 0.97), (50, 0.94), (60, 0.88), (65, 0.83), (70, 0.76),
        (75, 0.65), (80, 0.50), (85, 0.32), (90, 0.15), (95, 0.05), (110, 0.0)),
    2: ((40, 0.98), (50, 0.96), (60, 0.92), (65, 0.89), (70, 0.84),
        (75, 0.75), (80, 0.62), (85, 0.44), (90, 0.24), (95, 0.09), (110, 0.0)),
}

# Given a living parent who is not in the household, the chance they live
# inside the extract at all. Kierston is a five-kilometre radius sitting inside
# a metro of 900,000, so most of the "nearby" parents national surveys count
# are near but not here. This is the single knob that decides how dense the
# cross-household graph gets, and it is a guess anchored on shape rather than
# on a statistic: at 0.30 a young adult usually has one parent in the city and
# rarely both, which is what the household composition already implies.
PARENT_IN_CITY = 0.30

# Children ever born, per person. Coresident children count against it, so a
# woman living with three is already at her cap under the common draw and can
# take no more; this is what stops the matcher handing out a fourth from across
# town. Fathers get the same shape with a longer tail, since the men with the
# most children are older than the women with the most and had them over a
# wider window.
PARITY = {
    1: ((0, 0.19), (1, 0.17), (2, 0.32), (3, 0.19), (4, 0.08), (5, 0.03),
        (6, 0.02)),
    2: ((0, 0.15), (1, 0.18), (2, 0.35), (3, 0.20), (4, 0.08), (5, 0.03),
        (6, 0.01)),
}

# The widest age spread a set of people can have and still be read as siblings
# where the survey does not say so outright. Twenty-two years is generous — it
# is most of one woman's fertile span — and generous is the right side to err
# on, because the alternative reading is that four people with the same
# relationship to the same householder arrived by unrelated routes.
SIBLING_SPAN = 22

# The chance the householder's partner is not the other birth parent of a child
# the survey calls the householder's own. Stepfamilies are the reason; PUMS
# flags a stepchild of the *householder* and has no way to flag one of the
# partner. Unmarried partners are much more often a second relationship, and a
# same-sex partner is never the other birth parent, so those children get an
# adoptive edge instead.
STEPPARENT = {21: 0.18, 23: 0.18, 22: 0.52, 24: 0.52}

# A stepchild of the householder is usually the partner's birth child, which is
# what makes them a stepchild. Not always — some arrive from a relationship
# that predates the current partner too.
STEP_FROM_PARTNER = 0.86

# Having matched a mother, the chance the father slot resolves to her partner
# rather than being matched on its own. Below 1.0 because children whose
# parents both live in the city but not with each other are exactly the records
# that make a family reconstruction hard, and there should be some.
COUPLED = 0.74

# Distance decay on the match, in km. Adult children cluster near their
# parents and this is the only thing in the stage that makes the kin graph
# spatial; without it the matcher would wire a grandmother on one edge of the
# extract to a household on the other as readily as to her neighbour.
PROXIMITY_KM = 1.9

# Candidates drawn per slot. Each is a birth year sampled from the age-at-birth
# distribution and then a random person of that year, so the sample is already
# concentrated where the answer should be and 48 is enough to choose from.
CANDIDATES = 48

# Relative weight on a candidate whose race_ethnicity differs from the child's.
# Not zero: mixed parentage is how nh_two_or_more people come to exist, and a
# hard filter would make every one of them unmatchable.
CROSS_ETHNICITY = 0.06
MIXED = "nh_two_or_more"
MIXED_WEIGHT = 0.45

# Whether an unmatched slot is worth writing down. A stub is only useful if
# something refers to it more than once or if the person could still be
# knocked on a door — a sibship shares one, and a living parent elsewhere is
# somebody a record could name. The dead parent of an only child explains
# nothing that a drawn surname does not already explain, so it is left out
# rather than adding 90,000 nodes nothing points at twice.
STUB_SINGLETONS = False


# ---------------------------------------------------------------------------
# Small numeric helpers
# ---------------------------------------------------------------------------

def km(a, b):
    """Equirectangular distance in km, same as the other social stages."""
    x = math.radians(b[1] - a[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    y = math.radians(b[0] - a[0])
    return 6371.0 * math.hypot(x, y)


def survival(sex, age):
    """Probability someone of this sex is alive at this age."""
    table = SURVIVAL[sex]
    if age < table[0][0]:
        return 1.0
    previous_age, previous = table[0]
    for top, value in table:
        if age <= top:
            span = top - previous_age
            if span <= 0:
                return value
            share = (age - previous_age) / span
            return previous + (value - previous) * share
        previous_age, previous = top, value
    return 0.0


def age_bands(sex):
    """The age-at-birth table for a parent of this sex."""
    return MOTHER_AGE if sex == 2 else FATHER_AGE


def draw_age_at_birth(sex, rng):
    """An age at which this person had a child."""
    table = age_bands(sex)
    target = rng.random() * sum(row[2] for row in table)
    running = 0.0
    for low, high, weight in table:
        running += weight
        if target <= running:
            return rng.randint(low, high)
    return rng.randint(*table[-1][:2])


def age_limits(sex):
    """(youngest, oldest) a parent of this sex can be at a birth."""
    table = age_bands(sex)
    return table[0][0], table[-1][1]


def draw_parity(sex, rng):
    """How many children this person has, ever."""
    table = PARITY[sex]
    target = rng.random() * sum(w for _, w in table)
    running = 0.0
    for count, weight in table:
        running += weight
        if target <= running:
            return count
    return table[-1][0]


# ---------------------------------------------------------------------------
# Pass one: the household
# ---------------------------------------------------------------------------

class Graph:
    """Edges and unfilled slots, accumulated across the whole city.

    `parents[child]` is the answer this stage exists to produce. `slots` holds
    what pass one could not fill; each is a role plus the set of children who
    share it, and pass two turns every one of them into a person or a stub.
    """

    def __init__(self):
        self.parents = defaultdict(list)
        self.partners = []
        self.slots = []
        self.resident_children = Counter()

    def link(self, child, parent, role, kind, basis):
        """Record one parent edge, unless that role and tier is already taken.

        A person can hold four edges, not two: a stepmother does not displace
        the mother, she sits beside her, and a record that had to choose would
        lose whichever one it was not asked about. What cannot repeat is a
        second birth mother, so the key is the role and the tier together.
        """
        step = kind in STEP_KINDS
        if any(edge["role"] == role and (edge["kind"] in STEP_KINDS) == step
               for edge in self.parents[child]):
            return False
        self.parents[child].append(
            {"id": parent, "role": role, "kind": kind, "basis": basis})
        if basis == "household":
            self.resident_children[parent] += 1
        return True

    def has(self, child, role):
        """Is the birth (or adoptive) parent in this role already known?"""
        return any(edge["role"] == role and edge["kind"] not in STEP_KINDS
                   for edge in self.parents[child])

    def slot(self, children, role, kind="birth"):
        if children:
            self.slots.append({"children": list(children), "role": role,
                               "kind": kind})


def role_of(person):
    """mother or father, from sex. PUMS codes 1 male, 2 female."""
    return "mother" if person["sex"] == 2 else "father"


def plausible(parent, child):
    """Is this age gap one a parent and child could actually have?"""
    return parent["age"] - child["age"] >= MIN_GAP


def blended(consort, rng):
    """Is the partner a stepparent to the householder's own children?

    Drawn once for the household and not once per child, which is the
    difference between a stepfamily and a household where the same man is one
    boy's father and the next boy's stepfather. The first exists; the second
    does not, and drawing per child produces it several thousand times.
    """
    if consort is None:
        return False
    if consort["relationship"] in SAME_SEX:
        return True
    return rng.random() < STEPPARENT[consort["relationship"]]


def couple_parents(child, head, consort, blend, graph, rng):
    """Attach the householder and their partner to a child of the household.

    The householder's own relationship to the child is the surveyed one. The
    partner's is not surveyed at all, and the three ways it can go — the other
    birth parent, a stepparent, or the birth parent in the case where the
    householder is the stepparent — are what `blend` and STEP_FROM_PARTNER
    divide between.
    """
    kind = CHILD_KIND[child["relationship"]]

    if plausible(head, child):
        graph.link(child["id"], head["id"], role_of(head), kind, "household")

    if consort is None or not plausible(consort, child):
        return

    if kind == "step":
        # The householder is the stepparent here, so the partner is usually the
        # one the child came with.
        partner_kind = ("birth" if rng.random() < STEP_FROM_PARTNER
                        else "step")
    elif not blend:
        partner_kind = kind
    elif consort["relationship"] in SAME_SEX:
        # Whatever the survey calls the householder, only one of a same-sex
        # couple can be the birth parent.
        partner_kind = "adoptive"
    else:
        partner_kind = "step"

    graph.link(child["id"], consort["id"], role_of(consort), partner_kind,
               "household")


def resolve_household(members, graph, rng):
    """Turn one household's RELSHIPP star into edges and shared slots."""
    by_relationship = defaultdict(list)
    for member in members:
        by_relationship[member["relationship"]].append(member)

    heads = by_relationship.get(HEAD)
    if not heads:
        return
    head = heads[0]
    consorts = [m for r in CONSORTS for m in by_relationship.get(r, [])]
    consort = consorts[0] if consorts else None
    if consort is not None:
        graph.partners.append(
            [head["id"], consort["id"],
             "spouse" if consort["relationship"] in SPOUSES else "partner"])

    # -- the householder's children ---------------------------------------
    children = [m for r in CHILD_KIND for m in by_relationship.get(r, [])]
    blend = blended(consort, rng)
    for child in children:
        couple_parents(child, head, consort, blend, graph, rng)

    # -- the householder's own parents ------------------------------------
    # A resident parent is the one cross-generation edge the survey states
    # outright, and it is worth as much as all the children put together: it is
    # what gives the graph a third layer without any matching at all.
    for parent in by_relationship.get(PARENT, []):
        if plausible(parent, head):
            graph.link(head["id"], parent["id"], role_of(parent), "birth",
                       "household")
    for parent in by_relationship.get(PARENT_IN_LAW, []):
        if consort is not None and plausible(parent, consort):
            graph.link(consort["id"], parent["id"], role_of(parent), "birth",
                       "household")

    # -- siblings of the householder --------------------------------------
    # They have the householder's parents, whoever those turn out to be. Where
    # a parent is resident the edge is immediate; where it is not, the sibling
    # joins the householder's slot rather than opening one of their own.
    siblings = by_relationship.get(SIBLING, [])
    for sibling in siblings:
        for edge in list(graph.parents[head["id"]]):
            if edge["id"] in {m["id"] for m in members}:
                resident = next(m for m in members if m["id"] == edge["id"])
                if plausible(resident, sibling):
                    graph.link(sibling["id"], edge["id"], edge["role"],
                               "birth", "household")

    # -- children-in-law and grandchildren --------------------------------
    # A child-in-law is married to one of the resident children; pairing them
    # by age is a guess, but an unpaired one leaves the grandchildren with a
    # father nobody can name.
    in_laws = list(by_relationship.get(CHILD_IN_LAW, []))
    pairs = {}
    available = [c for c in children if c["age"] >= 16]
    for in_law in in_laws:
        mates = [c for c in available
                 if c["id"] not in pairs and abs(c["age"] - in_law["age"]) <= 18
                 and c["sex"] != in_law["sex"]]
        if not mates:
            mates = [c for c in available if c["id"] not in pairs]
        if mates:
            mate = min(mates, key=lambda c: abs(c["age"] - in_law["age"]))
            pairs[mate["id"]] = in_law
            graph.partners.append([mate["id"], in_law["id"], "spouse"])

    # The youngest plausible resident child takes the grandchildren: in a
    # three-generation household they are the one who has not moved out with
    # them yet. Grandchildren landing on the same resident parent are siblings,
    # so they are grouped and share whatever slot is left over.
    grandchildren = defaultdict(list)
    for grandchild in by_relationship.get(GRANDCHILD, []):
        candidates = [c for c in children if plausible(c, grandchild)]
        if not candidates:
            continue
        parent = min(candidates, key=lambda c: c["age"])
        grandchildren[parent["id"]].append(grandchild)
        graph.link(grandchild["id"], parent["id"], role_of(parent), "birth",
                   "household")
        mate = pairs.get(parent["id"])
        if mate is not None and plausible(mate, grandchild):
            graph.link(grandchild["id"], mate["id"], role_of(mate), "birth",
                       "household")

    # -- what is left ------------------------------------------------------
    # Sibships, so that everyone the pass above established as a full sibling
    # holds one slot with the others rather than one of their own.
    sibships = defaultdict(list)
    for child in children:
        kind = CHILD_KIND[child["relationship"]]
        # Only birth and adoptive children of the same couple are full
        # siblings. A stepchild and a foster child each stand alone: the
        # household says nothing about who else shares their absent parent.
        key = kind if kind in ("birth", "adoptive") else ("solo", child["id"])
        sibships[key].append(child)
    sibships[("head",)] = [head] + siblings
    if consort is not None:
        sibships[("consort", consort["id"])] = [consort]
    for parent_id, group in grandchildren.items():
        sibships[("grand", parent_id)] = group
    placed = {m["id"] for group in sibships.values() for m in group}
    # Everyone the pass above did not place. Most of them stand alone, but two
    # codes are worth grouping: several grandchildren with no resident parent,
    # or several `other relative`s close in age, are far more often one set of
    # siblings than they are unrelated people who each turned up separately.
    # Left solo they get a slot each, four different fathers and four different
    # surnames in one house, which is the shape this whole layer exists to stop
    # producing.
    for relationship in (GRANDCHILD, 33):
        group = [m for m in by_relationship.get(relationship, [])
                 if m["id"] not in placed]
        if len(group) > 1 and max(m["age"] for m in group) - min(
                m["age"] for m in group) <= SIBLING_SPAN:
            sibships[("group", relationship)] = group
            placed |= {m["id"] for m in group}

    for other in members:
        if other["id"] not in placed:
            sibships[("solo", other["id"])] = [other]

    for group in sibships.values():
        for role in ("mother", "father"):
            wanting = [m for m in group if not graph.has(m["id"], role)]
            graph.slot(wanting, role)


# ---------------------------------------------------------------------------
# Pass two: the city
# ---------------------------------------------------------------------------

class Supply:
    """Who is available to be somebody's parent, and how much room they have.

    Indexed by (sex, birth year) so a slot with a birth-year window can sample
    straight out of the years it wants instead of filtering the city.
    """

    def __init__(self, people, homes, resident_children, seed):
        self.people = people
        self.homes = homes
        self.by_year = defaultdict(list)
        self.capacity = {}
        self.drawn = {}
        for person in people.values():
            if person["age"] < 16:
                continue
            rng = keyed(seed, person["id"], "parity")
            parity = draw_parity(person["sex"], rng)
            self.drawn[person["id"]] = parity
            resident = resident_children.get(person["id"], 0)
            # Never below what they already live with: the survey is the
            # authority on those and a drawn parity that disagrees is the
            # thing that is wrong.
            self.capacity[person["id"]] = max(0, parity - resident)
            self.by_year[(person["sex"], person["birth_year"])].append(
                person["id"])

    def spare(self, person_id):
        return self.capacity.get(person_id, 0)

    def take(self, person_id, count):
        """Spend `count` of a person's remaining parity.

        A slot is a set of siblings and costs one place per child, not one per
        slot. Charging it once was the first version and it is why a woman with
        room for two ended up with a matched sibship of four.
        """
        self.capacity[person_id] = max(
            0, self.capacity.get(person_id, 0) - count)

    def sample(self, sex, low_year, high_year, rng):
        """Candidate ids, drawn from the years a parent could have been born.

        Years are picked through the age-at-birth distribution rather than
        uniformly, so a slot is offered the parents it should mostly get and
        the tails stay reachable.
        """
        years = [y for y in range(low_year, high_year + 1)
                 if (sex, y) in self.by_year]
        if not years:
            return []
        # Weight each year by how much of the fertility distribution lands on
        # it, relative to the reference birth used to build the window.
        weights = []
        for year in years:
            age_at_birth = high_year + age_limits(sex)[0] - year
            weights.append(band_weight(sex, age_at_birth))
        if sum(weights) <= 0:
            weights = [1.0] * len(years)

        out = []
        for year in rng.choices(years, weights=weights, k=CANDIDATES):
            pool = self.by_year[(sex, year)]
            out.append(pool[rng.randrange(len(pool))])
        return out


def band_weight(sex, age_at_birth):
    """The share of births this parent age carries, per year of age."""
    for low, high, weight in age_bands(sex):
        if low <= age_at_birth <= high:
            return weight / (high - low + 1)
    return 0.0


def ethnic_weight(parent, child_ethnicity):
    """How much a candidate of this ethnicity suits a child of that one."""
    if parent["race_ethnicity"] == child_ethnicity:
        return 1.0
    if child_ethnicity == MIXED or parent["race_ethnicity"] == MIXED:
        return MIXED_WEIGHT
    return CROSS_ETHNICITY


def match(slot, supply, homes_of, seed, index):
    """Find an in-city parent for one slot, or None.

    The birth-year window is the intersection of what every child in the slot
    allows: a woman has to have been young enough at the youngest child's birth
    and old enough at the eldest's.
    """
    rng = keyed(seed, index, "match")
    role = slot["role"]
    sex = 2 if role == "mother" else 1
    youngest, oldest = age_limits(sex)

    births = [child["birth_year"] for child in slot["children"]]
    first, last = min(births), max(births)
    low_year = last - oldest       # born no earlier than this
    high_year = first - youngest   # and no later than this
    if low_year > high_year:
        return None

    home = homes_of(slot["children"][0])
    ethnicity = slot["children"][0]["race_ethnicity"]
    households = {child.get("household") for child in slot["children"]}
    kin = {child["id"] for child in slot["children"]}

    best, weights = [], []
    for candidate_id in supply.sample(sex, low_year, high_year, rng):
        if candidate_id in kin:
            continue
        candidate = supply.people[candidate_id]
        # Somebody sharing the address would have been surveyed as a parent.
        # If they were not, they are not one.
        if candidate.get("household") in households:
            continue
        spare = supply.spare(candidate_id)
        if spare < len(slot["children"]):
            continue
        weight = spare * ethnic_weight(candidate, ethnicity)
        if weight <= 0:
            continue
        other = homes_of(candidate)
        if home and other:
            weight *= math.exp(-km(home, other) / PROXIMITY_KM)
        best.append(candidate_id)
        weights.append(weight)

    if not best:
        return None
    return rng.choices(best, weights=weights, k=1)[0]


def resolve_slots(graph, people, supply, homes_of, partner_of, seed):
    """Turn every unfilled slot into a matched person or an external stub.

    Mother slots go first so a father slot can resolve to her partner, which is
    how a matched couple ends up being a couple rather than two unrelated
    people who happen to have been picked for the same child.
    """
    externals = []
    mothers = {}
    order = sorted(range(len(graph.slots)),
                   key=lambda i: (graph.slots[i]["role"] != "mother", i))

    for index in order:
        slot = graph.slots[index]
        rng = keyed(seed, index, "slot")
        sex = 2 if slot["role"] == "mother" else 1
        children = slot["children"]
        eldest = max(children, key=lambda c: c["age"])

        age_at_birth = draw_age_at_birth(sex, rng)
        birth_year = eldest["birth_year"] - age_at_birth
        age_now = YEAR - birth_year

        key = tuple(sorted(child["id"] for child in children))
        chosen = None

        if rng.random() < survival(sex, age_now):
            # A living parent. The partner of a mother already matched for
            # these same children is the first thing to try.
            if slot["role"] == "father":
                mate = partner_of.get(mothers.get(key))
                if (mate is not None and supply.spare(mate) >= len(children)
                        and people[mate]["sex"] == 1
                        and all(people[mate]["age"] - c["age"] >= MIN_GAP
                                for c in children)
                        and rng.random() < COUPLED):
                    chosen = mate
            if chosen is None and rng.random() < PARENT_IN_CITY:
                chosen = match(slot, supply, homes_of, seed, index)
            status = "elsewhere"
        else:
            status = "deceased"

        if chosen is not None:
            supply.take(chosen, len(children))
            if slot["role"] == "mother":
                mothers[key] = chosen
            for child in children:
                graph.link(child["id"], chosen, slot["role"], slot["kind"],
                           "matched")
            continue

        if len(children) < 2 and not STUB_SINGLETONS:
            continue

        stub = {
            "id": EXTERNAL_BASE + len(externals),
            "sex": sex,
            "birth_year": birth_year,
            "race_ethnicity": eldest["race_ethnicity"],
            "status": status,
            "children": len(children),
        }
        externals.append(stub)
        for child in children:
            graph.link(child["id"], stub["id"], slot["role"], slot["kind"],
                       "external")

    return externals


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def report(graph, people, externals, supply):
    total = len(people)
    counts = Counter(len(graph.parents.get(p, ())) for p in people)
    print("parent edges, per person (three and four are stepparents):")
    for known in sorted(counts):
        n = counts[known]
        print(f"  {known}  {n:>8,}  {n / total * 100:5.1f}%")

    # The figure above is dominated by adults and says little on its own. What
    # it should look like by age is the real check: a child living at home has
    # both parents because the survey said so, and a 70-year-old has neither
    # because they are dead. A flat line across the ages would mean the life
    # table is not being consulted.
    bands = ((17, "0-17"), (34, "18-34"), (54, "35-54"), (74, "55-74"),
             (999, "75+"))
    print("\n  by age, share with a birth parent known:")
    for top, label in bands:
        low = 0 if label == "0-17" else int(label.split("-")[0].rstrip("+"))
        cohort = [p for p in people.values() if low <= p["age"] <= top]
        if not cohort:
            continue
        known = [sum(1 for e in graph.parents.get(p["id"], ())
                     if e["kind"] not in STEP_KINDS) for p in cohort]
        both = sum(1 for k in known if k >= 2) / len(cohort) * 100
        any_one = sum(1 for k in known if k >= 1) / len(cohort) * 100
        print(f"    {label:<7}{len(cohort):>8,}   either {any_one:5.1f}%   "
              f"both {both:5.1f}%")

    basis = Counter(edge["basis"] for edges in graph.parents.values()
                    for edge in edges)
    edges = sum(basis.values())
    print(f"\n{edges:,} parent edges")
    for name, n in basis.most_common():
        print(f"  {name:<12}{n:>8,}  {n / edges * 100:5.1f}%")

    kinds = Counter(edge["kind"] for edges in graph.parents.values()
                    for edge in edges)
    print("  " + "  ".join(f"{k} {v:,}" for k, v in kinds.most_common()))

    # Every edge has to run down the generations, or something has produced a
    # person who is their own ancestor and every walk of the graph will hang.
    bad_gap = 0
    for child_id, rows in graph.parents.items():
        for edge in rows:
            if edge["id"] >= EXTERNAL_BASE:
                continue
            if (people[edge["id"]]["age"] - people[child_id]["age"]) < MIN_GAP:
                bad_gap += 1
    print(f"\nedges with a gap under {MIN_GAP} years: {bad_gap}")

    # Depth is what the layer is for. Two generations is a household; three is
    # an ancestry, and only the cross-household pass produces them.
    def depth(person_id, seen):
        if person_id in seen:
            return 0
        seen = seen | {person_id}
        rows = graph.parents.get(person_id, ())
        return 1 + max((depth(e["id"], seen) for e in rows), default=0)

    reach = Counter(depth(p, frozenset()) for p in people)
    print("\ngenerations above a person (self counts as one):")
    for generations in sorted(reach):
        n = reach[generations]
        print(f"  {generations}  {n:>8,}  {n / total * 100:5.1f}%")

    # The constraint the whole second pass exists to respect. Children living
    # with a person are the survey's and stand however many they are; what the
    # matcher added on top has to fit inside the parity it drew, and a nonzero
    # figure here means somebody is being handed a family they cannot have.
    children_of = Counter(edge["id"] for edges in graph.parents.values()
                          for edge in edges)
    matched_of = Counter(edge["id"] for edges in graph.parents.values()
                         for edge in edges if edge["basis"] == "matched")
    inside = [children_of[p] for p in people if children_of.get(p)]
    print(f"\n{len(inside):,} residents with a child in the city")
    print(f"  most children on one person: {max(inside, default=0)}, "
          f"most added by matching: {max(matched_of.values(), default=0)}")
    over = sum(1 for person_id, added in matched_of.items()
               if added > supply.drawn.get(person_id, 0)
               - graph.resident_children.get(person_id, 0))
    print(f"  people matched past their parity: {over}")

    print(f"\n{len(externals):,} external parents")
    status = Counter(stub["status"] for stub in externals)
    for name, n in status.most_common():
        print(f"  {name:<12}{n:>8,}")
    shared = Counter(stub["children"] for stub in externals)
    print("  children each: "
          + ", ".join(f"{k}:{v:,}" for k, v in sorted(shared.items())))

    # Siblings are the check that slot sharing worked. Two people with the same
    # mother should agree about their father — the same man, or neither of them
    # having one. They will not always: a woman can have children by two men,
    # and the ones the survey put in her household are hers whatever the
    # matcher did for the ones it added. Disagreement is a share, not a fault,
    # and it is the share that would be near 50% if slots were not shared.
    by_mother = defaultdict(list)
    for child_id, rows in graph.parents.items():
        for edge in rows:
            if edge["role"] == "mother" and edge["kind"] not in STEP_KINDS:
                by_mother[edge["id"]].append(child_id)
    pairs = agree = 0
    for kids in by_mother.values():
        fathers = [next((e["id"] for e in graph.parents[k]
                         if e["role"] == "father" and e["kind"] not in
                         STEP_KINDS), None) for k in kids]
        for i in range(len(kids) - 1):
            pairs += 1
            agree += fathers[i] == fathers[i + 1]
    if pairs:
        print(f"\nsiblings sharing a mother: {pairs:,} adjacent pairs, "
              f"{agree / pairs * 100:.1f}% share a father")

    print(f"\n{len(graph.partners):,} partner edges")


# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()

    population = json.loads(POPULATION.read_text())
    dwellings = json.loads(DWELLINGS.read_text())
    coords = {d["id"]: (d["lat"], d["lon"])
              for d in dwellings["dwellings"] + dwellings["quarters"]}

    residents = population["person_records"]
    quarters = population["quarters_records"]
    people = {p["id"]: p for p in residents + quarters}

    # Birth year, which identity.py will refine into a date later. Age is as of
    # mid-year, so this is the year that is right for two thirds of people and
    # one out for the rest — close enough for an age gap and a life table, and
    # deliberately not written out, so identity.py stays the one authority on
    # when anybody was born.
    for person in people.values():
        person["birth_year"] = YEAR - person["age"]

    household_home = {h["id"]: coords.get(h["dwelling"])
                      for h in population["household_records"]}

    def homes_of(person):
        if "household" in person:
            return household_home.get(person["household"])
        return coords.get(person.get("dwelling"))

    graph = Graph()
    members = defaultdict(list)
    for person in residents:
        members[person["household"]].append(person)

    for household_id, group in members.items():
        resolve_household(group, graph, keyed(args.seed, household_id, "kin"))

    # Group-quarters residents have no household to read a relationship out of,
    # so both their slots are open and pass two is the only thing that can fill
    # them. Institutional populations skew young and old at once — dormitories
    # and nursing homes — and the age windows sort that out on their own.
    for person in quarters:
        for role in ("mother", "father"):
            graph.slot([person], role)

    partner_of = {}
    for a, b, _ in graph.partners:
        partner_of[a] = b
        partner_of[b] = a

    supply = Supply(people, coords, graph.resident_children, args.seed)
    externals = resolve_slots(graph, people, supply, homes_of, partner_of,
                              args.seed)

    OUTPUT.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": YEAR,
        "persons": len(people),
        "external_base": EXTERNAL_BASE,
        "parent_in_city": PARENT_IN_CITY,
        "externals": externals,
        "partners": graph.partners,
        "parents": {str(k): v for k, v in sorted(graph.parents.items()) if v},
    }, separators=(",", ":")))

    report(graph, people, externals, supply)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
