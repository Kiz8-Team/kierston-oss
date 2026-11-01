"""Place every synthetic household in a specific dwelling unit.

Synthesis produces households with no address; this gives each one a building
and a unit index within it. Two constraints do the work:

  capacity  a building holds exactly the `units` extract_dwellings estimated,
            never more, so the map cannot be over-filled
  fit       bigger households get bigger units

Fit is a stochastic rank match. Units are sorted by floor area, households by
how much space they want, and the two orders are zipped. The point of the noise
term is that a strict sort is badly wrong: it would put every one-person
household in the smallest unit in Kierston and produce a city sorted with a
rigidity no real housing market has. SPREAD blurs the ranking so the
correlation comes out strong but loose, which is what the real relationship
looks like.

The only real input to "wants space" is household size, which is a physical
need. Income enters as a weaker secondary term, because richer households buy
more room than they strictly need — but INCOME_WEIGHT is a modelling choice
here, not a fitted value, and there is nothing in this data to calibrate it
against. Doing that properly needs block-group median values or rents joined to
the stock, which is the same ACS work IPU is waiting on. Set it to 0 to place
on size alone.

Which units end up empty is drawn uniformly. Real vacancy is not uniform — it
concentrates in older and smaller stock — but nothing in the dwelling data
distinguishes those, so an unbiased draw beats an invented bias.

Group quarters are placed separately, with no household structure, and by the
kind of quarters PUMS says they live in. Noninstitutional residents (RELSHIPP
38) are spread across the dormitories. Institutional residents (RELSHIPP 37)
go to nursing homes from age NURSING_HOME_AGE and to correctional facilities
below it; PUMS does not say which institution, and age is the variable that
separates the two in the census GQ tables. Within each kind, residents are
spread in proportion to floor area.
"""

import argparse
import json
import random
import statistics
from collections import Counter, defaultdict
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from paths import SIM_DATA  # noqa: E402

POPULATION = SIM_DATA / "population.json"
DWELLINGS = SIM_DATA / "dwellings.json"

DEFAULT_SEED = 20260728

# How much a household's income pulls it towards a larger unit, relative to its
# size. See the module docstring: a judgement call, not a measurement.
INCOME_WEIGHT = 0.35
# Standard deviation of the noise added to the demand ranking, in rank units
# (the ranking itself spans 0-1). It sets how tightly household size tracks
# unit area, measured over this stock as:
#
#   SPREAD  0.15   0.25   0.35   0.50
#   r       0.45   0.39   0.34   0.28
#
# 0.25 is the middle of the plausible band rather than a fitted value: there is
# no Kierston measurement to fit to. The report prints the resulting r, so this
# can be moved deliberately if the simulation wants housing sorted harder or
# looser.
SPREAD = 0.25

# Quarters kinds intake/dwellings.py writes for institutions; anything else in
# the quarters list is a dormitory.
NURSING_HOME = "nursing_home"
CORRECTIONAL = "correctional"
INSTITUTIONAL = (NURSING_HOME, CORRECTIONAL)
# RELSHIPP for the institutionalized group-quarters population.
INSTITUTIONALIZED = 37
# Institutional residents from this age go to a nursing home, younger ones to
# a correctional facility.
NURSING_HOME_AGE = 60
# Floor area assumed for a quarters building whose footprint reads as zero, so
# a mapped node still takes a share.
MIN_QUARTERS_AREA = 100.0


def unit_areas(dwellings, fallback):
    """Expand buildings into one (building id, unit index, floor area) per unit.

    Floor area is footprint × levels ÷ units. Half the stock carries no level
    count, so those fall back to a single storey and read smaller than they
    are — the same assumption extract_dwellings makes, and it biases the
    ranking only where it applies uniformly.
    """
    units = []
    for building in dwellings:
        gross = building["area"] * max(building["levels"], 1)
        per_unit = gross / building["units"] if gross else fallback
        for index in range(building["units"]):
            units.append((building["id"], index, per_unit))
    return units


