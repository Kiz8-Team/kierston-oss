"""The number-issuing conventions every personal record in Kierston obeys.

Nothing here decides *who* gets a record. This module only answers "what does
the next one look like", and it exists because that question has a real answer
for every identifier a person carries. An SSN is not nine random digits: its
first three encode where the card was applied for, its middle two were issued
in a fixed non-sequential order within that area, and the whole scheme was
abandoned for random assignment on 25 June 2011. A VIN carries a check digit
that fails on eleven of twelve random strings. A plate is a position in a
sequence the state has been walking since 1977.

The point of getting that right is that these records are meant to be *joined*.
A person's SSN area should agree with their POBP, their plate should agree with
their registration year, their docket number should agree with which court
heard the case. Records generated from independent random draws agree with
nothing, and a simulation built on them can never pose the interesting
question — does this evidence hang together — because the answer is always no.

Two shapes of generator live here:

  check-digit formats   VIN, ABA routing number. Digits are drawn, then the
                        check position is *computed*, so every number
                        validates under the real algorithm.
  sequential series     SSN groups, driver licences, plates, dockets, licence
                        to carry. A `Series` hands out consecutive values, so
                        numbers issued close together look it, and no two
                        people ever share one.

The tables are as real as I could make them without a paid data source. Area
ranges, the SSA group order, the ABA and VIN algorithms and the docket formats
are all documented conventions. The NXX lists are curated from the reference
city's published exchanges and are the one place a real NANPA download would
improve things; anything marked `hand-curated` in a comment is a place a better
source drops straight in.

What is particular to one city or one state is not in this file. The city's
court numbers, "now", area codes and banks come from its profile's `[locale]`
and `cities/<slug>/*.csv`; the state's licence and plate numbering from its
`jurisdiction.toml`. The formats and algorithms stay here.

A deliberate consequence, chosen over my objection and on the record: because
these follow real conventions, a number generated here can collide with a real
person's. See the module docstring in identity.py for what that means and the
one mitigation that survived — nothing generated here is a validated *pair*,
so a name and an SSN never agree with a real record at once.
"""

import random
import string
import sys
from pathlib import Path

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import city_data  # noqa: E402
import jurisdiction as legal  # noqa: E402
import profile as city_profile  # noqa: E402

_LOCALE = city_profile.load().locale
_LAW = legal.load()
FORMATS = legal.state_module("formats")


def keyed(*parts):
    """An RNG seeded on the parts, for per-person-per-domain independence.

    Every generator here takes an rng rather than owning one, and the callers
    build theirs with this: `keyed(seed, person_id, "ssn")`. That makes each
    person's draw in each domain independent of every other, so re-running one
    domain — or adding a new one — does not reshuffle the rest. Draw everything
    from a single stream instead and inserting one field at the top silently
    changes every value below it, which makes any before/after comparison
    useless.

    Joined into a string because Python 3.14 removed tuple seeding.
    """
    return random.Random("\x1f".join(str(p) for p in parts))


# The city's courts: its county's judicial district, which numbers the Common
# Pleas dockets, and the division of the federal district that sits in the
# city, which prefixes a federal docket. Both from the profile's [locale].
JUDICIAL_DISTRICT = _LOCALE.judicial_district
FEDERAL_DIVISION = _LOCALE.federal_division

# Simulation "now", from [locale] reference_date. Every issue date, expiry and
# docket year is measured from here; the profile is the one place to change to
# move the whole city in time.
REFERENCE_DATE = _LOCALE.reference_date
REFERENCE_YEAR = REFERENCE_DATE.year


# ---------------------------------------------------------------------------
# Social Security numbers
# ---------------------------------------------------------------------------

