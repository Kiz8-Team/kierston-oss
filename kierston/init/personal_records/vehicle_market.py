"""What car a household in Kierston actually owns, given what it earns.

The problem this solves is the one a naive fleet always gets wrong: a city
where vehicles are drawn independently of income has cleaners in Range Rovers
and surgeons in twenty-year-old Cavaliers, and no amount of tuning a price
ceiling fixes it, because the thing that ties income to a car is not a budget
constraint. It is that people buy what people like them buy. Household income
predicts body type and vehicle *age* at least as strongly as it predicts price:
the difference between $30k and $150k is much more "a nine-year-old sedan
versus a three-year-old SUV" than it is any single dollar figure.

So nothing here estimates that relationship. `build_vehicle_market.py` bakes
the NHTS 2022 household vehicle file into a resampling table keyed by income
bracket, and a draw is: take a real surveyed vehicle from the right bracket,
then name a real model that make sold that year. A $40k household never draws
a Porsche because no $40k household in the survey reported one — the constraint
is the data's, not a rule someone wrote and has to maintain.

Four things come out of a draw and they are sourced quite differently, which
matters when judging how far to trust each:

    make, body, age    surveyed. NHTS, conditioned on income bracket.
    model              catalogued. A real model the make sold that year, from
                       the EPA fuel-economy extract.
    colour             curated. Axalta North America shares by body type.
    price              estimated. Tier x body table plus a depreciation curve,
                       and the only number here with no source behind it.

Price is last on purpose. By the time it is assigned the make and the year are
already fixed by the survey, so price only has to *agree* with them — it is
carrying consistency, not realism. Read a generated price as "about what this
car is worth", never as a quote.

Not modelled: trim and options (the EPA extract's `baseModel` deliberately
strips them, since a fleet distinguishing an LX from an EX implies a source for
that split that does not exist), and mileage, which belongs with vehicle use
rather than with the registration record.
"""

import bisect
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


from paths import VEHICLE_MARKET as MARKET  # noqa: E402

# How far to walk away from a model year looking for a catalogue entry. The
# EPA extract misses about 4% of surveyed (make, body, year) cells — an
# unpopular body a make sold in small numbers, mostly, or a year at the edge
# of the extract. Six years either way resolves nearly all of them and stays
# inside a single model generation, so the name that comes back is one the
# make really did sell on that platform.
YEAR_WINDOW = 6


