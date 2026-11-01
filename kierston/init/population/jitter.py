"""Perturb the continuous fields so cloned households stop being identical.

Weighted cloning copies 1,391 PUMS records into 46,039 households, so every
household shape recurs ~33 times, exactly. That is faithful to the source and
useless as soon as anything downstream keys off a person: 33 people share a
birthday, a salary to the dollar and an employer's worth of hours. The
distributions are right and the individuals are not.

This moves each copy off its template by a little, in the two fields where a
small move is meaningless statistically and decisive for uniqueness:

  income  multiplied by a lognormal draw, median 1, so the perturbation is
          proportional — a $500 nudge on a $30k salary, $2k on a $120k one.
          Sign and zeros survive multiplication, which matters: PUMS carries
          negative incomes (business losses) and a great many exact zeros for
          people with no earnings, and inventing income for either would be a
          real change rather than a cosmetic one.
  age     integer offset of a year or two.

Nothing else moves. Occupation, education, race and household composition are
categorical: perturbing them would not disguise a duplicate, it would
fabricate a person the PUMA never surveyed.

Two invariants hold the result together, because breaking either would corrupt
structure that cloning was chosen to preserve in the first place:

  household income tracks its members. Each household's income absorbs the sum
  of its members' income deltas, so whatever relation HINCP had to its PINCPs
  survives unchanged rather than being re-derived here.

  ages keep their order within a household. Members are jittered
  independently, then the new ages are reassigned by the members' original age
  rank — so the eldest stays eldest and no child overtakes a parent.

And ages do not cross the thresholds a simulation is entitled to read as
categorical: 16, 18, 21 and 65 gate driving, adulthood and retirement, and a
17-year-old who becomes 18 has changed more than their age. A draw that would
cross one is dropped, leaving that person on their original age. Some people
therefore come through unjittered, which is the honest outcome — better than
clamping them onto the boundary and piling up 19,000 exact 18-year-olds.

This is cosmetic by design and does not make the population any finer-grained
than its 1,391 source records. Two households cloned from the same record
still have the same size, the same relationships and the same jobs; they are
now merely distinguishable. Genuine within-city variation is IPU's job, and
after IPU lands this step still applies unchanged.
"""

import random


# Lognormal sigma on income: ~5%, so two thirds of incomes move less than that
# and essentially none moves more than 15%. Small enough that no quantile or
# poverty count shifts materially, large enough that collisions on a
# five-figure salary are vanishingly unlikely.
INCOME_SIGMA = 0.05

# Age offset in years, before rounding. At 1.2 roughly a third of people stay
# put, most of the rest move a year, and two years is the practical limit.
AGE_SD = 1.2

# Ages that mean something beyond their magnitude. Jitter stays inside the
# interval each person already occupies. 15 is here because it is where PUMS
# starts asking about income: cross it and a person either holds a null income
# they should have been asked for, or an earned one nobody reported.
AGE_THRESHOLDS = (15, 16, 18, 21, 65)

# AGEP is top-coded at 99, and pack_population.py writes age as u8.
AGE_MAX = 99


def jitter_income(value, rng, sigma=INCOME_SIGMA):
    """Scale `value` by a lognormal draw with median and mean both 1.

    The -sigma^2/2 shift is what makes the mean 1 as well as the median:
    without it a lognormal multiplier drifts every income up by sigma^2/2, and
    a systematic raise is not what this step is for.
    """
    if value is None:
        # Under 15: PUMS never asked. Not zero, and not something to invent.
        return None
    if not value:
        return 0
    return round(value * rng.lognormvariate(-sigma * sigma / 2, sigma))


def age_bounds(age):
    """The threshold-delimited interval `age` sits in, inclusive."""
    low = max((t for t in AGE_THRESHOLDS if t <= age), default=0)
    high = min((t - 1 for t in AGE_THRESHOLDS if t > age), default=AGE_MAX)
    return low, min(high, AGE_MAX)


def jitter_age(age, rng, sd=AGE_SD):
    """Offset `age` by a year or two, or not at all if that crosses a threshold."""
    low, high = age_bounds(age)
    proposed = age + round(rng.gauss(0, sd))
    return proposed if low <= proposed <= high else age


