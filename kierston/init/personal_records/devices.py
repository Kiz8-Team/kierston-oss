"""Assign a handset and subscription to every resident with a mobile number.

identity.py already hands out phone numbers, and for a while that was enough:
a number is what a call record joins on and a person is who a number belongs
to. It stops being enough the moment anything downstream wants to model the
*device*. A number is a subscription, not a thing in a pocket. It is ported
between carriers, it survives four handsets, it can be lifted onto a new SIM by
anyone who can talk a shop into it — and none of that is expressible while the
only endpoint the city has is a string of ten digits.

So this stage makes both of them objects, and writes them as two tables.

    HANDSET       the hardware. IMEI, TAC, make, model, tier, release year, the
                  OS it is running, when it was acquired and in what condition,
                  whether it takes a SIM card or has the chip soldered in, and
                  that chip's EID.
    SUBSCRIPTION  the relationship with a carrier. MSISDN, IMSI, ICCID, who the
                  carrier is and whose network actually carries it, prepaid or
                  postpaid, whose name the account is in, who uses it — and a
                  reference to the handset the SIM is currently sitting in.

Splitting them is not tidiness. A call detail record keys on the subscription
and reports the handset alongside it, so the two are what a CDR *is*; and the
relationship between them is neither one-to-one nor stable. A dual-SIM phone is
two subscriptions in one handset and cannot be written down at all if the
number is a field on the device. A SIM moved into a different phone is one
subscription and two handsets. Both are ordinary, and both become expressible
by putting the reference on the subscription rather than the number on the
device.

The EID stays with the handset while the ICCID moves to the subscription, and
that is the split working rather than an inconsistency: the eUICC is soldered
to the board and outlives every profile written to it, so a phone taken through
three carriers has three ICCIDs and one EID.

Between them they carry the identifiers that actually distinguish a phone from
a subscription from a SIM card:

    IMEI    the handset. Burned into the radio at the factory, unchanged by a
            new SIM, and the thing a network sees whether or not a subscriber
            is on it.
    IMSI    the subscription. Lives on the SIM, identifies the subscriber to
            the network, and carries the *host* network's MNC — which for an
            MVNO customer is not the company they pay.
    ICCID   the SIM card itself. A serial number for a piece of plastic (or,
            increasingly, for a profile downloaded onto a chip that is soldered
            down), issued by whoever printed it.

Those three are different objects with different lifetimes, and a model that
collapses them into one "phone id" cannot answer the questions this benchmark
exists to pose — the same IMEI turning up under a second IMSI, or one ICCID
moving between two handsets, are the shapes of an actual investigation.

Everything here is modelled. ACS asks whether a household has telephone
service (TEL) and stops; no survey in the extract knows what anyone's phone
*is*. So every distribution below is sourced from published market figures
where one exists and stated as an estimate where it does not, and the ones
resting on nothing better than a plausible shape are named in NOTICES.md.

One handset and one subscription per person, for now
----------------------------------------------------
Everyone who has a `mobile` in identity.json gets exactly one of each, and
nobody else gets any. That is a simplification and a temporary one — a person
with a work phone and a personal phone is ordinary, and a burner is the whole
point of a burner — so nothing here is written as though it were permanent.
The output maps a person to a *list* of each, the packer hangs both lists off
identity as child tables, and adding a second phone or a second line to
somebody later changes a count and not a format.

What this layer deliberately does not model is *change over time*. There is no
retired handset, no previous SIM, no date a number moved between phones. A
subscription names the handset it is in now and that is the whole of it. The
split exists so that dual-SIM and a moved SIM are expressible as shapes, not so
that the city carries a device history it has no use for yet.

Landlines are deliberately left where they are. A landline is already an
endpoint with a number, no IMEI, no IMSI, and a many-to-one relationship to a
household, which is exactly what identity.py records. Giving it a row here
would mean inventing hardware identifiers for a thing that has none.

What the identifiers have to survive
------------------------------------
Structural correctness is the entire value of this layer, because anything
under test will validate and join on these. So:

  * The IMEI's check digit is Luhn-computed, not drawn, and its TAC is a
    **real GSMA allocation** for the model the record claims, read from
    reference/tac_table.json. That is deliberate and it is the opposite of the
    caution identity.py applies to phone numbers: a phone number is dialable
    and reaches a real person, while a TAC names a model and nobody at all.
    Tooling under test resolves TAC to make and model against public
    databases, so a TAC that resolved to nothing would fail that lookup and
    mark every handset in the city as synthetic before any other question got
    asked. Colliding with the real allocation is the point.
  * The IMSI's MNC is the host network's, which for an MVNO subscriber is not
    the carrier on the bill. That asymmetry is modelled explicitly with two
    fields rather than being smoothed away.
  * The ICCID is Luhn-checked and carries the issuer identifier of whoever
    issued the SIM, which is again the host network and not the reseller.
  * The eSIM's EID carries its own two-digit mod-97 checksum.

And each of the three is unique across the city, drawn with the retry loop
identity.py uses for phone numbers and for the same reason: a duplicate is not
a blemish, it is a join that silently resolves to the wrong person. As there,
a retry redraws only the digits — the platform, the model, the carrier and the
plan are decided once and kept, because a collision that reshuffled them would
quietly move the distributions this file exists to get right.
"""

import argparse
import json
import math
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import registries  # noqa: E402
from registries import keyed  # noqa: E402


from paths import SIM_DATA  # noqa: E402
POPULATION = SIM_DATA / "population.json"
IDENTITY = SIM_DATA / "identity.json"
KINSHIP = SIM_DATA / "kinship.json"
OUTPUT = SIM_DATA / "devices.json"

DEFAULT_SEED = 20260728

# Simulation "now", the same date identity.py works against. Every acquisition
# date is measured back from here and every "current OS version" is what was
# current on it.
TODAY = registries.REFERENCE_DATE


# ---------------------------------------------------------------------------
# Check digits
# ---------------------------------------------------------------------------

def luhn(digits):
    """The Luhn check digit that completes `digits`.

    The IMEI and the ICCID both end in one, and both are routinely validated by
    anything that handles them — which is the reason to compute the digit
    rather than draw it. A drawn check digit is wrong nine times in ten, and a
    fifteen-digit number that fails Luhn is not an IMEI, it is a typo.

    Doubling runs over every second digit counting from the right of the
    *completed* number. The check digit is not appended yet, so that is every
    even index from the right of what is passed in.
    """
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 0:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return str(-total % 10)


def eid_check(digits):
    """The two check digits that complete a 30-digit EID, GSMA SGP.02 style.

    Not Luhn — the eUICC identifier borrows the IBAN scheme: append "00", take
    the remainder mod 97, and the checksum is 98 minus it, which makes the
    finished 32-digit number congruent to 1 mod 97. `report` verifies that,
    because a checksum implemented from memory is worth checking against its
    own definition rather than trusted.
    """
    return f"{98 - (int(digits + '00') % 97):02d}"


# ---------------------------------------------------------------------------
# Handsets: the model catalogue, and the TACs that identify them
# ---------------------------------------------------------------------------

