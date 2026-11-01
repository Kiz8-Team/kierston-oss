"""Build the vehicle market asset from the NHTS and fuel-economy extracts.

Two public files answer two different halves of "what car does this household
own", and neither is usable at generation time in its raw form — together they
are 25 MB of CSV that would be re-parsed on every run to answer a question with
a few hundred kilobytes of structure in it.

  NHTS 2022 (`vehv2pub.csv`)     what households *actually* own, by income.
                                 One row per household vehicle: make, body
                                 type, age, lease vs owned, and the income
                                 bracket of the household holding it. This is
                                 the file that keeps a $40k household out of a
                                 Porsche — not a price rule, but the plain
                                 absence of Porsches in that bracket's rows.

  fuelecononomy.gov (`vehicles.csv`)  what was actually *sold*. One row per
                                 EPA-tested variant, 1984-2025, with the model
                                 name and an EPA size class. This is what turns
                                 "a 2016 Toyota SUV" into "a 2016 Toyota RAV4".

The output is a resampling table, not a fitted model. Drawing a vehicle means
picking a real surveyed vehicle from the right income bracket and then naming a
real model that the same make sold that year. Fitting a distribution over make
and body type would smooth exactly the lumps that make a fleet look real: the
survey knows that pickups cluster in particular income bands and that old cars
concentrate in poor households, and any parametric summary of that is a worse
answer than the rows themselves.

What is *not* survey-derived, and is a curated table with its own reasoning:

  price    No free source carries MSRP by model. Neither file above has a
           price column at all. So price is a tier x body x model-year table
           (see PRICE) with a depreciation curve over it. This is the weakest
           link in the chain and it is deliberately the last one: by the time
           price is assigned, the make and year are already survey-anchored,
           so price only has to *agree* with them rather than independently
           carry the realism.

  colour   No registry records paint. Shares are the Axalta annual North
           America report, split by body type because white dominates trucks
           in a way it does not dominate cars.

Run once; re-run when a new NHTS release or fuel-economy dump lands.

    python util_scripts/build_vehicle_market.py
"""

import argparse
import collections
import csv
import json
import sys
from pathlib import Path


# National data, identical for every city, so this is distilled once into
# reference/ rather than being re-parsed on every run. `raw/` holds the two
# bulk CSVs it reads.
REFERENCE = Path(__file__).resolve().parents[1]
NHTS_VEHICLES = REFERENCE / "raw" / "vehv2pub.csv"
FUEL_ECONOMY = REFERENCE / "raw" / "vehicles.csv"
OUT = REFERENCE / "vehicle_market.json"

# The reference year the market table is priced in. Values come out in dollars
# of this year, so it has to move with the simulation's own "today".
PRICE_YEAR = 2025

# NHTS MAKE is a two-digit code; the codebook (codebook_v1.1.xlsx, CODEBOOK_VEH)
# names 56 of them. Only makes that can be matched against the fuel-economy
# catalogue are listed here — the codebook's motorcycle makes (Harley-Davidson,
# Yamaha, Ducati) are dropped with the motorcycle body type, and the residual
# codes (98 Other, 99 Unknown, XX suppressed) have no model list to draw from.
#
# Names on the right are spelled the way fueleconomy.gov spells them, which is
# not always the way NHTS does: NHTS carries "Nissan/Datsun" and "KIA", the EPA
# carries "Nissan" and "Kia", and joining on the raw strings silently drops
# 12,000 vehicles.
NHTS_MAKE = {
    "01": "American Motors", "02": "Jeep", "03": "AM General",
    "06": "Chrysler", "07": "Dodge", "09": "Plymouth",
    "12": "Ford", "13": "Lincoln", "14": "Mercury",
    "18": "Buick", "19": "Cadillac", "20": "Chevrolet",
    "21": "Oldsmobile", "22": "Pontiac", "23": "GMC", "24": "Saturn",
    "30": "Volkswagen", "32": "Audi", "34": "BMW", "35": "Nissan",
    "36": "FIAT", "37": "Honda", "38": "Isuzu", "39": "Jaguar",
    "41": "Mazda", "42": "Mercedes-Benz", "43": "MG", "45": "Porsche",
    "47": "Saab", "48": "Subaru", "49": "Toyota", "50": "Triumph",
    "51": "Volvo", "52": "Mitsubishi", "53": "Suzuki", "54": "Acura",
    "55": "Hyundai", "58": "Infiniti", "59": "Lexus", "62": "Land Rover",
    "63": "Kia", "65": "Smart", "67": "Scion",
}