# Area number ranges by state of birth, as SSA assigned them until 2011. The
# key is the POBP code (FIPS state code, zero-padded to three), because that is
# what the population records carry.
#
# This is the pre-randomisation table, and it is the whole reason the join is
# interesting: a card applied for in Pennsylvania starts 159-211, and one
# applied for in Puerto Rico starts 580-584 or 596-599. Someone born in PR who
# lives in the reference city — 8.5% of it — carries that in their SSN forever.
#
# Several states hold two disjoint blocks because SSA exhausted the first and
# came back later; both are listed, and a draw picks by width so the older,
# wider block dominates the way it does in reality.
SSN_AREAS = {
    "033": [(1, 3)],                      # New Hampshire
    "023": [(4, 7)],                      # Maine
    "050": [(8, 9)],                      # Vermont
    "025": [(10, 34)],                    # Massachusetts
    "044": [(35, 39)],                    # Rhode Island
    "009": [(40, 49)],                    # Connecticut
    "036": [(50, 134), (681, 690)],       # New York
    "034": [(135, 158)],                  # New Jersey
    "042": [(159, 211)],                  # Pennsylvania
    "024": [(212, 220)],                  # Maryland
    "010": [(221, 222)],                  # Delaware
    "051": [(223, 231)],                  # Virginia
    "054": [(232, 236)],                  # West Virginia
    "037": [(237, 246), (650, 653)],      # North Carolina
    "045": [(247, 251), (654, 658)],      # South Carolina
    "013": [(252, 260)],                  # Georgia
    "012": [(261, 267), (589, 595)],      # Florida
    "039": [(268, 302)],                  # Ohio
    "018": [(303, 317)],                  # Indiana
    "017": [(318, 361)],                  # Illinois
    "026": [(362, 386)],                  # Michigan
    "055": [(387, 399)],                  # Wisconsin
    "021": [(400, 407)],                  # Kentucky
    "047": [(408, 415)],                  # Tennessee
    "001": [(416, 424)],                  # Alabama
    "028": [(425, 428), (587, 588)],      # Mississippi
    "005": [(429, 432)],                  # Arkansas
    "022": [(433, 439), (659, 665)],      # Louisiana
    "040": [(440, 448)],                  # Oklahoma
    "048": [(449, 467), (627, 645)],      # Texas
    "027": [(468, 477)],                  # Minnesota
    "019": [(478, 485)],                  # Iowa
    "029": [(486, 500)],                  # Missouri
    "038": [(501, 502)],                  # North Dakota
    "046": [(503, 504)],                  # South Dakota
    "031": [(505, 508)],                  # Nebraska
    "020": [(509, 515)],                  # Kansas
    "030": [(516, 517)],                  # Montana
    "016": [(518, 519)],                  # Idaho
    "056": [(520, 520)],                  # Wyoming
    "008": [(521, 524)],                  # Colorado
    "035": [(525, 525), (585, 585), (648, 649)],   # New Mexico
    "004": [(526, 527), (600, 601)],      # Arizona
    "049": [(528, 529), (646, 647)],      # Utah
    "032": [(530, 530), (680, 680)],      # Nevada
    "053": [(531, 539)],                  # Washington
    "041": [(540, 544)],                  # Oregon
    "006": [(545, 573), (602, 626)],      # California
    "002": [(574, 574)],                  # Alaska
    "015": [(575, 576), (750, 751)],      # Hawaii
    "011": [(577, 579)],                  # District of Columbia
    "072": [(580, 584), (596, 599), (667, 675)],   # Puerto Rico
    "078": [(580, 580)],                  # Virgin Islands
    "060": [(586, 586)],                  # American Samoa
    "066": [(586, 586)],                  # Guam
    "069": [(586, 586)],                  # Northern Marianas
}

# Where a card is applied for, not where the holder was born, so someone born
# abroad who naturalised here gets the home state's area — the jurisdiction's
# state, as a POBP. Also the fallback for a POBP this table does not know.
HOME_POBP = _LAW.state.pobp
DEFAULT_SSN_AREA = HOME_POBP

# Never issued, in any era: area 000, 666, and 900-999 (that block is ITIN
# space). Group 00 and serial 0000 are likewise never issued.
INVALID_AREAS = {0, 666}