# Brand share of the US Android installed base — Samsung takes something close
# to three fifths of it, Motorola is the clear second on the strength of the
# prepaid channel, and the rest are small. LG is in the table despite having
# left the phone business in 2021, because people did not throw their phones
# away when it did; its models are all pre-2021 and it therefore only ever
# turns up as an old handset, which is the correct answer.
BRAND_SHARE = {
    "Samsung": 58, "Motorola": 14, "Google": 7, "TCL": 5, "LG": 4,
    "OnePlus": 3, "Nokia": 3,
}

# The catalogue: make, model, price tier. Tier drives who buys it — the budget
# rows are where the bottom income band lives and the flagship rows are where
# it does not.
#
# The release year is deliberately *not* here. It comes from the TAC table
# below, which is built from real allocations and states the year the source
# database records for each variant. Writing it out twice invited exactly the
# disagreement it eventually produced: a catalogue that dated the Galaxy A16 to
# 2025 against an allocation dated 2024 would sell somebody a handset months
# before its IMEI could exist. One source of truth, and it is the one with
# evidence behind it.
#
# Deliberately not exhaustive. Sixty-odd models covering nine years and three
# price tiers reproduce the *shape* of what a city carries; a full catalogue
# would add rows without adding structure. Models are dropped rather than
# guessed at when the TAC database cannot name them — see NOTICES.md for the
# handful that went that way.
CATALOGUE = (
    # Apple. The SE and the 16e are Apple's budget line, the Pro models its
    # flagship, and the plain numbered phone is the volume seller.
    ("Apple", "iPhone 8", "mid"),
    ("Apple", "iPhone XR", "mid"),
    ("Apple", "iPhone 11", "mid"),
    ("Apple", "iPhone SE (2nd generation)", "budget"),
    ("Apple", "iPhone 12", "mid"),
    ("Apple", "iPhone 13", "mid"),
    ("Apple", "iPhone 13 Pro", "flagship"),
    ("Apple", "iPhone SE (3rd generation)", "budget"),
    ("Apple", "iPhone 14", "mid"),
    ("Apple", "iPhone 14 Pro", "flagship"),
    ("Apple", "iPhone 15", "mid"),
    ("Apple", "iPhone 15 Pro", "flagship"),
    ("Apple", "iPhone 16", "mid"),
    ("Apple", "iPhone 16 Pro", "flagship"),
    ("Apple", "iPhone 16e", "budget"),
    ("Apple", "iPhone 17", "mid"),
    ("Apple", "iPhone 17 Pro", "flagship"),

    # Samsung. The A series is most of the volume and nearly all of the prepaid
    # channel; the S series is the flagship. The oldest rows are here because
    # the catalogue has to reach back as far as the oldest handset anybody
    # still carries — a nine-year-old phone is rare and not absent, and a
    # catalogue that started in 2021 would quietly forbid one.
    ("Samsung", "Galaxy S8", "flagship"),
    ("Samsung", "Galaxy S9", "flagship"),
    ("Samsung", "Galaxy A10e", "budget"),
    ("Samsung", "Galaxy A20", "budget"),
    ("Samsung", "Galaxy S10", "flagship"),
    ("Samsung", "Galaxy A03s", "budget"),
    ("Samsung", "Galaxy A13 5G", "budget"),
    ("Samsung", "Galaxy A14 5G", "budget"),
    ("Samsung", "Galaxy A15 5G", "budget"),
    ("Samsung", "Galaxy A16 5G", "budget"),
    ("Samsung", "Galaxy A53 5G", "mid"),
    ("Samsung", "Galaxy A54 5G", "mid"),
    ("Samsung", "Galaxy A55 5G", "mid"),
    ("Samsung", "Galaxy S21 5G", "flagship"),
    ("Samsung", "Galaxy S22", "flagship"),
    ("Samsung", "Galaxy S23", "flagship"),
    ("Samsung", "Galaxy S24", "flagship"),
    ("Samsung", "Galaxy S25", "flagship"),

    # Motorola. Almost entirely the moto g and moto e lines, which are the
    # phones the prepaid carriers put on the wall behind the counter.
    ("Motorola", "moto e4", "budget"),
    ("Motorola", "moto e5 play", "budget"),
    ("Motorola", "moto g7", "mid"),
    ("Motorola", "moto g pure", "budget"),
    ("Motorola", "moto g play (2023)", "budget"),
    ("Motorola", "moto g play (2024)", "budget"),
    ("Motorola", "moto g stylus (2023)", "mid"),
    ("Motorola", "moto g 5G (2024)", "mid"),
    ("Motorola", "moto g power (2025)", "mid"),
    ("Motorola", "edge (2024)", "flagship"),

    # Google. Small share, long software support, and an a-series that sells
    # into the middle rather than the bottom — which is why no Pixel ever turns
    # up in the lowest income band.
    ("Google", "Pixel 6a", "mid"),
    ("Google", "Pixel 7", "flagship"),
    ("Google", "Pixel 7a", "mid"),
    ("Google", "Pixel 8", "flagship"),
    ("Google", "Pixel 8a", "mid"),
    ("Google", "Pixel 9", "flagship"),
    ("Google", "Pixel 9a", "mid"),
    ("Google", "Pixel 10", "flagship"),

    ("OnePlus", "Nord N30", "budget"),
    ("OnePlus", "OnePlus 12", "flagship"),
    ("OnePlus", "OnePlus 13", "flagship"),

    ("TCL", "TCL 30 XE 5G", "budget"),
    ("TCL", "TCL 40 XE 5G", "budget"),
    ("TCL", "TCL 50 XE 5G", "budget"),

    ("Nokia", "Nokia G300", "budget"),
    ("Nokia", "Nokia G400 5G", "budget"),

    # LG left the phone business in 2021. These stay in circulation for years
    # afterwards and are here for exactly that reason: a city where every
    # handset comes from a company that still exists is a city with no history.
    ("LG", "LG K51", "budget"),
    ("LG", "LG Stylo 6", "budget"),
    ("LG", "LG Velvet 5G", "mid"),
)

# --- The TAC table -------------------------------------------------------
# A TAC is the first eight digits of an IMEI and it names the make and model of
# the handset. These are real GSMA allocations, cut down to this catalogue by
# reference/build/build_tac_table.py from a public bulk mirror of the TAC
# database, and checked into data/ rather than fetched at runtime — the same
# arrangement reference/vehicle_market.json has.
#
# Real, and not invented, because the tooling this city exists to exercise
# resolves a TAC against exactly such a database to answer "what handset is
# this". An invented TAC resolves to nothing, which does not merely lose the
# answer — it announces that the record is synthetic. And there is nothing to
# protect anybody from: a TAC identifies a *model*, so the six-digit serial
# after it is what makes a handset unique, and a real iPhone 15 TAC on a
# synthetic iPhone 15 is a true statement about a phone nobody owns.
#
# Each model keeps up to eight of its allocations, US market variants first,
# because a real model has one TAC per hardware variant and region and a whole
# city reporting a single allocation of one popular handset would be the tell.
from paths import TAC_TABLE  # noqa: E402


