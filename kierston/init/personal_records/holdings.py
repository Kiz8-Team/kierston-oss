"""Generate what each Kierston resident holds: licenses, accounts, loans, property, credentials, firearms.

The other personal-records stages describe things that *happened* to a person —
they were born, they entered the country, they were charged. This one describes
what they currently have, and the shape is different: one row per person per
thing, each with an issuer, a number, a date and a status. A driver licence is
not a fact about a person, it is a document with an expiry, and the expired ones
are as interesting as the current ones.

Eight kinds of holding, in the order they depend on each other:

  driver licence     the state DMV, eight digits, renewed on a four-year cycle keyed
                     to the holder's birthday, and suspended by the DUI and
                     driving-under-suspension convictions in dockets.json
  firearms           a licence to carry, § 6111 records of sale, and the § 6105
                     prohibition that dockets.py derived
  money              income streams, deposit accounts with balances, cash in
                     hand, and the cards that spend from them. The model is in
                     banking.py; this stage only calls it and files the rows
  loans              student, and the mortgage that lives with the deed; the
                     auto loans moved out with the vehicles, because a loan
                     secured on a VIN belongs with the VIN it is secured on
  real estate        deed and mortgage, from TEN, VALP and MRGP
  degrees            from SCHL, with the field of study from FOD1P and FOD2P
  military service   from MIL and VPS, which date the service to a named war
  prescriptions      from DIS, HICOV and age

Vehicles used to be here and are now their own stage and their own registry,
keyed by VIN rather than by owner — see vehicles.py for why that inversion is
the correct one. This stage still decides who holds a driver licence, which is
what that one reads to know who a car can be registered to.

Most of the volume is anchored on a survey response, which is what keeps the
totals honest. TEN and VALP say who owns and what it is worth. SCHL and FOD1P
say who holds which degree in what subject. MIL and VPS say who served and in
which war — and VPS is better than a date, because it names the conflict, so a
Vietnam-era veteran's DD-214 lands in the right decade without a guess.

Gun ownership is the part with no survey anchor at all, and it is worth naming
what it rests on. Pennsylvania keeps no registry of firearms and publishes no
count of owners, by design — 18 Pa.C.S. § 6111.4 prohibits one. What exists is
the licence-to-carry count held by each county sheriff, and the figure used here
is an assumed value (no published source): 4-6% of adults hold a permit. Ownership is broader than
permit-holding and is set from survey estimates of household gun ownership in
urban Pennsylvania, which is well below the state figure. Two things are then
real records rather than estimates: the § 6111 record of sale, which every
handgun transfer through a dealer generates and which the State Police retain,
and the PICS background check that precedes it — including the ones that come
back denied, which is where this file joins the criminal history.

Ordering note: this stage runs after dockets.py, not before. It has to, because
a licence to carry cannot be issued to someone under a § 6105 prohibition and a
driver licence cannot be current while suspended, and both of those facts live
in the court records. Run it first and the city ends up with felons holding
carry permits.
"""

import argparse
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population import pums
import banking
import registries
from registries import keyed


from paths import PUMS_CODEBOOK, SIM_DATA  # noqa: E402
import city_data  # noqa: E402
import jurisdiction as legal  # noqa: E402
import profile as city_profile  # noqa: E402

LAW = legal.load()
MONEY = legal.state_module("money")
COUNTY = city_profile.load().locale.county

POPULATION = SIM_DATA / "population.json"
IDENTITY = SIM_DATA / "identity.json"
DOCKETS = SIM_DATA / "dockets.json"
EMPLOYMENT = SIM_DATA / "employment.json"
OUTPUT = SIM_DATA / "holdings.json"

DEFAULT_SEED = 20260728
TODAY = registries.REFERENCE_YEAR

# Not-applicable sentinels on the household fields read here. VEH and TEN use
# -1 and 0 on group quarters and vacant units; YRBLT uses 1938 for the same
# rows and 1939 as a real "1939 or earlier" bucket, which is a trap of its own
# — the two differ by one year and only one of them is data.
VEH_NA = -1
YRBLT_NA = 1938
YRBLT_FLOOR = 1939


# ---------------------------------------------------------------------------
# Driver licences
# ---------------------------------------------------------------------------

# Share of each age band holding a driver licence. The reference city is denser
# and poorer than its state and its licensing rate is correspondingly lower,
# especially among the young: a third of the city's households have no vehicle.
LICENSED_BY_AGE = ((15, 0.0), (17, 0.34), (20, 0.62), (24, 0.74),
                   (64, 0.84), (74, 0.80), (84, 0.62), (200, 0.31))

# People without a driver licence still need state ID, and the state DMV
# issues a non-driver photo ID on the same numbering series. Worth having as its own
# record: it is the document someone without a car uses to open a bank account
# or vote, and whether a person has one is consequential.
PHOTO_ID_IF_UNLICENSED = 0.58

# Licences renew on the jurisdiction's cycle, expiring on the holder's
# birthday, and seniors on a shorter one.
RENEWAL_YEARS = LAW.licensing.renewal_years
SENIOR_RENEWAL_YEARS = LAW.licensing.senior_renewal_years
SENIOR_AGE = LAW.licensing.senior_age

# REAL ID is optional in Pennsylvania and take-up is partial, which makes it a
# usefully discriminating field: about 30% of licences carry the marking.
REAL_ID_SHARE = 0.30

# Suspension lengths in months, by the section that triggered them, from the
# jurisdiction. A section not in the table carries no suspension at all.
SUSPENSION_MONTHS = LAW.licensing.suspension_months


# Occupations whose holder drives on the job, and the licence class the job
# needs. OCCP codes from the PUMS codebook. init_work.py overwrites the
# occupation of everyone it recruits, so a staffed officer, medic, cab driver
# or bus driver carries the role's code by the time this stage reads it.
# "AB" is a truck driver: class A or B, drawn. Firefighters and police drive
# their apparatus on a class C licence under the PA emergency-vehicle exemption.
DRIVING_OCCUPATIONS = {
    "3710": "C",   # first-line supervisors of police and detectives
    "3720": "C",   # first-line supervisors of firefighting
    "3740": "C",   # firefighters
    "3840": "C",   # parking enforcement officers
    "3870": "C",   # police officers
    "3401": "C",   # emergency medical technicians
    "3402": "C",   # paramedics
    "5510": "C",   # couriers and messengers
    "9110": "C",   # ambulance drivers and attendants
    "9121": "B",   # bus drivers, school
    "9122": "B",   # bus drivers, transit and intercity
    "9130": "AB",  # driver/sales workers and truck drivers
    "9141": "C",   # shuttle drivers and chauffeurs
    "9142": "C",   # taxi drivers
    "9150": "C",   # motor vehicle operators, all other
    "9350": "C",   # parking attendants
}