# Randomisation day. Cards issued on or after this date carry no geographic or
# chronological information at all — SSA draws area, group and serial freely
# from what is left. Anyone in this city young enough to have been enumerated
# after it (born from 2011, plus later immigrants) gets a random number, and
# that discontinuity is real and worth reproducing: it is exactly why "the
# area code says Pennsylvania" stops being evidence for the youngest cohort.
RANDOMIZATION_YEAR = 2011

# The order SSA issued group numbers within an area: odd 01-09, then even
# 10-98, then even 02-08, then odd 11-99. Not an accident of history worth
# skipping — it is why a 1975 card and a 1985 card from the same area differ in
# a way that looks arbitrary but is completely determined.
SSN_GROUP_ORDER = (
    list(range(1, 10, 2)) + list(range(10, 100, 2))
    + list(range(2, 10, 2)) + list(range(11, 100, 2))
)

# ITIN: issued to people who file taxes without work authorisation, which is
# most of the noncitizen population without status. Always starts with 9, and
# the middle two digits come from a reserved set that has grown over time.
ITIN_GROUPS = (list(range(50, 66)) + list(range(70, 89))
               + list(range(90, 93)) + list(range(94, 100)))


def ssn_area(pobp, issue_year, rng):
    """The three-digit area for a card applied for in `issue_year`.

    Post-randomisation this ignores `pobp` entirely, which is the point.
    """
    if issue_year >= RANDOMIZATION_YEAR:
        while True:
            area = rng.randint(1, 899)
            if area not in INVALID_AREAS:
                return f"{area:03d}"
    ranges = SSN_AREAS.get(pobp) or SSN_AREAS[DEFAULT_SSN_AREA]
    # Weight by block width so the wide original block dominates the narrow
    # later one, as it does in the real population.
    widths = [high - low + 1 for low, high in ranges]
    low, high = rng.choices(ranges, weights=widths)[0]
    return f"{rng.randint(low, high):03d}"