def catalogue():
    """Join the model catalogue to its TAC allocations, or refuse to run.

    Loud rather than lenient, in both directions. A catalogue entry the table
    cannot name is a handset with no IMEI, and a release year outside the OS
    tables is a handset with no plausible software — either one would surface
    as a KeyError several hundred lines below, on one person in a hundred
    thousand, long after the cause had scrolled past.
    """
    table = json.loads(TAC_TABLE.read_text())
    models, tacs = [], []
    for make, model, tier in CATALOGUE:
        entry = table["models"].get(f"{make}|{model}")
        if entry is None:
            raise SystemExit(
                f"{make} {model} has no TAC allocation in {TAC_TABLE.name} — "
                f"add it to CATALOGUE in reference/build/build_tac_table.py and "
                f"rebuild, or drop the model")
        models.append((make, model, entry["released"], tier))
        tacs.append(tuple(entry["tacs"]))
    return tuple(models), tuple(tacs), table


MODELS, MODEL_TACS, TAC_PROVENANCE = catalogue()

# The lookup a TAC database performs, built the same way round: eight digits to
# a make and model. Used by the validator to prove the round trip closes.
TACS_BY_MODEL = {(make, model): set(MODEL_TACS[index])
                 for index, (make, model, _, _) in enumerate(MODELS)}

# Reporting body identifiers actually in use, which are the first two digits of
# a TAC. Carried in the table's own header by the builder; read back here so a
# TAC's provenance can be checked without reopening the file it came from.
REPORTING_BODIES = TAC_PROVENANCE["reporting_bodies"]


def imei(tac, rng):
    """A 15-digit IMEI: an 8-digit TAC, a 6-digit serial, and a Luhn digit.

    Only the serial is drawn. The TAC is the model's and stays put, which is
    what a redraw on collision must not disturb — an IMEI that changed model
    because two serials happened to agree would be a device that changed shape.
    """
    body = f"{tac}{rng.randrange(1_000_000):06d}"
    return body + luhn(body)


# ---------------------------------------------------------------------------
# Networks, carriers and plans
# ---------------------------------------------------------------------------

# The host networks: who actually carries the traffic, and the identifiers that
# say so. `mnc` is the mobile network code inside the IMSI and `iin` the issuer
# identifier inside the ICCID; both are real, published values, because both
# are the first thing anyone decoding one of these numbers looks at.
#
# The big three carry MCC 310. EchoStar's Boost network does not — it is MCC
# 313, which the FCC opened for additional US assignments once 310 filled up.
# Keeping that right is worth the extra field: "every US IMSI starts 310" is
# exactly the sort of assumption a benchmark should be able to break.
NETWORKS = {
    "verizon": {
        "label": "Verizon", "mcc": "310", "mnc": ("004", "012"), "iin": "480",
    },
    "att": {
        "label": "AT&T", "mcc": "310", "mnc": ("410", "150"), "iin": "410",
    },
    "tmobile": {
        "label": "T-Mobile", "mcc": "310", "mnc": ("260", "160"), "iin": "260",
    },
    "boost": {
        "label": "Boost", "mcc": "313", "mnc": ("340",), "iin": "340",
    },
}

# Who the subscriber pays, which host network carries them, and whether that
# makes them an MVNO customer. The weights are US connection shares tilted for
# eastern Pennsylvania, where the notable local fact is Comcast: this is
# Xfinity's home cable footprint and Xfinity Mobile — a Verizon MVNO — sells
# far better here than its national share suggests.
#
# `host` is a list of (network, weight) rather than a single network because
# one carrier genuinely has more than one answer. Boost runs its own 5G network
# now and still hands a large share of its traffic to AT&T and T-Mobile under
# the agreements it was built on, so a Boost subscriber's IMSI is not
# predictable from the brand on the bill. Everyone else has one host.
POSTPAID_CARRIERS = (
    ("Verizon Wireless", (("verizon", 100),), False, 30),
    ("T-Mobile", (("tmobile", 100),), False, 28),
    ("AT&T", (("att", 100),), False, 25),
    ("Xfinity Mobile", (("verizon", 100),), True, 7),
    ("Spectrum Mobile", (("verizon", 100),), True, 3),
    ("Visible", (("verizon", 100),), True, 3),
    ("Consumer Cellular", (("att", 60), ("tmobile", 40)), True, 2),
    ("US Mobile", (("verizon", 60), ("tmobile", 40)), True, 2),
)

PREPAID_CARRIERS = (
    ("Metro by T-Mobile", (("tmobile", 100),), True, 23),
    ("Cricket Wireless", (("att", 100),), True, 23),
    ("Boost Mobile", (("boost", 45), ("att", 30), ("tmobile", 25)), True, 15),
    ("Straight Talk", (("verizon", 70), ("tmobile", 30)), True, 13),
    ("TracFone", (("verizon", 100),), True, 5),
    ("Total Wireless", (("verizon", 100),), True, 5),
    ("Mint Mobile", (("tmobile", 100),), True, 6),
    ("Verizon Prepaid", (("verizon", 100),), False, 4),
    ("AT&T Prepaid", (("att", 100),), False, 3),
    ("T-Mobile Prepaid", (("tmobile", 100),), False, 3),
)

# Share of lines on prepaid, by household income band. Prepaid runs around a
# fifth to a quarter of US connections overall and is not spread evenly over
# anything: it concentrates hard at the bottom, where the barrier is not the
# monthly price — prepaid is often dearer per gigabyte — but the credit check
# and the two-year commitment a postpaid line asks for. That weaker subscriber
# verification is the reason this field is worth carrying at all.
#
# Kierston is poorer than the country, so the citywide share this produces sits
# above the national one. That is the conditioning working, not a miscalibration.
PREPAID_BY_INCOME = (0.46, 0.34, 0.23, 0.16, 0.11, 0.07)

# A line somebody else pays for is nearly always a line on a family plan, and a
# family plan is a postpaid product. Applied as an odds multiplier so it bends
# the income conditioning rather than overriding it.
PREPAID_ODDS_ON_FAMILY_PLAN = 0.35


# ---------------------------------------------------------------------------
# Income banding
# ---------------------------------------------------------------------------

# Six bands, used by everything below that conditions on money: platform, tier,
# how long a phone is kept, whether it was bought new, and prepaid share. One
# banding rather than five so the conditioning is legible in the report.
INCOME_BAND_EDGES = (25_000, 50_000, 75_000, 100_000, 150_000)
INCOME_BAND_LABELS = ("<25k", "25-50k", "50-75k", "75-100k", "100-150k", "150k+")


def income_band(income):
    """Which of the six bands an income falls in."""
    for index, edge in enumerate(INCOME_BAND_EDGES):
        if income < edge:
            return index
    return len(INCOME_BAND_EDGES)


# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

# iOS share by age, which is the strongest single split in the US market and
# not close to a coin flip anywhere. Teenagers are overwhelmingly on iPhone —
# survey after survey puts the share in the mid-eighties, and the mechanism is
# not really price, it is that a green bubble is a social cost in an American
# high school. The share falls monotonically with age from there, and the
# retired are the one cohort where Android leads outright.
IOS_BY_AGE = ((12, 0.72), (17, 0.85), (24, 0.79), (34, 0.63), (44, 0.55),
              (54, 0.48), (64, 0.43), (200, 0.37))

# And by income, applied as a multiplier on the odds rather than on the
# probability, so it cannot push a share past 1. An iPhone costs more than the
# Android a comparable household buys, and US platform share tracks household
# income about as tightly as it tracks age.
IOS_ODDS_BY_INCOME = (0.60, 0.82, 1.00, 1.28, 1.60, 2.10)

