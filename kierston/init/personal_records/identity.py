"""Generate the identity record (name, birth date, SSN, phone) for every Kierston resident.

This is the first of the personal-records stages and the one the others depend
on. Nothing else can run until a person has a name, a date of birth and a
number the state knows them by, because every later record is *about* those:
a driver licence renews on a birthday, a docket names a defendant, a credit
file is keyed on an SSN. Generate those downstream and they disagree with each
other; generate them here once and every record joins.

What comes out, per person:

  name              first, middle, surname, from names.py — see there for how
                    the cohort curves work
  birth             date of birth and birth year, from AGEP and QTRBIR
  taxpayer id       SSN, ITIN, or nothing, with the area number agreeing with
                    where the card was applied for
  phone             a mobile, a household landline, or neither, on a real
                    local exchange
  immigration       citizenship, entry year, legal status, what the status
                    rests on, and the documents it actually comes with
  marital status    current status and marriage count, which dockets.py turns
                    into licences and decrees

Most of it is not invented. AGEP, QTRBIR, SEX, POBP, CIT, YOEP, CITWP, MAR,
MARHT and TEL are surveyed facts about a real respondent, and this stage's job
is mostly to *read* them correctly — which is harder than it sounds, because
four of those fields encode not-applicable as a plausible year. YOEP is 1937 on
every US-born person and CITWP is 1946 on everyone who was not naturalised;
taken literally, 72% of the city entered the country in 1937. Each one is
guarded here and named in a comment where it is read.

The one substantial thing invented is legal status for noncitizens. PUMS asks
citizenship and stops, by design — it does not ask, and could not usefully ask,
whether a respondent is a permanent resident, on a student visa, under
temporary protected status, or has no status at all. That distinction drives
which documents a person holds and much of what happens to them in the other
records, so it is allocated here from published national estimates conditioned
on years since entry and region of birth, and flagged as an estimate in the
output.

On the identifiers being real-format. This was asked for explicitly and the
consequence is worth stating once in the place it lands: an SSN drawn from the
real Pennsylvania area range is an SSN that could belong to a real person, and
across 125,408 people some of them will. Same for phone numbers, which are
worse, because a phone number is *dialable*. The mitigation that survives is
that no generated record is a valid pair — a name here never agrees with the
real holder of the number beside it — so nothing in this file identifies
anybody. If this data ever leaves the simulation, the phone numbers are the
part to think about first.
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# the path when it runs as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import names

from population import pums
import registries
from registries import keyed


from paths import SIM_DATA
POPULATION = SIM_DATA / "population.json"
KINSHIP = SIM_DATA / "kinship.json"
OUTPUT = SIM_DATA / "identity.json"

DEFAULT_SEED = 20260728

# Simulation "now". Ages in the population are as of this date, so it is what
# a birth date has to be consistent with.
TODAY = (registries.REFERENCE_DATE.year, registries.REFERENCE_DATE.month,
         registries.REFERENCE_DATE.day)

# Days in each month, ignoring leap years. A February 29th birthday would be a
# nice touch and is not worth the special case: it changes one person in 1,461
# and every date consumer would have to handle it.
MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

# AGEP top-codes at 95 — everybody older is recorded as 95, so the birth years
# of the oldest cohort are wrong on average. Spreading them over a plausible
# tail would be a guess piled on a top code, so they are left alone; noted here
# so nothing reads the 95s as a real age spike.

# --- not-applicable sentinels ---------------------------------------------
# Three year-valued fields read here encode "question did not apply" as a year
# that looks like data. Each is checked where it is read rather than scrubbed
# on load, so the guard stays visible next to the use.
YOEP_NA = 1937        # year of entry, on every US-born person
CITWP_NA = 1946       # year of naturalisation, on everyone not naturalised
MARHYP_NA = 1943      # year last married, on the never-married


def survey_shift(serialno):
    """Years to add to a calendar year this respondent reported.

    The extract is a five-year file, surveyed 2019 to 2023, and SERIALNO opens
    with the year the household was interviewed. AGEP is taken as the age at
    TODAY, which moves every birth date forward by the years since the
    interview — and a year the respondent reported (YOEP, CITWP, MARHYP) has to
    move with it, or it stays behind. Read literally, a two-year-old
    interviewed in 2019 entered the country five years before being born.
    Shifting keeps what was surveyed, which is the age at each event and the
    years between them; the calendar years themselves were only ever the
    interview's.
    """
    return registries.REFERENCE_YEAR - int(str(serialno)[:4])

# CIT codes.
BORN_US = "1"
BORN_TERRITORY = "2"      # Puerto Rico, Guam, USVI, Northern Marianas
BORN_ABROAD_US_PARENT = "3"
NATURALIZED = "4"
NONCITIZEN = "5"

# POBP blocks. Codes under 100 are US states and territories; the hundreds are
# world regions — 100s Europe, 200s Asia, 300s the Americas, 400s Africa,
# 500s Oceania. See REGIONS below, which is what actually reads them.


# ---------------------------------------------------------------------------
# Birth dates
# ---------------------------------------------------------------------------

def birth_date(age, quarter, rng):
    """A date of birth consistent with `age` at TODAY and QTRBIR `quarter`.

    QTRBIR is on the file and is the only thing that pins a birthday to better
    than a year, so it gets used: without it every birthday would be uniform
    over the year, and anything keyed on a birthday — licence renewals, the
    18th and 21st birthdays that gate half these records — would be smooth
    where the real distribution is not quite.

    The year falls out of whether the birthday has already happened this year.
    """
    year, month, day = TODAY
    quarter = quarter if quarter in (1, 2, 3, 4) else rng.randint(1, 4)
    birth_month = (quarter - 1) * 3 + rng.randint(1, 3)
    birth_day = rng.randint(1, MONTH_DAYS[birth_month - 1])
    passed = (birth_month, birth_day) <= (month, day)
    birth_year = year - age - (0 if passed else 1)
    return f"{birth_year:04d}-{birth_month:02d}-{birth_day:02d}"


def year_of(date):
    return int(date[:4])


# ---------------------------------------------------------------------------
# Immigration
# ---------------------------------------------------------------------------

# How the noncitizen population divides by legal status, by years since entry.
# PUMS asks citizenship and nothing further, so this is the estimate: national
# shares (roughly 12.7M lawful permanent residents, 2.3M on temporary lawful
# status, 11M without status, plus humanitarian categories) tilted by tenure,
# because status is overwhelmingly a function of how long someone has been
# here. Recent arrivals are on temporary status, parole or nothing; a
# twenty-year resident who has not naturalised is almost always an LPR.
#
# Not a fact about the reference city. Flagged as an estimate in the output, and the
# thing to replace first if a Migration Policy Institute county profile is ever
# joined in.
STATUS_BY_TENURE = (
    # years since entry (<=), lpr, temporary, humanitarian, none
    (2,  (0.12, 0.30, 0.20, 0.38)),
    (5,  (0.26, 0.22, 0.16, 0.36)),
    (10, (0.44, 0.13, 0.11, 0.32)),
    (20, (0.58, 0.06, 0.09, 0.27)),
    (99, (0.68, 0.02, 0.08, 0.22)),
)
STATUSES = ("lpr", "temporary", "humanitarian", "none")

# Regional adjustment, applied as a multiplier before renormalising. The Syrian
# community here arrived through refugee admissions and the Middle East block
# reflects that; South and East Asian migration to the reference region is largely
# employment- and study-based, so temporary status is over-represented and
# unauthorised status well under. The Caribbean and Central American blocks
# tilt the other way.
REGION_TILT = {
    "middle_east": {"humanitarian": 4.0, "none": 0.4},
    "south_asia": {"temporary": 2.6, "none": 0.3, "lpr": 1.2},
    "east_asia": {"temporary": 2.2, "none": 0.4, "lpr": 1.2},
    "africa": {"humanitarian": 2.4, "none": 0.6},
    "europe": {"temporary": 1.4, "none": 0.5, "lpr": 1.3},
    "caribbean": {"none": 1.2},
    "central_america": {"none": 1.7, "lpr": 0.7},
    "south_america": {"none": 1.3},
}

# POBP code ranges to the regions above, for the tilt and for passport formats.
REGIONS = (
    (99, "us"), (199, "europe"), (219, "south_asia"), (234, "middle_east"),
    (249, "east_asia"), (299, "asia_other"), (309, "north_america"),
    (339, "caribbean"), (349, "central_america"), (399, "south_america"),
    (499, "africa"), (599, "oceania"),
)

# Middle Eastern countries sit inside the Asia block rather than in their own
# range, so the ones present here are named explicitly. 239 Syria is the third
# largest foreign birthplace in this extract.
MIDDLE_EAST = {"210", "222", "223", "224", "225", "226", "227", "228",
               "229", "230", "231", "232", "233", "234", "235", "236",
               "237", "238", "239", "240", "241", "242", "243"}

# India and Nepal are in the 200s alongside the Middle East; separated because
# their migration pathways are completely different.
SOUTH_ASIA = {"210", "211", "212", "213", "214", "215", "216", "217",
              "218", "219", "229"}


def region(pobp):
    """Which world region a POBP code falls in."""
    if pobp in SOUTH_ASIA:
        return "south_asia"
    if pobp in MIDDLE_EAST:
        return "middle_east"
    code = int(pobp)
    for upper, label in REGIONS:
        if code <= upper:
            return label
    return "other"


# Humanitarian protection is not one status but several, and they differ most
# in how long they last. A refugee must apply for a green card after a year
# and nearly all have one within two; an asylee can after a year and usually
# does within three. So a refugee or asylee who has been here longer than that
# is, on paper, a permanent resident whose card says RE6 or AS6, and is moved
# there rather than left holding a humanitarian status nobody keeps for twenty
# years. What does last is TPS, renewed by designation for decades, and a
# pending asylum claim, which the affirmative backlog holds open for years.
HUMANITARIAN_KINDS = (
    # kind, weight, longest tenure the status is still held
    ("refugee", 34, 1),
    ("asylee", 22, 3),
    ("asylum_applicant", 20, 12),
    ("tps", 24, 99),
    ("parole", 12, 3),
)
HUMANITARIAN_LIMIT = {kind: limit for kind, _, limit in HUMANITARIAN_KINDS}

# How a person without status came to be without it. Since about 2010 more of
# the unauthorised population has overstayed a lawful admission than crossed
# without one, but it splits sharply by origin: Mexico and Central America are
# mostly entries without inspection, and Asia, Europe and Africa almost wholly
# overstays of a visitor or student visa. The share here is the overstay one.
OVERSTAY_SHARE = {
    "north_america": 0.15, "central_america": 0.15, "caribbean": 0.45,
    "south_america": 0.5,
}
OVERSTAY_DEFAULT = 0.8


def legal_status(pobp, entry_year, rng):
    """(status, basis) for a noncitizen, from tenure and region of birth.

    The basis is what the status rests on — the humanitarian kind, how an
    unauthorised person entered — and is None for the two statuses whose basis
    is drawn later, against the person's age: an LPR's class of admission and a
    nonimmigrant's visa category. A refugee or asylee who is past the point of
    adjusting comes back as an LPR with that basis fixed.
    """
    tenure = registries.REFERENCE_YEAR - entry_year
    weights = next(w for cutoff, w in STATUS_BY_TENURE if tenure <= cutoff)
    tilt = REGION_TILT.get(region(pobp), {})
    weights = [w * tilt.get(status, 1.0)
               for w, status in zip(weights, STATUSES)]
    status = rng.choices(STATUSES, weights=weights)[0]

    if status == "humanitarian":
        kind = rng.choices([k for k, _, _ in HUMANITARIAN_KINDS],
                           weights=[w for _, w, _ in HUMANITARIAN_KINDS])[0]
        if kind in ("refugee", "asylee") and tenure > HUMANITARIAN_LIMIT[kind]:
            return "lpr", kind
        if kind == "parole" and tenure > 3:
            kind = rng.choices(("asylum_applicant", "tps"), weights=(20, 24))[0]
        if kind == "asylum_applicant" and tenure > 12:
            kind = "tps"
        return status, kind
    if status == "none":
        overstay = OVERSTAY_SHARE.get(region(pobp), OVERSTAY_DEFAULT)
        # An overstay needs an admission that has already run out, so this
        # year's arrivals without status crossed.
        if tenure >= 1 and rng.random() < overstay:
            return status, "visa_overstay"
        return status, "entered_without_inspection"
    return status, None


# ---- Permanent residence --------------------------------------------------

# Class of admission, which is what the Category box on a green card prints.
# The five groups are the INA's own and the shares are the average of recent
# DHS yearbooks: immediate relatives of citizens are half of all new green
# cards, the family preferences and employment a fifth and a seventh, refugee
# and asylee adjustments about an eighth, and the diversity lottery the rest.
LPR_BASES = ("immediate_relative", "family_preference", "employment",
             "refugee_asylee", "diversity")
LPR_BASIS_SHARES = (45, 20, 14, 12, 5)

# The same regional tilt as legal status, for the same reason. The Dominican
# Republic and Mexico are not eligible for the diversity lottery at all and
# send almost everyone through family; India and China are also ineligible and
# are the employment queue; the lottery is a large share of African and
# European immigration and the refugee programme most of the Syrian one.
LPR_BASIS_TILT = {
    "caribbean": {"immediate_relative": 1.3, "family_preference": 1.6,
                  "employment": 0.3, "refugee_asylee": 0.4, "diversity": 0.05},
    "central_america": {"immediate_relative": 1.2, "family_preference": 1.4,
                        "employment": 0.3, "refugee_asylee": 0.5,
                        "diversity": 0.2},
    "north_america": {"family_preference": 1.4, "employment": 0.6,
                      "refugee_asylee": 0.2, "diversity": 0.05},
    "south_america": {"family_preference": 1.2, "employment": 0.9,
                      "diversity": 0.4},
    "south_asia": {"employment": 3.0, "refugee_asylee": 0.6, "diversity": 0.1},
    "east_asia": {"employment": 2.0, "refugee_asylee": 0.5, "diversity": 0.1},
    "asia_other": {"family_preference": 1.4, "employment": 1.2},
    "middle_east": {"refugee_asylee": 4.0, "employment": 0.6, "diversity": 0.8},
    "africa": {"diversity": 4.0, "refugee_asylee": 2.0, "employment": 0.6},
    "europe": {"employment": 1.5, "diversity": 2.0, "refugee_asylee": 0.6},
}

# The classes a principal, their spouse and their child are admitted under, in
# that order, one row per programme. A derivative is admitted in the class of
# the principal they came with, so a spouse of an EB-2 engineer holds E22 and
# their child E23 — which is why a household's cards agree with each other.
DERIVATIVE_CLASSES = {
    "employment": (("E11", "E14", "E15"), ("E21", "E22", "E23"),
                   ("E31", "E34", "E35")),
    "refugee_asylee": (("RE6", "RE7", "RE8"), ("AS6", "AS7", "AS8")),
    "diversity": (("DV1", "DV2", "DV3"),),
}
CHILD_CLASSES = {"IR2", "F22"} | {
    row[2] for rows in DERIVATIVE_CLASSES.values() for row in rows}
DERIVATIVE_WEIGHTS = {
    "employment": (2, 5, 4), "refugee_asylee": (1, 1), "diversity": (1,),
}


def lpr_class(pobp, age, married, rng, basis=None, tier=None):
    """(basis, category) for someone who became a permanent resident at `age`.

    The class has to be one this person could have held. A child is admitted
    as a child — IR2, F22, or the child derivative of a parent's programme —
    and never as the H-1B engineer; IR1 and F21 need a marriage and IR5 a
    US-citizen son or daughter of 21, so a parent of forty or more. `basis` and
    `tier` pin the programme when it is already known, as it is for a refugee
    who has been here long enough to have adjusted.
    """
    if basis is None:
        tilt = LPR_BASIS_TILT.get(region(pobp), {})
        weights = [share * tilt.get(b, 1.0)
                   for b, share in zip(LPR_BASES, LPR_BASIS_SHARES)]
        basis = rng.choices(LPR_BASES, weights=weights)[0]
    child = age < 18 or (age < 21 and not married)

    if basis == "immediate_relative":
        if child:
            return basis, "IR2"
        roles = [(code, weight) for code, weight, ok in (
            ("IR1", 3, married), ("IR5", 1, age >= 40)) if ok]
        if roles:
            return basis, rng.choices([c for c, _ in roles],
                                      weights=[w for _, w in roles])[0]
        # An unmarried adult under forty has no immediate-relative class to
        # hold; the nearest real one is the family preference below.
        basis = "family_preference"

    if basis == "family_preference":
        if child:
            return basis, "F22"
        if married:
            return basis, rng.choices(("F21", "F31", "F41"),
                                      weights=(3, 2, 3))[0]
        return basis, rng.choices(("F11", "F24", "F41"), weights=(3, 2, 3))[0]

    rows = DERIVATIVE_CLASSES[basis]
    if tier is None:
        tier = rng.choices(range(len(rows)),
                           weights=DERIVATIVE_WEIGHTS[basis])[0]
    principal, spouse, kid = rows[tier]
    if child:
        return basis, kid
    if married and rng.random() < 0.4:
        return basis, spouse
    return basis, principal


# Years from green card to naturalisation. Five is the statutory minimum, and
# three for someone married to and living with a US citizen for those three
# years (INA 319(a)). Nobody naturalises the day they become eligible: the DHS
# yearbooks put the median at about seven years, with a long tail of people
# who waited decades.
NATURALIZATION_WAIT = 5
NATURALIZATION_WAIT_SPOUSE = 3


def residence_before(entry_year, latest, birth_year, rng):
    """When someone whose residence must begin by `latest` became an LPR.

    Both ends of the span are surveyed — YOEP when they came and CITWP when
    they naturalised — and this places the green card between them. Half of
    all new green cards go to people arriving on an immigrant visa, who become
    residents the day they land; the rest adjust from inside the country,
    usually within a few years. When the survey leaves too little room, the
    reason is that YOEP is the *latest* year the person came to live here: a
    resident who left and came back, and whose green card is older than the
    arrival the survey recorded.
    """
    if entry_year <= latest:
        slack = latest - entry_year
        lag = 0 if rng.random() < 0.5 else min(slack, rng.randint(1, 8))
        return entry_year + lag
    return max(birth_year, latest - rng.randint(0, 3))


def naturalized_history(birth_year, entry_year, naturalized_year, pobp,
                        married, rng):
    """The permanent residence a naturalised citizen held before the oath.

    Returns lpr_year, basis, category, and whether the citizenship was derived.
    Under eighteen nobody naturalises on their own: a child who is a permanent
    resident becomes a citizen automatically when a parent naturalises (INA
    320), and proves it with a certificate of citizenship rather than of
    naturalisation. PUMS files both as CIT 4, so the age decides which.
    """
    if naturalized_year - birth_year < 18:
        lpr = max(birth_year, min(entry_year, naturalized_year))
        basis, category = lpr_class(pobp, lpr - birth_year, False, rng)
        return lpr, basis, category, True

    # The three-year route needs three years of marriage to a citizen, and an
    # adult spouse to have held it.
    spouse = (married and naturalized_year - birth_year >= 21
              and rng.random() < 0.2)
    wait = NATURALIZATION_WAIT_SPOUSE if spouse else NATURALIZATION_WAIT
    lpr = residence_before(entry_year, naturalized_year - wait, birth_year, rng)
    if spouse and lpr - birth_year < 18:
        spouse = False
        lpr = residence_before(entry_year, naturalized_year - NATURALIZATION_WAIT,
                               birth_year, rng)
    if spouse:
        return lpr, "immediate_relative", "IR1", False
    basis, category = lpr_class(pobp, lpr - birth_year, married, rng)
    return lpr, basis, category, False


def resident_history(birth_year, entry_year, pobp, married, rng, fixed=None):
    """(lpr_year, basis, category) for a noncitizen permanent resident.

    Drawn in the order it happened. The class comes from the age they arrived
    at; the green card follows on arrival for an immigrant visa and a few years
    later for an adjustment; and a refugee or asylee adjusts after the one year
    the statute makes them wait. A child's adjustment is kept inside the years
    their child class could still be held.
    """
    age = entry_year - birth_year
    tier = {"refugee": 0, "asylee": 1}.get(fixed)
    basis, category = lpr_class(
        pobp, age, married, rng,
        basis="refugee_asylee" if fixed else None, tier=tier)
    if basis == "refugee_asylee":
        lag = rng.randint(1, 2)
    else:
        lag = 0 if rng.random() < 0.55 else rng.randint(1, 6)
    if category in CHILD_CLASSES:
        lag = max(0, min(lag, 20 - age))
    return min(registries.REFERENCE_YEAR, entry_year + lag), basis, category


# ---- Nonimmigrant visas ---------------------------------------------------

# Nonimmigrant categories, with whether the holder is the principal — the
# student, the worker — and the longest anyone plausibly holds it. A principal
# visa is an adult's; a child here on temporary status is the H-4, F-2, J-2 or
# L-2 dependant of a parent who holds the principal one. The limits are the
# statute's where it has one (six years of H-1B, seven of L-1A, five of J-1
# research) stretched for the extensions that are routine, and a TN renews
# without limit.
VISA_CLASSES = (
    # category, weight, principal, longest tenure
    ("F-1", 30, True, 8), ("H-1B", 26, True, 15), ("J-1", 8, True, 5),
    ("L-1", 7, True, 7), ("TN", 5, True, 40), ("B-2", 6, False, 1),
    ("H-4", 12, False, 15), ("F-2", 3, False, 8), ("J-2", 2, False, 5),
    ("L-2", 3, False, 7),
)

# Students and exchange visitors are admitted for "duration of status" rather
# than to a date, so their I-94 carries D/S where everyone else's has an end.
DURATION_OF_STATUS = {"F-1", "F-2", "J-1", "J-2"}


def visa_category(age, tenure, rng):
    """A nonimmigrant category this person could hold at this age and tenure."""
    fits = [(c, w) for c, w, principal, longest in VISA_CLASSES
            if tenure <= longest and (age >= 18 or not principal)]
    if not fits:
        # Longer than any category allows. An H-1B holder whose green card is
        # pending can extend indefinitely, which is the real version of this.
        return "H-1B" if age >= 18 else "H-4"
    return rng.choices([c for c, _ in fits], weights=[w for _, w in fits])[0]


# Employment authorisation categories, 8 CFR 274a.12. The category code on an
# EAD says why the holder is allowed to work, so it has to agree with the
# status and its basis — an (a)(5) card is an asylee's and nobody else's, and
# an H-1B principal needs no EAD because the petition is the authorisation.
# Each entry is the categories and the share of holders who have one.
EAD_CATEGORIES = {
    "refugee": (("(a)(3)",), 0.9),
    "asylee": (("(a)(5)",), 0.9),
    "asylum_applicant": (("(c)(8)",), 0.85),
    "tps": (("(a)(12)", "(c)(19)"), 0.85),
    "parole": (("(c)(11)",), 0.8),
    "F-1": (("(c)(3)(B)", "(c)(3)(C)"), 0.3),
    "H-4": (("(c)(26)",), 0.45),
    "L-2": (("(a)(18)",), 0.6),
    "J-2": (("(c)(5)",), 0.4),
    # A principal on a work visa carries an EAD only once an adjustment is
    # pending, and then it is the (c)(9) that comes with the I-485.
    "H-1B": (("(c)(9)",), 0.15),
    "L-1": (("(c)(9)",), 0.15),
}

# Nobody under sixteen is issued an EAD in practice. The rule allows it for
# some categories, and nobody who is not working applies.
EAD_MINIMUM_AGE = 16

# USCIS receipt-number service-centre prefixes. Everything filed from
# Pennsylvania goes through one of these four, and the prefix on an EAD or a
# green card receipt is the first thing anyone checks.
SERVICE_CENTRES = ("SRC", "MSC", "IOE", "EAC")

# Passport number formats by region, as a template: 9 is a digit, A a letter.
# Real formats, because a Dominican passport number and a Syrian one do not
# look alike and this city holds a lot of the former.
PASSPORT_FORMATS = {
    "caribbean": ("AA9999999", "999999999"),
    "central_america": ("A99999999", "999999999"),
    "south_america": ("AA999999", "A9999999"),
    "middle_east": ("999999999", "A99999999"),
    "south_asia": ("A9999999", "AA9999999"),
    "east_asia": ("A99999999", "AA9999999"),
    "asia_other": ("A9999999", "999999999"),
    "africa": ("A9999999", "AA999999"),
    "europe": ("AA9999999", "999999999"),
    "oceania": ("A9999999",),
    "north_america": ("AA999999",),
    "us": ("999999999",),
}
LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"


def formatted(template, rng):
    """Fill a passport template: 9 becomes a digit, A a letter."""
    return "".join(
        str(rng.randint(0, 9)) if c == "9"
        else rng.choice(LETTERS) if c == "A" else c
        for c in template)


def alien_number(entry_year, rng):
    """An A-number, whose leading digits date the file.

    USCIS reached the 200-millions in the mid-2000s and the 208/209 blocks in
    the 2010s, so a recent arrival's A-number starts with a 2 and a
    long-settled resident's does not. Nine digits since the switch from seven.
    """
    if entry_year >= 2012:
        lead = rng.choice((207, 208, 209, 216, 220, 227, 231, 240))
    elif entry_year >= 2000:
        lead = rng.choice((95, 96, 97, 98, 99, 200, 201, 202, 203, 204, 205))
    else:
        lead = rng.randint(20, 94)
    return f"A{lead:03d}{rng.randrange(1_000_000):06d}"


def receipt(rng):
    """A USCIS receipt number, as printed on every notice and card."""
    return f"{rng.choice(SERVICE_CENTRES)}{rng.randrange(10 ** 10):010d}"


# A green card runs ten years and is renewed, but the status does not lapse
# with the card, and a real share of permanent residents let it run out —
# USCIS puts renewals in arrears at around one in eight.
LPR_CARD_TERM = 10
LPR_CARD_LAPSED = 0.12


def current_card(since, until, rng, lapse=True):
    """The issue year of the card held at `until`, for residence since `since`.

    The latest ten-year renewal, or occasionally the one before it when the
    holder never renewed. Dating every card from the day residence began would
    leave half the long-settled residents holding a card that expired decades
    ago.
    """
    renewals = max(0, (until - since) // LPR_CARD_TERM)
    if lapse and renewals and rng.random() < LPR_CARD_LAPSED:
        renewals -= 1
    return since + renewals * LPR_CARD_TERM


def documents(status, basis, history, citizenship, pobp, entry_year,
              naturalized_year, birth_year, rng, papers):
    """The documents a person of this status actually holds.

    Written as a list of records rather than a set of flags because that is what
    the underlying thing is — a document has a number, an issuer and an expiry,
    and half the interesting questions are about the expiry. An EAD that ran out
    in 2023 is a different fact from no EAD at all.

    `history` is the permanent residence — lpr_year, basis, category and
    whether citizenship was derived — for anyone who held it, and the visa
    category for anyone on one. `papers` is every document number already
    issued in the city: an A-number or a certificate number is one file's and
    never a second person's, so a number is passed as a draw and redrawn until
    it is free.
    """
    held = []
    today = registries.REFERENCE_YEAR

    def add(kind, draw, issued, expires=None, **extra):
        number = unique(draw, papers, f"a {kind} number")
        if issued is not None:
            issued = max(birth_year, issued)
        if expires is not None and issued is not None:
            expires = max(issued, expires)
        held.append({"document": kind, "number": number, "issued": issued,
                     "expires": expires, **extra})

    if citizenship in (BORN_US, BORN_TERRITORY):
        # No immigration documents at all, which is the majority of the city.
        # A passport is a travel document rather than a status document, and
        # roughly 45% of adults hold one.
        return held

    if citizenship == BORN_ABROAD_US_PARENT:
        # Citizens at birth, documented by a consular report rather than a
        # certificate of naturalisation. Form FS-240.
        add("consular_report_of_birth_abroad", lambda: f"FS{rng.randrange(10 ** 7):07d}",
            entry_year or None, issuer="U.S. Department of State")
        return held

    # The file is opened at first contact, which for a resident who left and
    # came back is the green card rather than the arrival the survey recorded.
    lpr_year = history.get("lpr_year")
    opened = min(entry_year, lpr_year) if lpr_year else entry_year
    add("alien_registration", lambda: alien_number(opened, rng), opened,
        issuer="U.S. Citizenship and Immigration Services")

    def green_card(issued, expires, **extra):
        add("permanent_resident_card", lambda: receipt(rng), issued, expires=expires,
            form="I-551", resident_since=lpr_year,
            category=history["category"], basis=history["basis"],
            issuer="U.S. Citizenship and Immigration Services", **extra)

    if citizenship == NATURALIZED:
        if history["derived"]:
            # N-560, applied for on an N-600 and issued to someone who became
            # a citizen by law rather than by oath.
            add("certificate_of_citizenship",
                lambda: f"{rng.randrange(10_000_000, 99_999_999)}", naturalized_year,
                form="N-560", basis="derivation",
                issuer="U.S. Citizenship and Immigration Services")
        else:
            # N-550. Its number is sequential in a national series that had
            # passed 30 million by the 2010s.
            add("certificate_of_naturalization",
                lambda: f"{rng.randrange(28_000_000, 38_000_000)}", naturalized_year,
                form="N-550", basis="naturalization",
                issuer="U.S. Citizenship and Immigration Services")
        # The green card held on the day of the oath, surrendered at it, so a
        # historical record rather than a current holding. The resident-since
        # year printed on it is what the waiting period was counted from.
        issued = current_card(lpr_year, naturalized_year, rng, lapse=False)
        green_card(min(issued, naturalized_year), issued + LPR_CARD_TERM,
                   status="surrendered")
        return held

    # Everyone below is a noncitizen, and `status` is the estimate.
    age = today - birth_year
    ead = None
    if status == "lpr":
        # I-551. The card held now is the latest renewal; the year residence
        # began is on it separately, as it is on the real card.
        issued = current_card(lpr_year, today, rng)
        green_card(issued, issued + LPR_CARD_TERM)
    elif status == "temporary":
        category = history["category"]
        # A nonimmigrant on a study or work visa. The visa foil in the passport
        # and the I-94 admission record are separate documents with separate
        # numbers, and it is the I-94 that says how long they may stay. The
        # foil only has to be valid to enter, so a current I-94 beside an
        # expired foil is ordinary; an expired I-94 would not be temporary
        # status at all but an overstay, which is a different basis.
        stamped = max(entry_year, today - rng.randint(0, 4))
        add("nonimmigrant_visa", lambda: f"{rng.randrange(10 ** 8):08d}", stamped,
            expires=stamped + (rng.choice((1, 5, 10)) if category == "B-2"
                               else rng.randint(1, 5)),
            category=category, issuer="U.S. Department of State")
        if category in DURATION_OF_STATUS:
            admitted = max(entry_year, today - rng.randint(0, 3))
            add("arrival_departure_record", lambda: f"{rng.randrange(10 ** 11):011d}",
                admitted, form="I-94", category=category,
                status="duration_of_status",
                issuer="U.S. Customs and Border Protection")
        else:
            term = 1 if category == "B-2" else rng.randint(1, 3)
            admitted = max(entry_year, today - rng.randrange(0, term))
            add("arrival_departure_record", lambda: f"{rng.randrange(10 ** 11):011d}",
                admitted, expires=max(today, admitted + term), form="I-94",
                category=category,
                issuer="U.S. Customs and Border Protection")
        if category == "F-1":
            add("sevis_record", lambda: f"N{rng.randrange(10 ** 10):010d}", entry_year,
                issuer="Student and Exchange Visitor Program")
        ead = category
    elif status == "humanitarian":
        # Refugees are admitted and parolees paroled, each with an I-94 that
        # says so. An asylee's grant comes with one too. A pending asylum claim
        # and TPS are applications rather than admissions, so what the holder
        # has is the USCIS notice.
        if basis in ("refugee", "asylee", "parole"):
            add("arrival_departure_record", lambda: f"{rng.randrange(10 ** 11):011d}",
                entry_year, expires=(max(today, entry_year + 2)
                                     if basis == "parole" else None),
                form="I-94", basis=basis,
                issuer="U.S. Customs and Border Protection")
        elif basis == "asylum_applicant":
            # Filed within the one-year deadline, and still pending.
            add("asylum_application", lambda: receipt(rng),
                min(today, entry_year + rng.randint(0, 1)), form="I-589",
                basis=basis, status="pending",
                issuer="U.S. Citizenship and Immigration Services")
        elif basis == "tps":
            # Re-registered every eighteen months or so with each extension of
            # the country's designation, so the notice held is a recent one.
            issued = max(entry_year, today - rng.randint(0, 1))
            add("tps_approval", lambda: receipt(rng), issued, expires=issued + 2,
                form="I-797", basis=basis,
                issuer="U.S. Citizenship and Immigration Services")
        ead = basis
    elif status == "none" and basis == "visa_overstay":
        # The admission that ran out, which is the one paper trail an overstay
        # leaves: a visa foil and an I-94 whose end date has passed. Mostly
        # visitors, some students who stopped studying.
        category = rng.choices(("B-2", "F-1", "J-1", "H-1B"),
                               weights=(70, 15, 8, 7))[0] if (
            entry_year - birth_year >= 18) else "B-2"
        add("nonimmigrant_visa", lambda: f"{rng.randrange(10 ** 8):08d}", entry_year,
            expires=entry_year + rng.choice((1, 5, 10)), category=category,
            issuer="U.S. Department of State")
        add("arrival_departure_record", lambda: f"{rng.randrange(10 ** 11):011d}",
            entry_year, expires=min(today - 1, entry_year + 1), form="I-94",
            category=category, status="expired",
            issuer="U.S. Customs and Border Protection")

    if ead in EAD_CATEGORIES and today - birth_year >= EAD_MINIMUM_AGE:
        categories, share = EAD_CATEGORIES[ead]
        if rng.random() < share:
            # The card a person holds now, not their first one. EADs run one to
            # five years and are renewed, so the issue date is the most recent
            # renewal — dating it from the year of entry would leave a
            # twenty-year resident holding a card that expired in 2009.
            term = rng.choice((1, 2, 2, 2, 5))
            # Renewals do lapse, and a lapsed EAD is a consequential record in
            # its own right: it is one reason someone with lawful status ends
            # up working off the books. USCIS backlogs put this in the teens.
            elapsed = rng.randrange(0, term + (2 if rng.random() < 0.16 else 0))
            issued = max(entry_year, birth_year + EAD_MINIMUM_AGE,
                         today - elapsed)
            add("employment_authorization", lambda: receipt(rng), issued,
                expires=issued + term,
                form="I-766", category=rng.choice(categories))

    # A passport from the country of birth, which most immigrants hold and
    # which is often the only photo ID someone without status has.
    if rng.random() < (0.92 if status != "none" else 0.62):
        formats = PASSPORT_FORMATS.get(region(pobp), ("A9999999",))
        # Five years for a child's passport, ten for an adult's, and the one
        # held now is recent enough to still be valid most of the time.
        term = 5 if age < 16 else 10
        issued = rng.randint(max(birth_year, today - term - 2), today)
        add("foreign_passport", lambda: formatted(rng.choice(formats), rng), issued,
            expires=issued + term, country=pobp)
    return held


def immigration(citizenship, pobp, birth_year, entry_year, naturalized_year,
                married, rng):
    """(status, basis, history) for one person.

    `basis` is the one-word answer to *on what grounds* — the visa category,
    the humanitarian kind, the green card's programme, how an unauthorised
    person entered — and `history` holds what the documents are built from.
    """
    if citizenship in (BORN_US, BORN_TERRITORY, BORN_ABROAD_US_PARENT):
        return "citizen", None, {}
    if citizenship == NATURALIZED:
        lpr, basis, category, derived = naturalized_history(
            birth_year, entry_year, naturalized_year, pobp, married, rng)
        return "naturalized", "derivation" if derived else "naturalization", {
            "lpr_year": lpr, "basis": basis, "category": category,
            "derived": derived}

    status, basis = legal_status(pobp, entry_year, rng)
    if status == "lpr":
        lpr, lpr_basis, category = resident_history(
            birth_year, entry_year, pobp, married, rng, fixed=basis)
        return status, lpr_basis, {"lpr_year": lpr, "basis": lpr_basis,
                                   "category": category}
    if status == "temporary":
        category = visa_category(registries.REFERENCE_YEAR - birth_year,
                                 registries.REFERENCE_YEAR - entry_year, rng)
        return status, category, {"category": category}
    return status, basis, {}


# ---------------------------------------------------------------------------
# Taxpayer identification
# ---------------------------------------------------------------------------

# When a US-born person's card was applied for. Enumeration at birth — SSA
# issuing the number from the birth certificate — was phased in from 1987 and
# universal by 1990. Before that a card was applied for when it was first
# needed, which for most people was a first job at 15 or 16, and for some was
# never until Medicare. That history is why an SSN's group number is a rough
# date stamp, and getting the issue year wrong would put the wrong stamp on it.
ENUMERATION_AT_BIRTH = 1990
ENUMERATION_PHASE_IN = 1987


def ssn_issue_year(birth_year, citizenship, entry_year, naturalized_year, rng):
    """The year this person's card was applied for, or None if they have none."""
    if citizenship in (BORN_US, BORN_TERRITORY, BORN_ABROAD_US_PARENT):
        if birth_year >= ENUMERATION_AT_BIRTH:
            return birth_year
        if birth_year >= ENUMERATION_PHASE_IN:
            return birth_year + rng.randrange(0, 4)
        # First job, mostly. A minority never needed one until much later.
        age = rng.choices((rng.randint(14, 18), rng.randint(19, 30),
                           rng.randint(31, 62)), weights=(70, 22, 8))[0]
        return min(birth_year + age, registries.REFERENCE_YEAR)
    if citizenship == NATURALIZED:
        # Work authorisation, and therefore a number, almost always precedes
        # naturalisation by years.
        return min(naturalized_year or entry_year, entry_year + rng.randrange(0, 4))
    return None


