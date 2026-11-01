"""Draw names that match a person's cohort, ethnicity and descent.

Three things have to be true at once for a name to pass as real, and each needs
a different mechanism:

  the cohort     A woman aged 71 is not called Madison. Given names in
                 reference/names.json are popularity curves rather than flat lists —
                 peak year, width, weight — so the distribution for a birth year
                 is the curves evaluated at that year. One row covers the whole
                 century and there is no per-decade table to maintain.
  the ethnicity  Kierston is 53.8% hispanic, 30.0% nh_white, 10.4% nh_black. A
                 single national list would give a majority-hispanic city Anglo
                 names, so given names and surnames are both drawn per naming
                 group, and `naming_groups` maps each race_ethnicity category to
                 a mixture over groups rather than to one group — mixed and
                 other-race people draw from several.
  the descent    Surnames propagate down the kin graph kinship.py builds: a
                 child takes their father's line, a spouse mostly takes their
                 partner's, roommates share nothing but an address. Getting
                 this wrong is the most visible failure of all — a household of
                 five with five surnames reads as noise — and it used to be
                 approximated off RELSHIPP, which could only ever make a
                 household agree with itself.

Two surnames per person, then, and two more fields: the line someone was born
into and the name they go by are kept apart. A woman who takes her husband's
name still passes her own to her children, which is what makes a maiden name
recoverable from one record and not from another, and a stepchild who goes by
the surname of the man who raised him still carries his father's underneath.
Collapsing the two would remove most of the reason to have a kin graph at all.

Hispanic naming is handled properly rather than approximated, because it is the
majority here and because it is the single richest source of the record-linkage
texture this data exists to exercise. Two surnames, paternal then maternal; a
child takes their father's paternal and their mother's paternal; and agencies
drop the maternal one inconsistently. Both components are stored separately
alongside the rendered form so a downstream record can present either. With
descent to hang it on the maternal component is now literally a grandmother's
line, and stays consistent as far up as the graph reaches.

What this does not do is guarantee uniqueness. Names collide in reality — a city
this size holds dozens of Jose Rodriguez — and the identifiers in identity.py are
what distinguish people. A name generator that refused to repeat itself would be
the less realistic one.
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from paths import NAMES as INPUT  # noqa: E402

# Whether a partner goes by the other's name. Married couples mostly converge;
# unmarried ones mostly do not, and that difference is the reason a shared
# address is weak evidence of a shared surname.
TAKES_PARTNER_NAME = {"spouse": 0.72, "partner": 0.15}

# Of the couples where one takes the other's name, how often it is the woman.
# Not 1.0 — men taking their wife's name is rare but not absent, and a record
# set where it never happens cannot be used to test whether a linkage rule
# assumed it never happens.
WIFE_MOVES = 0.94

# A partner who did not take the other's name sometimes hyphenates rather than
# keeping their own outright. Applied only to the ones who already failed the
# draw above.
HYPHENATE = 0.22

# What is left after descent and marriage: people the kin graph could not place
# who live with somebody it could. RELSHIPP is all there is for them, and the
# question is only what they *display*, since a line they did not inherit is
# one they do not pass on either. In-laws married into the household and kept
# their own; roommates and other nonrelatives share nothing but an address,
# which is exactly the case that makes address-based record linkage fail.
DISPLAYS_HOUSEHOLD = {
    28: 0.55,   # sibling — mostly handled by descent now, this is the residue
    29: 0.30,   # parent
    30: 0.40,   # grandchild
    31: 0.10,   # parent-in-law
    32: 0.34,   # child-in-law
    33: 0.46,   # other relative
    34: 0.02,   # roommate
    36: 0.02,   # other nonrelative
}
DEFAULT_DISPLAY = 0.20

# A child whose father is not in the household, going by their mother's name
# rather than his. Most do; the ones who do not are why so many children share
# an address with somebody they do not share a surname with, and why a search
# on a household's surname misses one of its members.
MOTHERS_NAME = 0.62

# A child who lives with a stepparent and goes by their name. The line
# underneath is unchanged — this is a display, and the divergence between the
# two is the point.
STEPPARENTS_NAME = 0.38

# A son given his father's first name. Small, and worth having: two people with
# the same full name at the same address is the hardest record-linkage case
# there is, and nothing else in the pipeline produces one on purpose. No Jr
# suffix is recorded, which is itself realistic — plenty of agencies drop it.
NAMESAKE = {"anglo": 0.05, "hispanic": 0.06, "black": 0.03,
            "south_asian_muslim": 0.04}
DEFAULT_NAMESAKE = 0.01

# How often a person has a middle name at all, by naming group. Records without
# one are common and worth having: a middle initial that is sometimes absent is
# a linkage problem.
MIDDLE_NAME = {"anglo": 0.86, "black": 0.78, "hispanic": 0.34,
               "east_asian": 0.44, "southeast_asian": 0.50, "south_asian": 0.58,
               "south_asian_muslim": 0.62}

# Compound given names — "Jose Luis", "Maria Elena". Standard in Spanish naming
# and the reason a first-name field sometimes holds two words.
COMPOUND_GIVEN = {"hispanic": 0.17, "anglo": 0.01, "black": 0.02,
                  "east_asian": 0.01, "southeast_asian": 0.03, "south_asian": 0.08,
                  "south_asian_muslim": 0.14}

# Birth years the curves are evaluated over. Outside this the nearest end is
# used, which only affects the handful of people at the 95-year top code.
YEAR_RANGE = (1925, 2026)

# How far from its peak a name stays available, in sigmas. A gaussian has no
# hard edges, and names do: Keisha and Madison did not exist as common names
# before the 1970s and 1990s respectively, so a generous tail puts them on
# people born decades too early. 2.5 sigma is tight enough to keep a name inside
# its own era while leaving the broad mid-century names — sigma 18-24 — spanning
# the whole population.
CURVE_CUTOFF = 2.5


def load(path=INPUT):
    """The name tables, as written."""
    return json.loads(path.read_text())


class Namer:
    """Samples names from the tables, caching one distribution per cohort.

    Evaluating ~100 gaussians per person would be 12 million exp() calls over
    the city. The distribution only depends on (group, sex, birth year), of
    which there are under a thousand combinations, so each is built once.
    """

    def __init__(self, tables=None):
        self.tables = tables or load()
        self.groups = self.tables["naming_groups"]
        self.double_rate = self.tables["double_surname_rate"]
        self._cohorts = {}
        self._surnames = {}

    # -- naming group ------------------------------------------------------

    def group(self, race_ethnicity, rng):
        """A naming group for a person of this race_ethnicity category.

        A mixture rather than a mapping: nh_two_or_more draws from four groups,
        and even nh_white and hispanic leak into each other, which is what makes
        a Hispanic Miller and an Anglo Rodriguez possible without special cases.
        """
        mixture = self.groups.get(race_ethnicity) or {"anglo": 1.0}
        names, weights = zip(*mixture.items())
        return rng.choices(names, weights=weights)[0]

    # -- given names -------------------------------------------------------

    def _cohort(self, group, sex, year):
        """(names, cumulative weights) for one birth cohort."""
        year = max(YEAR_RANGE[0], min(YEAR_RANGE[1], year))
        key = (group, sex, year)
        cached = self._cohorts.get(key)
        if cached:
            return cached

        curves = self.tables["given"][group][str(sex)]
        names, cumulative, total = [], [], 0.0
        for name, peak, sigma, weight in curves:
            z = (year - peak) / sigma
            # Gaussian in time, truncated: see CURVE_CUTOFF. A name is
            # genuinely unavailable outside its era rather than merely
            # improbable, because "merely improbable" over 125,000 people means
            # several hundred anachronisms.
            if abs(z) > CURVE_CUTOFF:
                continue
            total += weight * math.exp(-z * z / 2)
            names.append(name)
            cumulative.append(total)

        if not names:
            # No curve reaches this year. Fall back to the widest ones rather
            # than failing; only possible at the extreme ends of YEAR_RANGE.
            names = [c[0] for c in sorted(curves, key=lambda c: -c[2])[:8]]
            cumulative = [float(i + 1) for i in range(len(names))]

        self._cohorts[key] = (names, cumulative)
        return names, cumulative

    def given(self, group, sex, year, rng):
        """One given name for this cohort."""
        names, cumulative = self._cohort(group, sex, year)
        target = rng.random() * cumulative[-1]
        # Linear scan: the lists are ~100 long and bisect on a parallel list
        # costs more in indirection than it saves here.
        for name, edge in zip(names, cumulative):
            if target <= edge:
                return name
        return names[-1]

    def first_name(self, group, sex, year, rng):
        """A given name, compounded where the group's convention allows.

        The second element of a compound is drawn from the same cohort, which
        keeps "Jose Luis" plausible and "Jose Mateo" rare for an older man.
        """
        first = self.given(group, sex, year, rng)
        if rng.random() < COMPOUND_GIVEN.get(group, 0.0):
            second = self.given(group, sex, year, rng)
            if second != first:
                return f"{first} {second}"
        return first

    def middle_name(self, group, sex, year, rng):
        """A middle name, or None."""
        if rng.random() >= MIDDLE_NAME.get(group, 0.7):
            return None
        return self.given(group, sex, year, rng)

    # -- surnames ----------------------------------------------------------

    def _surname_table(self, group):
        table = self._surnames.get(group)
        if table is None:
            rows = self.tables["surname"][group]
            names, cumulative, total = [], [], 0.0
            for name, weight in rows:
                total += weight
                names.append(name)
                cumulative.append(total)
            table = (names, cumulative)
            self._surnames[group] = table
        return table

    def surname(self, group, rng):
        """One surname drawn from a group's distribution."""
        names, cumulative = self._surname_table(group)
        target = rng.random() * cumulative[-1]
        for name, edge in zip(names, cumulative):
            if target <= edge:
                return name
        return names[-1]

    def line(self, group, rng):
        """A household surname line: (paternal, maternal or None).

        Groups that use one surname get a None maternal component, so the two
        conventions share a representation and nothing downstream has to branch
        on the group to render a name.
        """
        paternal = self.surname(group, rng)
        if rng.random() < self.double_rate.get(group, 0.0):
            return paternal, self.surname(group, rng)
        return paternal, None