# The third split, and the one a US-only market report will not show: immigrant
# populations skew Android, heavily and durably. Partly it is price and partly
# it is that a phone bought abroad is an Android phone almost everywhere Apple
# is not the default, and people arrive carrying one. The tilt is strongest in
# the first decade, which is when the phone somebody arrived with is still the
# phone they own or the one they replaced it with in kind.
IOS_ODDS_FOREIGN_BORN = 0.62
IOS_ODDS_RECENT_ARRIVAL = 0.45
RECENT_ARRIVAL_YEARS = 10


def graded(table, value):
    """The first probability in `table` whose bound `value` falls under."""
    return next(p for bound, p in table if value <= bound)


def platform(age, band, foreign_born, entry_year, rng):
    """`ios` or `android`, conditioned on age, income and nativity.

    Multiplied in odds space and converted back, which is the only way three
    independent tilts compose without one of them pushing a probability past
    the end of the scale.
    """
    base = graded(IOS_BY_AGE, age)
    odds = base / (1 - base) * IOS_ODDS_BY_INCOME[band]
    if foreign_born:
        odds *= IOS_ODDS_FOREIGN_BORN
        if entry_year and registries.REFERENCE_YEAR - entry_year <= RECENT_ARRIVAL_YEARS:
            odds *= IOS_ODDS_RECENT_ARRIVAL
    return "ios" if rng.random() < odds / (1 + odds) else "android"


# ---------------------------------------------------------------------------
# Acquisition: how old the phone is, and therefore which one it can be
# ---------------------------------------------------------------------------

# How long ago the handset was acquired, as a lognormal in years. The published
# figure people quote is a median US phone age of roughly two and a half to
# three years, which is a point estimate standing in for a long right tail —
# the distribution matters more than the median here, because the interesting
# handsets are the six-year-old ones. mu is ln(median); sigma is set so that
# about a sixth of phones are over five years old, which is roughly what
# replacement-cycle surveys imply.
AGE_MEDIAN_YEARS = 2.7
AGE_SIGMA = 0.62
AGE_CAP_YEARS = 9.0

# Multiplier on that age by income band. Holding a phone longer is the single
# most visible way the bottom band's handsets differ from the top's — it is not
# that they buy cheaper phones and replace them at the same rate, it is that
# they buy cheaper phones and keep them half again as long.
AGE_BY_INCOME = (1.35, 1.18, 1.00, 0.90, 0.82, 0.74)

# The earliest model in the catalogue is 2017, so nothing can be acquired
# before then; and nobody acquires a phone before they are old enough to be
# given one.
FIRST_MODEL_YEAR = min(released for _, _, released, _ in MODELS)
FIRST_PHONE_AGE = 8

# Share of handsets bought new rather than used or refurbished, by income band.
# The used market is large and it is where the bottom band buys: a carrier's
# certified-refurbished stock, a marketplace listing, or a hand-me-down from
# somebody in the household who upgraded.
NEW_BY_INCOME = (0.55, 0.66, 0.76, 0.83, 0.89, 0.93)

# How far back from the acquisition year the model can have been released.
# A new phone is bought while it is still on the shelf, which is about two
# years for a given model; a used one can be most of a decade old.
NEW_MAX_GAP = 2
USED_MAX_GAP = 7

# How sharply the choice concentrates on recent models, as the scale of an
# exponential in years since release. A retail buyer takes what is current; a
# used buyer is choosing on price, and price falls with age, so their
# distribution is much flatter.
RECENCY_SCALE = {"new": 0.9, "used": 2.4, "refurbished": 1.6}

# Price tier by income band, which is the other half of what income buys. The
# budget row is the prepaid wall behind the counter; the flagship row is a
# thousand dollars financed over thirty-six months.
TIER_BY_INCOME = {
    "budget":   (60, 45, 27, 16, 9, 5),
    "mid":      (34, 42, 49, 48, 42, 32),
    "flagship": (6, 13, 24, 36, 49, 63),
}


def acquisition(birth_year, band, rng):
    """The date this handset was acquired, and how it was bought.

    Age first and model second, rather than the other way round: a person
    replaces their phone on a cadence that has nothing to do with which model
    happens to be current, and the model is then whatever they could buy on the
    day. Drawing the model first and dating it afterwards produces the opposite
    dependency and a city where nobody owns an old phone.
    """
    years = min(AGE_CAP_YEARS,
                rng.lognormvariate(math.log(AGE_MEDIAN_YEARS), AGE_SIGMA)
                * AGE_BY_INCOME[band])
    acquired = TODAY - timedelta(days=int(years * 365.25))
    # Two floors, both hard: the catalogue starts in 2017, and an eight-year-old
    # was not buying a phone.
    floor = min(TODAY, date(max(FIRST_MODEL_YEAR,
                                birth_year + FIRST_PHONE_AGE), 1, 15))
    if acquired < floor:
        acquired = floor + timedelta(days=rng.randrange(
            max(1, (TODAY - floor).days)))
    condition = "new" if rng.random() < NEW_BY_INCOME[band] else rng.choices(
        ("used", "refurbished"), weights=(72, 28))[0]
    return acquired, condition


def choose_model(platform_name, acquired_year, condition, band, rng):
    """An index into MODELS: a phone that existed, and that this buyer would buy.

    Three weights multiplied. Brand share decides Samsung against Motorola,
    tier decides which end of that brand's range, and recency decides how old
    the handset was when it changed hands — which is where `condition` enters,
    because a phone bought new is nearly current by definition and a phone
    bought used is not.
    """
    max_gap = NEW_MAX_GAP if condition == "new" else USED_MAX_GAP
    scale = RECENCY_SCALE[condition]

    candidates, weights = [], []
    for index, (make, _, released, tier) in enumerate(MODELS):
        if (make == "Apple") != (platform_name == "ios"):
            continue
        gap = acquired_year - released
        if gap < 0 or gap > max_gap:
            continue
        weight = TIER_BY_INCOME[tier][band] * math.exp(-gap / scale)
        if make != "Apple":
            weight *= BRAND_SHARE[make]
        candidates.append(index)
        weights.append(weight)

    if not candidates:
        # Reachable only at the far edge of the age distribution, where a
        # handset is older than anything the catalogue lists for its platform.
        # The oldest models are the answer, not an error: the person is
        # carrying the oldest phone in the city.
        oldest = min(released for make, _, released, _ in MODELS
                     if (make == "Apple") == (platform_name == "ios"))
        candidates = [index for index, (make, _, released, _)
                      in enumerate(MODELS)
                      if (make == "Apple") == (platform_name == "ios")
                      and released == oldest]
        weights = [1.0] * len(candidates)
    return rng.choices(candidates, weights=weights)[0]


# ---------------------------------------------------------------------------
# Operating system
# ---------------------------------------------------------------------------

# The major version current at the middle of each year. Apple abandoned
# sequential numbering in 2025 and jumped from iOS 18 to iOS 26, naming
# releases for the model year ahead — so the run 18, 26 below is not a typo and
# not a gap. At TODAY (July 2026) iOS 26 is still current; 27 lands in the
# September after this simulation's clock.
IOS_BY_YEAR = {2017: 11, 2018: 12, 2019: 13, 2020: 14, 2021: 15, 2022: 16,
               2023: 17, 2024: 18, 2025: 26, 2026: 26}