# The staffed roles from employment.json, for anyone whose occupation code
# was not rewritten to match the role.
DRIVING_ROLES = {"police_officer": "C", "paramedic": "C", "emt": "C",
                 "taxi_driver": "C", "school_bus_driver": "B"}

# Commercial classes, ordered: an A licence covers what a B licence does.
COMMERCIAL = ("A", "B")


def graded(table, age):
    return next(value for bound, value in table if age <= bound)


def required_class(person, role):
    """The licence class this person's job needs, or None if it needs none."""
    need = DRIVING_ROLES.get(role) or DRIVING_OCCUPATIONS.get(
        str(person.get("occupation") or ""))
    return need


def driver_licence(person, identity, cases, registry, rng, required=None):
    """A licence or photo ID record, with any suspension in force.

    `required` is the class the person's job needs. A police officer, medic,
    cab, bus or truck driver holds a licence of at least that class regardless
    of the age-band draw.
    """
    age = person["age"]
    if age < 16:
        return None

    # Drawn for everyone so the stream stays aligned whether or not the job
    # forces the outcome.
    licensed = rng.random() < graded(LICENSED_BY_AGE, age)
    if required:
        licensed = True
    if not licensed and rng.random() >= PHOTO_ID_IF_UNLICENSED:
        return None

    birth = identity["birth_date"]
    first = int(birth[:4]) + (16 if licensed else 18) + rng.randrange(0, 4)
    first = min(first, TODAY)
    cycle = SENIOR_RENEWAL_YEARS if age >= SENIOR_AGE else RENEWAL_YEARS
    # Expiry is on the birthday, which is what makes the DOB and the licence
    # agree — the single most checkable join in this whole dataset.
    expires = TODAY + rng.randrange(0, cycle) + 1
    record = {
        "holding": "driver_licence" if licensed else "photo_id",
        "number": registry.next_licence(),
        "issuer": LAW.licensing.issuer,
        "issued": f"{max(first, expires - cycle):04d}{birth[4:]}",
        "expires": f"{expires:04d}{birth[4:]}",
        "first_issued": first,
        "real_id": rng.random() < REAL_ID_SHARE,
        "class": "C" if licensed else None,
        "status": "valid",
        "restrictions": [],
    }
    if licensed:
        if age < 18:
            record["class"] = "junior"
        elif rng.random() < 0.055:
            # A commercial licence, which is a different class and a different
            # renewal cycle, and is why some of these people drive for a living.
            record["class"] = rng.choice(("A", "B"))
        if rng.random() < 0.21:
            record["restrictions"].append("corrective lenses")
        if required == "AB":
            required = "A" if rng.random() < 0.65 else "B"
        if required in COMMERCIAL and record["class"] not in COMMERCIAL[
                :COMMERCIAL.index(required) + 1]:
            record["class"] = required

    # Suspensions, from the convictions. Derived rather than drawn: a suspended
    # licence with no conviction behind it is a record that contradicts itself.
    for case in cases:
        if not case.get("convicted"):
            continue
        for charge in case["charges"]:
            section = charge["section"].split("(")[0].strip()
            months = SUSPENSION_MONTHS.get(section) or SUSPENSION_MONTHS.get(
                charge["section"])
            if not months:
                continue
            start = int(case["disposed"][:4])
            record.setdefault("suspensions", []).append({
                "from": case["disposed"],
                "months": months,
                "reason": charge["cite"],
                "docket": case["docket"],
            })
            if start + months / 12 > TODAY:
                record["status"] = "suspended"
    return record



# ---------------------------------------------------------------------------
# Firearms
# ---------------------------------------------------------------------------

# Adults holding the county's licence to carry firearms. An assumed value
# (no published source). Pennsylvania publishes no owner count and § 6111.4
# forbids a registry, so the sheriff's licence count is the one real quantity
# this could be checked against. The minimum age and the term are the
# jurisdiction's.
LTCF_SHARE = 0.05
LTCF_AGE = LAW.firearms.carry_licence_age
LTCF_TERM_YEARS = LAW.firearms.carry_licence_term_years

# Ownership is broader than permit-holding — a permit is for carrying concealed,
# not for owning — but in an urban county it is not as much broader as the
# statewide figure suggests. Household gun ownership in Pennsylvania runs about
# 35%; in the cities it is closer to 18%, and the reference city is a city.
OWNERSHIP_BY_AGE = ((20, 0.02), (29, 0.10), (44, 0.16), (64, 0.20),
                    (200, 0.15))

# Men own guns at roughly three times the rate of women, which is one of the
# largest and most stable sex differences in any survey of the subject.
OWNERSHIP_SEX = {1: 1.65, 2: 0.45}

# Handguns move through dealers and generate a § 6111 record of sale; long guns
# can be sold privately in Pennsylvania with no record at all. That asymmetry is
# the single most important thing about firearms records in this state: roughly
# half the guns in the city have no paper behind them.
HANDGUN_SHARE = 0.52
PRIVATE_TRANSFER = {"handgun": 0.0, "long_gun": 0.42}

# Federally licensed dealers in and around the city, from its gun_dealers.csv.
# Names are generic on purpose — a real FFL is a real small business, and
# putting invented sales records against a real gun shop's name is the one
# thing in this whole dataset that could plausibly harm someone.
DEALERS = city_data.gun_dealers()

FIREARM_TYPES = (
    ("handgun", "pistol, semi-automatic", 0.40),
    ("handgun", "revolver", 0.12),
    ("long_gun", "rifle, bolt action", 0.12),
    ("long_gun", "rifle, semi-automatic", 0.14),
    ("long_gun", "shotgun, pump action", 0.16),
    ("long_gun", "shotgun, semi-automatic", 0.06),
)

# PICS — the Pennsylvania Instant Check System, run by the State Police rather
# than by the FBI, which is why PA has its own denial statistics. Around 1% of
# checks are denied outright, and a denial is itself a record.
PICS_DENIAL_BASE = 0.012


# PICS began operating on 1 July 1998; no check can predate it.
PICS_START = date(1998, 7, 1)
REFERENCE_DATE = registries.REFERENCE_DATE

# Sections whose conviction carries each § 6105 reason, matched on the reason
# text dockets.py writes. Kept to the stems the PA courts module uses.
ENUMERATED_MISDEMEANOURS = {"2709.1", "2718", "6114", "4952"}