def ssn(pobp, issue_year, rng):
    """A structurally valid SSN, geographic before 2011 and random after."""
    area = ssn_area(pobp, issue_year, rng)
    if issue_year >= RANDOMIZATION_YEAR:
        group = rng.randint(1, 99)
    else:
        # Position in the issue order tracks when the card was applied for.
        # Areas differ hugely in how far through the order they had got by a
        # given year, and nothing published gives that per area per year, so
        # this places the holder proportionally through the order by birth
        # decade — the shape is right even where the exact group is not.
        span = min(len(SSN_GROUP_ORDER), max(4, (issue_year - 1936) * 8 // 10))
        group = SSN_GROUP_ORDER[rng.randrange(span)]
    return f"{area}-{group:02d}-{rng.randint(1, 9999):04d}"


def itin(rng):
    """A taxpayer identification number for someone with no SSN."""
    return f"9{rng.randint(0, 99):02d}-{rng.choice(ITIN_GROUPS):02d}-" \
           f"{rng.randint(1, 9999):04d}"


# ---------------------------------------------------------------------------
# Telephone numbers
# ---------------------------------------------------------------------------

# The city's area codes, original first and overlays after. Which one a person
# carries is chronological: the original code's numbers were assigned first and
# stayed with their holders, so an older landline is almost always on it and a
# new mobile is roughly even between it and the first overlay.
AREA_CODES = _LOCALE.area_codes

# Central office codes serving the city and the boroughs inside the extract,
# from the city's exchanges.csv. Hand-curated from published exchange listings;
# a NANPA block download would replace the file wholesale without changing
# anything else here. Split by service type because it matters for the join: a
# landline and a mobile drawn from the same pool would make TEL and SMARTPHONE
# indistinguishable.
NXX_LANDLINE, NXX_WIRELESS = city_data.exchanges(AREA_CODES)

# Share of numbers on each area code, by the year the number was first
# assigned: (first year not covered, shares over AREA_CODES), from [locale].
AREA_CODE_ERAS = _LOCALE.area_code_eras


def area_code(assigned_year, rng):
    """Which NPA a number assigned in `assigned_year` would have come from."""
    for cutoff, weights in AREA_CODE_ERAS:
        if assigned_year < cutoff:
            return rng.choices(AREA_CODES, weights=weights)[0]
    return AREA_CODES[0]


def phone(assigned_year, rng, wireless=True, npa=None):
    """A dialable-format local number.

    Line 4 of the NANPA rules, worth honouring because it is cheap: the last
    four digits avoid nothing, but an NXX never starts with 0 or 1 and 555 is
    reserved — which is guaranteed by drawing from the curated lists rather
    than by generating and filtering.
    """
    npa = npa or area_code(assigned_year, rng)
    table = NXX_WIRELESS if wireless else NXX_LANDLINE
    return f"({npa}) {rng.choice(table[npa])}-{rng.randint(0, 9999):04d}"


# ---------------------------------------------------------------------------
# Sequential series
# ---------------------------------------------------------------------------

class Series:
    """A monotonic allocator for numbers a public authority issues in order.

    Driver licences, plates, docket numbers and carry permits are all handed
    out consecutively, and that is load-bearing information: two people whose
    licence numbers are close got them at the same time. Random draws destroy
    it, and — more prosaically — random draws collide, which a state registry
    by definition never does.

    `step` gives an allocator a stride, so a series that other counties also
    draw from does not come out looking like this city consumed every number.
    """

    def __init__(self, start, step=1):
        self.start = start
        self.step = step
        self.issued = 0

    def next(self, rng=None, jitter=0):
        """The next value. `jitter` skips a few, so runs are not contiguous."""
        value = self.start + self.issued * self.step
        self.issued += 1
        if jitter and rng:
            self.issued += rng.randrange(jitter)
        return value


# Driver licence and photo-ID numbers are eight digits with no check digit,
# issued in one statewide sequence starting where the jurisdiction says the
# state had reached.
DL_SERIES_START = _LAW.licensing.licence_series_start

# Passenger plates run three letters, four digits. The state walks this
# sequence block by block; letters are consumed left-slowest, so the sequence
# is LAA-0000 .. LAA-9999, LAB-0000 .. and the letters the jurisdiction leaves
# out (I, O and Q) are skipped throughout to keep plates legible at speed.
PLATE_LETTERS = _LAW.plates.letters
PLATE_BLOCK_START = tuple(_LAW.plates.block_start)

# Registration years for each plate block, so a plate can be dated: the block
# above opened in PLATE_BLOCK_YEAR, and the state's registration volume walks
# PLATE_BLOCKS_PER_YEAR blocks a year.
PLATE_BLOCK_YEAR = _LAW.plates.block_year
PLATE_BLOCKS_PER_YEAR = _LAW.plates.blocks_per_year

# The county's licence to carry firearms. Sheriffs issue these per county in
# their own sequence, and the number is printed on the licence. Prefix and
# starting point are the city's, from [locale].
LTCF_PREFIX = _LOCALE.carry_licence_prefix
LTCF_SERIES_START = _LOCALE.carry_licence_series_start

# School bus plates are not passenger plates and must not be drawn from the
# passenger series — a bus wearing LAR-4472 would be indistinguishable from a
# Camry to anything reading the plate, which defeats the point of a plate class.
# PA issues them against the SCHOOL BUS legend in a five-digit series of their
# own, and the fleet is small enough that they can be allocated consecutively
# rather than dated: a district registers its buses in batches, so consecutive
# numbers are what the real plates look like.
SCHOOL_BUS_SERIES_START = _LAW.plates.school_bus_series_start

# Municipal government plates, which is what a city-owned vehicle wears in
# Pennsylvania. The legend reads MUNICIPAL GOVERNMENT and the series is its
# own: a marked patrol car drawn from the passenger series would be a Camry to
# anything reading the plate, and the whole reason a police vehicle is in this
# registry at all is that it is a vehicle other systems observe.
#
# Allocated consecutively for the same reason school bus plates are — a city
# registers its fleet in batches, and the batch is what real municipal plates
# look like.
MUNICIPAL_SERIES_START = _LAW.plates.municipal_series_start


def plate_block(letters):
    """The position of a three-letter block in the sequence, LAA-first-style."""
    index = 0
    for letter in letters:
        index = index * len(PLATE_LETTERS) + PLATE_LETTERS.index(letter)
    return index


def plate_index(registered_year, rng):
    """A position in the passenger series consistent with a registration year.

    Plates are not reissued on renewal, so the letter block dates the *first*
    registration of that plate, which is usually when the current owner bought
    the car. That makes a plate weakly informative about vehicle age, which is
    true of real plates and is the reason to bother — and it has to run
    backwards as well as forwards, since most cars on the road today were first
    registered before the L block opened.
    """
    blocks = (registered_year - PLATE_BLOCK_YEAR) * PLATE_BLOCKS_PER_YEAR
    # Spread within the year, and allow some backwards drift for plates
    # transferred from an older vehicle.
    offset = blocks + rng.random() * PLATE_BLOCKS_PER_YEAR - rng.random() * 2
    index = (plate_block("".join(PLATE_BLOCK_START)) + int(offset)) * 10_000
    return max(0, index + rng.randrange(10_000))


def plate(index):
    """Format an absolute position in the passenger series as a plate."""
    serial, block = index % 10_000, index // 10_000
    letters = ""
    for _ in range(3):
        letters = PLATE_LETTERS[block % len(PLATE_LETTERS)] + letters
        block //= len(PLATE_LETTERS)
    return FORMATS.passenger_plate(letters, serial)


# Personalized plates are chosen, not issued from the sequence, so the letters
# the sequential series skips are available here: a vanity plate may contain
# I, O and Q. The state allows up to PERSONALIZED_MAX characters, letters and
# digits, with spaces permitted but not leading, trailing or doubled.
PERSONALIZED_MAX = _LAW.plates.personalized_max
PERSONALIZED_CHARS = set(string.ascii_uppercase + string.digits)


def personalized_valid(text):
    """Whether a string is something the state would put on a plate."""
    if not text or len(text) > PERSONALIZED_MAX:
        return False
    if text != text.strip() or "  " in text:
        return False
    if any(c not in PERSONALIZED_CHARS and c != " " for c in text):
        return False
    # A personalized plate that reads as a sequential one is refused: it would
    # be indistinguishable from an issued plate to anything reading it.
    return not FORMATS.SEQUENTIAL_PLATE.fullmatch(text)


def personalized_plate(text):
    """Normalise a requested string, or None if it is not issuable."""
    cleaned = " ".join(str(text).upper().split())
    return cleaned if personalized_valid(cleaned) else None


# Sequential and therefore collision-free by construction, which is the reason
# these do not need the rejection loop `registration` runs for passenger plates:
# those are drawn from a dated position and can land twice.
municipal_plate = FORMATS.municipal_plate
school_bus_plate = FORMATS.school_bus_plate


# ---------------------------------------------------------------------------
# Vehicle identification numbers
# ---------------------------------------------------------------------------

# World manufacturer identifiers, weighted to what actually registers around
# the reference city: domestic pickups and mid-market Japanese and Korean sedans and
# crossovers. The WMI is the first three characters and it decides the make, so
# drawing it independently of the model would produce a Honda-built Silverado.
WMI = (
    ("1FT", "Ford truck", 90), ("1FA", "Ford car", 55),
    ("1GC", "Chevrolet truck", 70), ("1G1", "Chevrolet car", 45),
    ("1C4", "Jeep", 55), ("3C6", "Ram", 35),
    ("5NP", "Hyundai", 40), ("KNA", "Kia", 40),
    ("4T1", "Toyota (US-built)", 55), ("JTD", "Toyota (Japan-built)", 30),
    ("1HG", "Honda (US-built)", 60), ("JHM", "Honda (Japan-built)", 25),
    ("JN1", "Nissan", 35), ("3N1", "Nissan (Mexico-built)", 25),
    ("WBA", "BMW", 15), ("WDD", "Mercedes-Benz", 14),
    ("WVW", "Volkswagen", 16), ("5UX", "BMW (US-built)", 12),
    ("2T3", "Toyota (Canada-built)", 18), ("5YJ", "Tesla", 14),
    ("1N4", "Nissan (US-built)", 22), ("2HG", "Honda (Canada-built)", 16),
)

# Model year is position 10, and the code cycles every 30 years: the letters
# skipping I, O, Q, U, Z, then the digits. B is 1981 and also 2011, which is
# genuinely ambiguous on a real VIN and left that way here.
VIN_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789"

# Position 9 is a check digit, and positions 1-8 and 10-17 feed it. The
# transliteration skips I, O and Q entirely — they never appear in a VIN, which
# is why a random 17-character string is almost never a valid one.
VIN_ALPHABET = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ"
VIN_TRANSLITERATE = {c: v for c, v in zip(
    "ABCDEFGHJKLMNPRSTUVWXYZ",
    (1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 7, 9, 2, 3, 4, 5, 6, 7, 8, 9))}
VIN_WEIGHTS = (8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2)


def vin_check(vin):
    """The check character for a 17-character VIN.

    Sum of each character's numeric value times its positional weight, modulo
    11; a remainder of 10 is written as X. Computed rather than drawn, so every
    VIN this module emits passes a real validator.

    Position 9 carries weight 0, so whatever is sitting in the check position
    does not affect the result — which is why this can be called on a VIN that
    already has a check digit to verify it, and on one with a placeholder to
    compute it.
    """
    total = sum(
        (int(c) if c.isdigit() else VIN_TRANSLITERATE[c]) * weight
        for c, weight in zip(vin, VIN_WEIGHTS) if weight)
    remainder = total % 11
    return "X" if remainder == 10 else str(remainder)


def vin(model_year, rng, wmi=None):
    """A check-digit-valid VIN for a vehicle of `model_year`."""
    wmi = wmi or rng.choices([w[0] for w in WMI],
                             weights=[w[2] for w in WMI])[0]
    # Positions 4-8 are the manufacturer's own descriptor: body, engine,
    # restraint system. No public table maps them, so they are drawn — the
    # digits are opaque on a real VIN too.
    descriptor = "".join(rng.choice(VIN_ALPHABET) for _ in range(5))
    year = VIN_YEAR_CODES[(model_year - 1980) % 30]
    plant = rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ")
    serial = f"{rng.randrange(1_000_000):06d}"
    body = f"{wmi}{descriptor}0{year}{plant}{serial}"
    return body[:8] + vin_check(body) + body[9:]


# ---------------------------------------------------------------------------
# Bank accounts
# ---------------------------------------------------------------------------

# Institutions with retail branches in the city, weighted by deposit share,
# from the city's banks.csv.
# The routing numbers are generated rather than real — a real ABA number
# identifies a real bank, and there is no version of this data that is both
# accurate and safe to hand out. The prefixes keep the Federal Reserve district
# right (03 = Philadelphia, 02 = New York, 05 = Richmond) so the number still
# looks like it belongs to an institution operating here.
BANKS = city_data.banks()

# Chime, Varo, Cash App and the rest hold the accounts of people the branch
# banks do not reach, which in this city is a large and identifiable group:
# young, low-income, often no credit file. Worth separating because a neobank
# account has no branch, and anything asking "where does this person bank"
# gets a different kind of answer.
NEOBANKS = (
    ("Chime (The Bancorp Bank, N.A.)", "031", 60),
    ("Varo Bank, N.A.", "121", 20),
    ("Cash App (Sutton Bank)", "041", 45),
    ("Current (Choice Financial Group)", "091", 20),
)

ACCOUNT_TYPES = ("checking", "savings", "money_market", "certificate")


def routing_number(prefix, rng):
    """A nine-digit ABA number whose check digit is correct for its first eight.

    3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be a multiple of 10. Solved for
    d9 rather than rejection-sampled.
    """
    digits = [int(c) for c in prefix] + [rng.randint(0, 9) for _ in range(5)]
    weighted = (3 * (digits[0] + digits[3] + digits[6])
                + 7 * (digits[1] + digits[4] + digits[7])
                + digits[2] + digits[5])
    digits.append(-weighted % 10)
    return "".join(str(d) for d in digits)


def account_number(rng, length=None):
    """A bank account number. No check digit standard exists; length varies."""
    length = length or rng.choice((8, 9, 10, 10, 11, 12, 12, 13))
    return "".join(str(rng.randint(0, 9)) for _ in range(length))


# ---------------------------------------------------------------------------
# Court dockets
# ---------------------------------------------------------------------------

# Magisterial district courts inside the extract, with the share of the city's
# cases each hears, from the city's magisterial_districts.csv. Summary offences
# and the preliminary stage of every criminal case start here, so most people
# with any record at all have an MJ docket and nothing else.
MAGISTERIAL_DISTRICTS = city_data.magisterial_districts()

magisterial_docket = FORMATS.magisterial_docket


def common_pleas_docket(sequence, year, kind="CR"):
    """The county trial court's docket number, by judicial district."""
    return FORMATS.common_pleas_docket(JUDICIAL_DISTRICT, sequence, year, kind)


def federal_docket(sequence, year, kind="cr"):
    """`5:26-cr-00123` — the federal district court, prefixed by its division.

    Bankruptcy shares the format with its own `bk` code and a sequence that
    starts at 10000 for chapter 7 and 20000 for chapter 13, which is how a
    docket number alone tells you which chapter was filed.
    """
    return f"{FEDERAL_DIVISION}:{year % 100:02d}-{kind}-{sequence:05d}"


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

class Registries:
    """Every sequential series a build needs, allocated from one seed.

    Held together in one object because the series have to be shared: two
    stages that each built their own driver-licence allocator would issue the
    same numbers. Anything that needs a number takes this.
    """

    def __init__(self, seed, reference_year=REFERENCE_YEAR):
        self.rng = keyed(seed, "registries")
        self.reference_year = reference_year
        self.driver_licence = Series(DL_SERIES_START)
        self.ltcf = Series(LTCF_SERIES_START)
        # Court sequences restart every calendar year, so they are keyed on
        # (court, kind, year) and created on first use.
        self._dockets = {}
        self._licences = {}
        self._account_numbers = set()
        self._firearm_serials = set()

    def next_account_number(self, rng, length=None):
        """A unique number in the city-wide bank-account namespace."""
        while True:
            number = account_number(rng, length)
            if number not in self._account_numbers:
                self._account_numbers.add(number)
                return number

    def next_firearm_serial(self, rng):
        """A unique manufacturer serial for a firearm in the city."""
        alphabet = "ABCDEFGHJKLMNPRSTUVWXYZ"
        while True:
            serial = (f"{rng.choice(alphabet)}{rng.choice(alphabet)}"
                      f"{rng.randrange(10 ** 6):06d}")
            if serial not in self._firearm_serials:
                self._firearm_serials.add(serial)
                return serial

    def next_licence(self):
        """A state driver's license number."""
        # Stride, because the city is ~9% of its county and a fraction of a
        # percent of the state: consecutive numbers here would imply the state
        # issued nothing to anyone else.
        return FORMATS.licence_number(self.driver_licence.next(self.rng, jitter=180))

    def next_ltcf(self):
        """A county licence-to-carry number."""
        return f"{LTCF_PREFIX}{self.ltcf.next(self.rng, jitter=4):06d}"

    def next_licence_number(self, kind, year):
        """`2019-01843` — a county licence, numbered per year, not a docket.

        A marriage licence is issued by the Clerk of Orphans' Court and is not a
        court case: it has no docket, no parties and no disposition. It gets its
        own series so it does not consume docket numbers, which would leave gaps
        in the criminal sequence that nothing accounts for.
        """
        key = (kind, year)
        if key not in self._licences:
            self._licences[key] = Series(self.rng.randint(5, 60))
        return f"{year}-{self._licences[key].next(self.rng, jitter=3):05d}"

    def next_docket(self, court, year, kind="CR", district=None, base=0):
        """A docket number in the right series for `court`, `kind` and `year`.

        Sequences are per court per type per year and shared across every
        stage, which is what makes a docket number a usable join key: two
        cases with the same number are the same case.

        `base` offsets the start of a series, which bankruptcy needs: EDPA
        numbers chapter 7 petitions from 10000 and chapter 13 from 20000, so
        the docket number alone says which chapter was filed.
        """
        key = (court, kind, year, district, base)
        if key not in self._dockets:
            # Not from 1: by the time the year opens, other matters have
            # already been filed, and a city that always holds docket 1 is a
            # tell. Criminal filings in the reference county run ~1,700 a year
            # at Common Pleas and many times that at the magisterial courts.
            self._dockets[key] = Series(base + self.rng.randint(20, 400))
        sequence = self._dockets[key].next(self.rng, jitter=3)
        if court == "magisterial":
            return magisterial_docket(district, sequence, year, kind)
        if court == "common_pleas":
            return common_pleas_docket(sequence, year, kind)
        if court == "federal":
            return federal_docket(sequence, year, kind)
        raise ValueError(f"unknown court {court!r}")

    def magisterial_district(self, rng):
        """Which MDJ court would have heard a case from this city."""
        districts = [d for d, _ in MAGISTERIAL_DISTRICTS]
        weights = [w for _, w in MAGISTERIAL_DISTRICTS]
        return rng.choices(districts, weights=weights)[0]

    def bank(self, rng, neobank=False):
        """(name, routing number) for an institution operating here.

        The routing number is derived from the name so every account at the
        same bank shares one, which is the join that matters.
        """
        table = NEOBANKS if neobank else BANKS
        name, prefix, _ = rng.choices(
            table, weights=[w for _, _, w in table])[0]
        if name not in self._routing:
            self._routing[name] = routing_number(
                prefix, keyed(name, "routing"))
        return name, self._routing[name]

    _routing = {}


def main() -> None:
    """Show one of everything, which is the fastest way to spot a bad format."""
    rng = random.Random(7)
    registries = Registries(20260728)

    print("SSN by place of birth and card year:")
    home = (_LAW.state.pobp, _LAW.state.name)
    for pobp, label in (home, ("072", "Puerto Rico"),
                        ("036", "New York"), ("329", "Dominican Republic"),
                        home):
        for year in (1962, 1988, 2016):
            print(f"  {label:<20} {year}   {ssn(pobp, year, rng)}")
    print(f"  {'no status (ITIN)':<20} ----   {itin(rng)}")

    print("\nphone by year first assigned:")
    for year in (1985, 2003, 2019, 2026):
        print(f"  {year}  landline {phone(year, rng, wireless=False)}   "
              f"mobile {phone(year, rng)}")

    print("\ndriver license:", ", ".join(
        registries.next_licence() for _ in range(4)))

    print("\nplate by registration year:")
    for year in (2015, 2021, 2024, 2026):
        print(f"  {year}  " + ", ".join(
            plate(plate_index(year, rng)) for _ in range(4)))

    print("\nVIN by model year (check digit computed):")
    for year in (2004, 2013, 2022, 2026):
        number = vin(year, rng)
        ok = vin_check(number) == number[8]
        print(f"  {year}  {number}  check {'ok' if ok else 'FAIL'}")

    print("\nbanks:")
    for neobank in (False, True):
        for _ in range(3):
            name, routing = registries.bank(rng, neobank)
            print(f"  {name:<44} {routing}  "
                  f"{account_number(rng)}  {rng.choice(ACCOUNT_TYPES)}")

    print("\ndockets:")
    district = registries.magisterial_district(rng)
    print("  " + registries.next_docket("magisterial", 2026, "CR", district))
    print("  " + registries.next_docket("magisterial", 2026, "NT", district))
    print("  " + registries.next_docket("common_pleas", 2026, "CR"))
    print("  " + registries.next_docket("common_pleas", 2019, "CV"))
    print("  " + registries.next_docket("common_pleas", 2026, "DR"))
    print("  " + registries.next_docket("federal", 2026, "cr"))
    print("  " + registries.next_docket("federal", 2024, "bk"))
    print("\nlicense to carry:", ", ".join(
        registries.next_ltcf() for _ in range(4)))


if __name__ == "__main__":
    main()