# Android's numbering did not move. 16 shipped in mid-2025 and 17 is expected
# around the middle of 2026, which is close enough to TODAY that assuming it
# has reached anybody's handset would be a stretch — the OEM rollout takes
# months even when the release does not.
ANDROID_BY_YEAR = {2017: 8, 2018: 9, 2019: 10, 2020: 11, 2021: 12, 2022: 13,
                   2023: 14, 2024: 15, 2025: 16, 2026: 16}

# The releases in order, which is what "one major behind" means. Derived rather
# than written out so the two tables above stay the only place a version number
# is stated.
MAJOR_LADDER = {
    "ios": sorted(set(IOS_BY_YEAR.values())),
    "android": sorted(set(ANDROID_BY_YEAR.values())),
}

# Years of major OS upgrades a handset gets after release, which is the whole
# reason an OS version is informative rather than decorative: it says as much
# about what the device *is* as about what its owner does. Apple supports a
# phone for around six years across the range. On Android the number is a
# property of the make and the tier, and the spread is enormous — Google and
# Samsung's flagships now promise five to seven, while the sub-$150 handsets
# that fill the prepaid channel get one upgrade if they are lucky and often
# none. A four-year-old budget Android is stuck on a four-year-old Android.
SUPPORT_YEARS = {
    ("Apple", "budget"): 6, ("Apple", "mid"): 6, ("Apple", "flagship"): 6,
    ("Google", "flagship"): 7, ("Google", "mid"): 5,
    ("Samsung", "flagship"): 5, ("Samsung", "mid"): 4, ("Samsung", "budget"): 2,
    ("OnePlus", "flagship"): 4, ("OnePlus", "budget"): 2,
    ("Motorola", "flagship"): 3, ("Motorola", "mid"): 2,
    ("Motorola", "budget"): 1,
    ("LG", "mid"): 2, ("LG", "budget"): 1,
    ("TCL", "budget"): 1, ("Nokia", "budget"): 2,
}

# Not everybody installs the update the week it lands, and a few never install
# it at all. Majors behind the newest their handset could run.
UPDATE_LAG = ((0, 76), (1, 17), (2, 7))


def os_version(make, model_tier, released, platform_name, rng):
    """A plausible OS version for this handset today.

    Bounded above twice — by what the platform has actually released, and by
    how long this particular handset kept getting upgrades — and then dragged
    back by however far behind its owner is. Bounded below by the version the
    phone shipped with, because a device cannot run something older than itself.
    """
    table = IOS_BY_YEAR if platform_name == "ios" else ANDROID_BY_YEAR
    ladder = MAJOR_LADDER[platform_name]
    supported = SUPPORT_YEARS[(make, model_tier)]
    newest = table[min(registries.REFERENCE_YEAR, released + supported)]
    shipped = table[released]

    lag = rng.choices([n for n, _ in UPDATE_LAG],
                      weights=[w for _, w in UPDATE_LAG])[0]
    # Version numbers are not contiguous across Apple's 18 -> 26 jump, so a lag
    # of one major is a step back along the ladder of releases and not a
    # subtraction from the number.
    position = max(ladder.index(shipped), ladder.index(newest) - lag)
    major = ladder[position]

    if platform_name == "ios":
        # A point release. The current major has had a few by mid-year; an
        # abandoned one sat on its last for good.
        minor = rng.randint(0, 5) if major == table[registries.REFERENCE_YEAR] \
            else rng.randint(1, 7)
        return f"iOS {major}.{minor}"
    return f"Android {major}"


# ---------------------------------------------------------------------------
# SIM
# ---------------------------------------------------------------------------

# Every iPhone Apple sold in the United States from the 14 onward has no SIM
# tray at all — a US iPhone 14 or later is eSIM by construction, not by
# preference, and that is a hard rule rather than a share. Everything else is a
# share, rising steeply with model year as Android caught up.
ESIM_ONLY_FROM = 2022        # the iPhone 14's release year
ESIM_SHARE_ANDROID = ((2021, 0.03), (2023, 0.12), (2024, 0.22), (2026, 0.34))
ESIM_SHARE_OLD_IPHONE = 0.18  # an iPhone 13 or earlier supports both


def sim_kind(make, model_name, released, rng):
    """`esim` or `physical`, from what the handset actually supports."""
    if make == "Apple":
        if released >= ESIM_ONLY_FROM and "SE (2nd" not in model_name:
            return "esim"
        return "esim" if rng.random() < ESIM_SHARE_OLD_IPHONE else "physical"
    share = graded(ESIM_SHARE_ANDROID, released)
    return "esim" if rng.random() < share else "physical"


def imsi(network, mnc, rng):
    """15 digits: MCC, MNC, and the subscriber's own MSIN.

    An IMSI is at most fifteen digits and North American MNCs are three, which
    leaves nine for the MSIN and not the ten a two-digit-MNC country would
    have. Getting that split wrong is the classic way to produce a sixteen-digit
    "IMSI" that no validator accepts.

    The MNC is the *host* network's. An Xfinity Mobile subscriber is on
    311-480 or 310-004 like any other Verizon customer, because the SIM was
    provisioned on Verizon's HLR — the only place Xfinity appears is on the
    bill. That gap is the point of carrying `carrier` and `host_network`
    separately, and it is the sort of thing that turns a confident attribution
    into a wrong one.
    """
    return f"{NETWORKS[network]['mcc']}{mnc}{rng.randrange(10 ** 9):09d}"


def iccid(network, rng):
    """19 or 20 digits identifying the SIM itself, Luhn-checked.

    Structure, left to right: 89 for telecommunications, 1 for the United
    States, then the issuer identifier of whoever issued the card — 480 for
    Verizon, 410 for AT&T, 260 for T-Mobile — then the issuer's own serial,
    then the check digit. Real US ICCIDs are read exactly that way, which is
    why an ICCID is evidence about the network and not about the reseller.

    Length varies by issuer and, honestly, by era; both 19 and 20 are common,
    so both appear here.
    """
    body = f"891{NETWORKS[network]['iin']}"
    body += "".join(str(rng.randint(0, 9))
                    for _ in range(rng.choice((12, 13, 13))))
    return body + luhn(body)


def eid(rng):
    """A 32-digit eUICC identifier, for a handset whose SIM is soldered in.

    Worth carrying separately from the ICCID because they are not the same
    object and do not have the same lifetime: the EID identifies the chip, the
    ICCID identifies a profile downloaded onto it, and a phone that has been
    moved between three carriers has three ICCIDs and one EID. That is the
    eSIM-era version of the SIM-swap question and it is unanswerable if the
    chip has no identifier.
    """
    body = "89" + "".join(str(rng.randint(0, 9)) for _ in range(28))
    return body + eid_check(body)


# ---------------------------------------------------------------------------
# Who the account is in the name of
# ---------------------------------------------------------------------------

# Share of lines whose subscription is held by somebody other than the person
# carrying the handset, by age. Nearly every minor's phone is on a parent's
# account; the interesting part is how slowly that unwinds — family plans are
# cheaper per line than individual ones, so a twenty-one-year-old is more
# likely than not still on their parents' bill, and a meaningful minority of
# people in their late twenties never come off it. The uptick at the top is the
# other direction entirely: an adult child putting a parent on their plan.
HELD_BY_OTHER = ((12, 0.97), (17, 0.93), (21, 0.52), (25, 0.28), (29, 0.13),
                 (64, 0.03), (200, 0.07))
