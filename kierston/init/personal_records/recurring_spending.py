"""Generate recurring household and personal bills: rent, utilities, loans, subscriptions.

`spend.ts` charges for places people go: a basket at the supermarket, a fare, an
hour in a deck. That is one of the three things a payment card sees. The Fed's
Diary of Consumer Payment Choice counts 47.2 payments a person a month, of which
about 10 are bills and 8.9 are remote — and a city that pays neither has an
income arriving and a discretionary trickle leaving, with the whole middle of a
household's money missing. Rent is not spent at a venue. Neither is the electric,
the phone, the car loan or the streaming subscription that nobody has cancelled.

This stage writes those as a schedule rather than as transactions. A bill is not
an event, it is a *rule* — an amount, a cadence, a day of the month, a way of
paying — and the simulated day decides for itself whether today is one of the
days that rule fires. That is the same bargain `banking.py` makes with income:
a stream is a schedule with a dated anchor, and `bank/payroll.ts` projects it.
Nothing here writes a dated payment, so nothing here has to be regenerated when
the simulation moves to another date.

Two kinds, which is the whole shape of the file
-----------------------------------------------
HOUSEHOLD charges are the dwelling's, not any one person's: rent, the mortgage,
the electric, the water, the trash, the car loan, the credit card. Anyone in the
household old enough to hold an account can pay one, and in a real household
they do — one partner has the rent on autopay and the other has the gas. So the
row is keyed on the household, carries a payer and (where there is a second
adult) an alternate, and says how the two of them split it. Children never
appear: under `ADULT` the row is not eligible, and a household of one adult and
three teenagers has one payer.

PERSONAL charges belong to a person and follow them: the phone plan, the
subscriptions nobody cancels, the gym, a life policy, the registration renewal
on the car in their name. A lodger's Netflix does not become the householder's
problem, which is exactly the distinction the two tables encode.

Where the numbers come from
---------------------------
Most of the household side is surveyed and is not invented at all. The ACS
housing record — the one every synthetic household already carries a SERIALNO
back to — has been sitting in the extract unread since the population was
built. It answers, per household:

    TEN, RNTP      tenure and the monthly rent
    MRGP, MRGI     the mortgage payment, and whether insurance is inside it
    MRGT, TAXAMT   whether tax is escrowed, and the yearly property tax
    INSP, CONP     hazard insurance a year, condo/HOA fee a month
    SMP, MHP       second mortgage or HELOC, and mobile home park fee
    ELEP, GASP     electricity and gas, monthly
    WATP, FULP     water and other fuel, yearly
    HFL            which fuel the place is heated with
    ACCESSINET     whether internet here is paid for
    HUPAC          whether there are children under 6, for childcare

Every one of those is dollars at the survey's own price level, so each is
multiplied by ADJHSG — the extract's own adjustment factor, six implied decimal
places — and then carried forward to the simulation's year. The sentinels are
the usual trap and are handled at the top of `_dollars`: ELEP is 2 when the
electricity is included in the rent, GASP is 3 when it is in the rent or in the
electricity bill, and a household whose heat is in the rent must end up with no
gas bill rather than with a $3 one.

What is modelled rather than surveyed says so in its `source` column, and it is
mostly the things no survey asks: what a phone plan costs, how many streaming
subscriptions a household has let accumulate, the premium on the policy whose
insurer `vehicles.py` already named. Those are drawn against published averages
and are honest guesses; the column exists so a reader can tell which half of a
household's outgoings rests on a survey answer and which on an assumption.

Rent geography
--------------
PUMS supplies a credible citywide rent distribution but no within-city
geography. Once a household has been assigned a dwelling, its surveyed rent is
therefore multiplied by a small hedonic factor. The factor rises with the
actual payer's income, distance from Center Square, unit floor area, and floor;
a rented whole house receives a premium and an apartment a small discount.
Distance is straight-line distance because this is a property attribute, not a
trip. Floor is inferred from unit index and building levels and is neutral when
levels are unknown. All continuous terms have explicit reference values and
the combined multiplier is bounded, so these modelled relationships distribute
the observed rents around the city without overwhelming their survey source.
The raw factor is divided by a stock-calibration constant measured across the
generated renter population, keeping the citywide rent level near its PUMS
anchor even though single-unit houses are common in the extracted stock.
The constants and formula live together below under ``Hedonic rent model``.

Seasonality
-----------
ELEP and GASP are *average* monthly costs, and a city where the gas bill is the
same in July as in January is wrong in a way anybody looking at a statement
would notice. Each utility carries a twelve-month curve normalised to a mean of
exactly 1.0, so applying it redistributes the surveyed annual total across the
year without changing it. The curves ride in the packed file's header rather
than being copied into the TypeScript, so there is one definition of them.

Ordering: this stage runs last of the personal records, after holdings.py and
after vehicles.py, because it reads both. A mortgage payment is holdings.py's
number, a car loan and an insurance policy are vehicles.py's, and this stage
turns each of them into a date and a payee rather than inventing a second one.
"""

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population import pums  # noqa: E402
import banking  # noqa: E402
import registries  # noqa: E402
from registries import keyed  # noqa: E402


from paths import SIM_DATA  # noqa: E402
import city_data  # noqa: E402
import jurisdiction as legal  # noqa: E402
import profile as city_profile  # noqa: E402

LOCALE = city_profile.load().locale
LAW = legal.load()
MONEY = legal.state_module("money")
POPULATION = SIM_DATA / "population.json"
HOLDINGS = SIM_DATA / "holdings.json"
VEHICLES = SIM_DATA / "vehicles.json"
DEVICES = SIM_DATA / "devices.json"
OUTPUT = SIM_DATA / "recurring_spending.json"
DWELLINGS = SIM_DATA / "dwellings.json"

DEFAULT_SEED = 20260806
TODAY = registries.REFERENCE_YEAR

# Old enough to be on a bill. Not the same as `POCKET_MONEY_AGE` in banking.py,
# which is 15 and is about carrying money: a 16-year-old with a cash job has a
# pocket and no lease. Household charges are payable by adults only — anyone in
# the household except the children — and `banking.ranked_adults` uses the same
# threshold to decide whose account is holding the rent.
ADULT = banking.HOUSING_FLOAT_ADULT

# The extract is 2019-2023 five-year data in 2023 dollars once ADJHSG has been
# applied. The simulation runs in 2026, and a rent quoted three years light
# would put every housing cost about a tenth below where the city's own income
# distribution sits. CPI shelter and household energy over 2023-2026, rounded.
#
# banking.py's, not a second copy: it sizes the balance that has to cover these
# bills, and two price levels would mean the floor and the bill disagree.
INFLATION = banking.HOUSING_INFLATION

