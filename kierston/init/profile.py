"""The city profile: the parameters that identify a city, loaded from TOML.

Only what code actually reads is in here. A profile schema that carried a
currency and a mayor because a city plausibly has them would be two fields
of documentation pretending to be configuration — every key below is consumed
by something, and `cities/kierston.toml` says by what.

Fitted values are deliberately absent. Anything the city's own data can answer
is measured at intake and written to the manifest; putting it here would ask a
new city's author to supply a number they have no way to know, and would let
Kierston's answer silently stand in for a city it was never measured on.
"""

import tomllib
from dataclasses import dataclass
from datetime import date

from paths import PROFILE, require


@dataclass(frozen=True)
class Extent:
    """The extract the city is cut from. Read by the acquire helpers."""
    center: tuple[float, float]
    radius_m: int


@dataclass(frozen=True)
class Microdata:
    """Which sample the population is cloned from. Read by acquire/fetch_pums.py."""
    dataset: str
    vintage: int
    state: str
    puma: tuple[str, ...]


@dataclass(frozen=True)
class Housing:
    """Dwelling-stock estimation, minus everything intake fits for itself."""
    min_sample: int
    flats_default: int
    flats_per_tall_level: int


@dataclass(frozen=True)
class Locale:
    """The city's local particulars, as `[locale]` states them.

    `time_zone` is published to city.json by intake/manifest.py;
    `reference_date` is "now" for registries.py, banking.py and every stage
    that ages a record; `centre` is the rent model's in recurring_spending.py;
    `postal_city` is read by work/facilities.py; `county` names the offices in
    holdings.py, recurring_spending.py and dockets.py; the court numbers and
    the carry-licence series are registries.py's, and so are the area codes
    and their eras, which devices.py also reads.
    """
    time_zone: str
    reference_date: date
    centre: tuple[float, float]
    postal_city: str
    county: str
    judicial_district: str
    federal_division: str
    carry_licence_prefix: str
    carry_licence_series_start: int
    area_codes: tuple[str, ...]
    # (first year not covered, shares over `area_codes`), in order.
    area_code_eras: tuple[tuple[int, tuple[float, ...]], ...]


@dataclass(frozen=True)
class Profile:
    name: str
    slug: str
    extent: Extent
    microdata: Microdata
    jurisdiction: str
    housing: Housing
    locale: Locale


def _locale(raw):
    eras = tuple((era["before"], tuple(era["shares"]))
                 for era in raw["area_code_eras"])
    codes = tuple(raw["area_codes"])
    if any(len(shares) != len(codes) for _, shares in eras):
        raise SystemExit(f"[locale] area_code_eras: every era needs one share "
                         f"per area code ({len(codes)})")
    reference = raw["reference_date"]
    if not isinstance(reference, date):
        raise SystemExit("[locale] reference_date must be a TOML date, "
                         "e.g. 2026-07-01")
    return Locale(
        time_zone=raw["time_zone"],
        reference_date=reference,
        centre=tuple(raw["centre"]),
        postal_city=raw["postal_city"],
        county=raw["county"],
        judicial_district=raw["judicial_district"],
        federal_division=raw["federal_division"],
        carry_licence_prefix=raw["carry_licence_prefix"],
        carry_licence_series_start=raw["carry_licence_series_start"],
        area_codes=codes,
        area_code_eras=eras,
    )


def load():
    """The active city's profile, chosen by KIERSTON_CITY."""
    require(PROFILE, f"write a profile for this city at {PROFILE}")
    raw = tomllib.loads(PROFILE.read_text())
    extent = raw["extent"]
    micro = raw["microdata"]
    housing = raw["housing"]
    return Profile(
        name=raw["city"]["name"],
        slug=raw["city"]["slug"],
        extent=Extent(center=tuple(extent["center"]), radius_m=extent["radius_m"]),
        microdata=Microdata(
            dataset=micro["dataset"], vintage=micro["vintage"],
            state=micro["state"], puma=tuple(micro["puma"]),
        ),
        jurisdiction=raw["jurisdiction"]["profile"],
        housing=Housing(
            min_sample=housing["min_sample"],
            flats_default=housing["flats_default"],
            flats_per_tall_level=housing["flats_per_tall_level"],
        ),
        locale=_locale(raw["locale"]),
    )