def taxpayer_id(person, status, citizenship, pobp, entry_year,
                naturalized_year, rng):
    """(kind, number, issue year) — an SSN, an ITIN, or nothing at all.

    Three cases, and the third is the one worth having. Citizens and lawfully
    working noncitizens get an SSN. People without work authorisation who still
    file taxes — which many do, because filing is required regardless of status
    and builds a record — get an ITIN. And some people have neither, which is
    a real condition with real consequences: no bank account, no lease in their
    own name, no credit file.
    """
    birth_year = year_of(person["birth_date"])
    issue_year = ssn_issue_year(birth_year, citizenship, entry_year,
                                naturalized_year, rng)
    if issue_year is not None:
        return "ssn", registries.ssn(pobp, issue_year, rng), issue_year

    # Noncitizen. LPRs and anyone with an EAD is eligible for an SSN.
    if status in ("lpr", "humanitarian") or (
            status == "temporary" and rng.random() < 0.82):
        issue_year = min(registries.REFERENCE_YEAR,
                         entry_year + rng.randrange(0, 3))
        # The card is applied for here, so the area number is the home
        # state's — not the birthplace's. This is the join that makes an SSN area
        # informative in the first place, and reading POBP here instead would
        # quietly claim SSA has offices in Santo Domingo.
        return "ssn", registries.ssn(registries.HOME_POBP, issue_year, rng), issue_year

    if status == "none":
        # Roughly half of unauthorised filers hold an ITIN. The rest have no
        # federal identifier, and children brought in without status have none
        # until they need to file.
        adult = person["age"] >= 18
        if adult and rng.random() < 0.52:
            return "itin", registries.itin(rng), min(
                registries.REFERENCE_YEAR, entry_year + rng.randrange(0, 6))
    return None, None, None


