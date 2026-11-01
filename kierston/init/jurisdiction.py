"""The legal system a city's records are filed under, loaded from TOML.

`jurisdictions/<profile>/jurisdiction.toml`, with the profile named by the
city's `[jurisdiction]`. It holds what every city under that legal system
shares: the state's codes, how a statute is cited, the motor vehicle agency's
numbering and plate rules, the carry-licence law. What differs between two
cities in the same state — which county, which court district, which sheriff —
is the city's `[locale]` instead; see profile.py.

Like the profile, every key is consumed: the docstring of each class says by what.
"""

import importlib
import tomllib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import profile as city_profile
from paths import jurisdiction_rules, require


@dataclass(frozen=True)
class State:
    """Read by registries.py (SSN area), identity.py (moved within the state)
    and plate_rules.py (a plate's home jurisdiction)."""
    code: str
    name: str
    fips: str

    @property
    def pobp(self):
        """The state as PUMS writes a place of birth or migration: zero-padded to three."""
        return self.fips.zfill(3)


@dataclass(frozen=True)
class Licensing:
    """Read by registries.py (licence numbering), holdings.py (licences),
    vehicles.py (registration issuer), recurring_spending.py (the fee's payee)
    and plate_rules.py."""
    issuer: str
    issuer_short: str
    licence_series_start: int
    renewal_years: int
    senior_renewal_years: int
    senior_age: int
    suspension_months: dict


@dataclass(frozen=True)
class Visitor:
    jurisdiction: str
    share: float
    pattern: str


@dataclass(frozen=True)
class Plates:
    """The passenger series and the special series are registries.py's;
    `front` and `visitors` are published to the simulation by plate_rules.py;
    the fee is recurring_spending.py's."""
    letters: str
    block_start: str
    block_year: int
    blocks_per_year: float
    front: bool
    personalized_max: int
    school_bus_series_start: int
    municipal_series_start: int
    registration_fee: float
    visitors: tuple


@dataclass(frozen=True)
class Firearms:
    """Read by holdings.py."""
    carry_licence_statute: str
    carry_licence_age: int
    carry_licence_term_years: int
    background_check_agency: str
    record_of_sale_form: str


@dataclass(frozen=True)
class Jurisdiction:
    profile: str
    state: State
    # How a statute section is cited, a format string over `title` and
    # `section`. Read by offenses.py.
    cite: str
    # The facility named for a state prison sentence. Read by dockets.py.
    state_prison: str
    licensing: Licensing
    plates: Plates
    firearms: Firearms

    def citation(self, title, section):
        return self.cite.format(title=title, section=section)


def _plates(raw):
    visitors = tuple(Visitor(jurisdiction=row["jurisdiction"], share=row["share"],
                             pattern=row["pattern"]) for row in raw["visitors"])
    for visitor in visitors:
        # The simulation fills a pattern from three drawn letters and six drawn
        # digits; a pattern that needs more cannot be written.
        if visitor.pattern.count("L") > 3 or visitor.pattern.count("D") > 6:
            raise SystemExit(f"plates.visitors {visitor.jurisdiction}: pattern "
                             f"{visitor.pattern!r} uses more than 3 L or 6 D")
    return Plates(
        letters=raw["letters"], block_start=raw["block_start"],
        block_year=raw["block_year"], blocks_per_year=raw["blocks_per_year"],
        front=raw["front"], personalized_max=raw["personalized_max"],
        school_bus_series_start=raw["school_bus_series_start"],
        municipal_series_start=raw["municipal_series_start"],
        registration_fee=raw["registration_fee"], visitors=visitors,
    )


@lru_cache(maxsize=None)
def load(profile=None):
    """The active city's jurisdiction, or the named bundle's."""
    profile = profile or city_profile.load().jurisdiction
    path = require(jurisdiction_rules(profile),
                   f"kierston/jurisdictions/{profile}/jurisdiction.toml is tracked "
                   f"in git; restore it")
    raw = tomllib.loads(path.read_text())
    licensing = raw["licensing"]
    firearms = raw["firearms"]
    return Jurisdiction(
        profile=profile,
        state=State(code=raw["state"]["code"], name=raw["state"]["name"],
                    fips=raw["state"]["fips"]),
        cite=raw["statutes"]["cite"],
        state_prison=raw["corrections"]["state_prison"],
        licensing=Licensing(
            issuer=licensing["issuer"], issuer_short=licensing["issuer_short"],
            licence_series_start=licensing["licence_series_start"],
            renewal_years=licensing["renewal_years"],
            senior_renewal_years=licensing["senior_renewal_years"],
            senior_age=licensing["senior_age"],
            suspension_months=dict(licensing["suspension_months"]),
        ),
        plates=_plates(raw["plates"]),
        firearms=Firearms(
            carry_licence_statute=firearms["carry_licence_statute"],
            carry_licence_age=firearms["carry_licence_age"],
            carry_licence_term_years=firearms["carry_licence_term_years"],
            background_check_agency=firearms["background_check_agency"],
            record_of_sale_form=firearms["record_of_sale_form"],
        ),
    )


STATE_GENERATORS = Path(__file__).resolve().parent / "state_specific_generators"


def state_module(name):
    """The active state's module `name` from state_specific_generators/<code>/.

    The folder is picked by `[state] code` in jurisdiction.toml, so every city in
    one state shares it.
    """
    code = load().state.code
    path = STATE_GENERATORS / code / f"{name}.py"
    if not path.exists():
        raise SystemExit(
            f"{path} is missing; state {code} needs its own {name}.py "
            f"(see state_specific_generators/README.md)")
    return importlib.import_module(f"state_specific_generators.{code}.{name}")