def render(paternal, maternal):
    """A surname as it appears on a record."""
    return f"{paternal} {maternal}" if maternal else paternal


STEP_KINDS = {"step", "foster"}


def _parent(edges, role, primary=True):
    """The id of a person's parent in this role, or None."""
    for edge in edges:
        if edge["role"] != role:
            continue
        if (edge["kind"] in STEP_KINDS) != primary:
            return edge["id"]
    return None


def descend(father, mother, namer, group, rng):
    """The surname line this person is born into.

    Two components, and both come from a parent's *line* rather than from what
    that parent goes by: a man who took his wife's name still passes his own
    down, and the child of a woman who took her husband's carries her birth
    name as their maternal component, which is the whole convention.

    A founder — nobody above them in the graph — draws a fresh line. Just under
    half the city are founders, which is what a five-kilometre extract of a
    metro of 900,000 should look like from underneath.
    """
    if father is not None:
        paternal = father["line_paternal"]
        # The maternal slot exists only for a line that uses one. Whether it
        # does is inherited too, so a hispanic family stays hispanic in form
        # even where a child's own ethnicity was coded differently.
        if father["line_maternal"] is None:
            return paternal, None
        if mother is not None:
            return paternal, mother["line_paternal"]
        return paternal, father["line_maternal"]

    if mother is not None:
        # No father anywhere in the graph. The child carries the mother's name
        # entire, which is what a birth record with one parent on it looks
        # like.
        return mother["line_paternal"], mother["line_maternal"]

    return namer.line(group, rng)