# ---------------------------------------------------------------------------
# Telephone
# ---------------------------------------------------------------------------

# TEL is a household question — "is telephone service available" — and it
# answers yes for 99% of households because a mobile counts. It does not say
# whether the household has a landline, which by the 2020s is a minority
# condition strongly graded by the householder's age.
LANDLINE_BY_AGE = ((35, 0.06), (50, 0.13), (65, 0.26), (75, 0.42), (200, 0.55))

# Age at which a person carries their own mobile. Not a cliff: a 10-year-old
# with a phone is common and a 6-year-old with one is not.
MOBILE_BY_AGE = ((7, 0.01), (10, 0.22), (13, 0.74), (17, 0.93),
                 (64, 0.96), (74, 0.92), (200, 0.78))

# Area codes for people who moved here from another state and kept their
# number, which is the normal thing to do since portability. Keyed on MIGSP,
# and only the origins that actually appear in the extract need entries.
MIGRANT_NPA = {
    "034": ("973", "908", "201", "862"),        # New Jersey
    "036": ("718", "917", "347", "914", "646"),  # New York
    "024": ("410", "443", "301"),               # Maryland
    "013": ("404", "678", "470"),               # Georgia
    "012": ("305", "786", "813", "407"),        # Florida
    "009": ("203", "860", "475"),               # Connecticut
    "025": ("617", "857", "508"),               # Massachusetts
    "072": ("787", "939"),                      # Puerto Rico
    "037": ("704", "980", "919"),               # North Carolina
    "051": ("703", "571", "804"),               # Virginia
    "006": ("213", "323", "310", "626"),        # California
    "048": ("214", "469", "713", "281"),        # Texas
    "039": ("216", "440", "614"),               # Ohio
    registries.HOME_POBP: None,        # moved within the home state: local number
}