# NHTS VEHTYPE, from the same codebook sheet. The four kept are the four that
# are ordinary household vehicles with a passenger registration; RV, motorcycle
# and "other truck" carry different plate classes and belong with the fleet /
# specialty work rather than here.
BODY = {"01": "car", "02": "van", "03": "suv", "04": "pickup"}

# EPA VClass has 34 values at trim granularity ("Small Sport Utility Vehicle
# 4WD", "Standard Pickup Trucks 2WD"); NHTS has four. Matching happens at the
# NHTS granularity, so the EPA classes fold down by substring. Order matters —
# "Small Pickup Trucks" contains neither "van" nor "cars", but testing pickup
# before the others keeps the rule readable rather than accidental.
def fold_epa_class(vclass):
    """The NHTS body type an EPA size class belongs to, or None if it has none."""
    v = vclass.lower()
    if "pickup" in v:
        return "pickup"
    if "sport utility" in v:
        return "suv"
    if "van" in v:
        return "van"
    if "cars" in v or "wagon" in v or "two seater" in v:
        return "car"
    # Special-purpose vehicles and the EPA's own unclassified rows.
    return None


# ---------------------------------------------------------------------------
# Price
# ---------------------------------------------------------------------------

# Where a make sits in the market. This decides price and nothing else — it is
# not a quality judgement and it is not what the survey conditions on, which is
# the make itself. Tiers exist because a curated MSRP table has to be small
# enough to be checkable by hand, and 43 makes x 4 bodies x 35 years is not.
TIER = {
    "economy": ("Kia", "Hyundai", "Mitsubishi", "Suzuki", "Smart", "Scion",
                "FIAT", "Saturn", "Isuzu", "Plymouth", "American Motors",
                "Geo", "Daewoo"),
    "mainstream": ("Ford", "Chevrolet", "Toyota", "Honda", "Nissan", "Mazda",
                   "Subaru", "Dodge", "Jeep", "Chrysler", "GMC", "Volkswagen",
                   "Buick", "Pontiac", "Oldsmobile", "Mercury", "Ram",
                   "AM General", "MG", "Triumph"),
    "near_luxury": ("Acura", "Infiniti", "Lexus", "Volvo", "Lincoln",
                    "Cadillac", "Audi", "Saab", "MINI", "Genesis"),
    "luxury": ("BMW", "Mercedes-Benz", "Jaguar", "Land Rover", "Porsche",
               "Tesla", "Maserati", "Alfa Romeo"),
}
MAKE_TIER = {make: tier for tier, makes in TIER.items() for make in makes}

# Median transaction price of a *new* vehicle in PRICE_YEAR dollars, by tier and
# body. Hand-built, because no free dataset carries MSRP by model: anchored on
# published 2024-25 average transaction prices (industry mid-$40Ks overall,
# full-size pickups near $60K, entry compacts low $20Ks) and interpolated
# across the grid. Every number here is an estimate and should be read as one.
PRICE = {
    "economy":     {"car": 22_000, "van": 27_000, "suv": 26_000, "pickup": 28_000},
    "mainstream":  {"car": 29_000, "van": 39_000, "suv": 36_000, "pickup": 47_000},
    "near_luxury": {"car": 47_000, "van": 52_000, "suv": 54_000, "pickup": 62_000},
    "luxury":      {"car": 68_000, "van": 72_000, "suv": 78_000, "pickup": 85_000},
}

# Share of original value retained after n years. The first year is the cliff
# every buyer knows about (~20%), then roughly 15%/year compounding, flattening
# once a car is worth more as transport than as an asset. Beyond the table the
# last value holds — a 25-year-old car and a 30-year-old car are both worth
# whatever someone will pay for a running car.
DEPRECIATION = (1.00, 0.80, 0.70, 0.61, 0.54, 0.47, 0.42, 0.37, 0.33, 0.29,
                0.26, 0.23, 0.21, 0.19, 0.17, 0.16, 0.15, 0.14, 0.13, 0.12,
                0.11, 0.11, 0.10, 0.10, 0.09, 0.09)