ELDERLY_FROM = 65


def account_holder(person, age, parents, children, members, household_adults,
                   rng):
    """(holder id, relation) — who the subscription is actually in the name of.

    Not the same question as who uses the phone, and the gap is the point. A
    subscriber name and address on a carrier's records belong to whoever signed
    for the line, so a number that resolves to a household head may be in a
    fifteen-year-old's pocket. This is one field now and a whole class of wrong
    answer later if it is missing.
    """
    if rng.random() >= graded(HELD_BY_OTHER, age):
        return person["id"], "self"

    if age >= ELDERLY_FROM:
        # A line on an adult child's family plan. Only in-city children can
        # hold an account; kinship's out-of-city stubs are not residents.
        grown = [c for c in children.get(person["id"], ()) if c in members]
        grown = [c for c in grown if members[c]["age"] >= 25]
        if grown:
            return rng.choice(sorted(grown)), "child"
        return person["id"], "self"

    # A parent, and preferably one under the same roof — the parent who pays
    # the phone bill is overwhelmingly the parent the child lives with.
    household = person.get("household")
    candidates = [p["id"] for p in parents.get(person["id"], ())
                  if p["id"] in members]
    resident = [pid for pid in candidates
                if household is not None
                and members[pid].get("household") == household]
    if resident:
        return rng.choice(sorted(resident)), "parent"
    if candidates:
        return rng.choice(sorted(candidates)), "parent"

    # No parent this stage can name: a lodger's household head, a grandparent
    # raising a grandchild, a group-quarters resident with nobody at all.
    adults = [p["id"] for p in household_adults.get(household, ())
              if p["id"] != person["id"] and p["age"] - age >= 12]
    if adults:
        return max(adults, key=lambda pid: members[pid]["age"]), "household_head"
    return person["id"], "self"


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

# The same retry bound identity.py uses on phone numbers, and the same
# reasoning: the identifier spaces here are astronomically larger than the city
# (a TAC alone leaves a million serials per model), so a collision is a
# birthday coincidence and reaching this bound would mean something structural
# is wrong rather than that two draws happened to agree.
DRAW_ATTEMPTS = 24


def unique(draw, taken, what):
    """Draw until the result is one nobody else holds, then claim it."""
    for _ in range(DRAW_ATTEMPTS):
        number = draw()
        if number not in taken:
            taken.add(number)
            return number
    raise SystemExit(
        f"no unused {what} after {DRAW_ATTEMPTS} draws ({len(taken):,} in use); "
        f"check the identifier spaces in devices.py")


# NPAs that belong to this city — the profile's [locale] area codes, by way of
# registries.py. A mobile on anything else came from somewhere else and was
# ported in, which identity.py models off MIGSP — read back here rather than
# re-derived, so the two files cannot disagree.
LOCAL_NPA = registries.AREA_CODES


def build(population, identities, kinship, seed):
    """(handsets, subscriptions) — two tables, both keyed by the person.

    Two rather than one because they are two objects. See the module docstring:
    a subscription is what a call detail record joins on and a handset is what
    it was made from, and the pair is neither one-to-one nor stable.
    """
    people = [person for person in population["person_records"]
              + population["quarters_records"] if not person.get("incarcerated")]
    members = {person["id"]: person for person in people}
    household_income = {h["id"]: h["income"]
                        for h in population["household_records"]}

    household_adults = {}
    for person in population["person_records"]:
        if person["age"] >= 18 and not person.get("incarcerated"):
            household_adults.setdefault(person["household"], []).append(person)

    parents = {int(pid): kin for pid, kin in kinship["parents"].items()}
    children = {}
    for child, kin in parents.items():
        for parent in kin:
            children.setdefault(parent["id"], []).append(child)

    # One set per identifier space. Separate rather than shared because these
    # are three different registries with three different issuers, and an IMEI
    # that happened to equal an ICCID would be a coincidence, not a clash.
    imeis, imsis, iccids, eids = set(), set(), set(), set()

    devices, subscriptions = {}, {}
    for person in people:
        identity = identities.get(str(person["id"]))
        if not identity or not identity["mobile"]:
            continue

        rng = keyed(seed, person["id"], "device")
        age = person["age"]
        household = person.get("household")
        income = (household_income.get(household) if household is not None
                  else person.get("income")) or 0
        band = income_band(income)

        foreign_born = identity["citizenship"] in ("naturalized", "noncitizen")
        kind = platform(age, band, foreign_born, identity["entry_year"], rng)

        acquired, condition = acquisition(
            int(identity["birth_date"][:4]), band, rng)
        index = choose_model(kind, acquired.year, condition, band, rng)
        make, model, released, tier = MODELS[index]

        holder, relation = account_holder(
            person, age, parents, children, members, household_adults, rng)

        # Plan before carrier, because the two carrier lists are disjoint —
        # nobody sells a postpaid Cricket line — and because it is the plan,
        # not the brand, that income actually decides.
        prepaid_p = PREPAID_BY_INCOME[band]
        if relation != "self":
            odds = prepaid_p / (1 - prepaid_p) * PREPAID_ODDS_ON_FAMILY_PLAN
            prepaid_p = odds / (1 + odds)
        plan = "prepaid" if rng.random() < prepaid_p else "postpaid"

        table = PREPAID_CARRIERS if plan == "prepaid" else POSTPAID_CARRIERS
        carrier, hosts, is_mvno, _ = rng.choices(
            table, weights=[w for *_, w in table])[0]
        host = rng.choices([h for h, _ in hosts],
                           weights=[w for _, w in hosts])[0]
        mnc = rng.choice(NETWORKS[host]["mnc"])

        sim = sim_kind(make, model, released, rng)

        # Everything categorical is now decided. Only the digits below are
        # redrawn on a collision — see the module docstring, and telephone()
        # in identity.py, for why that separation has to be maintained.
        tac = rng.choice(MODEL_TACS[index])

        # The handset: a piece of hardware, and everything that is true of it
        # whoever is paying for whatever SIM happens to be in it today.
        handset = {
            "user": person["id"],
            # True for every handset today, and a field rather than an
            # assumption because it will not be true for long: the second phone
            # a person carries is exactly the case this layer exists to hold.
            "primary": True,
            "imei": unique(lambda: imei(tac, rng), imeis,
                           f"IMEI for person {person['id']}"),
            "tac": tac,
            "platform": kind,
            "make": make,
            "model": model,
            "model_released": released,
            "tier": tier,
            "os_version": os_version(make, tier, released, kind, rng),
            "acquired": acquired.isoformat(),
            "condition": condition,
            # Whether this handset takes a card or has the chip soldered down,
            # which is a fact about the hardware and not about the plan.
            "sim_type": sim,
            # And the chip's own identifier, where there is a chip. The EID
            # stays here rather than moving across with the ICCID for the
            # reason the eUICC exists at all: the chip is part of the board and
            # outlives every profile written to it, so a phone that has been
            # through three carriers has three ICCIDs and one EID. Putting them
            # in the same row would say the opposite.
            "eid": (unique(lambda: eid(rng), eids,
                           f"EID for person {person['id']}")
                    if sim == "esim" else None),
        }

        # The subscription: a relationship with a carrier, which is what a call
        # detail record is actually about. It names the handset it currently
        # sits in rather than being a field on it.
        subscription = {
            "user": person["id"],
            "primary": True,
            # identity.py's number, not a new one. This stage never mints a
            # phone number; a second source of MSISDNs would be a second answer
            # to the question every call record joins on.
            "msisdn": identity["mobile"],
            "imsi": unique(lambda: imsi(host, mnc, rng), imsis,
                           f"IMSI for person {person['id']}"),
            "iccid": unique(lambda: iccid(host, rng), iccids,
                            f"ICCID for person {person['id']}"),
            "ported_in": identity["mobile"][1:4] not in LOCAL_NPA,
            "carrier": carrier,
            "host_network": NETWORKS[host]["label"],
            "mvno": is_mvno,
            "plan_type": plan,
            "account_holder": holder,
            "account_holder_relation": relation,
            # Which handset this SIM is in, by IMEI. A reference and not a
            # containment: it is the field a (IMSI, IMEI) pair off a call
            # record is checked against, and the field that makes "this number
            # moved into a different phone" a statement the schema can hold
            # rather than a contradiction.
            "handset": handset["imei"],
        }
        # Lists, not records. One handset and one subscription each is this
        # build's rule and not the format's — see the module docstring.
        devices[person["id"]] = [handset]
        subscriptions[person["id"]] = [subscription]
    return devices, subscriptions


