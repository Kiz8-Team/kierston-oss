"""Expand the PUMS sample into every household and person in Kierston.

The method is weighted household cloning. Each of the 1,391 surveyed
households carries WGTP, the number of real households it stands for; copy it
that many times and the sample becomes the city. Because whole households are
copied, every within-household relationship survives the expansion intact —
nothing about composition, age structure or income is modelled here.

This is the baseline, and deliberately so. It reproduces the PUMA's
distributions and nothing finer, because a single PUMA carries no within-city
geography: every block group comes out looking like the city average. The fix
is IPU (iterative proportional updating), which reweights these same 1,391
records per block group against ACS marginals so neighbourhoods differ. That
changes one step — the weights fed to `integerize` become per-zone instead of
citywide — and leaves the rest of this file alone. Until block groups are
joined in, this stands on its own, and afterwards it stays useful as the
control to validate IPU against.

What it cannot do is invent households. 46,039 households drawn from 1,391
distinct records means each shape recurs ~33 times, and IPU will not change
that — it reweights, it does not generate. If the simulation ever needs
genuinely unique households, that is where a generative model or post-hoc
jittering of the continuous fields comes in.

Households come out unplaced. Assigning them to specific dwelling units is a
separate stage with its own constraints (size against unit area, income
against neighbourhood) and belongs with dwellings.json, not here.
"""

import argparse
import json
import random
from collections import Counter
from pathlib import Path

import jitter
import pums
import traits


# Generated output is simulation input, not working data: it goes to sim_data,
# leaving `data` for the raw extracts and drafts it is built from.
from paths import SIM_DATA
OUTPUT = SIM_DATA / "population.json"
DWELLINGS = SIM_DATA / "dwellings.json"

# Default household count: what the PUMS weights themselves imply, 46,039.
# Kierston is the whole 5 km extract rather than the reference city proper, so its
# 51,945 dwelling units exceed this — the difference reads as vacancy. Override
# when the stock is meant to fill differently.
DEFAULT_SEED = 20260728


def integerize(weights, target, rng):
    """Split `target` copies across `weights` in proportion, as whole numbers.

    Sampling `target` households at random with replacement would do the job,
    but it adds Monte Carlo noise to every marginal — run it twice and the
    city's age structure moves. This walks the cumulative weight instead and
    cuts it at integer boundaries offset by one random draw, so each household
    gets its expected count rounded up or down and never anything else. The
    counts sum to `target` exactly and the only randomness is which side of
    the rounding each household lands on.

    It is also the same integerisation step IPU needs at the end, so it carries
    over unchanged.
    """
    scale = target / sum(weights)
    offset = rng.random()
    counts, cumulative, taken = [], 0.0, 0
    for weight in weights:
        cumulative += weight * scale
        upto = int(cumulative + offset)
        counts.append(upto - taken)
        taken = upto

    # Floating-point drift can leave the last boundary a hair short. Hand any
    # shortfall to the heaviest households, which is where it belongs anyway.
    for index in sorted(range(len(weights)), key=lambda i: -weights[i]):
        if taken >= target:
            break
        counts[index] += 1
        taken += 1
    return counts


def synthesize(records, target, rng, weight_of):
    """Clone `records` into `target` copies, returned in shuffled order.

    Shuffled because the output order would otherwise be the PUMS file order,
    and anything downstream that slices or streams the list — dwelling
    assignment above all — would get households grouped by source record.
    """
    copies = integerize([weight_of(r) for r in records], target, rng)
    expanded = [r for record, n in zip(records, copies) for r in [record] * n]
    rng.shuffle(expanded)
    return expanded


def build(households, quarters, target, rng, jitter_fields=True):
    """Return (household records, person records, quarters person records).

    Cloning is exact by construction, which leaves ~33 identical copies of
    every source household. `jitter_fields` runs the income and age
    perturbation that separates them; see jitter.py for what it does and does
    not touch. Pass False to get the raw expansion, which is what you want when
    validating the clone itself.
    """
    out_households, out_persons = [], []
    for household in synthesize(households, target, rng, lambda h: h["weight"]):
        household_id = len(out_households)
        out_households.append({
            "id": household_id,
            # Provenance: which PUMS record this is a copy of. Keeps every
            # synthetic household traceable to a real surveyed one.
            "source": household["serialno"],
            "size": len(household["members"]),
            "income": household["income"],
            # Filled by dwelling assignment, which has not run yet.
            "dwelling": None,
        })
        for member in household["members"]:
            out_persons.append({
                "id": len(out_persons),
                "household": household_id,
                **{k: v for k, v in member.items() if k != "weight"},
            })

    target_quarters = round(sum(q["weight"] for q in quarters))
    out_quarters = []
    # Ids continue the person sequence rather than restarting. The two lists
    # stay separate — they synthesise differently and pack into separate
    # tables — but anything that refers to a person by id alone must not have
    # to know which list they came from. employment.json is exactly that:
    # dormitory residents hold jobs like anyone else, and a roster keyed on a
    # restarted id silently merges person 5 with quarters resident 5.
    for member in synthesize(quarters, target_quarters, rng, lambda q: q["weight"]):
        out_quarters.append({
            "id": len(out_persons) + len(out_quarters),
            **{k: v for k, v in member.items() if k != "weight"},
        })

    # After cloning, before anything reads the numbers. Dwelling assignment
    # ranks households by income, so it has to see the jittered values.
    if jitter_fields:
        jitter.apply(out_households, out_persons, out_quarters, rng)

    # After the jitter, because the chronotype curve reads the age and the age
    # is not settled until then. Unconditional, unlike the jitter: a population
    # built with --no-jitter still needs people who sleep, and the traits are
    # not a disguise for cloning the way the jitter is.
    #
    # On its own generator, seeded by exactly one draw from the shared one. That
    # fixes the number of draws this stage takes from `rng` at one forever, so
    # adding a fourth trait later adds fields to the population and changes
    # nothing else in it. Drawing them from `rng` directly would make every
    # subsequent value depend on how many traits happened to exist.
    traits.apply(out_persons, out_quarters, random.Random(rng.getrandbits(64)))

    return out_households, out_persons, out_quarters