def graded(table, age):
    """The first probability in `table` whose age bound `age` falls under."""
    return next(p for bound, p in table if age <= bound)


# How many times a colliding number is redrawn before the run gives up. Loud
# rather than lenient: the taxpayer-id loop above accepts a duplicate after
# eight tries because a repeated SSN is a real-world nuisance, but a repeated
# telephone number is a broken join, and reaching this bound would mean the NXX
# lists had run out of room rather than that two draws happened to agree.
PHONE_ATTEMPTS = 24


def unique(draw, taken, what):
    """Draw until the result is one nobody else holds, then claim it."""
    for _ in range(PHONE_ATTEMPTS):
        number = draw()
        if number not in taken:
            taken.add(number)
            return number
    raise SystemExit(
        f"no unused number for {what} after {PHONE_ATTEMPTS} draws "
        f"({len(taken):,} in use); widen the NXX lists in registries.py")


def telephone(person, row, rng, taken):
    """A mobile number, or None. Assignment year decides the area code.

    `taken` is every number already issued in the city, mobile and landline
    alike, and the draw retries against it. A telephone number is the key a
    call record joins on, so two people holding one is not a small blemish —
    it makes those records unresolvable. The curated NXX lists give around
    830,000 mobile numbers for 98,000 holders, so a collision is a birthday
    coincidence rather than a shortage and a handful of redraws clears it.

    What is redrawn is only the digits. Whether the person carries a phone at
    all, and the year the number was assigned, are decided once and kept —
    otherwise a collision would quietly change how many teenagers have phones.
    """
    age = person["age"]
    if rng.random() >= graded(MOBILE_BY_AGE, age):
        return None

    birth_year = year_of(person["birth_date"])
    # The number a person carries is the one they have had since they got their
    # first phone as a teenager, or since they last moved — not one issued
    # today. That is what makes an area code informative. 1996 is the floor
    # because nobody in this city has carried a mobile number for longer.
    # Clamped at the top for the children who have a phone but are not yet 13.
    first = min(max(birth_year + 13, 1996), registries.REFERENCE_YEAR)
    # Triangular rather than uniform, peaked at the year they became eligible:
    # people keep their number, so the distribution of *when a number was
    # assigned* is front-loaded, not flat. Uniform here puts more than half the
    # city on the first overlay code, which only opened in 1999.
    assigned = int(rng.triangular(first, registries.REFERENCE_YEAR, first))

    # Someone who moved in from out of state kept their old number. MIGSP is
    # the state they moved from and "N" is its not-applicable.
    origin = row.get("MIGSP", "N")
    codes = None
    if origin not in ("N", "", registries.HOME_POBP) and age >= 16:
        codes = MIGRANT_NPA.get(origin)
        if codes and rng.random() >= 0.74:
            codes = None

    def draw():
        if codes:
            return f"({rng.choice(codes)}) {rng.randint(200, 999)}-" \
                   f"{rng.randint(0, 9999):04d}"
        return registries.phone(assigned, rng)

    return unique(draw, taken, f"a mobile for person {person['id']}")