class Market:
    """The baked market table, ready to draw from.

    Loading is deferred to first use rather than done at import, because the
    table is 1.5 MB of JSON and several stages import this module for the
    price helpers without ever drawing a vehicle.
    """

    def __init__(self, path=MARKET):
        self.path = Path(path)
        self._loaded = False

    # -- loading ------------------------------------------------------------

    def _load(self):
        if self._loaded:
            return
        if not self.path.exists():
            raise FileNotFoundError(
                f"{self.path.name} is missing; run "
                f"reference/build/build_vehicle_market.py")
        market = json.loads(self.path.read_text())
        self.price_year = market["price_year"]
        self.make_tier = market["make_tier"]
        self.price = market["price"]
        self.depreciation = market["depreciation"]
        self.scrap_floor = market["scrap_floor"]
        self.colour = {b: ([c for c, _ in v], [w for _, w in v])
                       for b, v in market["colour"].items()}
        self.catalogue = market["catalogue"]

        # Income brackets, as ascending ceilings so a HINCP value resolves by
        # bisection rather than by scanning eleven ranges.
        brackets = sorted(market["income_brackets"].items(),
                          key=lambda kv: kv[1][0])
        self._bracket_codes = [code for code, _ in brackets]
        self._bracket_ceilings = [high for _, (_, high) in brackets]

        # Cumulative survey weights per bracket, so a draw is one bisection.
        self.survey = {}
        for code, rows in market["survey"].items():
            cumulative, running = [], 0.0
            for row in rows:
                running += row["weight"]
                cumulative.append(running)
            self.survey[code] = (rows, cumulative, running)

        # A company taxi is not bought by a synthetic household, so it must not
        # inherit any household's income bracket. Build one city-independent
        # pool from the commercial passenger vehicles in every bracket.
        commercial = []
        for rows, _, _ in self.survey.values():
            commercial.extend(row for row in rows
                              if row["commercial"] and row["body"] in ("car", "suv"))
        cumulative, running = [], 0.0
        for row in commercial:
            running += row["weight"]
            cumulative.append(running)
        self.commercial = (commercial, cumulative, running)

        # Which years the catalogue holds per (make, body), for the widening
        # walk. Built once here rather than parsed out of the keys per draw.
        self._years = {}
        for key in self.catalogue:
            make, body, year = key.rsplit("|", 2)
            self._years.setdefault((make, body), []).append(int(year))
        for years in self._years.values():
            years.sort()

        self._loaded = True

    # -- lookups ------------------------------------------------------------

    def bracket(self, income):
        """The NHTS income bracket a household income falls in.

        Households with no income, or with the negative HINCP that PUMS uses
        for a loss, sit in the bottom bracket — which is where the survey puts
        them too, since NHTS asks for a bracket rather than a signed figure.
        """
        self._load()
        if income is None:
            income = 0
        index = bisect.bisect_right(self._bracket_ceilings, max(0, int(income)))
        return self._bracket_codes[min(index, len(self._bracket_codes) - 1)]

    def models(self, make, body, year):
        """`(names, weights)` for a cell, widening the year until one answers.

        Returns empty lists only when the make sold nothing of that body at
        all, which the caller has to handle — it means the survey and the
        catalogue disagree about what the make ever built, and the honest
        answer is to redraw rather than to invent a name.
        """
        self._load()
        cell = self.catalogue.get(f"{make}|{body}|{year}")
        if not cell:
            available = self._years.get((make, body))
            if not available:
                return [], []
            nearest = min(available, key=lambda y: (abs(y - year), y))
            if abs(nearest - year) > YEAR_WINDOW:
                return [], []
            cell = self.catalogue[f"{make}|{body}|{nearest}"]
        return [m for m, _ in cell], [w for _, w in cell]

    def new_price(self, make, body):
        """Roughly what this vehicle cost new, in `price_year` dollars."""
        self._load()
        tier = self.make_tier.get(make, "mainstream")
        return self.price[tier][body]

    def value(self, make, body, age):
        """Roughly what it is worth now, depreciated from new."""
        self._load()
        retained = self.depreciation[min(age, len(self.depreciation) - 1)]
        priced = self.new_price(make, body) * retained
        return max(self.scrap_floor, int(round(priced / 50.0) * 50))

    # -- drawing ------------------------------------------------------------

    def _finish(self, row, rng, today):
        """Turn one surveyed row into a complete drawable market record."""
        make, body, age = row["make"], row["body"], row["age"]
        model_year = today - age
        names, volume = self.models(make, body, model_year)
        if not names:
            return None
        colours, weights = self.colour[body]
        return {
            "make": make,
            "model": rng.choices(names, weights=volume)[0],
            "body": body,
            "model_year": model_year,
            "colour": rng.choices(colours, weights=weights)[0],
            "leased": row["leased"],
            "commercial": row["commercial"],
            "price_new": self.new_price(make, body),
            "value": self.value(make, body, age),
        }

    def draw(self, income, rng, today):
        """One vehicle for a household earning `income`.

        `today` is the simulation's reference year, and the surveyed vehicle's
        *age* rather than its model year is what carries over from the survey:
        NHTS was collected in 2022, so a surveyed 2015 car is a seven-year-old
        car, and seven years before today is what it should be here.
        """
        self._load()
        code = self.bracket(income)
        rows, cumulative, total = self.survey[code]

        # A handful of redraws covers the rare surveyed row whose make has no
        # catalogue entry for its body at all. Falling back to a fixed make
        # would quietly concentrate the fleet on whatever that make was.
        for _ in range(8):
            row = rows[bisect.bisect_left(cumulative, rng.random() * total)]
            drawn = self._finish(row, rng, today)
            if drawn:
                return drawn
        raise RuntimeError(
            f"no drawable vehicle for income bracket {code} after 8 attempts")

    def draw_commercial(self, rng, today):
        """A commercial passenger vehicle, independent of household income."""
        self._load()
        rows, cumulative, total = self.commercial
        for _ in range(8):
            row = rows[bisect.bisect_left(cumulative, rng.random() * total)]
            drawn = self._finish(row, rng, today)
            if drawn:
                drawn["leased"] = False
                drawn["commercial"] = True
                return drawn
        raise RuntimeError("no drawable commercial passenger vehicle after 8 attempts")


# The shared instance. One table, loaded once, drawn from with per-person RNGs
# the same way `registries` is used.
market = Market()


def main():
    """Draw a sample fleet and report what it looks like, as a sanity check."""
    import collections

    rng = random.Random(20260731)
    today = 2025
    incomes = (12_000, 28_000, 45_000, 68_000, 95_000, 140_000, 260_000)

    print(f"{'income':>9}  {'median value':>12}  typical draws")
    for income in incomes:
        draws = [market.draw(income, rng, today) for _ in range(400)]
        values = sorted(d["value"] for d in draws)
        common = collections.Counter(
            f"{d['model_year']} {d['make']} {d['model']}" for d in draws)
        ages = sorted(today - d["model_year"] for d in draws)
        print(f"{income:>9,}  {values[len(values) // 2]:>12,}  "
              f"median age {ages[len(ages) // 2]:>2}y  "
              f"{', '.join(n for n, _ in common.most_common(3))}")

    # The concentration check: a real fleet is lumpy, so this is not looking
    # for uniformity. It is looking for whether one model runs away with the
    # city, which is what resampling 13,000 rows into 60,000 vehicles could do.
    fleet = [market.draw(rng.choice(incomes), rng, today) for _ in range(60_000)]
    exact = collections.Counter(
        f"{d['model_year']} {d['make']} {d['model']}" for d in fleet)
    nameplate = collections.Counter(f"{d['make']} {d['model']}" for d in fleet)
    print(f"\n60,000-vehicle fleet: {len(exact):,} distinct make/model/year, "
          f"{len(nameplate):,} distinct nameplates")
    print(f"  most common exact vehicle: {exact.most_common(1)[0][1]:,} "
          f"({100 * exact.most_common(1)[0][1] / 60_000:.2f}%) "
          f"{exact.most_common(1)[0][0]}")
    for name, count in nameplate.most_common(6):
        print(f"  {100 * count / 60_000:5.2f}%  {name}")
    body = collections.Counter(d["body"] for d in fleet)
    print("  bodies: " + ", ".join(
        f"{b} {100 * c / 60_000:.0f}%" for b, c in body.most_common()))


if __name__ == "__main__":
    main()