def assign_descent(people, parents, namer, seed, keyed):
    """Give everyone a line and a name, working down the generations.

    `people` is every person to be named — residents, group-quarters residents
    and the external stubs kinship.py invented — keyed by id and carrying
    `sex`, `birth_year` and `race_ethnicity`. `parents` is the kin graph.

    Order is by birth year, which is a valid topological order for free:
    kinship.py refuses any edge with under thirteen years in it, so a parent is
    always named before their child and no second pass is needed to close the
    graph.
    """
    order = sorted(people.values(), key=lambda p: p["birth_year"])
    for person in order:
        rng = keyed(seed, person["id"], "names")
        edges = parents.get(person["id"], ())
        father = people.get(_parent(edges, "father"))
        mother = people.get(_parent(edges, "mother"))

        group = namer.group(person["race_ethnicity"], rng)
        paternal, maternal = descend(father, mother, namer, group, rng)

        # A son given his father's first name, before the cohort draw, so the
        # inherited name is the father's and not one the son's own era would
        # have produced.
        first = None
        if (father is not None and person["sex"] == 1
                and rng.random() < NAMESAKE.get(group, DEFAULT_NAMESAKE)):
            first = father["first_name"]

        person["naming_group"] = group
        person["first_name"] = first or namer.first_name(
            group, person["sex"], person["birth_year"], rng)
        person["middle_name"] = namer.middle_name(
            group, person["sex"], person["birth_year"], rng)
        person["line_paternal"] = paternal
        person["line_maternal"] = maternal
        # The display starts as the line and is moved by marriage and by the
        # household below.
        person["surname_paternal"] = paternal
        person["surname_maternal"] = maternal
        person["surname"] = render(paternal, maternal)