# ---------------------------------------------------------------------------
# Marital status
# ---------------------------------------------------------------------------

# MAR codes. 5 is never married and carries the MARHYP sentinel.
MARITAL = {1: "married", 2: "widowed", 3: "divorced", 4: "separated",
           5: "never_married"}


def marital(row, shift):
    """Current marital status and history, as far as PUMS records it.

    MARHT counts times married and MARHYP is the year of the most recent
    marriage — both surveyed, both useful, and MARHYP carrying the 1943
    sentinel on the never-married. It is moved by `shift` like every other
    reported year (see survey_shift), or a respondent interviewed in 2019 who
    married at twenty would be married here at thirteen. MARHD/MARHM/MARHW flag
    a divorce, marriage or widowhood inside the last twelve months, which is
    what makes the recent-events part of the docket ledger land on real dates.
    """
    status = MARITAL.get(int(row["MAR"]), "never_married")
    times = int(row.get("MARHT") or 0)
    year = int(row.get("MARHYP") or 0)
    record = {
        "status": status,
        "times_married": times or None,
        "married_year": None if year in (0, MARHYP_NA) else min(
            registries.REFERENCE_YEAR, year + shift),
        # 1 is yes, 2 is no, 0 is not applicable.
        "married_last_year": row.get("MARHM") == "1",
        "divorced_last_year": row.get("MARHD") == "1",
        "widowed_last_year": row.get("MARHW") == "1",
    }
    # MARHT is asked only of people who have ever been married, and a couple of
    # rows come back married with no count. One is the safe reading.
    if status != "never_married" and not record["times_married"]:
        record["times_married"] = 1
    return record


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def build(population, survey, kinship, seed):
    """One identity record per person, keyed by person id."""
    namer = names.Namer()
    out = {}

    # Taxpayer numbers are drawn from a constrained space rather than allocated
    # from a series, so 125,000 draws collide a few dozen times. SSA never
    # issues the same number twice and anything joining on one has to be able
    # to assume that, so a collision is redrawn. Kept here rather than inside
    # registries because uniqueness is a property of this population, not of
    # the format.
    taken = set()

    # And the same for telephone numbers, for a stronger reason: a number is
    # what a call record joins on, and a landline shared by a household is
    # already a deliberate many-to-one. Mobiles and landlines share the one set
    # — the NXX lists keep the two kinds apart, but a carrier does not issue a
    # number twice because it happens to look wireless.
    dialled = set()

    # And document numbers, across every kind at once: USCIS and State number
    # from series, and an A-number drawn from the recent 208/209 blocks is a
    # small enough space for a few thousand arrivals to collide in.
    papers = set()

    members = {}
    for person in population["person_records"]:
        members.setdefault(person["household"], []).append(person)

    # Names are assigned down the kin graph, because a surname is a fact about
    # descent and only secondarily about an address. Birth dates come first:
    # the given-name draw is conditioned on birth year, so it has to exist
    # before names run.
    for person in population["person_records"] + population["quarters_records"]:
        rng = keyed(seed, person["id"], "birth")
        row = survey[(person["serialno"], person["sporder"])]
        quarter = int(row.get("QTRBIR") or 0)
        person["birth_date"] = birth_date(person["age"], quarter, rng)
        person["birth_year"] = year_of(person["birth_date"])

    # The external parents get named alongside everybody else and for the same
    # reason: a mother who died in 1994 is still where her children's surname
    # came from, and a stub without a name transmits nothing. They are held
    # apart from the residents afterwards — no identifiers, no documents, and
    # nothing in this file's per-person outputs.
    parents = {int(k): v for k, v in kinship["parents"].items()}
    externals = {stub["id"]: dict(stub) for stub in kinship["externals"]}
    universe = {p["id"]: p for p in population["person_records"]
                + population["quarters_records"]}
    universe.update(externals)

    names.assign_descent(universe, parents, namer, seed, keyed)
    names.assign_partners(universe, kinship["partners"], seed, keyed)
    # Last, and only for what descent and marriage left over: the lodger and
    # the cousin who go by the household's name without having inherited it.
    for household_id, people in members.items():
        names.assign_household(people, parents, seed, keyed)

    # One landline per household, shared by its members.
    landlines = {}
    for household_id, people in members.items():
        row = survey[(people[0]["serialno"], people[0]["sporder"])]
        head = max(people, key=lambda p: p["age"])
        rng = keyed(seed, household_id, "landline")
        has_service = row.get("TEL") == "1"
        if has_service and rng.random() < graded(LANDLINE_BY_AGE, head["age"]):
            # A household landline predates every mobile in the house and
            # almost always sits on the original area code.
            assigned = rng.randint(1985, 2015)
            landlines[household_id] = unique(
                lambda: registries.phone(assigned, rng, wireless=False),
                dialled, f"a landline for household {household_id}")

    for person in population["person_records"] + population["quarters_records"]:
        row = survey[(person["serialno"], person["sporder"])]
        rng = keyed(seed, person["id"], "identity")

        citizenship = row["CIT"]
        pobp = row["POBP"].zfill(3)

        # Guarded: YOEP is 1937 for everyone born in the US and CITWP is 1946
        # for everyone who was not naturalised. Both read as real years. What
        # survives the guard is an interview-year calendar year, moved to this
        # city's calendar by the respondent's own survey year.
        shift = survey_shift(person["serialno"])
        birth_year = person["birth_year"]
        entry = int(row.get("YOEP") or 0)
        entry_year = None if entry in (0, YOEP_NA) else entry + shift
        naturalized = int(row.get("CITWP") or 0)
        naturalized_year = (None if naturalized in (0, CITWP_NA)
                            else naturalized + shift)
        # The survey's birth year and this one's are drawn separately from the
        # same quarter, so an arrival in the year of birth can land a year
        # early. Nobody arrives or naturalises before being born.
        if entry_year is not None:
            entry_year = min(registries.REFERENCE_YEAR,
                             max(birth_year, entry_year))
        if naturalized_year is not None:
            naturalized_year = min(registries.REFERENCE_YEAR,
                                   max(birth_year, naturalized_year))

        # A foreign-born person with the sentinel in YOEP has no recorded entry
        # year, which happens. Their birth year is the floor.
        if citizenship in (NATURALIZED, NONCITIZEN) and entry_year is None:
            entry_year = rng.randint(birth_year, registries.REFERENCE_YEAR)
        # CITWP is missing on a handful of naturalised rows. Naturalisation
        # comes at least five years after arrival, or at the latest now.
        if citizenship == NATURALIZED and naturalized_year is None:
            naturalized_year = min(registries.REFERENCE_YEAR, entry_year
                                   + NATURALIZATION_WAIT + rng.randint(0, 6))

        # Its own stream, so that the immigration history can be redrawn
        # without moving anybody's SSN or telephone number.
        migration = keyed(seed, person["id"], "immigration")
        status, basis, history = immigration(
            citizenship, pobp, birth_year, entry_year, naturalized_year,
            int(row["MAR"]) != 5, migration)

        for attempt in range(8):
            kind, number, issued = taxpayer_id(
                person, status, citizenship, pobp,
                entry_year or person["birth_year"], naturalized_year, rng)
            if number is None or number not in taken:
                break
        if number:
            taken.add(number)

        record = {
            "first_name": person["first_name"],
            "middle_name": person["middle_name"],
            "surname": person["surname"],
            "surname_paternal": person["surname_paternal"],
            "surname_maternal": person["surname_maternal"],
            # The line they were born into, which is the name they pass on and
            # not always the one they go by. For most people the two agree; for
            # a married woman or a stepchild they do not, and a record that
            # holds both is what makes a maiden name recoverable.
            "line_paternal": person["line_paternal"],
            "line_maternal": person["line_maternal"],
            "naming_group": person["naming_group"],
            "birth_date": person["birth_date"],
            "taxpayer_id_kind": kind,
            "taxpayer_id": number,
            "taxpayer_id_issued": issued,
            "citizenship": {
                BORN_US: "born_us", BORN_TERRITORY: "born_territory",
                BORN_ABROAD_US_PARENT: "born_abroad_us_parent",
                NATURALIZED: "naturalized", NONCITIZEN: "noncitizen",
            }[citizenship],
            "birthplace": pobp,
            "birth_region": region(pobp),
            "entry_year": entry_year,
            "naturalized_year": naturalized_year,
            # An estimate, not a survey response. Named so nothing downstream
            # mistakes it for one.
            "legal_status": status,
            "legal_status_source": (
                "estimated" if citizenship == NONCITIZEN else "acs"),
            # What the status rests on: the green card's programme, the visa
            # category, the humanitarian kind, how an unauthorised person
            # entered, or whether citizenship came by oath or by derivation.
            "status_basis": basis,
            "documents": documents(status, basis, history, citizenship, pobp,
                                   entry_year, naturalized_year, birth_year,
                                   migration, papers),
            "mobile": telephone(person, row, rng, dialled),
            "landline": landlines.get(person.get("household")),
            "marital": marital(row, shift),
        }
        out[person["id"]] = record

    # A name and a birth year, and deliberately nothing else. An external
    # parent is somebody a resident's record refers to, not somebody the city
    # holds a file on.
    absent = {
        stub["id"]: {
            "first_name": stub["first_name"],
            "middle_name": stub["middle_name"],
            "surname": stub["surname"],
            "surname_paternal": stub["surname_paternal"],
            "surname_maternal": stub["surname_maternal"],
            "line_paternal": stub["line_paternal"],
            "line_maternal": stub["line_maternal"],
            "naming_group": stub["naming_group"],
            "birth_year": stub["birth_year"],
            "sex": stub["sex"],
            "status": stub["status"],
        }
        for stub in externals.values()
    }
    return out, absent