def iso_date(text):
    """A docket date as a date. Dockets count in 30-day months, so a day past
    the end of the real month is clamped to its last day."""
    year, month, day = int(text[:4]), int(text[5:7]), int(text[8:10])
    for last in (31, 30, 29, 28):
        try:
            return date(year, month, min(day, last))
        except ValueError:
            continue
    raise ValueError(text)


def disqualified_since(reason, cases, orders):
    """The earliest date by which the prohibition `reason` was certainly in force.

    `cases` are the person's convicted criminal cases and `orders` their PFA
    orders. Where the exact case behind a reason cannot be recovered (the
    domestic share of simple assault is a draw in dockets.py), the latest
    candidate is used, which is never earlier than the real one.
    """
    def stems(case):
        return {charge["section"].split("(")[0].strip()
                for charge in case["charges"]}

    dated = [case for case in cases if case.get("disposed")]
    if "6105(a)" in reason:
        hits = [c["disposed"] for c in dated if c.get("felony_convicted")]
        return iso_date(min(hits)) if hits else None
    if "6105(c)(9)" in reason:
        hits = [c["disposed"] for c in dated
                if stems(c) & ENUMERATED_MISDEMEANOURS]
        return iso_date(min(hits)) if hits else None
    if "922(g)(9)" in reason:
        hits = [c["disposed"] for c in dated if "2701" in stems(c)]
        return iso_date(max(hits)) if hits else None
    if "6105(c)(3)" in reason:
        hits = [c["disposed"] for c in dated if "3802" in stems(c)]
        return iso_date(max(hits)) if hits else None
    if "6105(c)(6)" in reason:
        active = [o["filed"] for o in orders
                  if int(o["filed"][:4]) + o["order_months"] / 12 > TODAY]
        return iso_date(max(active)) if active else None
    hits = [c["disposed"] for c in dated]
    return iso_date(max(hits)) if hits else None


def firearms(person, identity, prohibited, registry, rng, cases=(), orders=()):
    """Guns held, the permit to carry one, and the checks that were run."""
    age = person["age"]
    if age < 18:
        return []

    out = []
    owns = rng.random() < (graded(OWNERSHIP_BY_AGE, age)
                           * OWNERSHIP_SEX.get(person["sex"], 1.0))

    # A prohibited person may not lawfully acquire or possess one, and the
    # records reflect the lawful system: no permit, no new purchases, and a
    # denial on the last check they attempted. What they actually possess is
    # outside any record, which is the point — the absence is the record.
    if prohibited:
        if rng.random() < 0.09:
            # Dated after the event the denial cites and no later than the
            # reference date. Not before the buyer turned 18 or PICS existed.
            since = disqualified_since(prohibited[0], cases, orders)
            born = iso_date(identity["birth_date"])
            adult = date(born.year + 18, born.month, min(born.day, 28))
            earliest = max(d for d in (since, adult, PICS_START) if d)
            if earliest > REFERENCE_DATE:
                return out
            checked = date.fromordinal(rng.randint(
                earliest.toordinal(), REFERENCE_DATE.toordinal()))
            dealer, ffl = rng.choice(DEALERS)
            out.append({
                "holding": "pics_check",
                "date": checked.isoformat(),
                "approval": None,
                "result": "denied",
                "reason": prohibited[0],
                "dealer": dealer,
                "ffl": ffl,
                "issuer": LAW.firearms.background_check_agency,
            })
        return out

    # The 4-6% figure is a share of all adults, and licences are only issued
    # from 21, so the rate among the eligible has to be scaled up slightly to
    # land on it across the whole adult population.
    if age >= LTCF_AGE and rng.random() < LTCF_SHARE * 1.09:
        issued = TODAY - rng.randrange(0, LTCF_TERM_YEARS)
        out.append({
            "holding": "licence_to_carry",
            "number": registry.next_ltcf(),
            "issuer": f"{COUNTY} Sheriff",
            "issued": f"{issued:04d}-{rng.randint(1, 12):02d}-"
                      f"{rng.randint(1, 28):02d}",
            "expires": issued + LTCF_TERM_YEARS,
            "statute": LAW.firearms.carry_licence_statute,
            "status": "valid" if issued + LTCF_TERM_YEARS > TODAY else "expired",
        })

    if not owns:
        return out

    for _ in range(rng.choices((1, 2, 3, 5, 8), weights=(46, 26, 16, 8, 4))[0]):
        kind, description, _ = rng.choices(
            FIREARM_TYPES, weights=[w for _, _, w in FIREARM_TYPES])[0]
        acquired = rng.randint(
            min(max(1975, int(identity["birth_date"][:4]) + 18), TODAY), TODAY)
        private = rng.random() < PRIVATE_TRANSFER[kind]
        record = {
            "holding": "firearm",
            "type": kind,
            "description": description,
            "acquired": acquired,
            # A serial number is on the gun, not in a state registry: PA holds
            # the record of sale, not a list of what anyone owns.
            "serial": registry.next_firearm_serial(rng),
            "transfer": "private" if private else "dealer",
            "record_of_sale": None,
            "pics_approval": None,
        }
        if not private:
            dealer, ffl = rng.choice(DEALERS)
            record["dealer"] = dealer
            record["ffl"] = ffl
            # Form SP 4-113, the § 6111 record of sale, retained by the State
            # Police. Handguns only — a long gun sold by a dealer generates a
            # federal 4473 held by the dealer, not a state record.
            if kind == "handgun":
                record["record_of_sale"] = (
                    f"{LAW.firearms.record_of_sale_form}-{acquired}-"
                    f"{rng.randrange(10 ** 6):06d}")
            record["pics_approval"] = f"{rng.randrange(10 ** 10):010d}"
        out.append(record)
    return out


# ---------------------------------------------------------------------------
# Student loans
# ---------------------------------------------------------------------------

# Student loan holders, by attainment. The balances are what matter and they
# are wildly skewed, which is why they are drawn log-normally rather than
# uniformly.
STUDENT_LOAN_BY_EDUCATION = {20: 0.34, 21: 0.46, 22: 0.54, 23: 0.58, 24: 0.52}