def display(person, source, rng, hyphenate=False):
    """Move what a person goes by onto somebody else's name, keeping the line."""
    if hyphenate and rng.random() < HYPHENATE:
        person["surname_paternal"] = (f"{person['line_paternal']}-"
                                      f"{source['surname_paternal']}")
        person["surname_maternal"] = None
    else:
        person["surname_paternal"] = source["surname_paternal"]
        person["surname_maternal"] = (source["surname_maternal"]
                                      if person["line_maternal"] else None)
    person["surname"] = render(person["surname_paternal"],
                               person["surname_maternal"])


def assign_partners(people, partners, seed, keyed):
    """Married couples mostly converge on one name. Unmarried ones mostly do not.

    Which of the two moves is decided by sex and not by which of them the
    survey happened to record the household around. That distinction is worth
    the four lines: half of householders are women, so moving the partner onto
    the householder makes half of husbands take their wife's name, and since
    the children carry their father's line either way, the household then reads
    with three surnames in it where it should have one. A married couple with
    two children reads as one family 88% of the time with this, and 41% of the
    time without.
    """
    for first, second, kind in partners:
        one, other = people.get(first), people.get(second)
        if one is None or other is None:
            continue
        rng = keyed(seed, min(first, second), "married")

        if one["sex"] != other["sex"]:
            woman, man = ((one, other) if one["sex"] == 2 else (other, one))
            person, source = ((woman, man) if rng.random() < WIFE_MOVES
                              else (man, woman))
        else:
            # No convention to appeal to. Whoever was recorded first keeps
            # their name, which at least makes the choice stable.
            person, source = other, one

        if rng.random() < TAKES_PARTNER_NAME.get(kind, 0.5):
            display(person, source, rng)
        elif kind == "spouse":
            display(person, source, rng, hyphenate=True)