def distribution(counter, total):
    """Sorted (label, count, percent) rows for the validation report."""
    return [(k, v, v / total * 100) for k, v in counter.most_common()]


def report(households, persons, quarters, source_households, source_persons):
    print(f"{len(households):,} households  {len(persons):,} people "
          f"({len(persons) / len(households):.2f} per household)")
    print(f"{len(quarters):,} group-quarters residents held separately\n")

    used = len({h["source"] for h in households})
    print(f"drawn from {used:,} of {len(source_households):,} PUMS households, "
          f"each appearing {len(households) / used:.0f}× on average")

    # How much of that repetition survives as literally identical records.
    # Without jitter it is all of it; with jitter this is the whole point.
    people, shapes = jitter.duplicates(households, persons)
    print(f"{people * 100:.1f}% of people and {shapes * 100:.1f}% of households "
          f"are distinct records")

    # Every marginal below is checked against the PUMS weighted total rather
    # than a published table: cloning cannot beat its source, so agreement here
    # proves the expansion is faithful, not that the city is right. Validating
    # against ACS is what IPU is for.
    weighted = sum(p["weight"] for p in source_persons)

    # The household count is exact by construction; the person count is not,
    # and cannot be. Census calibrates WGTP and PWGTP independently, so
    # expanding by WGTP lands on the right number of households and a slightly
    # wrong number of people. This gap is the concrete form of the constraint
    # IPU exists to resolve — it reweights against household and person
    # marginals at once, which cloning by a single weight cannot do.
    print(f"\n{len(persons):,} people from the household weights; the person "
          f"weights imply {round(weighted):,} "
          f"({(len(persons) / weighted - 1) * 100:+.1f}%)")

    print("\nrace and ethnicity (synthetic vs PUMS person weights):")
    synthetic = Counter(p["race_ethnicity"] for p in persons)
    truth = Counter()
    for p in source_persons:
        truth[p["race_ethnicity"]] += p["weight"]
    width = max(len(k) for k in synthetic)
    for label, count, share in distribution(synthetic, len(persons)):
        expected = truth[label] / weighted * 100
        print(f"  {label:<{width}}  {count:>7,}  {share:5.1f}%   "
              f"PUMS {expected:5.1f}%   {share - expected:+.2f}")

    print("\nhousehold size:")
    sizes = Counter(h["size"] for h in households)
    for size in sorted(sizes):
        print(f"  {size:>2}  {sizes[size]:>7,}  "
              f"{sizes[size] / len(households) * 100:5.1f}%")

    print("\nage:")
    bands = [(0, 17), (18, 34), (35, 64), (65, 200)]
    for low, high in bands:
        count = sum(1 for p in persons if low <= p["age"] <= high)
        label = f"{low}-{high}" if high < 200 else f"{low}+"
        print(f"  {label:>6}  {count:>7,}  {count / len(persons) * 100:5.1f}%")

    if DWELLINGS.exists():
        units = json.loads(DWELLINGS.read_text())["units"]
        vacant = units - len(households)
        print(f"\n{units:,} dwelling units in the stock, {len(households):,} "
              f"occupied — {vacant:,} vacant ({vacant / units * 100:.1f}%)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--households", type=int, default=None,
                        help="number of households (default: sum of WGTP)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="rounding seed; recorded in the output")
    parser.add_argument("--no-jitter", action="store_true",
                        help="leave incomes and ages exactly as cloned")
    args = parser.parse_args()

    source_households, source_quarters = pums.load()
    target = args.households or round(sum(h["weight"] for h in source_households))
    rng = random.Random(args.seed)

    households, persons, quarters = build(
        source_households, source_quarters, target, rng,
        jitter_fields=not args.no_jitter)

    SIM_DATA.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "source": pums.INPUT.name,
        # Seed and target define the run. Change either and this is a different
        # population, so both travel with the data rather than living in a
        # shell history somewhere.
        "seed": args.seed,
        # Which fields have been moved off their PUMS values, and by how much.
        # Anything comparing this population back to the extract needs to know.
        "jitter": None if args.no_jitter else {
            "income_sigma": jitter.INCOME_SIGMA,
            "age_sd": jitter.AGE_SD,
            "age_thresholds": list(jitter.AGE_THRESHOLDS),
        },
        "households": len(households),
        "persons": len(persons),
        "quarters_persons": len(quarters),
        "pums_households": len(source_households),
        # Unplaced: `dwelling` is null on every household until assignment runs.
        "household_records": households,
        "person_records": persons,
        # Dormitory residents. Not households; placed in dwellings.json
        # `quarters` buildings by a separate step.
        "quarters_records": quarters,
    }, separators=(",", ":")))

    source_persons = [m for h in source_households for m in h["members"]]
    report(households, persons, quarters, source_households, source_persons)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