# ---------------------------------------------------------------------------
# Hedonic rent model
# ---------------------------------------------------------------------------

# A PUMS housing record can seed several synthetic households. RNTP is rounded
# survey data, so carrying it across verbatim makes those otherwise independent
# leases conspicuously identical. Give each lease a small, centred adjustment;
# a dedicated keyed RNG keeps this from changing due dates or any other bill.
RENT_JITTER = 0.03

# Hedonic adjustments applied after the surveyed rent has established the
# lease's citywide price level. They are deliberately shallow: PUMS already
# contains the real spread of rents, while these terms give that spread a
# plausible address instead of replacing it with an invented price model.
CITY_CENTER = LOCALE.centre  # the downtown square, from [locale] centre
REFERENCE_INCOME = 40_000
REFERENCE_DISTANCE_KM = 2.0
REFERENCE_AREA_M2 = 85.0
HOUSE_PREMIUM = 0.10
APARTMENT_DISCOUNT = 0.04
INCOME_ELASTICITY = 0.06
DISTANCE_PREMIUM_PER_KM = 0.025
AREA_ELASTICITY = 0.16
FLOOR_PREMIUM = 0.012
# Mean raw factor across the generated renter stock. Centering on this value
# makes the feature model redistribute rent rather than inflate the whole city.
RENT_FACTOR_CENTER = 1.134
MIN_RENT_FACTOR = 0.68
MAX_RENT_FACTOR = 1.55

HOUSE_KINDS = {"house", "detached", "bungalow", "semidetached_house",
               "terrace"}


def money(value):
    """Dollars, rounded to the cent. Same contract as banking.py's."""
    return round(float(value), 2)


def distance_from_center_km(building):
    """Straight-line distance from Center Square, adequate at city scale."""
    lat = math.radians(building["lat"])
    center_lat = math.radians(CITY_CENTER[0])
    dy = lat - center_lat
    dx = math.radians(building["lon"] - CITY_CENTER[1]) * math.cos(
        (lat + center_lat) / 2)
    return 6371.0 * math.hypot(dx, dy)