def jitter_household(members, rng, income_sigma, age_sd):
    """Jitter one household's members in place; return the income delta.

    Members are the person records of a single household, in PUMS order. The
    delta is what the household's own income must absorb to stay consistent
    with them.
    """
    delta = 0
    for member in members:
        income = jitter_income(member["income"], rng, income_sigma)
        if income is not None:
            delta += income - member["income"]
        member["income"] = income

    # Independent draws can reorder a household — a 40-year-old parent down to
    # 38 while their 38-year-old spouse goes to 41 is harmless, the same swap
    # against a child is not. Reassigning the new ages by the members' original
    # rank keeps every within-household age relation exactly as PUMS recorded
    # it, at no cost to the jitter itself: the multiset of new ages is
    # untouched, only which member holds which.
    ages = sorted(jitter_age(m["age"], rng, age_sd) for m in members)
    order = sorted(range(len(members)), key=lambda i: members[i]["age"])
    for age, index in zip(ages, order):
        members[index]["age"] = age

    return delta


def apply(households, persons, quarters, rng,
          income_sigma=INCOME_SIGMA, age_sd=AGE_SD):
    """Jitter a synthesised population in place.

    `persons` carry a `household` index into `households`; they arrive grouped
    by it, since build() emits each household's members together, but this
    groups explicitly rather than relying on that.
    """
    members = [[] for _ in households]
    for person in persons:
        members[person["household"]].append(person)

    for household, group in zip(households, members):
        delta = jitter_household(group, rng, income_sigma, age_sd)
        household["income"] += delta

    # Group quarters have no household structure to preserve — a dormitory
    # resident is jittered on their own.
    for person in quarters:
        jitter_household([person], rng, income_sigma, age_sd)


# Fields that do not count towards being the same person.
#
# `id` and `household` are identity. The sleep traits are excluded for a
# different reason: `traits.py` draws them per simulated person, so counting
# them would make every clone unique by construction and report a population
# perfectly disguised no matter how badly the jitter had done its job. Two
# people who differ only in when they like to go to bed are still the same
# clone for the purpose this measures.
NOT_IDENTITY = ("id", "household", "chronotype", "sleep_need", "readiness")


def signature(person):
    """A person stripped of identity, for counting exact duplicates."""
    return tuple(sorted((k, v) for k, v in person.items()
                        if k not in NOT_IDENTITY))


def duplicates(households, persons):
    """(distinct people, distinct households) as fractions of the totals.

    Two households are the same if their member lists match field for field,
    which after jitter should essentially never happen and before it happens
    ~33 times over.
    """
    members = [[] for _ in households]
    for person in persons:
        members[person["household"]].append(signature(person))

    people = len({signature(p) for p in persons}) / len(persons)
    shapes = len({tuple(m) for m in members}) / len(households)
    return people, shapes


def main() -> None:
    """Print what the jitter costs the marginals, on the current population."""
    import argparse
    import json
    import statistics
    from pathlib import Path

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from paths import SIM_DATA

    path = SIM_DATA / "population.json"
    data = json.loads(path.read_text())
    households = data["household_records"]
    persons = data["person_records"]
    quarters = data["quarters_records"]

    before = ([h["income"] for h in households], [p["age"] for p in persons])
    print("before  %.1f%% of people distinct, %.1f%% of households"
          % tuple(100 * f for f in duplicates(households, persons)))

    apply(households, persons, quarters, random.Random(args.seed))

    print("after   %.1f%% of people distinct, %.1f%% of households"
          % tuple(100 * f for f in duplicates(households, persons)))

    after = ([h["income"] for h in households], [p["age"] for p in persons])
    for name, old, new in zip(("household income", "age"), before, after):
        print(f"\n{name}")
        for label, f in (("mean", statistics.mean),
                         ("median", statistics.median),
                         ("stdev", statistics.stdev)):
            print(f"  {label:<7} {f(old):>12,.1f} -> {f(new):>12,.1f}")


if __name__ == "__main__":
    main()
