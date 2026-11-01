"""Dwelling-stock parameters, measured from the city's own buildings.

These were four module constants in `extract_dwellings.py`, every one of them
derived by hand from Kierston's OSM export and then written down. That is fine
until somebody points the pipeline at another city, where the constants are
still the reference city's and nothing says so — an apartment block in a city with
different stock gets its unit count from a median nobody measured there.

So the ones a sample can answer are answered from the sample. What this module
does *not* do is pretend that all four are like that. Two of them are:

    area_per_unit    gross floor area per apartment unit, m². The median of
                     footprint x levels / building:flats over the blocks
                     carrying both. Kierston: 367 blocks, median 105.95,
                     mean 108.5, p10-p90 65-148 — a spread wide enough to be
                     worth re-measuring anywhere else, and tight enough to
                     carry the blocks OSM never counted.

    flats_by_level   median flats among tagged apartments of the same height.
                     Kierston: 168 blocks at 2 levels, 163 at 3, 18 at 4, and
                     then it falls off a cliff — 4 or fewer per level above
                     that, with an enormous spread.

The other two are judgements wearing a number, and hoisting them in here would
have been the more comfortable lie. `flats_default` covers blocks with no
height information at all: the sample that would fit it is precisely the sample
that is missing. `flats_per_tall_level` covers 5 levels and up, where Kierston
offers 16 blocks whose flats-per-level median is 11.2 — the shipped value is
12, so it was chosen and not measured. Both stay in the profile, where a number
somebody picked belongs.

Thin samples fall back to Kierston's own values, because Kierston's stock is
the only stock anyone has measured. The manifest records which of the two
happened for every value, so a city fitted on nine buildings says so out loud
rather than reporting a number as if it had been earned.
"""

from collections import defaultdict
from dataclasses import dataclass
from statistics import mean, median


# Measured on Kierston, and used when a city's own sample is too thin to fit.
# Not defaults in the ordinary sense — they are one city's answer standing in
# for another's, which is why every use of them is recorded in the manifest.
KIERSTON_AREA_PER_UNIT = 106.0
KIERSTON_FLATS_BY_LEVEL = {1: 3, 2: 4, 3: 5, 4: 8}


@dataclass(frozen=True)
class Value:
    """One fitted parameter, and whether it was actually fitted."""
    value: object
    source: str          # "fitted" or "fallback"
    sample: int
    stats: dict | None = None

    def entry(self):
        """The manifest's view: the number, and what stands behind it."""
        record = {"value": self.value, "source": self.source, "sample": self.sample}
        if self.stats:
            record["stats"] = self.stats
        return record


@dataclass(frozen=True)
class Housing:
    area_per_unit: Value
    flats_by_level: Value

    def manifest(self):
        return {
            "area_per_unit": self.area_per_unit.entry(),
            "flats_by_level": self.flats_by_level.entry(),
        }


def _percentile(values, fraction):
    ordered = sorted(values)
    return ordered[int(fraction * len(ordered))]


def fit_housing(samples, min_sample):
    """Fit the two measurable parameters from `(flats, levels, area)` triples.

    `samples` is every multi-unit residential building with a usable footprint,
    tagged or not — see `dwellings.py:fit_samples` for why POI-tagged shells
    are included here but excluded from the stock itself.
    """
    tagged = [(flats, levels, area) for flats, levels, area in samples if flats > 0]

    ratios = [area * levels / flats for flats, levels, area in tagged
              if levels > 0 and area]
    if len(ratios) >= min_sample:
        # One decimal place: the spread is 65-148, so the second one would be
        # reporting precision the sample does not have.
        area_per_unit = Value(round(median(ratios), 1), "fitted", len(ratios), {
            "median": round(median(ratios), 2),
            "mean": round(mean(ratios), 2),
            "p10": round(_percentile(ratios, 0.10), 1),
            "p90": round(_percentile(ratios, 0.90), 1),
        })
    else:
        area_per_unit = Value(KIERSTON_AREA_PER_UNIT, "fallback", len(ratios))

    by_level = defaultdict(list)
    for flats, levels, _ in tagged:
        if levels > 0:
            by_level[levels].append(flats)

    # int() and not round(): a median of 8.5 flats over 18 buildings is not
    # evidence for 9, and rounding up compounds across a whole stock.
    fitted_levels = {level: int(median(values))
                     for level, values in sorted(by_level.items())
                     if len(values) >= min_sample}
    counts = {level: len(values) for level, values in sorted(by_level.items())}

    # Levels the city could not answer keep Kierston's figure. A level with a
    # thin local sample is the case this exists for; a level Kierston never had
    # an answer for either falls through to the tall rate, as before.
    merged = dict(KIERSTON_FLATS_BY_LEVEL)
    merged.update(fitted_levels)
    borrowed = sorted(set(merged) - set(fitted_levels))
    flats_by_level = Value(
        merged,
        "fitted" if fitted_levels else "fallback",
        sum(len(values) for values in by_level.values()),
        {
            "fitted_levels": fitted_levels,
            "borrowed_levels": borrowed,
            "sample_by_level": counts,
        },
    )

    return Housing(area_per_unit=area_per_unit, flats_by_level=flats_by_level)


def report(housing, min_sample):
    """Print what was measured and what was borrowed. Intake's own validation."""
    area, levels = housing.area_per_unit, housing.flats_by_level
    print("fitted from this city's stock:")
    if area.source == "fitted":
        stats = area.stats
        print(f"  area per unit      {area.value:>6} m²  "
              f"n={area.sample:,} median={stats['median']} mean={stats['mean']} "
              f"p10-p90 {stats['p10']}-{stats['p90']}")
    else:
        print(f"  area per unit      {area.value:>6} m²  BORROWED from Kierston "
              f"(n={area.sample} < {min_sample})")

    fitted = levels.stats["fitted_levels"]
    borrowed = levels.stats["borrowed_levels"]
    counts = levels.stats["sample_by_level"]
    shown = ", ".join(f"{level}:{flats}(n={counts[level]})"
                      for level, flats in sorted(fitted.items()))
    print(f"  flats by level     {shown or 'nothing fitted'}")
    if borrowed:
        thin = ", ".join(
            f"{level}:{levels.value[level]}"
            f"(n={counts.get(level, 0)})" for level in borrowed)
        print(f"  borrowed from Kierston: {thin}  "
              f"— fewer than {min_sample} tagged blocks at that height")