def report(identities, population):
    """Everything worth failing a build over, printed."""
    total = len(identities)
    print(f"{total:,} identity records\n")

    print("citizenship:")
    counts = Counter(r["citizenship"] for r in identities.values())
    width = max(len(k) for k in counts)
    for label, count in counts.most_common():
        print(f"  {label:<{width}}  {count:>7,}  {count / total * 100:5.1f}%")
    # Two different marginals get called "US-born" and they differ by ten
    # points, so both are printed. ACS "native" counts anyone born a citizen,
    # including in Puerto Rico; "citizen" adds the naturalised. Neither is
    # something this stage sets — CIT is surveyed and the extract fixes both —
    # so these lines check the extract, not this file. The 87% target given for
    # the reference city matches the citizen share, not the native one; published ACS
    # foreign-born for the city is ~20%, which is the native line below.
    noncitizen = counts.get("noncitizen", 0)
    native = total - noncitizen - counts.get("naturalized", 0)
    print(f"  {'native':<{width}}  {native:>7,}  "
          f"{native / total * 100:5.1f}%   ACS foreign-born ~20%")
    print(f"  {'citizen':<{width}}  {total - noncitizen:>7,}  "
          f"{(total - noncitizen) / total * 100:5.1f}%   target 87%")

    print("\nlegal status of noncitizens (estimated, not surveyed):")
    noncitizens = [r for r in identities.values()
                   if r["citizenship"] == "noncitizen"]
    counts = Counter(r["legal_status"] for r in noncitizens)
    for label, count in counts.most_common():
        print(f"  {label:<{width}}  {count:>7,}  "
              f"{count / max(1, len(noncitizens)) * 100:5.1f}%")

    print("\ntaxpayer identification:")
    counts = Counter(r["taxpayer_id_kind"] for r in identities.values())
    for label, count in counts.most_common():
        print(f"  {str(label):<{width}}  {count:>7,}  "
              f"{count / total * 100:5.1f}%")

    # An SSN whose area does not match its holder's birthplace is not an error
    # — post-2011 cards are random and foreign-born people are enumerated here
    # — but the share that do match is the check that the join works at all.
    home = registries.HOME_POBP
    home_ranges = registries.SSN_AREAS[home]
    pa = [r for r in identities.values()
          if r["taxpayer_id_kind"] == "ssn" and r["birthplace"] == home
          and r["taxpayer_id_issued"] < registries.RANDOMIZATION_YEAR]
    in_range = sum(1 for r in pa
                   if any(low <= int(r["taxpayer_id"][:3]) <= high
                          for low, high in home_ranges))
    spans = ", ".join(f"{low:03d}-{high:03d}" for low, high in home_ranges)
    print(f"\nhome-state-born, pre-2011 card: {in_range:,} of {len(pa):,} "
          f"({in_range / max(1, len(pa)) * 100:.1f}%) in the home area range "
          f"{spans}")
    pr = [r for r in identities.values()
          if r["taxpayer_id_kind"] == "ssn" and r["birthplace"] == "072"
          and r["taxpayer_id_issued"] < registries.RANDOMIZATION_YEAR]
    pr_range = sum(1 for r in pr
                   if 580 <= int(r["taxpayer_id"][:3]) <= 584
                   or 596 <= int(r["taxpayer_id"][:3]) <= 599
                   or 667 <= int(r["taxpayer_id"][:3]) <= 675)
    print(f"PR-born, pre-2011 card: {pr_range:,} of {len(pr):,} "
          f"({pr_range / max(1, len(pr)) * 100:.1f}%) in a PR area range")

    # Numbers here are drawn, not allocated from a series, so two people can
    # collide. At 125,000 draws from a nine-digit space with a constrained area
    # this is a handful, and it is worth printing rather than assuming: a
    # duplicate SSN would break any join that treats it as a key.
    numbers = [r["taxpayer_id"] for r in identities.values() if r["taxpayer_id"]]
    print(f"{len(numbers):,} numbers issued, "
          f"{len(numbers) - len(set(numbers)):,} collisions")

    print("\ntelephone:")
    mobile = sum(1 for r in identities.values() if r["mobile"])
    landline = sum(1 for r in identities.values() if r["landline"])
    print(f"  mobile     {mobile:>7,}  {mobile / total * 100:5.1f}%")
    print(f"  landline   {landline:>7,}  {landline / total * 100:5.1f}% "
          f"of people are in a household with one")
    # The same collision count as the taxpayer ids get, and for a harder
    # requirement: a duplicate number makes a call record unresolvable, so this
    # line has to read zero rather than a handful.
    dialled = [r["mobile"] for r in identities.values() if r["mobile"]]
    dialled += list({r["landline"] for r in identities.values() if r["landline"]})
    print(f"  {len(dialled):,} numbers in service, "
          f"{len(dialled) - len(set(dialled)):,} collisions")
    npa = Counter(r["mobile"][1:4] for r in identities.values() if r["mobile"])
    print("  area codes: " + ", ".join(
        f"{code} {count / mobile * 100:.1f}%"
        for code, count in npa.most_common(6)))

    print("\nimmigration documents held:")
    kinds = Counter(d["document"] for r in identities.values()
                    for d in r["documents"])
    width = max(len(k) for k in kinds) if kinds else 10
    for label, count in kinds.most_common():
        print(f"  {label:<{width}}  {count:>7,}")

    # Expiry is the point of holding documents as records. A lapsed EAD is a
    # different person, legally, from one with a current card.
    lapsed = sum(1 for r in identities.values() for d in r["documents"]
                 if d["document"] == "employment_authorization"
                 and d["expires"] and d["expires"] < registries.REFERENCE_YEAR)
    current = sum(1 for r in identities.values() for d in r["documents"]
                  if d["document"] == "employment_authorization"
                  and d["expires"] and d["expires"] >= registries.REFERENCE_YEAR)
    print(f"  of which employment authorization: {current:,} current, "
          f"{lapsed:,} expired")

    print("\nstatus basis:")
    for status in ("naturalized", "lpr", "temporary", "humanitarian", "none"):
        counts = Counter(r["status_basis"] for r in identities.values()
                         if r["legal_status"] == status)
        print(f"  {status:<13}" + ", ".join(
            f"{basis} {count:,}" for basis, count in counts.most_common(6)))

    # The timeline has to be one a person could have lived. Every line below
    # should read zero; each is a rule the statute or the calendar sets.
    print("\nimmigration timeline (all should be 0):")
    broken = Counter()
    young = 0
    for r in identities.values():
        born = year_of(r["birth_date"])
        age = registries.REFERENCE_YEAR - born
        if r["entry_year"] and r["entry_year"] < born:
            broken["entered before birth"] += 1
        if r["naturalized_year"] and r["naturalized_year"] < born:
            broken["naturalised before birth"] += 1
        if (r["marital"]["married_year"]
                and r["marital"]["married_year"] - born < 15):
            young += 1
        docs = {d["document"]: d for d in r["documents"]}
        card = docs.get("permanent_resident_card")
        if r["citizenship"] == "naturalized":
            nat = r["naturalized_year"]
            if nat - born < 18 and "certificate_of_naturalization" in docs:
                broken["naturalised by oath under 18"] += 1
            if nat - born >= 18 and card:
                wait = (NATURALIZATION_WAIT_SPOUSE if card["category"] == "IR1"
                        else NATURALIZATION_WAIT)
                if nat - card["resident_since"] < wait:
                    broken["naturalised inside the waiting period"] += 1
            if card and card["resident_since"] > nat:
                broken["green card after naturalisation"] += 1
        if card and not (card.get("basis") and card.get("category")):
            broken["green card without a class of admission"] += 1
        if card and card["category"] in CHILD_CLASSES and (
                card["resident_since"] - born >= 21):
            broken["child class held as an adult"] += 1
        visa = docs.get("nonimmigrant_visa")
        principal = {c for c, _, p, _ in VISA_CLASSES if p}
        if (r["legal_status"] == "temporary" and visa
                and visa["category"] in principal and age < 18):
            broken["principal visa held by a minor"] += 1
        ead = docs.get("employment_authorization")
        if ead and ead["issued"] - born < EAD_MINIMUM_AGE:
            broken["EAD issued under 16"] += 1
        i94 = docs.get("arrival_departure_record")
        if (r["legal_status"] == "temporary" and i94 and i94["expires"]
                and i94["expires"] < registries.REFERENCE_YEAR):
            broken["temporary status on an expired I-94"] += 1
        if r["legal_status"] == "humanitarian" and r["status_basis"] in (
                "refugee", "asylee") and (registries.REFERENCE_YEAR
                                          - r["entry_year"] > 3):
            broken["refugee or asylee past adjustment"] += 1
        if r["legal_status"] not in ("citizen", None) and not r["status_basis"]:
            broken["status without a basis"] += 1
    for label in ("entered before birth", "naturalised before birth",
                  "naturalised by oath under 18",
                  "naturalised inside the waiting period",
                  "green card after naturalisation",
                  "green card without a class of admission",
                  "child class held as an adult",
                  "principal visa held by a minor", "EAD issued under 16",
                  "temporary status on an expired I-94",
                  "refugee or asylee past adjustment",
                  "status without a basis"):
        print(f"  {label:<40} {broken[label]:>6,}")
    # Not a rule: MARHYP does record a few marriages at thirteen and fourteen,
    # and they are the respondents' own answers. Before the survey years were
    # shifted this line read over six thousand.
    print(f"  last married before 15, as surveyed: {young:,}")
    cards = [d for r in identities.values() if r["legal_status"] == "lpr"
             for d in r["documents"] if d["document"] == "permanent_resident_card"]
    expired = sum(1 for d in cards if d["expires"] < registries.REFERENCE_YEAR)
    print(f"  LPR cards past expiry (unrenewed, expected ~{LPR_CARD_LAPSED:.0%} "
          f"of those due): {expired:,} of {len(cards):,}")

    print("\nmarital status:")
    # Among 15 and over, which is who MAR is asked of. Reported over everyone
    # it just measures the child share.
    adults = [r for r in identities.values() if r["marital"]["status"]
              and registries.REFERENCE_YEAR - year_of(r["birth_date"]) >= 15]
    counts = Counter(r["marital"]["status"] for r in adults)
    width = max(len(k) for k in counts)
    for label, count in counts.most_common():
        print(f"  {label:<{width}}  {count:>7,}  "
              f"{count / len(adults) * 100:5.1f}% of the 15+ population")

    print("\nbirth dates by quarter (QTRBIR, should be near even):")
    quarters = Counter((int(r["birth_date"][5:7]) - 1) // 3 + 1
                       for r in identities.values())
    for quarter in sorted(quarters):
        print(f"  Q{quarter}  {quarters[quarter]:>7,}  "
              f"{quarters[quarter] / total * 100:5.1f}%")

    # Ages must survive the round trip. A birth date that gives back a
    # different age than the population record would break every age gate
    # downstream, silently.
    people = {p["id"]: p for p in population["person_records"]
              + population["quarters_records"]}
    year, month, day = TODAY
    wrong = 0
    for person_id, record in identities.items():
        born = record["birth_date"]
        age = year - int(born[:4]) - (
            (month, day) < (int(born[5:7]), int(born[8:10])))
        if age != people[person_id]["age"]:
            wrong += 1
    print(f"\nage round-trip: {wrong:,} of {total:,} birth dates disagree "
          f"with the population record's age")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()

    population = json.loads(POPULATION.read_text())
    survey = pums.rows_by_person()
    kinship = json.loads(KINSHIP.read_text())

    identities, absent = build(population, survey, kinship, args.seed)

    OUTPUT.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": registries.REFERENCE_YEAR,
        "today": "%04d-%02d-%02d" % TODAY,
        "persons": len(identities),
        "absent_parents": absent,
        # Which fields are survey responses and which are modelled. Anything
        # validating this data against ACS needs to know not to expect the
        # second group to match anything.
        "surveyed": ["birth_date", "citizenship", "birthplace", "entry_year",
                     "naturalized_year", "marital"],
        "modelled": ["first_name", "middle_name", "surname", "line_paternal",
                     "line_maternal", "taxpayer_id", "legal_status",
                     "status_basis", "documents", "mobile", "landline"],
        "identities": identities,
    }, separators=(",", ":")))

    report(identities, population)
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