def validate(devices, subscriptions):
    """The invariants a downstream join is entitled to assume."""
    for handsets in devices.values():
        for device in handsets:
            if luhn(device["imei"][:14]) != device["imei"][14]:
                raise RuntimeError(f"IMEI fails Luhn: {device['imei']}")
            if len(device["imei"]) != 15:
                raise RuntimeError(f"IMEI is not 15 digits: {device['imei']}")
            if device["eid"] and int(device["eid"]) % 97 != 1:
                raise RuntimeError(f"EID fails its checksum: {device['eid']}")
            if (device["eid"] is None) != (device["sim_type"] == "physical"):
                raise RuntimeError(
                    f"EID present on a physical SIM, or absent from an eSIM: "
                    f"{device['imei']}")
            if not device["imei"].startswith(device["tac"]):
                raise RuntimeError(f"IMEI does not carry its TAC: {device}")
            # The round trip a TAC lookup performs: eight digits back to the
            # make and model this record claims. If this ever fails, an IMEI in
            # this city resolves to somebody else's handset.
            if device["tac"] not in TACS_BY_MODEL[
                    (device["make"], device["model"])]:
                raise RuntimeError(
                    f"TAC {device['tac']} is not allocated to "
                    f"{device['make']} {device['model']}")
            if device["tac"][:2] not in REPORTING_BODIES:
                raise RuntimeError(
                    f"TAC {device['tac']} names no real reporting body")

    # The reference has to resolve. A subscription pointing at an IMEI no
    # handset carries is the exact failure the split introduces the
    # possibility of, so it is checked rather than assumed.
    handsets = {device["imei"] for row in devices.values() for device in row}
    for lines in subscriptions.values():
        for line in lines:
            if luhn(line["iccid"][:-1]) != line["iccid"][-1]:
                raise RuntimeError(f"ICCID fails Luhn: {line['iccid']}")
            if len(line["imsi"]) != 15:
                raise RuntimeError(f"IMSI is not 15 digits: {line['imsi']}")
            if line["handset"] not in handsets:
                raise RuntimeError(
                    f"subscription {line['msisdn']} references unknown "
                    f"handset {line['handset']}")