# No car on the road is worth nothing: below this it is scrap steel with plates
# on it, and the floor is roughly what a yard pays by weight.
SCRAP_FLOOR = 700


def value_at_age(new_price, age):
    """Current market value of a vehicle that cost `new_price` new, `age` years on."""
    retained = DEPRECIATION[min(age, len(DEPRECIATION) - 1)]
    return max(SCRAP_FLOOR, int(round(new_price * retained / 50.0) * 50))


# ---------------------------------------------------------------------------
# Colour
# ---------------------------------------------------------------------------

# Axalta's North America colour popularity shares, split by body because the
# split is real and large: white is a quarter of cars and a third of pickups,
# and a fleet coloured from one national table has visibly too few white trucks.
# Weights are relative within a body type and need not sum to 100.
COLOUR = {
    "car":    (("white", 22), ("black", 22), ("gray", 20), ("silver", 10),
               ("blue", 10), ("red", 8), ("green", 2), ("brown", 2),
               ("beige", 2), ("gold", 1), ("orange", 1)),
    "suv":    (("white", 26), ("black", 22), ("gray", 19), ("silver", 9),
               ("blue", 9), ("red", 7), ("green", 3), ("brown", 2),
               ("beige", 2), ("gold", 1)),
    "pickup": (("white", 32), ("black", 18), ("gray", 16), ("red", 10),
               ("blue", 9), ("silver", 8), ("green", 3), ("brown", 2),
               ("beige", 1), ("gold", 1)),
    "van":    (("white", 40), ("gray", 14), ("silver", 12), ("black", 12),
               ("blue", 8), ("red", 6), ("green", 3), ("brown", 2),
               ("beige", 2), ("gold", 1)),
}


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# HHFAMINC bracket -> (low, high) household income in dollars, from the
# codebook. The open top bracket gets a finite ceiling so a bracket can be
# looked up from a HINCP value by comparison rather than by special case.
INCOME_BRACKET = {
    "01": (0, 10_000), "02": (10_000, 15_000), "03": (15_000, 25_000),
    "04": (25_000, 35_000), "05": (35_000, 50_000), "06": (50_000, 75_000),
    "07": (75_000, 100_000), "08": (100_000, 125_000),
    "09": (125_000, 150_000), "10": (150_000, 200_000),
    "11": (200_000, 10_000_000),
}

# NHTS census division 02 is the Middle Atlantic (NY, NJ, PA). It is the right
# region and it is too small to condition on: 1,164 urban vehicles across 11
# income brackets leaves cells of 16. So regional rows are upweighted rather
# than filtered to, which tilts the fleet toward the local mix — older, fewer
# pickups — without ever emptying a bracket. The multiplier is a judgement
# call, not an estimate; it is here to be turned down if the fleet reads wrong.
MID_ATLANTIC = "02"
REGION_TILT = 3.0


def load_catalogue():
    """(make, body, year) -> [(model, weight)], from the EPA extract.

    The weight is a stand-in for sales volume, which no free source carries at
    model level. Drawn uniformly instead, the catalogue puts a Kia K900 — a
    $60k flagship sold for five years in four figures — in as many driveways as
    a Silverado, which is the same failure as an income-blind fleet wearing a
    different hat.

    Two things in the extract correlate with volume well enough to stand in for
    it. How many model years a nameplate survived: a car nobody bought is
    cancelled, and the ones that run for decades are the ones that sell. And
    how many distinct EPA variants exist in a given year: high-volume models
    are tested in more engine and drivetrain combinations than low-volume ones.
    Their product spreads roughly two orders of magnitude across a make's
    range, which is about the real spread, and the square root pulls it back
    from letting one nameplate swamp its cell.

    This is a proxy and it is the weakest input in the file. Real sales volumes
    by model-year drop straight in here if a source ever turns up.
    """
    variants = collections.Counter()
    years_seen = collections.defaultdict(set)
    rows = []
    with open(FUEL_ECONOMY, newline="") as handle:
        for row in csv.DictReader(handle):
            body = fold_epa_class(row["VClass"])
            year = row["year"]
            if not body or not year.isdigit():
                continue
            model = (row["baseModel"] or row["model"]).strip()
            if not model:
                continue
            key = (row["make"], body, int(year), model)
            variants[key] += 1
            years_seen[(row["make"], model)].add(int(year))
            rows.append(key)

    catalogue = collections.defaultdict(dict)
    for make, body, year, model in set(rows):
        longevity = len(years_seen[(make, model)])
        weight = (longevity * variants[(make, body, year, model)]) ** 0.5
        catalogue[(make, body, year)][model] = round(weight, 3)
    return {k: sorted(v.items()) for k, v in catalogue.items()}