def ranks(values):
    """Map each value to its position in [0, 1], ties broken by input order."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    out = [0.0] * len(values)
    last = max(len(values) - 1, 1)
    for position, index in enumerate(order):
        out[index] = position / last
    return out


def demand(households, rng):
    """Score each household on how much dwelling space it wants."""
    size = ranks([h["size"] for h in households])
    income = ranks([h["income"] for h in households])
    return [
        size[i] + INCOME_WEIGHT * income[i] + rng.gauss(0, SPREAD)
        for i in range(len(households))
    ]


def assign(households, units, rng):
    """Match households to units by rank, leaving the surplus units vacant.

    Occupied units are drawn first and uniformly, so vacancy does not
    systematically strip one end of the size distribution before matching.
    """
    occupied = rng.sample(units, len(households))
    occupied.sort(key=lambda u: u[2])

    scores = demand(households, rng)
    by_demand = sorted(range(len(households)), key=lambda i: scores[i])

    for position, index in enumerate(by_demand):
        building, unit, area = occupied[position]
        households[index]["dwelling"] = building
        households[index]["unit"] = unit
        households[index]["unit_area"] = round(area, 1)


def quarters_kind(resident):
    """Which kind of quarters building a group-quarters resident lives in."""
    if resident["relationship"] != INSTITUTIONALIZED:
        return "noninstitutional"
    return NURSING_HOME if resident["age"] >= NURSING_HOME_AGE else CORRECTIONAL


def assign_quarters(residents, quarters, rng):
    """Place group-quarters residents in buildings of their kind."""
    groups = defaultdict(list)
    for resident in residents:
        groups[quarters_kind(resident)].append(resident)
    for kind in ("noninstitutional", NURSING_HOME, CORRECTIONAL):
        members = groups.get(kind)
        if not members:
            continue
        if kind == "noninstitutional":
            buildings = [q for q in quarters if q["kind"] not in INSTITUTIONAL]
        else:
            buildings = [q for q in quarters if q["kind"] == kind]
        if not buildings:
            raise SystemExit(
                f"no {kind} quarters building in dwellings.json for "
                f"{len(members):,} residents; re-run the dwellings stage")
        spread_by_area(members, buildings, rng)


def spread_by_area(residents, quarters, rng):
    """Spread residents across quarters buildings by floor area."""
    weights = [max(q["area"], MIN_QUARTERS_AREA) * max(q["levels"], 1)
               for q in quarters]
    total = sum(weights)
    # Proportional shares, with the rounding remainder handed to the largest
    # building rather than dropped.
    counts = [int(len(residents) * w / total) for w in weights]
    counts[weights.index(max(weights))] += len(residents) - sum(counts)

    slots = [q["id"] for q, n in zip(quarters, counts) for _ in range(n)]
    rng.shuffle(slots)
    for resident, building in zip(residents, slots):
        resident["dwelling"] = building


def report(households, persons, quarters_residents, units, dwellings):
    print(f"{len(households):,} households placed in {len(units):,} units — "
          f"{len(units) - len(households):,} vacant "
          f"({(1 - len(households) / len(units)) * 100:.1f}%)")

    per_building = Counter(h["dwelling"] for h in households)
    capacity = {d["id"]: d["units"] for d in dwellings}
    over = [b for b, n in per_building.items() if n > capacity[b]]
    print(f"buildings over capacity: {len(over)}")
    print(f"buildings occupied: {len(per_building):,} of {len(dwellings):,}")

    sizes = [h["size"] for h in households]
    areas = [h["unit_area"] for h in households]
    print(f"\nhousehold size vs unit area: r = "
          f"{statistics.correlation(sizes, areas):.2f}  "
          f"(0 = random placement, 1 = strictly sorted)")

    print("\nfloor area per person by household size:")
    by_size = defaultdict(list)
    for household in households:
        by_size[household["size"]].append(household["unit_area"])
    for size in sorted(by_size):
        area = statistics.median(by_size[size])
        print(f"  {size:>2}-person  {len(by_size[size]):>7,} households  "
              f"median unit {area:>6.0f} m²  {area / size:>5.0f} m²/person")

    kinds = {d["id"]: d["kind"] for d in dwellings}
    print("\noccupied units by building kind:")
    occupied_kinds = Counter(kinds[h["dwelling"]] for h in households)
    for kind, count in occupied_kinds.most_common():
        print(f"  {count:>7,}  {kind}")

    residents = Counter(r["dwelling"] for r in quarters_residents)
    print(f"\n{len(quarters_residents):,} group-quarters residents across "
          f"{len(residents)} buildings "
          f"({min(residents.values()):,}-{max(residents.values()):,} each)")
    for kind, count in Counter(quarters_kind(r)
                               for r in quarters_residents).most_common():
        print(f"  {count:>7,}  {kind}")

    placed = sum(1 for p in persons if p["household"] is not None)
    print(f"\n{placed:,} people with an address")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="placement seed; recorded in the output")
    args = parser.parse_args()

    population = json.loads(POPULATION.read_text())
    stock = json.loads(DWELLINGS.read_text())
    rng = random.Random(args.seed)

    households = population["household_records"]
    units = unit_areas(stock["dwellings"], stock["area_per_unit"])
    if len(households) > len(units):
        raise SystemExit(
            f"{len(households):,} households will not fit in {len(units):,} units")

    assign(households, units, rng)
    assign_quarters(population["quarters_records"], stock["quarters"], rng)

    population["placement_seed"] = args.seed
    population["dwelling_source"] = DWELLINGS.name
    POPULATION.write_text(json.dumps(population, separators=(",", ":")))

    report(households, population["person_records"],
           population["quarters_records"], units, stock["dwellings"])
    print(f"\nWrote {POPULATION} ({POPULATION.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