def unit_floor(household, building):
    """One-based floor inferred from a unit index when levels are known."""
    levels = int(building.get("levels") or 0)
    units = int(building.get("units") or 1)
    if levels <= 1 or units <= 1:
        return 1
    units_per_floor = math.ceil(units / levels)
    return min(levels, int(household.get("unit") or 0) // units_per_floor + 1)


def rent_factor(household, payer, building):
    """A bounded hedonic multiplier for a placed renter household."""
    income = max(1_000, float(payer.get("income") or 0))
    area = max(20.0, float(household.get("unit_area") or REFERENCE_AREA_M2))
    distance = distance_from_center_km(building)

    factor = (income / REFERENCE_INCOME) ** INCOME_ELASTICITY
    factor *= 1 + DISTANCE_PREMIUM_PER_KM * (
        distance - REFERENCE_DISTANCE_KM)
    factor *= (area / REFERENCE_AREA_M2) ** AREA_ELASTICITY

    whole_house = (int(building.get("units") or 1) == 1
                   and building.get("kind") in HOUSE_KINDS)
    if whole_house:
        factor *= 1 + HOUSE_PREMIUM
    elif building.get("kind") == "apartments":
        factor *= 1 - APARTMENT_DISCOUNT

    factor *= 1 + FLOOR_PREMIUM * (unit_floor(household, building) - 1)
    factor /= RENT_FACTOR_CENTER
    return min(MAX_RENT_FACTOR, max(MIN_RENT_FACTOR, factor))


def weighted(table, rng):
    """Pick from an ((value, weight), ...) table."""
    return rng.choices([v for v, _ in table], weights=[w for _, w in table])[0]


# ---------------------------------------------------------------------------
# Reading the survey's dollars
# ---------------------------------------------------------------------------

def _number(row, field):
    value = row.get(field, "")
    return int(value) if str(value).lstrip("-").isdigit() else None


def _dollars(row, field, floor):
    """A surveyed housing amount in simulation-year dollars, or None.

    `floor` is the first value the codebook calls data. Everything below it is
    a not-applicable code dressed as a number — ELEP 2 means the electricity is
    in the rent, GASP 3 means the gas is in the rent or inside the electricity
    bill — and a bill generated from one of those would be a $2 utility for a
    household that has no utility account at all. See the PUMS sentinel note in
    holdings.py; this is the same trap in the housing columns.
    """
    value = _number(row, field)
    if value is None or value < floor:
        return None
    factor = _number(row, "ADJHSG")
    adjusted = value * ((factor / 1_000_000) if factor else 1.0) * INFLATION
    return money(adjusted)


# ---------------------------------------------------------------------------
# Seasonality
# ---------------------------------------------------------------------------

def _normalised(curve):
    """A twelve-month curve scaled to a mean of exactly 1.0.

    Normalising matters more than the shape does. ELEP and GASP are averages
    over a year, so any curve whose mean is not 1.0 silently rescales the
    surveyed annual total — a heating curve averaging 1.08 would hand every gas
    household an eight percent raise that the survey never said they paid.
    """
    mean = sum(curve) / len(curve)
    return [round(value / mean, 4) for value in curve]


SEASONAL = {
    "none": [1.0] * 12,
    # Air conditioning in a humid continental summer, and the base load the
    # rest of the year. July and August are the peak in eastern Pennsylvania.
    "electric": _normalised(
        [1.06, 1.02, 0.93, 0.84, 0.86, 1.04, 1.24, 1.25, 1.08, 0.88, 0.90, 1.02]),
    # Heating, which is far peakier than cooling: a gas bill in January is five
    # or six times the same house's July bill, because July is the stove alone.
    "gas": _normalised(
        [1.90, 1.82, 1.44, 0.92, 0.52, 0.32, 0.28, 0.28, 0.34, 0.66, 1.16, 1.72]),
}


# ---------------------------------------------------------------------------
# Who bills whom
# ---------------------------------------------------------------------------

# The utilities that actually serve the reference city, because a resident's
# statement says the utility's name and not "Electric Company". The municipal
# payees are the city's own, in the same voice as `spend.ts`'s "City of
# Kierston Meters". All from the city's billers.csv, by role; the weighted
# roles are (name, weight) tables in file order.
def _weighted_billers(role):
    return tuple((b["name"], b["weight"]) for b in city_data.billers(role))


ELECTRIC = city_data.biller("electricity")
GAS = city_data.biller("gas")
WATER = city_data.biller("water")
TRASH = city_data.biller("trash")
HEATING_OIL = _weighted_billers("heating_oil")
COUNTY = f"{LOCALE.county} Treasurer"
SCHOOL_DISTRICT = city_data.biller("school_district")
# Who holds a second mortgage, which the survey reports as a payment only.
SECOND_MORTGAGE = city_data.biller("second_mortgage")

INTERNET = _weighted_billers("internet")
TELEVISION = _weighted_billers("television")

# There is no carrier table here. Which carrier somebody is with, and whether
# the line is prepaid, are decisions devices.py already made against the
# handset — and it made them on income, on who holds the account and on the
# reference region's actual market, all of which this file would have had to
# reproduce and would have reproduced differently. It reads them instead. See
# `mobile_charges`.

# Each streaming service with the share of subscribing households that hold it
# and what it costs a month in 2026. Nobody holds all of them; `STREAMING_COUNT`
# says how many a household has let accumulate.
STREAMING = (
    ("Netflix", 0.58, 17.99), ("Amazon Prime", 0.52, 14.99),
    ("Disney+", 0.32, 11.99), ("Max", 0.26, 16.99),
    ("Hulu", 0.30, 12.99), ("Paramount+", 0.18, 7.99),
    ("Peacock", 0.17, 10.99), ("Apple TV+", 0.15, 12.99),
    ("Spotify", 0.36, 11.99), ("YouTube Premium", 0.24, 13.99),
)
STREAMING_COUNT = ((0, 22), (1, 20), (2, 21), (3, 17), (4, 12), (5, 8))

# Gyms as (name, monthly price, weight), charities and newspapers as (name,
# weight), storage as names drawn uniformly — the city's billers.csv again.
GYMS = tuple((b["name"], b["price"], b["weight"])
             for b in city_data.billers("gym"))

CHARITIES = _weighted_billers("charity")

STORAGE = tuple(b["name"] for b in city_data.billers("storage"))
NEWS = _weighted_billers("news")

# ISO 18245 categories, the same table `assign_mcc.py` draws from. A biller's
# category is what a card network would see, not what the bill is called.
MCC = {
    "rent": 6513, "mortgage": 6012, "second_mortgage": 6012,
    "mobile_home_fee": 6513, "hoa": 6513,
    "property_tax": 9311, "home_insurance": 6300,
    "electricity": 4900, "gas": 4900, "water": 4900, "trash": 4900,
    "heating_oil": 5983,
    "internet": 4899, "television": 4899, "mobile": 4814,
    "childcare": 8351,
    "student_loan": 8299, "auto_loan": 6012, "credit_card": 6012,
    "auto_insurance": 6300, "life_insurance": 6300, "health_premium": 6300,
    "streaming": 5968, "music": 5968, "gym": 7997, "news": 5192,
    "storage": 4225, "charity": 8398, "registration": 9399,
}


# ---------------------------------------------------------------------------
# Cadence
# ---------------------------------------------------------------------------

# When housing money actually leaves, which is not the same question as when
# the rent is due, and is not the same answer for every landlord.
#
# The first version put every rent, mortgage, HOA fee, lot fee and premium in
# the city on the 1st. The second spread them, but spread them badly: the mass
# that came off the 1st went to the 2nd through the 5th and the 28th through
# the 30th, which is still the turn of the month. That is the shape of a city
# where every lease is written the same way, and this one is not.
#
# BLD says which. A 5-or-more-unit building is professionally managed and its
# tenants are all on the 1st, because that is what a managed lease says. A one-
# to-four-unit building is the small-landlord stock — 72.5% of renting
# households here — and those leases commonly run from the move-in date, so the
# due day is the anniversary of whenever the tenant happened to arrive and is
# spread across the whole month rather than clustered at either end of it.
#
# The split between "the 1st anyway" and "the day they moved in" is modelled,
# not surveyed; no ACS column asks it. What is surveyed is which building each
# household lives in, which is what decides who the question is asked of.
MANAGED_BLD = {"6", "7", "8", "9"}
MANAGED_FIRST = 0.85
SMALL_LANDLORD_FIRST = 0.45


def rent_due_day(row, rng):
    """The day of the month this household's rent leaves."""
    managed = str(row.get("BLD", "")).lstrip("0") in MANAGED_BLD
    if rng.random() < (MANAGED_FIRST if managed else SMALL_LANDLORD_FIRST):
        # On the 1st, or within the grace period for the ones who pay late.
        return weighted(((1, 86), (2, 5), (3, 4), (5, 3), (4, 2)), rng)
    # A move-in anniversary, which fell wherever it fell. Capped at 28 like
    # every other rule here so no month loses it.
    return rng.randint(1, 28)


# A mortgage is due on the 1st with fifteen days of grace, and autopay dates
# are chosen rather than imposed, so it spreads further than a managed lease.
MORTGAGE_DUE = ((1, 38), (2, 7), (3, 6), (5, 7), (10, 7), (15, 9), (20, 5),
                (25, 5), (28, 6), (8, 5), (12, 5))

# A monthly premium or an association fee follows its own biller's cycle and
# has no reason to sit on the 1st at all.
BILLED_MONTHLY_DUE = ((1, 22), (5, 12), (10, 12), (15, 14), (20, 12),
                      (25, 12), (28, 8), (8, 8))


def _schedule(kind, biller, amount, frequency, rng, *, day=None, month=None,
              seasonal="none", variance=0.0, source="modelled", until=None,
              card=None, share=0.0):
    """One rule. The runtime asks it "are you due today" and nothing else.

    `day` is the day of the month it falls on, capped at 28 so no rule ever
    disappears in February. `month` anchors the ones that are not monthly: an
    annual bill fires in that month, a semiannual one in it and six months
    later, a quarterly one in it and every third month after. That is enough
    calendar for every bill here and it needs three small integers rather than
    a list of dates, which is what keeps the row flat.
    """
    return {
        "kind": kind,
        "biller": biller,
        "mcc": MCC[kind],
        "amount": money(amount),
        "frequency": frequency,
        "due_day": day if day is not None else rng.randint(1, 28),
        "anchor_month": month if month is not None else rng.randint(1, 12),
        "seasonal": seasonal,
        # Month-to-month wobble, as the sigma of a log-normal the runtime
        # applies. A rent does not vary; a water bill does.
        "variance": round(variance, 3),
        "source": source,
        "until": until,
        "card": card,
        # Nonzero only on a card payment: the share of the live balance to pay,
        # with `amount` as the floor under it. See `debt_charges`.
        "share_of_balance": round(share, 3),
    }


# How a bill gets paid, before the payer's own banking is taken into account.
# Autopay is the default for anything with a fixed amount and a lender behind
# it, and much rarer for a variable bill that people like to look at first.
AUTOPAY = {
    "rent": 0.42, "mortgage": 0.88, "second_mortgage": 0.86,
    "mobile_home_fee": 0.45, "hoa": 0.62,
    "property_tax": 0.10, "home_insurance": 0.55,
    "electricity": 0.46, "gas": 0.44, "water": 0.34, "trash": 0.30,
    "heating_oil": 0.20,
    "internet": 0.72, "television": 0.74, "mobile": 0.80,
    "childcare": 0.66,
    "student_loan": 0.72, "auto_loan": 0.84, "credit_card": 0.58,
    "auto_insurance": 0.70, "life_insurance": 0.82, "health_premium": 0.78,
    "streaming": 1.0, "music": 1.0, "gym": 0.94, "news": 0.96,
    "storage": 0.72, "charity": 0.64, "registration": 0.0,
}

# Which instrument an autopaid bill comes out on. A subscription is a card
# mandate; a mortgage is a direct debit. The runtime routes the rest.
CARD_MANDATE = {"streaming", "music", "gym", "news", "storage", "television",
                "internet", "mobile", "charity"}


def _method(kind, banked, rng):
    """autopay_ach, autopay_card, manual_card or check.

    Somebody with no deposit account cannot hold a direct debit, and that is
    not a detail — the unbanked pay the rent with a money order and the phone
    at a counter, which is the single largest behavioural difference between a
    banked and an unbanked household's month.
    """
    if not banked:
        return "check" if kind in ("rent", "mortgage", "hoa", "property_tax") \
            else "manual_card"
    if rng.random() < AUTOPAY[kind]:
        return "autopay_card" if kind in CARD_MANDATE else "autopay_ach"
    if kind in CARD_MANDATE:
        return "manual_card"
    # Not on autopay does not mean paper. Most of these are somebody opening
    # the biller's app on the due date and pushing the money themselves, which
    # is a one-off debit and not a cheque — cheques are now a tenth of bill
    # payments and are concentrated in rent and tax.
    return weighted((("manual_ach", 70), ("manual_card", 18), ("check", 12)), rng)


# ---------------------------------------------------------------------------
# Household charges
# ---------------------------------------------------------------------------

TEN_MORTGAGED, TEN_OWNED, TEN_RENTED = "1", "2", "3"

# The reference city's solid waste fee is billed quarterly and is a flat municipal
# charge rather than a metered one, so it does not vary with the household.
TRASH_QUARTERLY = 112.0

# Renters pay for trash inside the rent in a building; a house is billed.
#
# Unpadded, because that is how BLD arrives in this extract — "3", not "03".
# The padded version of this set matched nothing at all, and the city went four
# regenerations without a single refuse bill in it.
TRASH_BILLED_BLD = {"1", "2", "3"}

INTERNET_COST = ((0, 62.0), (30_000, 68.0), (60_000, 78.0), (10 ** 9, 92.0))
TELEVISION_SHARE = 0.38
TELEVISION_COST = 96.0

# PA centre-based care, a week, 2026. The under-6 rate is the one that hurts.
CHILDCARE_UNDER6 = 268.0
CHILDCARE_SCHOOL_AGE = 118.0
CHILDCARE_SHARE = 0.58

# Full coverage against liability-only, a year, Pennsylvania. Older cars carry
# less because there is less to cover, which is what `value` is for.
AUTO_INSURANCE_FULL = 1_480.0
AUTO_INSURANCE_LIABILITY = 620.0
AUTO_INSURANCE_FULL_ABOVE = 6_000

# Standard federal repayment is ten years, and the rate is the weighted average
# of what the mixed federal/private book in holdings.py would carry.
STUDENT_LOAN_TERM = 120
STUDENT_LOAN_RATE = 0.055
# The floor is a real rule and not a smoothing: a federal standard plan does
# not bill below $50 a month, it shortens the term instead. Without it the
# small balances holdings.py's paydown leaves behind bill $12 a month.
STUDENT_LOAN_MINIMUM = 50.0

# Revolvers pay a percentage of the balance and transactors clear the month.
# The split is the Fed's: a little over half of accounts carry a balance.
REVOLVER_SHARE = 0.55
REVOLVER_PAYMENT = 0.055
REVOLVER_MINIMUM = 35.0


def _amortised(principal, annual_rate, months):
    """The level payment on an instalment loan."""
    if months <= 0 or principal <= 0:
        return 0.0
    rate = annual_rate / 12
    if rate <= 0:
        return principal / months
    factor = (1 + rate) ** months
    return principal * rate * factor / (factor - 1)


def housing(row, rng, rent_rng=None):
    """Rent or mortgage, and everything the deed drags along with it."""
    out = []
    tenure = row.get("TEN")

    if tenure == TEN_RENTED:
        rent = _dollars(row, "RNTP", 1)
        if rent:
            if rent_rng is not None:
                rent = money(rent * rent_rng.uniform(1 - RENT_JITTER, 1 + RENT_JITTER))
            out.append(_schedule("rent", "Kierston property management", rent,
                                 "monthly", rng, day=rent_due_day(row, rng),
                                 source="survey"))
    elif tenure in (TEN_MORTGAGED, TEN_OWNED):
        # The mortgage payment itself is filed against the lender the mortgage
        # record already names, and is added by `debt_charges` — this branch
        # only handles what sits outside the payment. MRGT and MRGI say whether
        # that is anything at all: an escrowed loan pays the tax and the
        # insurance inside the monthly figure, and billing them again here
        # would charge the household twice for both.
        escrowed_tax = row.get("MRGT") == "1"
        escrowed_insurance = row.get("MRGI") == "1"

        tax = _dollars(row, "TAXAMT", 1)
        if tax and not escrowed_tax:
            # Billed by the authorities and in the months the state sets.
            authorities = {"county": COUNTY, "school_district": SCHOOL_DISTRICT}
            for authority, share, month in MONEY.PROPERTY_TAX:
                out.append(_schedule("property_tax", authorities[authority],
                                     tax * share, "annual", rng,
                                     day=rng.randint(1, 28), month=month,
                                     source="survey"))

        insurance = _dollars(row, "INSP", 1)
        if insurance and not escrowed_insurance:
            out.append(_schedule("home_insurance", MONEY.HOME_INSURER,
                                 insurance, "annual", rng, month=rng.randint(1, 12),
                                 source="survey"))

        second = _dollars(row, "SMP", 1)
        if second:
            out.append(_schedule("second_mortgage", SECOND_MORTGAGE,
                                 second, "monthly", rng,
                                 day=weighted(MORTGAGE_DUE, rng),
                                 source="survey"))

    # MHP is a *yearly* figure, unlike RNTP and MRGP above — the park bills it
    # monthly, so it is divided rather than passed through. Left as-is it puts
    # a $2,220 monthly lot fee on a trailer.
    park = _dollars(row, "MHP", 1)
    if park:
        out.append(_schedule("mobile_home_fee", "Kierston Mobile Home Park",
                             park / 12, "monthly", rng,
                             day=rent_due_day(row, rng), source="survey"))

    condo = _dollars(row, "CONP", 1)
    if condo:
        out.append(_schedule("hoa", "Kierston Homeowners Association", condo,
                             "monthly", rng, day=weighted(BILLED_MONTHLY_DUE, rng),
                             source="survey"))
    return out


def utilities(row, rng):
    """Electric, gas, water, oil and the trash, as the survey reported them."""
    out = []

    electric = _dollars(row, "ELEP", 3)
    if electric:
        out.append(_schedule("electricity", ELECTRIC, electric, "monthly", rng,
                             seasonal="electric", variance=0.09,
                             source="survey"))

    gas = _dollars(row, "GASP", 4)
    if gas:
        out.append(_schedule("gas", GAS, gas, "monthly", rng, seasonal="gas",
                             variance=0.11, source="survey"))

    # WATP and FULP are *yearly*, unlike the two above. Water is billed
    # quarterly here, which is how a municipal authority does it.
    water = _dollars(row, "WATP", 3)
    if water:
        out.append(_schedule("water", WATER, water / 4, "quarterly", rng,
                             month=rng.randint(1, 3), variance=0.14,
                             source="survey"))

    # Fuel oil and propane are not billed, they are delivered — three drops
    # through the heating season rather than twelve equal payments, which is
    # why this one is not a monthly bill with a seasonal curve on it.
    fuel = _dollars(row, "FULP", 3)
    if fuel:
        supplier = weighted(HEATING_OIL, rng)
        for month in (10, 12, 2):
            out.append(_schedule("heating_oil", supplier, fuel / 3, "annual",
                                 rng, month=month, variance=0.18,
                                 source="survey"))

    if str(row.get("BLD", "")).lstrip("0") in TRASH_BILLED_BLD \
            and row.get("TEN") in (
            TEN_MORTGAGED, TEN_OWNED, TEN_RENTED):
        out.append(_schedule("trash", TRASH, TRASH_QUARTERLY, "quarterly", rng,
                             day=15, month=rng.randint(1, 3)))
    return out


def connectivity(row, income, rng):
    """Internet and television. ACCESSINET says who is paying for the first."""
    out = []
    if row.get("ACCESSINET") == "1":
        cost = next(value for bound, value in INTERNET_COST if income <= bound)
        out.append(_schedule("internet", weighted(INTERNET, rng),
                             cost * rng.uniform(0.85, 1.2), "monthly", rng))
        if rng.random() < TELEVISION_SHARE:
            out.append(_schedule("television", weighted(TELEVISION, rng),
                                 TELEVISION_COST * rng.uniform(0.7, 1.3),
                                 "monthly", rng))
    return out


def childcare(row, members, rng):
    """Paid care, for the households that plausibly buy it.

    HUPAC says whether there are children under 6, which is the expensive case.
    The condition on the adults is the one that matters: care is bought when
    there is nobody at home to provide it, so a household with a non-working
    adult in it mostly does not appear here.
    """
    pac = row.get("HUPAC")
    if pac not in ("1", "2", "3"):
        return []
    adults = [m for m in members if m["age"] >= ADULT]
    if not adults or not all(m.get("employment") in (1, 2, 4, 5) for m in adults):
        return []
    if rng.random() > CHILDCARE_SHARE:
        return []

    under6 = sum(1 for m in members if m["age"] < 6)
    school = sum(1 for m in members if 6 <= m["age"] < 13)
    weekly = under6 * CHILDCARE_UNDER6 + school * CHILDCARE_SCHOOL_AGE
    if weekly <= 0:
        return []
    # `due_day` on a weekly rule is a weekday, in the simulation's own terms:
    # 0 is Monday, matching `weekday` in sim/src/time.ts. Care is billed for
    # the week on the day the week starts, which is a Monday for most centres.
    return [_schedule("childcare", "Kierston Children's Center",
                      weekly * rng.uniform(0.8, 1.15), "weekly", rng,
                      day=weighted(((0, 74), (1, 8), (4, 18)), rng))]


def vehicle_charges(vehicles, rng):
    """The insurance and the loan on each car the household keeps.

    Both are anchored on records that already exist: `vehicles.py` named the
    insurer and wrote the policy number, and the auto loan is its own row with
    a principal, a rate and a term. Nothing here decides who is insured — the
    registry already did, including the uninsured.
    """
    out = []
    for vehicle, loan in vehicles:
        if vehicle["insurer"]:
            full = (vehicle["value"] or 0) >= AUTO_INSURANCE_FULL_ABOVE
            yearly = (AUTO_INSURANCE_FULL if full else AUTO_INSURANCE_LIABILITY)
            yearly *= rng.uniform(0.72, 1.45)
            # Insurers quote a six-month term and most people pay it monthly.
            if rng.random() < 0.62:
                out.append(_schedule("auto_insurance", vehicle["insurer"],
                                     yearly / 12, "monthly", rng))
            else:
                out.append(_schedule("auto_insurance", vehicle["insurer"],
                                     yearly / 2, "semiannual", rng,
                                     month=rng.randint(1, 6)))
        if loan and loan["balance"] > 0:
            payment = _amortised(loan["principal"], loan["rate"] / 100,
                                 loan["term_months"])
            out.append(_schedule(
                "auto_loan", "Kierston Auto Finance", payment, "monthly", rng,
                day=rng.randint(1, 28), source="survey",
                until=f"{loan['originated'] + loan['term_months'] // 12:04d}-"
                      f"{rng.randint(1, 12):02d}-01"))
    return out


def debt_charges(person, held, rng):
    """Servicing what holdings.py already put on this person's books.

    The mortgage, the student loan and the credit cards are all records that
    exist and have never moved a cent: a card balance in this city goes up
    forever because nothing pays it down. These are the payments that close
    that loop, and each one is filed against the person the debt belongs to and
    then paid by whichever adult in the household is paying that month.
    """
    out = []
    for record in held:
        holding = record["holding"]

        if holding == "mortgage" and record.get("monthly_payment"):
            originated = int(str(record["originated"])[:4])
            out.append(_schedule(
                "mortgage", record["lender"], record["monthly_payment"],
                "monthly", rng, day=weighted(MORTGAGE_DUE, rng),
                source="survey",
                until=f"{originated + record['term_months'] // 12:04d}-"
                      f"{record['originated'][5:7]}-01"))

        elif holding == "student_loan" and record["status"] == "repayment" \
                and record["balance"] > 0:
            payment = min(record["balance"],
                          max(STUDENT_LOAN_MINIMUM,
                              _amortised(record["balance"], STUDENT_LOAN_RATE,
                                         STUDENT_LOAN_TERM)))
            out.append(_schedule("student_loan", record["servicer"], payment,
                                 "monthly", rng, source="survey"))

        elif holding == "credit_card":
            # The only charge here whose amount is a *rule* rather than a
            # number, and it has to be. Every other bill is the same next month
            # as it was this month; a card payment is a share of a balance that
            # the simulation itself is moving, and a fixed dollar figure frozen
            # at the reference date would be wrong by the second week. So the
            # row carries `share_of_balance` and a floor, and the runtime reads
            # the live balance off the card.
            #
            # A revolver pays a fraction and carries the rest at interest; a
            # transactor clears the statement. The split is the Fed's, a little
            # over half of active accounts revolving.
            revolver = rng.random() < REVOLVER_SHARE
            out.append(_schedule(
                "credit_card", record["issuer"] or "card issuer",
                REVOLVER_MINIMUM if revolver else 0.0, "monthly", rng,
                source="survey", card=record["last_four"],
                share=REVOLVER_PAYMENT if revolver else 1.0))
    return out


# ---------------------------------------------------------------------------
# Personal charges
# ---------------------------------------------------------------------------

GYM_SHARE = ((24, 0.22), (44, 0.24), (64, 0.16), (200, 0.08))
NEWS_SHARE = ((44, 0.04), (64, 0.09), (200, 0.16))
STORAGE_SHARE = 0.09
STORAGE_COST = 96.0
CHARITY_SHARE = ((34, 0.10), (54, 0.18), (200, 0.26))
CHARITY_COST = ((0, 15.0), (50_000, 30.0), (100_000, 60.0), (10 ** 9, 125.0))

# Term life, for the people who buy it: earners with dependants, mostly.
LIFE_SHARE = 0.26
LIFE_COST = 38.0
LIFE_AGE = 25
LIFE_INSURERS = ("Northwestern Mutual", "State Farm Life", "Prudential",
                 "MassMutual", "New York Life")

# HINS2 is coverage bought directly rather than through an employer — the
# marketplace plan, which is the one that arrives as a monthly debit. Employer
# coverage is a payroll deduction and is already inside the net pay
# `banking.py` computes, so billing it here would take it twice.
HEALTH_DIRECT_COST = ((0, 95.0), (30_000, 210.0), (60_000, 380.0),
                      (10 ** 9, 540.0))

# The state's annual registration fee, from the jurisdiction.
REGISTRATION_FEE = LAW.plates.registration_fee
INSPECTION_FEE = 78.0


def graded(table, value):
    return next(result for bound, result in table if value <= bound)


def personal(person, has_card, vehicles, row, rng):
    """The subscriptions and premiums that follow a person, not a dwelling.

    The phone bill is not here. It is the one personal charge that is not the
    person's to begin with — a minor's line is billed to a parent — so it is
    built from the subscription table in `mobile_charges` below, where the
    account holder is known.
    """
    out = []
    age = person["age"]
    income = person.get("income") or 0

    # Subscriptions need something to charge. Somebody with no card at all does
    # not hold a streaming mandate, which is most of why the unbanked show up
    # in the ledger with a quarter of the transaction count.
    if has_card and age >= 15:
        wanted = weighted(STREAMING_COUNT, rng)
        pool = [s for s in STREAMING if rng.random() < s[1]]
        rng.shuffle(pool)
        for name, _, price in pool[:wanted]:
            kind = "music" if name in ("Spotify", "YouTube Premium") else "streaming"
            out.append(_schedule(kind, name, price, "monthly", rng))

    if age >= 16 and rng.random() < graded(GYM_SHARE, age):
        name, price, _ = rng.choices(GYMS, weights=[w for _, _, w in GYMS])[0]
        out.append(_schedule("gym", name, price, "monthly", rng))

    if age >= 25 and rng.random() < graded(NEWS_SHARE, age):
        out.append(_schedule("news", weighted(NEWS, rng),
                             rng.choice((6.0, 12.0, 18.0)), "monthly", rng))

    if age >= ADULT and rng.random() < STORAGE_SHARE:
        out.append(_schedule("storage", rng.choice(STORAGE),
                             STORAGE_COST * rng.uniform(0.6, 1.8), "monthly",
                             rng))

    if age >= ADULT and rng.random() < graded(CHARITY_SHARE, age):
        out.append(_schedule("charity", weighted(CHARITIES, rng),
                             graded(CHARITY_COST, income), "monthly", rng,
                             day=rng.randint(1, 10)))

    if age >= LIFE_AGE and income > 20_000 and rng.random() < LIFE_SHARE:
        out.append(_schedule("life_insurance", rng.choice(LIFE_INSURERS),
                             LIFE_COST * rng.uniform(0.5, 2.4), "monthly", rng))

    if row.get("HINS2") == "1" and age >= ADULT:
        out.append(_schedule("health_premium", "Highmark Blue Shield",
                             graded(HEALTH_DIRECT_COST, income)
                             * rng.uniform(0.8, 1.25), "monthly", rng,
                             day=weighted(BILLED_MONTHLY_DUE, rng),
                             source="survey"))

    # The car's own paperwork, which is annual and dated: the state DMV renews
    # the registration on the month the registry already wrote, and the state
    # requires a safety inspection every year with an emissions test in the
    # reference county. Both are the owner's, not the household's.
    for vehicle, _ in vehicles:
        expires = vehicle["registration_expires"]
        month = int(expires[5:7])
        out.append(_schedule("registration", LAW.licensing.issuer_short,
                             REGISTRATION_FEE,
                             "annual", rng, day=min(28, int(expires[8:10])),
                             month=month, source="survey"))
        out.append(_schedule("registration", "Kierston Auto Service",
                             INSPECTION_FEE * rng.uniform(0.7, 1.6), "annual",
                             rng, month=1 + (month + 4) % 12))
    return out


# ---------------------------------------------------------------------------
# The phone bill
# ---------------------------------------------------------------------------

# What a line costs a month. Postpaid is the bigger number and the wider
# spread, because it is a range of plans with a range of data allowances and
# often a handset being paid off inside it; prepaid is a flat monthly price off
# a shelf. Both are modelled — no survey in the extract prices a phone plan.
MOBILE_POSTPAID = 58.0
MOBILE_PREPAID = 32.0
MOBILE_POSTPAID_SPREAD = (0.75, 1.6)
MOBILE_PREPAID_SPREAD = (0.7, 1.35)


def mobile_charges(subscriptions, banked, seed):
    """One phone bill per subscription, billed to whoever holds the account.

    This is the only personal charge built from another stage's table rather
    than drawn here, and the reason is that it is the only one whose payer is
    not its subject. `devices.py` already decided the carrier, the plan and the
    account holder, against income, against who the person's parents are and
    against the reference region's real market. Drawing them again here produced
    exactly what you would expect: two files that disagreed about roughly
    everybody, a resident billed by Cricket for a line the device table put on
    Metro. What this stage still owns is the price and the cadence.

    The account holder is a real join and not a relabelling. A fifteen-year-old
    with a phone generates a bill on their mother's record, because that is
    whose bank account the direct debit comes out of and whose name the carrier
    holds — and it means the mother's outgoings carry four lines where the
    household has four phones, which is what a family plan actually looks like.
    `for_person` keeps the attribution: it says which line the money is for
    without claiming the child pays it.
    """
    for lines in subscriptions.values():
        for line in lines:
            rng = keyed(seed, line["user"], "mobile-bill")
            prepaid = line["plan_type"] == "prepaid"
            base = MOBILE_PREPAID if prepaid else MOBILE_POSTPAID
            low, high = (MOBILE_PREPAID_SPREAD if prepaid
                         else MOBILE_POSTPAID_SPREAD)
            holder = line["account_holder"]
            charge = _schedule("mobile", line["carrier"],
                               base * rng.uniform(low, high), "monthly", rng)
            charge["person"] = holder
            # Whose line it is, where that is not whose bill it is.
            charge["for_person"] = (
                line["user"] if line["user"] != holder else None)
            charge["method"] = _method("mobile", holder in banked, rng)
            yield charge


# ---------------------------------------------------------------------------
# Who in the household pays
# ---------------------------------------------------------------------------

# How a two-adult household divides the bills. `alternate` is one payer with
# the other picking it up some months — the account the direct debit sits on
# changed and nobody moved it back. `shared` is a bill genuinely split down the
# middle, which is what housemates do with the rent and what couples rarely do.
SPLIT = (("sole", 46), ("alternate", 38), ("shared", 16))


def payers(members, rng):
    """The adults who can pay, best first.

    `banking.ranked_adults` and not a ranking of this module's own: the balance
    model floors the housing float on the top two of exactly this list, and a
    second ordering here would put the money on one person and the rent on
    another.
    """
    return banking.ranked_adults(members)


def assign_payer(charge, ranked, rng):
    """Put a payer, an alternate and a split on a household charge."""
    charge["payer"] = ranked[0]["id"]
    if len(ranked) < 2:
        charge["alt_payer"] = None
        charge["split"] = "sole"
        charge["split_share"] = 0.0
        return charge

    alternate = ranked[1]
    # The second adult takes some bills outright rather than every bill
    # sometimes — one of them has the phone and the internet, the other has the
    # power. Swapping the pair here is what produces that.
    if rng.random() < 0.34:
        ranked = [alternate, ranked[0]]
        charge["payer"] = ranked[0]["id"]
        alternate = ranked[1]

    split = weighted(SPLIT, rng)
    charge["alt_payer"] = alternate["id"]
    charge["split"] = split
    charge["split_share"] = round(
        rng.uniform(0.2, 0.45) if split == "alternate"
        else 0.5 if split == "shared" else 0.0, 3)
    return charge


# ---------------------------------------------------------------------------
# Building the city's schedule
# ---------------------------------------------------------------------------

def reduce_holdings(path):
    """{person: [the few holdings this stage needs]} and whether they bank.

    holdings.json is 235 MB and all that is wanted from it is the debt and one
    boolean. Keeping the parsed structure alongside the population is what puts
    this stage into swap, so it is reduced and dropped in the same breath —
    the same move `vehicles.py` makes for the licence flags.
    """
    data = json.loads(path.read_text())
    debts, banked, carded = {}, set(), set()
    for person, records in data["records"].items():
        person = int(person)
        keep = []
        for record in records:
            holding = record["holding"]
            if holding in ("mortgage", "student_loan", "credit_card"):
                keep.append(record)
            if holding == "bank_account" and record.get("type") != "cash":
                banked.add(person)
            if holding in ("credit_card", "debit_card"):
                carded.add(person)
        if keep:
            debts[person] = keep
    del data
    return debts, banked, carded


def household_vehicles(path):
    """{household: [(vehicle, loan or None)]} and {person: [(vehicle, loan)]}."""
    data = json.loads(path.read_text())
    loans = data["auto_loans"]
    by_household, by_owner = {}, {}
    for vin, vehicle in data["vehicles"].items():
        if vehicle["owner_type"] != "person" or vehicle["household"] is None:
            continue
        pair = (vehicle, loans.get(vin))
        by_household.setdefault(vehicle["household"], []).append(pair)
        by_owner.setdefault(vehicle["owner"], []).append(pair)
    del data
    return by_household, by_owner


def build(population, survey, debts, banked, carded, fleet, buildings,
          subscriptions, seed):
    """Every recurring charge in the city, split household and personal."""
    by_household_vehicles, by_owner_vehicles = fleet
    households = {h["id"]: h for h in population["household_records"]}
    members = {}
    for person in population["person_records"]:
        members.setdefault(person["household"], []).append(person)

    household_charges, personal_charges = [], []

    for household_id, household in households.items():
        people = members.get(household_id, [])
        if not people:
            continue
        row = survey[(people[0]["serialno"], people[0]["sporder"])]
        rng = keyed(seed, household_id, "household-bills")
        income = household["income"] or 0

        charges = (housing(row, rng, keyed(seed, household_id, "rent-jitter"))
                   + utilities(row, rng)
                   + connectivity(row, income, rng)
                   + childcare(row, people, rng)
                   + vehicle_charges(by_household_vehicles.get(household_id, []),
                                     rng))
        # Debt is filed against the person who owes it and paid by whoever in
        # the household is paying that month, which is why it lands in the
        # household table with a `for_person` rather than in the personal one.
        owed = []
        for person in people:
            for charge in debt_charges(person, debts.get(person["id"], []),
                                       keyed(seed, person["id"], "debt-bills")):
                charge["for_person"] = person["id"]
                owed.append(charge)

        ranked = payers(people, rng)
        for charge in charges + owed:
            charge.setdefault("for_person", None)
            charge["household"] = household_id
            assign_payer(charge, ranked, rng)
            if charge["kind"] == "rent":
                payer = next(p for p in people if p["id"] == charge["payer"])
                building = buildings[household["dwelling"]]
                charge["amount"] = money(
                    charge["amount"] * rent_factor(household, payer, building))
            charge["method"] = _method(
                charge["kind"], charge["payer"] in banked, rng)
            household_charges.append(charge)

    for person in population["person_records"] + population["quarters_records"]:
        row = survey[(person["serialno"], person["sporder"])]
        rng = keyed(seed, person["id"], "personal-bills")
        for charge in personal(person, person["id"] in carded,
                               by_owner_vehicles.get(person["id"], []), row, rng):
            charge["person"] = person["id"]
            # A personal charge is normally its subject's own, so the
            # attribution column is empty. The phone bill below is the
            # exception the column exists for.
            charge["for_person"] = None
            charge["method"] = _method(charge["kind"],
                                       person["id"] in banked, rng)
            personal_charges.append(charge)

    personal_charges.extend(mobile_charges(subscriptions, banked, seed))

    return household_charges, personal_charges


# What each frequency comes to in a year, for the annualised report.
PER_YEAR = {"weekly": 52, "monthly": 12, "quarterly": 4, "semiannual": 2,
            "annual": 1}


def report(household_charges, personal_charges, households, people):
    """What the city now pays, against what CE says it should.

    The annualised column is the one to read. CE's consumer unit spends about
    $26,000 a year in total, of which roughly $13,000 is shelter and utilities
    — and those two figures are what this stage is answerable to, because
    almost every dollar in them came off a survey answer rather than out of a
    draw.
    """
    print(f"\n{len(household_charges):,} household charges across "
          f"{len({c['household'] for c in household_charges}):,} households")
    print(f"{len(personal_charges):,} personal charges held by "
          f"{len({c['person'] for c in personal_charges}):,} people")

    # Card payments are excluded from every total below, and the exclusion is
    # not a fudge. A payment to a card settles charges the simulation has
    # already counted once at the till, so adding it to an expenditure figure
    # counts that money twice — CE treats it the same way, as a transfer rather
    # than as consumption. The rows are real and belong in the ledger; they are
    # simply not spending, and their amount is a rule rather than a number, so
    # there is nothing here to annualise anyway.
    settlements = [c for c in household_charges if c["share_of_balance"] > 0]
    print(f"\n  {len(settlements):,} card payments excluded from totals "
          f"(they settle spending already counted)")

    for label, charges, unit in (
            ("household", [c for c in household_charges
                           if c["share_of_balance"] == 0], households),
            ("personal", personal_charges, people)):
        print(f"\n  {label:<16}{'rows':>9}{'median':>10}{'a year':>11}"
              f"{'per unit/yr':>13}  source")
        by_kind = {}
        for charge in charges:
            by_kind.setdefault(charge["kind"], []).append(charge)
        rows = sorted(by_kind.items(),
                      key=lambda kv: -sum(c["amount"] * PER_YEAR[c["frequency"]]
                                          for c in kv[1]))
        for kind, group in rows:
            amounts = sorted(c["amount"] for c in group)
            yearly = sum(c["amount"] * PER_YEAR[c["frequency"]] for c in group)
            surveyed = sum(1 for c in group if c["source"] == "survey")
            print(f"  {kind:<16}{len(group):>9,}"
                  f"{amounts[len(amounts) // 2]:>10,.2f}"
                  f"{yearly / 1e6:>10,.1f}M{yearly / unit:>13,.0f}"
                  f"  {'survey' if surveyed == len(group) else 'modeled' if not surveyed else 'mixed'}")
        total = sum(c["amount"] * PER_YEAR[c["frequency"]] for c in charges)
        print(f"  {'total':<16}{len(charges):>9,}{'':>10}{total / 1e6:>10,.1f}M"
              f"{total / unit:>13,.0f}")

    methods = Counter(c["method"] for c in household_charges + personal_charges)
    total = sum(methods.values())
    print("\n  method: " + ", ".join(
        f"{name} {count / total * 100:.1f}%" for name, count in methods.most_common()))
    splits = Counter(c["split"] for c in household_charges)
    print("  split:  " + ", ".join(
        f"{name} {count / len(household_charges) * 100:.1f}%"
        for name, count in splits.most_common()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()

    for path in (POPULATION, HOLDINGS, VEHICLES, DEVICES):
        if not path.exists():
            raise SystemExit(f"{path.name} is missing; run the earlier "
                             f"stages first")

    population = json.loads(POPULATION.read_text())
    dwelling_stock = json.loads(DWELLINGS.read_text())
    buildings = {b["id"]: b for b in dwelling_stock["dwellings"]}
    survey = pums.rows_by_person()
    debts, banked, carded = reduce_holdings(HOLDINGS)
    fleet = household_vehicles(VEHICLES)
    # The phone bill's carrier, plan and payer come from here rather than being
    # drawn — see `mobile_charges`.
    subscriptions = json.loads(DEVICES.read_text())["subscriptions"]

    household_charges, personal_charges = build(
        population, survey, debts, banked, carded, fleet, buildings,
        subscriptions, args.seed)

    args.out.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": TODAY,
        "persons": len(population["person_records"])
        + len(population["quarters_records"]),
        "households": len(population["household_records"]),
        "seasonal": SEASONAL,
        "surveyed": ["TEN", "RNTP", "MRGP", "MRGI", "MRGT", "TAXAMT", "INSP",
                     "CONP", "SMP", "MHP", "ELEP", "GASP", "WATP", "FULP",
                     "HFL", "ACCESSINET", "HUPAC", "HINS2", "BLD", "ADJHSG"],
        "modelled": ["phone plan prices", "streaming and subscriptions", "gym",
                     "internet and television prices", "childcare rates",
                     "auto and life premiums", "trash fee", "autopay shares",
                     "who in a household pays which bill",
                     "rent adjustment by payer income, distance from center, "
                     "unit area, building kind, and floor"],
        "household": household_charges,
        "person": personal_charges,
    }))
    print(f"wrote {args.out}")
    report(household_charges, personal_charges,
           len(population["household_records"]),
           len(population["person_records"]))


if __name__ == "__main__":
    main()