def load_survey():
    """The surveyed household vehicles, as resampling rows grouped by income."""
    rows = collections.defaultdict(list)
    dropped = collections.Counter()
    with open(NHTS_VEHICLES, newline="") as handle:
        for row in csv.DictReader(handle):
            make = NHTS_MAKE.get(row["MAKE"])
            body = BODY.get(row["VEHTYPE"])
            bracket = row["HHFAMINC"]
            age, year = row["VEHAGE"], row["VEHYEAR"]
            if not make:
                dropped["make not in catalogue"] += 1
                continue
            if not body:
                dropped["body type not a household vehicle"] += 1
                continue
            if bracket not in INCOME_BRACKET:
                dropped["income not reported"] += 1
                continue
            if not age.isdigit() or not year.isdigit():
                dropped["age or year not reported"] += 1
                continue
            weight = float(row["WTHHFIN"] or 0)
            if weight <= 0:
                dropped["no survey weight"] += 1
                continue
            if row["CENSUS_D"] == MID_ATLANTIC:
                weight *= REGION_TILT
            rows[bracket].append({
                "make": make,
                "body": body,
                "age": int(age),
                "year": int(year),
                # VEHOWNED 02 is leased; it maps onto the existing title status.
                "leased": row["VEHOWNED"] == "02",
                "commercial": row["VEHCOMMERCIAL"] == "01",
                "weight": round(weight, 2),
            })
    return rows, dropped


def build():
    catalogue = load_catalogue()
    survey, dropped = load_survey()

    # A surveyed row is only drawable if some model can be named for it. Rather
    # than dropping the unmatched 4%, the draw widens its model year — a 2003
    # Isuzu SUV with no 2003 row is still an Isuzu SUV — so the resolution
    # ladder is recorded here and the module walks it at draw time.
    matched = unmatched = 0
    for bracket_rows in survey.values():
        for row in bracket_rows:
            if (row["make"], row["body"], row["year"]) in catalogue:
                matched += 1
            else:
                unmatched += 1

    return {
        "price_year": PRICE_YEAR,
        "region_tilt": REGION_TILT,
        "income_brackets": INCOME_BRACKET,
        "make_tier": MAKE_TIER,
        "price": PRICE,
        "depreciation": list(DEPRECIATION),
        "scrap_floor": SCRAP_FLOOR,
        "colour": {b: list(map(list, c)) for b, c in COLOUR.items()},
        # JSON cannot key on a tuple; the catalogue flattens to "make|body|year".
        "catalogue": {f"{m}|{b}|{y}": models
                      for (m, b, y), models in catalogue.items()},
        "survey": survey,
    }, dropped, matched, unmatched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    for path in (NHTS_VEHICLES, FUEL_ECONOMY):
        if not path.exists():
            sys.exit(f"missing extract: {path}")

    market, dropped, matched, unmatched = build()
    args.out.write_text(json.dumps(market, separators=(",", ":")))

    total = sum(len(r) for r in market["survey"].values())
    size = args.out.stat().st_size
    print(f"vehicle market -> {args.out.name} ({size / 1e6:.1f} MB)")
    print(f"  {total:,} surveyed vehicles across "
          f"{len(market['survey'])} income brackets")
    print(f"  {len(market['catalogue']):,} (make, body, year) cells, "
          f"{sum(len(v) for v in market['catalogue'].values()):,} models")
    print(f"  {unmatched:,} of {total:,} surveyed rows "
          f"({100 * unmatched / total:.1f}%) need a widened model year")
    for reason, count in dropped.most_common():
        print(f"  dropped {count:,}: {reason}")

    thin = [b for b, rows in market["survey"].items() if len(rows) < 100]
    if thin:
        print(f"  thin brackets (<100 rows): {', '.join(sorted(thin))}")


if __name__ == "__main__":
    main()