def loans(person, identity, rng):
    """Instalment debt: student, and the mortgage that lives with the deed.

    Auto loans are not here. They are written against a VIN and have to agree
    with the lien on that vehicle's title, so they live in vehicles.py with the
    vehicle they paid for — see that module for why the registry is keyed on
    the VIN rather than on the borrower.
    """
    out = []
    education = person.get("education") or 0

    if education in STUDENT_LOAN_BY_EDUCATION and rng.random() < \
            STUDENT_LOAN_BY_EDUCATION[education]:
        graduated = int(identity["birth_date"][:4]) + rng.randint(21, 30)
        years = max(0, TODAY - graduated)
        # Balances are extremely skewed and the median is far below the mean,
        # which a normal draw cannot produce — hence log-normal.
        #
        # Then scaled by when the person actually borrowed. Tuition has risen
        # far faster than inflation for forty years, so somebody who finished in
        # 1988 borrowed a fraction of what a 2020 graduate did, and drawing
        # every cohort from one distribution gives the retirees of this city
        # implausible six-figure debts.
        cohort = max(0.16, min(1.15, 1.0 - (2018 - graduated) * 0.028))
        principal = int(max(1_000, rng.lognormvariate(10.1, 0.75))
                        * cohort // 100 * 100)
        status = rng.choices(("repayment", "deferment", "default",
                              "paid_in_full"), weights=(60, 16, 12, 12))[0]
        # Balances do not amortise smoothly and for two of these statuses they
        # do not amortise at all: interest capitalises in deferment and default,
        # so those balances exceed the amount borrowed. Applying a single
        # straight-line paydown put the median at a quarter of the real one.
        if status == "paid_in_full":
            balance = 0
        elif status in ("deferment", "default"):
            balance = int(principal * rng.uniform(0.82, 1.0))
        else:
            balance = max(0, int(principal * max(0.05, 1 - years / 18)))
        out.append({
            "holding": "student_loan",
            "servicer": rng.choice(MONEY.STUDENT_LOAN_SERVICERS),
            "federal": rng.random() < 0.87,
            "originated": min(graduated, TODAY),
            "principal": principal,
            "balance": balance,
            "status": status,
        })
    return out


# ---------------------------------------------------------------------------
# Real estate
# ---------------------------------------------------------------------------

# TEN: 1 owned with a mortgage, 2 owned free and clear, 3 rented, 4 occupied
# without payment of rent.
OWNED_WITH_MORTGAGE = "1"
OWNED_OUTRIGHT = "2"


def real_estate(person, row, household, rng):
    """A deed and, where there is one, a mortgage.

    Anchored throughout: TEN says whether this household owns, VALP says what
    the property is worth, MRGP says what the monthly payment is, and YRBLT
    dates the structure. Almost nothing here is invented except the recording
    numbers and the lender.
    """
    tenure = row.get("TEN")
    if tenure not in (OWNED_WITH_MORTGAGE, OWNED_OUTRIGHT):
        return []
    if person["relationship"] != 20:
        # The deed is held by the householder. A spouse is usually on it too,
        # which is a second record for the same parcel rather than a second
        # parcel, and is not worth generating twice.
        return []

    value = row.get("VALP")
    value = int(value) if value and value.lstrip("-").isdigit() else None
    built = row.get("YRBLT")
    built = int(built) if built and built.isdigit() else None
    if built in (None, YRBLT_NA):
        built = None

    # Bought at some point after the structure was built and after the owner
    # turned 18.
    bought = TODAY - rng.choices((2, 6, 12, 22, 38),
                                 weights=(14, 24, 28, 22, 12))[0]
    bought = max(bought, (built or 1900) + 1, TODAY - person["age"] + 18)
    bought = min(bought, TODAY)

    deed = {
        "holding": "real_property",
        "address": household.get("dwelling"),
        "parcel": f"{rng.randrange(1000, 9999)}"
                  f"{rng.choice('ABCDEFGH')}{rng.randrange(100000, 999999)}"
                  f"-{rng.randrange(1, 9)}",
        # The county records deeds by book and page in the Recorder of Deeds'
        # own series, which is how a property's chain of title is actually
        # cited.
        "deed_book": rng.randint(1900, 2650),
        "deed_page": rng.randint(1, 999),
        "recorded": f"{bought:04d}-{rng.randint(1, 12):02d}-"
                    f"{rng.randint(1, 28):02d}",
        "issuer": f"{COUNTY} Recorder of Deeds",
        "assessed_value": value,
        "year_built": built if built != YRBLT_FLOOR else None,
        "year_built_or_earlier": built == YRBLT_FLOOR,
        "purchase_price": None if not value else int(
            value * rng.uniform(0.55, 0.95) ** max(0, (TODAY - bought) / 22)
            // 1000 * 1000),
    }
    out = [deed]

    if tenure == OWNED_WITH_MORTGAGE:
        payment = row.get("MRGP")
        payment = int(payment) if payment and payment.isdigit() else None
        term = rng.choices((360, 360, 180, 240), weights=(58, 20, 14, 8))[0]
        principal = (deed["purchase_price"] or value or 180_000)
        principal = int(principal * rng.uniform(0.78, 0.97) // 1000 * 1000)
        out.append({
            "holding": "mortgage",
            "parcel": deed["parcel"],
            "lender": rng.choice(MORTGAGE_LENDERS),
            "originated": f"{bought:04d}-{rng.randint(1, 12):02d}-01",
            "term_months": term,
            "principal": principal,
            "monthly_payment": payment,
            "escrow_includes_insurance": row.get("MRGI") == "1",
            "rate": round(rng.uniform(2.6, 7.9), 3),
            "balance": max(0, int(principal * max(0.0, 1 - (
                TODAY - bought) * 12 / term))),
            # Recorded as a separate instrument from the deed, in the same
            # series.
            "mortgage_book": rng.randint(1900, 2650),
            "mortgage_page": rng.randint(1, 999),
        })
    return out


# ---------------------------------------------------------------------------
# Degrees and military service
# ---------------------------------------------------------------------------

# SCHL, educational attainment, to the credential it represents.
DEGREES = {
    16: ("high_school_diploma", None),
    17: ("ged", None),
    20: ("associate", "Associate"),
    21: ("bachelor", "Bachelor"),
    22: ("master", "Master"),
    23: ("professional", "Professional degree"),
    24: ("doctorate", "Doctor of Philosophy"),
}

# Where a degree from this city was earned, from its colleges.csv: name, the
# level it awards here, and its weight among local graduates. The reference
# city's region has an unusual concentration of institutions for a city this
# size, and most graduates here went to one of them.
INSTITUTIONS = city_data.colleges()

# Where a higher degree came from, and the high schools a diploma names — the
# city's graduate_schools.csv and high_schools.csv, drawn uniformly.
GRADUATE_SCHOOLS = city_data.graduate_schools()
HIGH_SCHOOLS = city_data.high_schools()

# Who wrote the mortgage on a deed, from mortgage_lenders.csv, drawn uniformly.
MORTGAGE_LENDERS = city_data.mortgage_lenders()

# VPS names the conflict a veteran served in, which dates the service far more
# precisely than an age-based guess would. These are the midpoints of each.
SERVICE_ERAS = {
    "01": (2003, 2020), "02": (1995, 2010), "03": (1968, 2005),
    "04": (1990, 2001), "05": (1968, 1995), "06": (1964, 1975),
    "07": (1951, 1975), "08": (1942, 1975), "09": (1950, 1953),
    "10": (1942, 1953), "11": (1941, 1945), "12": (1976, 1989),
    "13": (1955, 1963), "14": (1976, 1989), "15": (1947, 1950),
}

BRANCHES = (("U.S. Army", 40), ("U.S. Navy", 22), ("U.S. Air Force", 20),
            ("U.S. Marine Corps", 14), ("U.S. Coast Guard", 4))


def credentials(person, identity, row, rng, fields):
    """Degrees held, with the field of study where PUMS records one."""
    education = person.get("education") or 0
    out = []
    if education < 16:
        return out

    birth = int(identity["birth_date"][:4])
    kind, label = DEGREES.get(education, (None, None))

    # Everyone with any post-secondary attainment finished high school first,
    # and the diploma is its own record.
    if education >= 16:
        out.append({
            "holding": "credential",
            "credential": "high_school_diploma" if education != 17 else "ged",
            "institution": None if education == 17
                           else rng.choice(HIGH_SCHOOLS),
            "awarded": birth + 18,
            "field": None,
        })

    if not kind or education < 20:
        return out

    # FOD1P and FOD2P are the fields of a bachelor's or higher, and "N" is the
    # not-applicable. A second field is a double major, which is a real and
    # separately-recorded thing.
    majors = [fields.get(row.get(code)) for code in ("FOD1P", "FOD2P")
              if row.get(code) not in (None, "", "N")]
    majors = [m for m in majors if m]

    eligible = [i for i in INSTITUTIONS
                if i[1] == ("associate" if kind == "associate" else "bachelor")]
    institution = rng.choices([i[0] for i in eligible],
                              weights=[i[2] for i in eligible])[0]
    awarded = birth + {"associate": 21, "bachelor": 23}.get(kind, 23)
    out.append({
        "holding": "credential",
        "credential": "associate" if kind == "associate" else "bachelor",
        "institution": institution,
        "awarded": min(awarded + rng.randrange(0, 5), TODAY),
        "field": majors[0] if majors else None,
        "second_field": majors[1] if len(majors) > 1 else None,
    })

    if kind in ("master", "professional", "doctorate"):
        out.append({
            "holding": "credential",
            "credential": kind,
            "institution": rng.choice(GRADUATE_SCHOOLS),
            "awarded": min(birth + rng.randint(25, 38), TODAY),
            "field": majors[0] if majors else None,
            "title": label,
        })
    return out


def military(person, identity, row, rng):
    """A DD-214 for anyone MIL says served, dated by the war VPS names."""
    served = row.get("MIL")
    if served not in ("1", "2", "3"):
        return []
    era = SERVICE_ERAS.get((row.get("VPS") or "").zfill(2))
    birth = int(identity["birth_date"][:4])
    entered = max(birth + 18, era[0] if era else birth + 19)
    entered = min(entered, TODAY)
    years = rng.choices((2, 3, 4, 6, 10, 20), weights=(14, 18, 30, 18, 12, 8))[0]
    branch = rng.choices([b for b, _ in BRANCHES],
                         weights=[w for _, w in BRANCHES])[0]
    record = {
        "holding": "military_service",
        "branch": branch,
        "entered": entered,
        # Still serving, so no discharge document yet.
        "separated": None if served == "1" else min(entered + years, TODAY),
        "component": "reserve" if served == "3" else "active",
        "conflict": None,
        "discharge": None,
        "document": None,
    }
    if served != "1":
        record["discharge"] = rng.choices(
            ("honorable", "general", "other_than_honorable", "medical"),
            weights=(84, 8, 4, 4))[0]
        record["document"] = "DD-214"
    return [record]


# ---------------------------------------------------------------------------
# Prescriptions
# ---------------------------------------------------------------------------

# Held as current prescriptions rather than as a fill history. A fill history is
# high-volume derived data — twelve rows a year per prescription — and it can be
# generated on demand from the prescription and its refill interval, which is
# how a pharmacy system stores it too.
#
# Anchored on three survey responses: DIS (a disability), HICOV (any health
# insurance) and age. An uninsured person has prescriptions too, but fewer of
# them and more gaps, which is one of the more consequential things insurance
# status does.
PRESCRIPTIONS_BY_AGE = ((17, 0.16), (34, 0.24), (49, 0.42),
                        (64, 0.62), (74, 0.82), (200, 0.90))
DISABILITY_MULTIPLIER = 1.8
UNINSURED_MULTIPLIER = 0.52

# Drug classes by the age band that carries them, which is what makes a
# prescription list read as a plausible medical history rather than a random
# draw from a formulary.
FORMULARY = (
    # (name, class, schedule, min age, max age, weight)
    ("lisinopril", "ACE inhibitor", None, 35, 200, 60),
    ("amlodipine", "calcium channel blocker", None, 40, 200, 50),
    ("atorvastatin", "statin", None, 40, 200, 58),
    ("metformin", "biguanide", None, 30, 200, 52),
    ("levothyroxine", "thyroid hormone", None, 25, 200, 40),
    ("metoprolol", "beta blocker", None, 45, 200, 34),
    ("omeprazole", "proton pump inhibitor", None, 20, 200, 36),
    ("gabapentin", "anticonvulsant", "V", 25, 200, 30),
    ("sertraline", "SSRI", None, 14, 200, 34),
    ("fluoxetine", "SSRI", None, 14, 200, 22),
    ("bupropion", "NDRI", None, 18, 200, 20),
    ("trazodone", "SARI", None, 20, 200, 18),
    ("albuterol", "beta-2 agonist", None, 4, 200, 32),
    ("montelukast", "leukotriene antagonist", None, 6, 200, 16),
    ("amoxicillin", "penicillin antibiotic", None, 0, 200, 26),
    ("prednisone", "corticosteroid", None, 10, 200, 18),
    ("ibuprofen 800mg", "NSAID", None, 12, 200, 24),
    ("methylphenidate", "stimulant", "II", 6, 40, 16),
    ("amphetamine salts", "stimulant", "II", 6, 45, 14),
    ("alprazolam", "benzodiazepine", "IV", 21, 200, 14),
    ("clonazepam", "benzodiazepine", "IV", 21, 200, 10),
    ("oxycodone", "opioid", "II", 18, 200, 12),
    ("hydrocodone-acetaminophen", "opioid", "II", 18, 200, 14),
    ("tramadol", "opioid", "IV", 18, 200, 12),
    ("buprenorphine-naloxone", "opioid partial agonist", "III", 18, 200, 9),
    ("insulin glargine", "insulin", None, 12, 200, 14),
    ("warfarin", "anticoagulant", None, 50, 200, 10),
    ("apixaban", "anticoagulant", None, 55, 200, 12),
    ("donepezil", "cholinesterase inhibitor", None, 65, 200, 8),
    ("tamsulosin", "alpha blocker", None, 50, 200, 14),
)

# The city's pharmacies with their weights, from pharmacies.csv.
PHARMACIES = city_data.pharmacies()


def prescriptions(person, row, rng):
    """Current prescriptions, with the controlled-substance schedule where there is one."""
    age = person["age"]
    chance = graded(PRESCRIPTIONS_BY_AGE, age)
    if row.get("DIS") == "1":
        chance = min(0.97, chance * DISABILITY_MULTIPLIER)
    if row.get("HICOV") == "2":
        chance *= UNINSURED_MULTIPLIER
    if rng.random() >= chance:
        return []

    # How many, given any at all. Polypharmacy in the over-65s is the norm.
    count = rng.choices((1, 2, 3, 5, 8, 12), weights=(
        (46, 28, 16, 7, 2, 1) if age < 50 else
        (24, 24, 22, 18, 9, 3) if age < 70 else (12, 16, 20, 24, 18, 10)))[0]

    eligible = [d for d in FORMULARY if d[3] <= age <= d[4]]
    pharmacy = rng.choices([p for p, _ in PHARMACIES],
                           weights=[w for _, w in PHARMACIES])[0]
    out, seen = [], set()
    for _ in range(count):
        name, drug_class, schedule, _, _, _ = rng.choices(
            eligible, weights=[d[5] for d in eligible])[0]
        if name in seen:
            continue
        seen.add(name)
        birth_year = TODAY - person["age"]
        written = max(birth_year, TODAY - rng.randrange(0, 3))
        out.append({
            "holding": "prescription",
            "drug": name,
            "drug_class": drug_class,
            # Schedule II-V controlled substances are reported to the PA
            # Prescription Drug Monitoring Program, which is a real record with
            # real consequences; everything else is not.
            "schedule": schedule,
            "pdmp_reported": schedule is not None,
            "written": f"{written:04d}-{rng.randint(1, 12):02d}-"
                       f"{rng.randint(1, 28):02d}",
            "days_supply": rng.choice((7, 14, 30, 30, 30, 90)),
            "refills": rng.choice((0, 0, 1, 2, 3, 5, 11)),
            "pharmacy": pharmacy,
            # The prescriber is a role, not a person: nothing in this
            # simulation models physicians yet, so this is a stable placeholder
            # rather than an invented name and NPI.
            "prescriber": "external",
        })
    return out


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def field_labels():
    """{FOD code: field of degree}, from the codebook."""
    raw = json.loads(PUMS_CODEBOOK.read_text())["variables"]
    return (raw.get("FOD1P", {}).get("values", {}) or {}).get("item", {})


def sectors():
    """{industry: sector} from the INDP label prefix — CON, MED, RET and the rest.

    assign_work.py reads the same prefixes to match people to sites. Here they
    decide how often somebody is paid and how likely it is to be in cash, both
    of which vary far more between sectors than the national average conveys.
    """
    labels = json.loads(
        PUMS_CODEBOOK.read_text())["variables"]["INDP"]["values"]["item"]
    return {code: label.split("-", 1)[0].strip() for code, label in labels.items()}


def staffed_roles():
    """{person id: role key} for everyone init_work.py staffed into a role."""
    if not EMPLOYMENT.exists():
        return {}
    data = json.loads(EMPLOYMENT.read_text())
    return {a["person"]: a["role"] for a in data.get("assignments", ())
            if a.get("role")}


def employers():
    """{person id: site id} for everyone assign_work.py sent somewhere."""
    if not EMPLOYMENT.exists():
        return {}
    data = json.loads(EMPLOYMENT.read_text())
    return {a["person"]: a.get("site") for a in data.get("assignments", ())}


class PayCycles:
    """The pay cycle of each employer, drawn once and shared by its staff.

    A payday is a fact about a workplace. Everyone at the same warehouse is
    paid on the same Friday, and drawing per person instead would scatter one
    employer's staff across four different cycles — which is not a small
    cosmetic error, because the whole point of a payday is that a lot of money
    moves on the same day.

    The draw is keyed on the site id rather than pulled from a shared stream,
    so a site's cycle does not depend on how many people were assigned before
    it. Somebody with no employer at all — the self-employed, the retired —
    gets their schedule from their own stream and never reaches this.
    """

    def __init__(self, seed):
        self.seed = seed
        self._cycles = {}

    def __call__(self, employer, sector):
        if employer not in self._cycles:
            self._cycles[employer] = banking.employer_cycle(
                sector, keyed(self.seed, employer or "no-site", "pay-cycle"))
        return self._cycles[employer]


def build(population, identities, status, seed):
    """Every holding in the city, keyed by person id."""
    registry = registries.Registries(seed)
    survey = pums.rows_by_person()
    fields = field_labels()
    sector_of = sectors()
    site_of = employers()
    cycles = PayCycles(seed)
    households = {h["id"]: h for h in population["household_records"]}
    # Who in each household is expected to be carrying the housing cost.
    # Counted here rather than in banking.py because this is where the person
    # list is, and ranked by banking's own function so that the balance model
    # and `recurring_spending.py` name the same people.
    members = {}
    for record in population["person_records"]:
        members.setdefault(record["household"], []).append(record)
    for household_id, people in members.items():
        household = households.get(household_id)
        if household is None:
            continue
        household["payers"] = {
            person["id"] for person
            in banking.ranked_adults(people)[:banking.HOUSING_FLOAT_PAYERS]}
    del members
    dockets = json.loads(DOCKETS.read_text())

    # Only the cases that can suspend a licence are needed here, so the rest of
    # the docket file is dropped straight away — it is 130 MB and holding all of
    # it alongside everything else is what makes this stage run out of memory.
    by_person = {}
    for case in dockets["criminal"]:
        if case.get("convicted"):
            by_person.setdefault(case["person"], []).append(case)
    # PFA orders, for dating a PICS denial that cites one. Only the filing date
    # and the order length are kept.
    orders = {}
    for case in dockets["civil"]:
        if case.get("kind") == "protection_from_abuse" and case.get("order_months"):
            orders.setdefault(case["person"], []).append(
                {"filed": case["filed"], "order_months": case["order_months"]})
    del dockets
    roles = staffed_roles()

    out = {}
    people = population["person_records"] + population["quarters_records"]
    for person in people:
        identity = identities[str(person["id"])]
        row = survey[(person["serialno"], person["sporder"])]
        household = households.get(person.get("household"), {})
        prohibited = status[str(person["id"])]["firearms_prohibited"]
        cases = by_person.get(person["id"], [])

        held = []
        licence = driver_licence(
            person, identity, cases, registry,
            keyed(seed, person["id"], "licence"),
            required=required_class(person, roles.get(person["id"])))
        if licence:
            held.append(licence)

        held += firearms(person, identity, prohibited, registry,
                         keyed(seed, person["id"], "firearms"),
                         cases=cases, orders=orders.get(person["id"], ()))
        held += banking.position(
            person, identity, household, sector_of.get(person.get("industry")),
            site_of.get(person["id"]), cycles, registry,
            keyed(seed, person["id"], "accounts"), row)
        held += loans(person, identity, keyed(seed, person["id"], "loans"))
        held += real_estate(person, row, household,
                            keyed(seed, person["id"], "property"))
        held += credentials(person, identity, row,
                            keyed(seed, person["id"], "credentials"), fields)
        held += military(person, identity, row,
                         keyed(seed, person["id"], "military"))
        held += prescriptions(person, row,
                              keyed(seed, person["id"], "prescriptions"))
        out[person["id"]] = held
    return out


def money_report(holdings, fifteen):
    """The calibration the balance model has to be read against.

    Deposits are drawn log-normally against SCF transaction-account medians by
    income, and the only way to know whether that landed is to print the
    medians back out by income band and compare. It goes here rather than into
    a notebook because a distribution nobody looks at is a distribution nobody
    fixes — see kierston/init/personal_records/banking.py for the targets.
    """
    def median(values):
        values = sorted(values)
        return values[len(values) // 2] if values else 0

    rows = [h for held in holdings.values() for h in held]
    streams = [h for h in rows if h["holding"] == "income_stream"]

    print("\nincome streams:")
    print(f"  {len(streams):,} streams held by "
          f"{sum(1 for held in holdings.values() if any(h['holding'] == 'income_stream' for h in held)):,} people")
    for label, key in (("source", "source"), ("frequency", "frequency"),
                       ("method", "method")):
        counts = Counter(s[key] for s in streams)
        print(f"  by {label}: " + ", ".join(
            f"{name} {count / len(streams) * 100:.1f}%"
            for name, count in counts.most_common()))
    paydays = Counter(s["payday"] for s in streams)
    standard = sum(count for day, count in paydays.items()
                   if day in ("1st", "15th_and_last", "1st_and_15th",
                              "last_day", "3rd"))
    print("  by payday:  " + ", ".join(
        f"{day} {count / len(streams) * 100:.1f}%"
        for day, count in paydays.most_common(8)))
    print(f"  {standard / len(streams) * 100:.1f}% paid on the 1st, 15th or "
          f"last day of the month")

    print("\ndeposits by income band:")
    banked = {}
    for person_id, held in holdings.items():
        accounts = [h for h in held if h["holding"] == "bank_account"]
        if any(a["type"] != "cash" for a in accounts):
            banked[person_id] = accounts
    income = {p["id"]: p.get("income") or 0 for p in fifteen}
    bands = ((0, "under $10k"), (10_000, "$10-20k"), (20_000, "$20-35k"),
             (35_000, "$35-55k"), (55_000, "$55-85k"), (85_000, "$85-150k"),
             (150_000, "over $150k"))
    print(f"  {'band':<12} {'people':>8} {'median':>12} {'mean':>12}")
    for index, (floor, label) in enumerate(bands):
        ceiling = bands[index + 1][0] if index + 1 < len(bands) else 10 ** 9
        totals = [sum(a["balance"] for a in accounts if a["type"] != "cash")
                  for person_id, accounts in banked.items()
                  if floor <= income.get(person_id, 0) < ceiling]
        if not totals:
            continue
        print(f"  {label:<12} {len(totals):>8,} "
              f"{median(totals):>11,.0f}$ "
              f"{sum(totals) / len(totals):>11,.0f}$")

    everyday = [h for h in rows if h["holding"] == "bank_account"
                and h["purpose"] == "everyday"]
    overdrawn = sum(1 for a in everyday if a["balance"] < 0)
    print(f"  {overdrawn:,} everyday accounts are overdrawn "
          f"({overdrawn / max(1, len(everyday)) * 100:.1f}%)")
    purposes = Counter(h["purpose"] for h in rows
                       if h["holding"] == "bank_account")
    print("  by purpose: " + ", ".join(f"{name} {count:,}"
                                       for name, count in purposes.most_common()))

    cash = [h["balance"] for h in rows
            if h["holding"] == "bank_account" and h["type"] == "cash"]
    cash_people = {person_id for person_id, held in holdings.items()
                   if any(h["holding"] == "income_stream" and h["method"] == "cash"
                          for h in held)}
    cash_held = [h["balance"] for person_id, held in holdings.items()
                 for h in held if h["holding"] == "bank_account"
                 and h["type"] == "cash" and person_id in cash_people]
    print(f"\ncash in hand: median ${median(cash):,.0f} across "
          f"{len(cash):,} people")
    if cash_held:
        print(f"  ${median(cash_held):,.0f} for the {len(cash_held):,} "
              f"paid in cash")


def report(holdings, population, status):
    people = population["person_records"] + population["quarters_records"]
    total = len(people)
    adults = [p for p in people if p["age"] >= 18]
    rows = [h for held in holdings.values() for h in held]

    print(f"{len(rows):,} holdings across {total:,} residents "
          f"({len(rows) / total:.1f} each)\n")

    kinds = Counter(h["holding"] for h in rows)
    width = max(len(k) for k in kinds)
    print(f"{'holding':<{width}}  {'rows':>8}  {'holders':>8}   share of people")
    for kind, count in kinds.most_common():
        holders = sum(1 for held in holdings.values()
                      if any(h["holding"] == kind for h in held))
        print(f"{kind:<{width}}  {count:>8,}  {holders:>8,}   "
              f"{holders / total * 100:5.1f}%")

    licences = [h for h in rows if h["holding"] == "driver_licence"]
    suspended = sum(1 for h in licences if h["status"] == "suspended")
    print(f"\ndriver licenses: {len(licences):,} "
          f"({len(licences) / len(adults) * 100:.1f}% of adults), "
          f"{suspended:,} currently suspended "
          f"({suspended / max(1, len(licences)) * 100:.1f}%)")

    print("\nfirearms:")
    ltcf = sum(1 for h in rows if h["holding"] == "licence_to_carry")
    guns = [h for h in rows if h["holding"] == "firearm"]
    owners = sum(1 for held in holdings.values()
                 if any(h["holding"] == "firearm" for h in held))
    prohibited = sum(1 for p in adults
                     if status[str(p["id"])]["firearms_prohibited"])
    denials = sum(1 for h in rows if h["holding"] == "pics_check")
    print(f"  license to carry      {ltcf:>7,}  "
          f"{ltcf / len(adults) * 100:5.1f}% of adults   target 4-6%")
    print(f"  owns at least one     {owners:>7,}  "
          f"{owners / len(adults) * 100:5.1f}% of adults")
    print(f"  firearms held         {len(guns):>7,}  "
          f"{len(guns) / max(1, owners):.1f} per owner")
    handguns = sum(1 for h in guns if h["type"] == "handgun")
    sale = sum(1 for h in guns if h["record_of_sale"])
    private = sum(1 for h in guns if h["transfer"] == "private")
    print(f"  handguns              {handguns:>7,}  "
          f"{handguns / max(1, len(guns)) * 100:5.1f}% of firearms")
    print(f"  § 6111 record of sale {sale:>7,}  "
          f"{sale / max(1, len(guns)) * 100:5.1f}% of firearms with a state record")
    print(f"  private transfer      {private:>7,}  "
          f"{private / max(1, len(guns)) * 100:5.1f}% of firearms with no record")
    print(f"  § 6105 prohibited     {prohibited:>7,}  "
          f"{prohibited / len(adults) * 100:5.1f}% of adults")
    print(f"  PICS denials          {denials:>7,}")
    # The consistency check this whole ordering exists for.
    conflict = sum(1 for person_id, held in holdings.items()
                   if status[str(person_id)]["firearms_prohibited"]
                   and any(h["holding"] in ("licence_to_carry", "firearm")
                           for h in held))
    print(f"  {conflict:,} prohibited people hold a permit or a firearm "
          f"(must be 0)")

    print("\nbanking and credit:")
    fifteen = [p for p in people if p["age"] >= 15]
    banked = sum(1 for held in holdings.values()
                 if any(h["holding"] == "bank_account" and h["type"] != "cash"
                        for h in held))
    neo = sum(1 for h in rows
              if h["holding"] == "bank_account" and h.get("neobank"))
    print(f"  {len(fifteen) - banked:,} of {len(fifteen):,} people 15+ hold no "
          f"deposit account ({(len(fifteen) - banked) / len(fifteen) * 100:.1f}%)")
    print(f"  {neo:,} accounts are at a neobank rather than a branch bank")
    cards = [h for h in rows if h["holding"] == "credit_card"]
    if cards:
        balances = sorted(h["balance"] for h in cards)
        print(f"  {len(cards):,} credit cards, median balance "
              f"${balances[len(balances) // 2]:,.0f}")
    debit = sum(1 for h in rows if h["holding"] == "debit_card")
    print(f"  {debit:,} debit cards issued against those accounts")

    money_report(holdings, fifteen)

    print("\nproperty and debt:")
    deeds = [h for h in rows if h["holding"] == "real_property"]
    mortgages = [h for h in rows if h["holding"] == "mortgage"]
    owner_occupied = len(deeds) / len(population["household_records"]) * 100
    print(f"  {len(deeds):,} deeds, {owner_occupied:.1f}% of households own "
          f"(ACS: ~46%)")
    print(f"  {len(mortgages):,} mortgages, "
          f"{len(mortgages) / max(1, len(deeds)) * 100:.0f}% of owners carry one")
    for kind in ("student_loan",):
        loan = [h for h in rows if h["holding"] == kind]
        if loan:
            # Median over those still carrying a balance. Including the
            # paid-off ones measures how old the loan book is, not what people
            # owe.
            balances = sorted(h["balance"] for h in loan if h["balance"])
            owed = sorted(h["principal"] for h in loan)
            print(f"  {len(loan):,} {kind}s, median borrowed "
                  f"${owed[len(owed) // 2]:,}, median balance outstanding "
                  f"${balances[len(balances) // 2]:,}" if balances else "")

    print("\ncredentials and service:")
    creds = Counter(h["credential"] for h in rows
                    if h["holding"] == "credential")
    width = max(len(k) for k in creds) if creds else 10
    for kind, count in creds.most_common():
        print(f"  {kind:<{width}}  {count:>7,}  "
              f"{count / len(adults) * 100:5.1f}% of adults")
    with_field = sum(1 for h in rows
                     if h["holding"] == "credential" and h.get("field"))
    print(f"  {with_field:,} carry a field of study from FOD1P")
    service = [h for h in rows if h["holding"] == "military_service"]
    print(f"  {len(service):,} veterans and serving members "
          f"({len(service) / len(adults) * 100:.1f}% of adults)")

    print("\nprescriptions:")
    scripts = [h for h in rows if h["holding"] == "prescription"]
    holders = sum(1 for held in holdings.values()
                  if any(h["holding"] == "prescription" for h in held))
    controlled = sum(1 for h in scripts if h["schedule"])
    print(f"  {len(scripts):,} current prescriptions held by {holders:,} people "
          f"({holders / total * 100:.1f}%)")
    print(f"  {controlled:,} are controlled substances reported to the PDMP "
          f"({controlled / max(1, len(scripts)) * 100:.1f}%)")
    common = Counter(h["drug"] for h in scripts)
    print("  most prescribed: " + ", ".join(
        f"{drug} {count:,}" for drug, count in common.most_common(6)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()

    population = json.loads(POPULATION.read_text())
    identities = json.loads(IDENTITY.read_text())["identities"]
    status = json.loads(DOCKETS.read_text())["status"]

    holdings = build(population, identities, status, args.seed)

    OUTPUT.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": TODAY,
        "persons": len(holdings),
        "holdings": sum(len(h) for h in holdings.values()),
        # Which of these are anchored on a survey response and which are not.
        # The gun records are the ones with no anchor and the shortest leash.
        "surveyed": ["tenure and value (TEN, VALP, MRGP)",
                     "attainment and field (SCHL, FOD1P, FOD2P)",
                     "military service (MIL, VPS)", "disability (DIS)",
                     "insurance (HICOV)", "year built (YRBLT)"],
        "modelled": ["driver licences and suspensions",
                     "firearms and licences to carry",
                     "income streams, paydays and pay methods",
                     "deposit balances, cash in hand, cards and credit",
                     "loans", "deed and mortgage numbers",
                     "institutions attended", "prescriptions"],
        "records": holdings,
    }, separators=(",", ":")))

    report(holdings, population, status)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