def assign_household(members, parents, seed, keyed):
    """The residue: people who live with a household the graph did not connect.

    An in-law, a lodger, a cousin the survey calls `other relative`. Descent
    gave each of them their own line and none of them a reason to share the
    householder's, so this is the only thing left that can put two surnames in
    a household that ought to have one. It moves the display and never the
    line — someone who goes by the name of the family they board with does not
    pass it to their children.

    Children get their own two rules here. One living apart from their father
    often goes by their mother's name instead of his, and one living with a
    stepparent sometimes goes by theirs; both leave the birth line untouched,
    which is what makes a name change recoverable from a record that carries
    both fields.
    """
    head = next((m for m in members if m["relationship"] == 20), None)
    if head is None:
        return
    resident = {m["id"] for m in members}

    for member in members:
        if member is head:
            continue
        edges = parents.get(member["id"], ())
        father = _parent(edges, "father")
        mother = _parent(edges, "mother")

        if father is None and mother is None:
            # Keyed on the relationship code and not the person, for the same
            # reason as below: two cousins boarding with the same family either
            # both go by its name or neither does.
            rng = keyed(seed, head["id"], member["relationship"], "display")
            share = DISPLAYS_HOUSEHOLD.get(member["relationship"],
                                           DEFAULT_DISPLAY)
            if rng.random() < share:
                display(member, head, rng)
            continue

        # Keyed on the parents rather than on the member, so siblings make the
        # same decision. Drawn per child instead, a woman raising three of them
        # ends up with one going by her name and two going by their father's,
        # which is the single worst thing this file can do to a household.
        step = _parent(edges, "father", primary=False)
        rng = keyed(seed, father, mother, step, "display")

        if father not in resident and mother in resident:
            if rng.random() < MOTHERS_NAME:
                display(member,
                        next(m for m in members if m["id"] == mother), rng)
        if step in resident and rng.random() < STEPPARENTS_NAME:
            display(member, next(m for m in members if m["id"] == step), rng)


def full_name(person):
    """The rendered name, for reports and the browser."""
    parts = [person["first_name"], person.get("middle_name"), person["surname"]]
    return " ".join(p for p in parts if p)


def main() -> None:
    """Sample names across cohorts and groups, to eyeball the tables."""
    import argparse
    import random
    from collections import Counter

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--samples", type=int, default=12)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    namer = Namer()

    tables = namer.tables["given"]
    groups = list(tables)
    width = max(len(g) for g in groups) + 2

    print("given-name coverage:")
    for group in groups:
        for sex in ("1", "2"):
            curves = tables[group][sex]
            peaks = [c[1] for c in curves]
            print(f"  {group:<{width}}{'male' if sex == '1' else 'female':<8}"
                  f"{len(curves):>4} names, peaks {min(peaks)}-{max(peaks)}")
    print("\nsurname pools:")
    for group, rows in namer.tables["surname"].items():
        print(f"  {group:<{width}}{len(rows):>4} surnames")

    # Every naming group a race_ethnicity category can reach must have both
    # tables, or a person of that category cannot be named at all.
    reachable = {g for mixture in namer.groups.values() for g in mixture}
    missing = [g for g in reachable
               if g not in tables or g not in namer.tables["surname"]]
    if missing:
        print(f"\n  !! naming_groups references groups with no table: {missing}")

    print("\nsampled names by cohort:")
    for year in (1938, 1958, 1978, 1998, 2018):
        print(f"\n  born {year}")
        for group in groups:
            for sex in (1, 2):
                drawn = []
                for _ in range(args.samples):
                    paternal, maternal = namer.line(group, rng)
                    drawn.append(f"{namer.first_name(group, sex, year, rng)} "
                                 f"{render(paternal, maternal)}")
                label = f"{group} {'M' if sex == 1 else 'F'}"
                print(f"    {label:<{width + 3}}{', '.join(drawn[:5])}")

    # The check the curves exist for: a name must not appear in a cohort it
    # could not belong to.
    print("\nleakage check — most common name per cohort, anglo female:")
    for year in range(1935, 2026, 15):
        counts = Counter(namer.given("anglo", 2, year, rng) for _ in range(4000))
        top = ", ".join(f"{n} {c / 40:.0f}%" for n, c in counts.most_common(4))
        print(f"  {year}  {top}")


if __name__ == "__main__":
    main()