def report(devices, subscriptions, population, identities):
    """Everything worth failing a build over, printed."""
    rows = [d for handsets in devices.values() for d in handsets]
    lines = [s for held in subscriptions.values() for s in held]
    total = len(rows)
    mobiles = sum(1 for r in identities.values() if r["mobile"])
    print(f"{total:,} handsets and {len(lines):,} subscriptions "
          f"for {len(devices):,} people\n")
    print(f"  {mobiles:,} people hold a mobile number in identity.json — "
          f"{'all covered' if total == mobiles else f'{mobiles - total:,} MISSING'}")

    people = {p["id"]: p for p in population["person_records"]
              + population["quarters_records"]}
    household_income = {h["id"]: h["income"]
                        for h in population["household_records"]}

    def band_of(device):
        person = people[device["user"]]
        household = person.get("household")
        income = (household_income.get(household) if household is not None
                  else person.get("income")) or 0
        return income_band(income)

    def share(rows_in, key):
        counts = Counter(key(r) for r in rows_in)
        return ", ".join(f"{label} {100 * n / max(1, len(rows_in)):.0f}%"
                         for label, n in counts.most_common())

    print("\nplatform:")
    counts = Counter(r["platform"] for r in rows)
    for label, count in counts.most_common():
        print(f"  {label:<10} {count:>7,}  {100 * count / total:5.1f}%")
    print("  US iOS share: 55-58%; expected lower here (poorer, more "
          "foreign-born)")

    print("\n  iOS share by age")
    bands = ((0, 12), (13, 17), (18, 24), (25, 34), (35, 44), (45, 54),
             (55, 64), (65, 200))
    for low, high in bands:
        cohort = [r for r in rows if low <= people[r["user"]]["age"] <= high]
        if cohort:
            ios = sum(1 for r in cohort if r["platform"] == "ios")
            print(f"    {low:>2}-{high if high < 200 else 0:<3} "
                  f"{len(cohort):>7,}  {100 * ios / len(cohort):5.1f}%")

    print("\n  iOS share by household income")
    for index, label in enumerate(INCOME_BAND_LABELS):
        cohort = [r for r in rows if band_of(r) == index]
        if cohort:
            ios = sum(1 for r in cohort if r["platform"] == "ios")
            print(f"    {label:<9} {len(cohort):>7,}  "
                  f"{100 * ios / len(cohort):5.1f}%")

    foreign = [r for r in rows
               if identities[str(r["user"])]["citizenship"]
               in ("naturalized", "noncitizen")]
    native = [r for r in rows
              if identities[str(r["user"])]["citizenship"]
              not in ("naturalized", "noncitizen")]
    for label, cohort in (("US-born", native), ("foreign-born", foreign)):
        if cohort:
            ios = sum(1 for r in cohort if r["platform"] == "ios")
            print(f"  {label:<14} {len(cohort):>7,}  "
                  f"iOS {100 * ios / len(cohort):5.1f}%")

    print("\nmakes: " + share(rows, lambda r: r["make"]))
    print("\n  most common handsets")
    common = Counter(f"{r['make']} {r['model']}" for r in rows)
    for name, count in common.most_common(10):
        print(f"    {100 * count / total:5.2f}%  {name}")

    print("\ncarrier:")
    counts = Counter(r["carrier"] for r in lines)
    width = max(len(c) for c in counts)
    for label, count in counts.most_common():
        print(f"  {label:<{width}}  {count:>7,}  {100 * count / total:5.1f}%")
    print("\nhost network: " + share(lines, lambda r: r["host_network"]))
    mvno = sum(1 for r in lines if r["mvno"])
    print(f"  {mvno:,} lines ({100 * mvno / total:.1f}%) on an MVNO "
          f"(IMSI names the host network)")
    # The join that the two-field model exists to make interesting. If this is
    # zero, the MVNO modelling has collapsed into a relabelling.
    disagree = sum(1 for r in lines
                   if not r["carrier"].startswith(r["host_network"]))
    print(f"  {disagree:,} lines ({100 * disagree / total:.1f}%) billed by a "
          f"carrier other than the IMSI network")

    print("\nplan type: " + share(lines, lambda r: r["plan_type"]))
    print("  prepaid share by household income")
    for index, label in enumerate(INCOME_BAND_LABELS):
        cohort = [r for r in lines if band_of(r) == index]
        if cohort:
            prepaid = sum(1 for r in cohort if r["plan_type"] == "prepaid")
            print(f"    {label:<9} {len(cohort):>7,}  "
                  f"{100 * prepaid / len(cohort):5.1f}%")

    print("\ndevice age (years since acquisition):")
    ages = sorted((TODAY - date.fromisoformat(r["acquired"])).days / 365.25
                  for r in rows)
    for label, position in (("p10", 0.10), ("median", 0.50), ("p90", 0.90)):
        print(f"  {label:<7} {ages[int(position * (total - 1))]:.1f}y")
    over_five = sum(1 for a in ages if a >= 5)
    print(f"  {over_five:,} ({100 * over_five / total:.1f}%) five years or "
          f"older (replacement surveys: ~1/6)")
    print("  median age by household income")
    for index, label in enumerate(INCOME_BAND_LABELS):
        cohort = sorted((TODAY - date.fromisoformat(r["acquired"])).days / 365.25
                        for r in rows if band_of(r) == index)
        if cohort:
            print(f"    {label:<9} {len(cohort):>7,}  "
                  f"{cohort[len(cohort) // 2]:.1f}y")
    print("  condition: " + share(rows, lambda r: r["condition"]))
    early = sum(1 for r in rows
                if int(r["acquired"][:4]) < r["model_released"])
    print(f"  {early:,} handsets acquired before their model was released")

    print("\nOS: " + share(rows, lambda r: r["os_version"].split(".")[0]))
    print("SIM: " + share(rows, lambda r: r["sim_type"]))
    esim = [r for r in rows if r["sim_type"] == "esim"]
    print(f"  {sum(1 for r in esim if r['eid']):,} of {len(esim):,} eSIM "
          f"handsets carry an EID")

    print("\naccount holder:")
    other = [r for r in lines if r["account_holder"] != r["user"]]
    print(f"  {len(other):,} of {total:,} lines ({100 * len(other) / total:.1f}%) "
          f"are held by somebody other than the user")
    print("  " + share(lines, lambda r: r["account_holder_relation"]))
    minors = [r for r in lines if people[r["user"]]["age"] < 18]
    held = sum(1 for r in minors if r["account_holder"] != r["user"])
    print(f"  minors: {held:,} of {len(minors):,} "
          f"({100 * held / max(1, len(minors)):.1f}%) on somebody else's account")

    print("\nidentifiers:")
    for field, table in (("imei", rows), ("imsi", lines), ("iccid", lines)):
        values = [r[field] for r in table]
        print(f"  {field:<6} {len(values):,} issued, "
              f"{len(values) - len(set(values)):,} collisions")
    bad = sum(1 for r in rows if luhn(r["imei"][:14]) != r["imei"][14])
    print(f"  {bad:,} IMEIs fail their Luhn digit")
    bad = sum(1 for r in lines if luhn(r["iccid"][:-1]) != r["iccid"][-1])
    print(f"  {bad:,} ICCIDs fail their Luhn digit")
    bad = sum(1 for r in rows if r["eid"] and int(r["eid"]) % 97 != 1)
    print(f"  {bad:,} EIDs fail their mod-97 checksum")
    # The two agreements that make these numbers joinable rather than
    # decorative: a TAC lookup has to return the handset the record claims, and
    # an IMSI's MNC has to name the network that actually carries the line.
    bad = sum(1 for r in rows
              if r["tac"] not in TACS_BY_MODEL[(r["make"], r["model"])])
    print(f"  {bad:,} IMEIs carry a TAC allocated to a different model")
    bad = sum(1 for r in rows if r["tac"][:2] not in REPORTING_BODIES)
    print(f"  {bad:,} IMEIs carry a TAC from an unrecognized reporting body")
    print(f"  {len({r['tac'] for r in rows}):,} distinct TACs in service, all "
           "real allocations from " + TAC_PROVENANCE["source"])
    bodies = Counter(r["tac"][:2] for r in rows)
    print("  reporting bodies: " + ", ".join(
        f"{body} {REPORTING_BODIES[body]} {100 * n / total:.0f}%"
        for body, n in bodies.most_common()))
    mnc_of = {network["label"]: network["mnc"] for network in NETWORKS.values()}
    bad = sum(1 for r in lines if r["imsi"][3:6] not in mnc_of[r["host_network"]])
    print(f"  {bad:,} IMSIs carry an MNC that is not their host network's")
    # The join the split creates and therefore the one it has to prove.
    carried = {r["imei"] for r in rows}
    bad = sum(1 for r in lines if r["handset"] not in carried)
    print(f"  {bad:,} subscriptions reference an unknown handset")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()

    for path in (POPULATION, IDENTITY, KINSHIP):
        if not path.exists():
            raise SystemExit(
                f"{path.name} is missing — run the earlier stages first")

    population = json.loads(POPULATION.read_text())
    identity = json.loads(IDENTITY.read_text())
    kinship = json.loads(KINSHIP.read_text())

    devices, subscriptions = build(
        population, identity["identities"], kinship, args.seed)
    validate(devices, subscriptions)

    args.out.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": registries.REFERENCE_YEAR,
        "today": TODAY.isoformat(),
        "persons": len(population["person_records"]),
        "handsets": sum(len(h) for h in devices.values()),
        "subscriptions": sum(len(s) for s in subscriptions.values()),
        # Nothing here is surveyed. ACS asks whether a household has telephone
        # service and asks nothing at all about handsets, so the honest answer
        # to "which of these came off the survey" is none of them.
        "surveyed": [],
        "modelled": ["platform", "make", "model", "os_version", "acquired",
                     "condition", "carrier", "host_network", "plan_type",
                     "sim_type", "imei", "imsi", "iccid", "eid",
                     "account_holder"],
        # Where the TACs came from, carried with the data rather than only in
        # a comment. Anything decoding an IMEI from this file is entitled to
        # know that the allocation is real and which mirror of the GSMA table
        # it was cut from.
        "tac_source": {
            "source": TAC_PROVENANCE["source"],
            "license": TAC_PROVENANCE["source_license"],
            "retrieved": TAC_PROVENANCE["retrieved"],
            "note": TAC_PROVENANCE["note"],
        },
        # Two tables, both keyed by the person who uses the line. The
        # subscription points at its handset by IMEI rather than being nested
        # inside it, which is what lets one handset hold two lines and one line
        # move between handsets.
        "devices": devices,
        "subscriptions": subscriptions,
    }, separators=(",", ":")))

    print(f"devices.json ({args.out.stat().st_size / 1e6:.1f} MB)\n")
    report(devices, subscriptions, population, identity["identities"])


if __name__ == "__main__":
    main()
