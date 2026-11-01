"""Decide who is on which messaging platform, and which threads they share.

devices.py gave everybody an endpoint. This stage decides what they can be
reached *on*, which is a different question and a much more demographic one. A
phone number is universal; a Snapchat account is not, and the shape of who has
one is most of what makes a communications dataset look like a real city
rather than a uniform mixture.

Not six independent coin flips
------------------------------
The obvious implementation draws each platform separately at its published
national rate. It produces a city where every combination of apps occurs in
proportion to the product of its parts, which is wrong in three ways that all
matter, and each correction is a pass here.

    base        adoption keyed on the demographics that actually drive it,
                which is not the same set for every platform. Snapchat is a
                cliff in age and almost nothing else. WhatsApp barely moves
                with age at all and moves enormously with where somebody was
                born. Signal moves with education and income and with nothing
                a survey of the general public would find interesting.
    breadth     one latent trait per person, so the number of apps somebody
                has is not a binomial draw. Real people cluster at "one app"
                and at "all of them", and the middle is thinner than
                independence predicts.
    contagion   an app is useless unless the people you talk to have it. One
                pass over ties.bin lifts adoption by the share of a person's
                high-affinity contacts already on the platform, which is what
                turns three defensible marginal distributions into the clumps
                a real city has — WhatsApp concentrated in particular families
                and street networks rather than sprinkled evenly over everyone
                who matches a demographic profile.

The contagion pass is the one that would be hardest to add later and the one
that changes the output most. Without it the marginals are right and every
join is wrong: a household where the parents are on WhatsApp and the children
are not, over and over, city-wide.

Calibration, and why it is an intercept
---------------------------------------
Each platform has a published national reach and a set of relative effects
that are much better evidenced than the level. Multiplying a base rate by four
adjustment factors gives a number that matches no published figure at all, so
instead the effects are applied as log-odds and a single intercept per
platform is solved by bisection until the realised city-wide share hits the
target. The effects keep their shape, the level comes out where it should, and
the intercepts are written into the output so the calibration is inspectable
rather than implicit. ties.py does the same thing for the same reason.

Where the numbers come from
---------------------------
Reach and the age gradients are Pew Research Center's social media use
figures; the WhatsApp ethnicity and nativity gradients are from the same
source's breakdowns, which are unusually large for that platform and are the
single most load-bearing input in this file. Everything else — the breadth
trait, the contagion weight, the handle formats, the share of accounts whose
display name is not the owner's real name — is modelled, has no survey behind
it, and is named in NOTICES.md as such.

Two things this stage deliberately does not do
----------------------------------------------
**iMessage is not adopted.** It is not a platform anyone chooses; it is what
happens when both ends are Apple. So it gets an account for every iOS handset
and no draw at all. It matters more than any modelled platform here: at 53%
iOS these handsets pair iPhone-to-iPhone about 28% of the time, and every one
of those exchanges leaves the carrier's SMS records for a data session that
names no correspondent. A city modelled without it has roughly twice the SMS
traffic a real operator would log.

**Carrier channels get one account, not three.** SMS, MMS and voice share an
identifier — the number — because on the carrier that is what you are. Three
rows would be three names for one identity and would make the account table
say something false about how many handles a person has.

Groups are built here, dyads are not
------------------------------------
A group conversation has a membership that outlives any day it was busy on, so
it is a static object and belongs beside the accounts. It is built from the
structures that already exist — a household, a family, a work unit, a
congregation — rather than by clustering the tie graph, because those are
where real group chats actually come from and clustering would invent
committees nobody is on.

A dyad needs none of this. Its membership is the pair, its channel follows
from what the two share, and its identity can be derived wherever it is needed
without being written down. Storing ninety thousand two-row conversations
would be storing the tie graph a second time.
"""

import argparse
import json
import math
import struct
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import registries  # noqa: E402


from paths import SIM_DATA  # noqa: E402
POPULATION = SIM_DATA / "population.json"
IDENTITY = SIM_DATA / "identity.json"
DEVICES = SIM_DATA / "devices.json"
AFFILIATIONS = SIM_DATA / "affiliations.json"
KINSHIP = SIM_DATA / "kinship.json"
TIES = SIM_DATA / "ties.bin"
OUTPUT = SIM_DATA / "accounts.json"

DEFAULT_SEED = 20260728
TODAY = registries.REFERENCE_DATE

# The youngest age anybody here holds an account of their own. Below it a child
# may well use a parent's device, which is a different fact and one this layer
# has no way to express — an account is an identity, and borrowing a phone
# does not create one.
MIN_AGE = 10


# ---------------------------------------------------------------------------
# The platforms, and what moves adoption on each
# ---------------------------------------------------------------------------

# Age gradients as (upper bound inclusive, share). Read in order; the last
# entry catches everyone older. These are the shape of the effect, not its
# level — the intercept solve below rescales all of them together.
#
# `odds` are multiplicative on the odds, applied against a reference category
# of 1.0. They are relative effects and survive the rescaling unchanged, which
# is the entire reason for working in log-odds rather than in probabilities.
PLATFORMS = (
    {
        "name": "messenger",
        # The only platform with genuine mass reach across the whole adult age
        # range, and the reason a city modelled on Snapchat and WhatsApp alone
        # has no traffic at all between the over-fifties.
        "target": 0.61,
        "age": ((17, 0.52), (29, 0.70), (49, 0.72), (64, 0.62), (999, 0.43)),
        "odds": {"female": 1.35},
    },
    {
        "name": "snapchat",
        # The sharpest age cliff of anything here: two thirds of people under
        # thirty and almost nobody over sixty-five. If one number in this file
        # is visibly right in the output, it should be this one.
        "target": 0.27,
        "age": ((17, 0.62), (29, 0.65), (49, 0.30), (64, 0.12), (999, 0.04)),
        "odds": {"female": 1.25},
    },
    {
        "name": "whatsapp",
        # Nearly flat in age and enormous in nativity. A foreign-born resident
        # of this city is several times more likely to be on it than a
        # US-born one of the same age, because what it is for here is talking
        # to people who are not here.
        "target": 0.29,
        "age": ((17, 0.24), (29, 0.38), (49, 0.36), (64, 0.22), (999, 0.14)),
        "odds": {
            "hispanic": 2.9,
            "nh_black": 1.4,
            "nh_asian": 2.6,
            "foreign_born": 3.4,
            # Somebody who arrived recently still has a live network abroad;
            # somebody who came as a child mostly does not.
            "recent_arrival": 1.6,
        },
    },
    {
        "name": "telegram",
        # Small, male-skewed, and concentrated in particular diasporas rather
        # than spread thinly. The regional effects are what stop it landing as
        # uniform noise across the whole city.
        "target": 0.09,
        "age": ((17, 0.07), (29, 0.16), (49, 0.11), (64, 0.05), (999, 0.02)),
        "odds": {
            "male": 1.7,
            "europe": 3.2,
            "middle_east": 3.6,
            "south_asia": 1.6,
            "central_america": 0.6,
            "degree": 1.3,
        },
    },
    {
        "name": "signal",
        # The one platform whose adoption is essentially an occupational and
        # educational fact. Nothing about age explains it once those are in.
        "target": 0.06,
        "age": ((17, 0.03), (29, 0.09), (49, 0.08), (64, 0.04), (999, 0.02)),
        "odds": {
            "degree": 2.4,
            "tech": 3.8,
            "high_income": 1.7,
        },
    },
)

# Census OCCP range for computer and mathematical occupations, which is the
# `tech` term above. Narrow on purpose: an engineer is not a Signal user by
# virtue of being an engineer, and widening this to all of ENG or SCI puts the
# platform's whole population in the wrong place.
TECH_OCCUPATIONS = (1005, 1240)

# EDUCATION >= this is a bachelor's degree or better in the ACS SCHL coding.
DEGREE = 21

# Household income above which `high_income` applies. Roughly twice this
# city's median, which is where the effect is actually visible.
HIGH_INCOME = 120_000

# Arrived within this many years of the reference year.
RECENT_YEARS = 12


# ---------------------------------------------------------------------------
# Breadth and contagion
# ---------------------------------------------------------------------------

# How much of the variation in "how many apps has this person got" is a person
# rather than a draw. Applied as a log-odds shift common to every platform, so
# it correlates adoption across platforms without touching any marginal.
#
# Modelled. Nothing measures this directly; the value is set so that the joint
# distribution of app counts has visible mass at both ends rather than the
# binomial hump independence would give.
BREADTH_SD = 0.85

# How hard a person's contacts pull them onto a platform, in log-odds per unit
# of "share of my close ties who are already on it". Large, because the effect
# is large: a messaging app with none of your people on it has no use at all.
CONTAGION = 2.6

# The affinity above which a tie counts as somebody you would actually want to
# message. Below it a tie is a colleague you nod at, and their app choice does
# not move yours.
CONTAGION_FLOOR = 0.35


# ---------------------------------------------------------------------------
# Handles
# ---------------------------------------------------------------------------

# Share of accounts whose display name is not the holder's real name, per
# platform. Modelled, and deliberately not uniform: Facebook has spent twenty
# years enforcing real names and Snapchat never has.
PSEUDONYMOUS = {
    "messenger": 0.06,
    "whatsapp": 0.11,
    "telegram": 0.44,
    "signal": 0.19,
    "snapchat": 0.71,
}

# Share of Telegram accounts that have set a public @username at all. The rest
# are reachable only by a number they have almost certainly hidden, which is
# the difficulty that platform actually presents.
TELEGRAM_USERNAME = 0.58

HANDLE_WORDS = (
    "blue", "iron", "quiet", "north", "silver", "red", "little", "old", "fast",
    "dark", "green", "wild", "lone", "true", "gold", "grey", "bright", "small",
    "fox", "wolf", "crow", "hawk", "bear", "moth", "pike", "owl", "hare",
    "river", "stone", "ridge", "creek", "hill", "vale", "moor", "bay",
    "south", "east", "west", "black", "white", "cold", "lucky", "lazy", "sly",
    "happy", "sunny", "rusty", "dusty", "misty", "stormy", "frosty", "big",
    "tiny", "brave", "calm", "swift", "odd", "cool", "salty", "sweet",
    "tiger", "lion", "raven", "eagle", "otter", "badger", "falcon", "viper",
    "shark", "panda", "kitty", "pup", "duck", "goose", "deer", "moose",
    "lake", "pine", "oak", "maple", "cedar", "field", "forest", "harbor",
    "storm", "rain", "snow", "cloud", "sky", "star", "moon", "sun", "fire",
    "ghost", "shadow", "rocket", "pixel", "ninja", "king", "queen", "boss",
    "chef", "rider", "hunter", "dreamer", "gamer", "skater", "baker",
)


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

# Chance a structure that could have a group chat actually has one. A household
# of four does not necessarily have a family thread; a work unit of nine
# usually does, because somebody has to cover shifts.
GROUP_RATE = {
    "household": 0.58,
    "kin": 0.44,
    "work": 0.72,
    "worship": 0.35,
    "gym": 0.22,
    "sports": 0.66,
    "civic": 0.48,
    "fraternal": 0.41,
    "union": 0.30,
    "school": 0.52,
    "youth": 0.58,
}

# A group needs this many members with a shared platform to be worth creating,
# and is split rather than created above the upper bound — a real "group chat"
# of four hundred people is a broadcast list, and is recorded as one.
MIN_GROUP = 3
MAX_GROUP = 48

# Above this size the thread is a notice board and nobody replies to it.
BROADCAST_ABOVE = 60

# Share of a candidate group that has to be on a messenger before the thread
# runs there and the rest are left out. Modelled. Below it the group has no
# common app and falls back to the number everybody has.
ALTERNATIVE_SHARE = 0.7


class Rng:
    """The same mulberry32 stream the simulation uses, keyed the same way.

    Written out here rather than imported because init is NumPy-and-stdlib by
    policy, and because a stage that draws per person wants the identical
    stream discipline the runtime has: a draw keyed on who it is about, so
    adding a platform next month cannot reshuffle the accounts this month
    already produced.
    """

    __slots__ = ("state",)

    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def next(self):
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.state
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def bool(self, probability):
        return self.next() < probability

    def between(self, low, high):
        return low + self.next() * (high - low)

    def int(self, low, high):
        return int(self.between(low, high + 1))

    def pick(self, items):
        return items[int(self.next() * len(items))]

    def gauss(self, mean=0.0, sigma=1.0):
        u = max(1e-12, self.next())
        v = self.next()
        return mean + sigma * math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)


def avalanche(x):
    x &= 0xFFFFFFFF
    x = ((x ^ (x >> 16)) * 0x7FEB352D) & 0xFFFFFFFF
    x = ((x ^ (x >> 15)) * 0x846CA68B) & 0xFFFFFFFF
    return (x ^ (x >> 16)) & 0xFFFFFFFF


def mix(*keys):
    h = 0x9E3779B9
    for key in keys:
        h = avalanche(h ^ (key & 0xFFFFFFFF))
    return h


def stream(seed, *keys):
    return Rng(mix(seed, *keys))


LAYER_ADOPT = 1
LAYER_HANDLE = 2
LAYER_BREADTH = 3
LAYER_GROUP = 4
LAYER_UNIQUE = 5


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def sigmoid(x):
    if x < -35:
        return 0.0
    if x > 35:
        return 1.0
    return 1 / (1 + math.exp(-x))


# ---------------------------------------------------------------------------
# Reading what earlier stages wrote
# ---------------------------------------------------------------------------

def read_ties():
    """The tie graph, as (a, b, affinity) for ties inside the population.

    Only what the contagion pass needs. External stubs are dropped here — a
    contact who is not in the city has no account row to be influenced by and
    cannot influence anybody — and negative ties are dropped because an
    estrangement does not recommend an app.
    """
    blob = TIES.read_bytes()
    if blob[:4] != b"KTIE":
        raise SystemExit("ties.bin is not a KTIE file")
    length = struct.unpack_from("<I", blob, 4)[0]
    header = json.loads(blob[8:8 + length])
    offset = 8 + length
    offset += -offset % 8

    count = header["edges"]
    columns = {}
    for column in header["columns"]:
        dtype = column["dtype"]
        size = int(dtype[-1])
        width = size * count
        columns[column["name"]] = (dtype, blob[offset:offset + width])
        offset += width

    def ints(name, fmt):
        return struct.unpack_from(f"<{count}{fmt}", columns[name][1], 0)

    a = ints("a", "i")
    b = ints("b", "i")
    affinity = ints("affinity", "B")
    valence = ints("valence", "b")
    external = header["external_base"]

    edges = []
    for i in range(count):
        if valence[i] < 0:
            continue
        if a[i] >= external or b[i] >= external:
            continue
        if affinity[i] < CONTAGION_FLOOR * 255:
            continue
        edges.append((a[i], b[i], affinity[i] / 255))
    return edges, header


def load_people(population, identity):
    """Everything adoption keys on, flattened into one row per person."""
    identities = identity["identities"]
    households = {row["id"]: row for row in population["household_records"]}
    people = {}
    for row in population["person_records"]:
        if row["age"] < MIN_AGE or row.get("incarcerated"):
            continue
        record = identities.get(str(row["id"])) or identities.get(row["id"])
        household = households.get(row["household"])
        people[row["id"]] = {
            "id": row["id"],
            "age": row["age"],
            "sex": row["sex"],
            "ethnicity": row["race_ethnicity"],
            "education": row["education"] or 0,
            "occupation": row["occupation"],
            "income": (household or {}).get("income") or 0,
            "region": (record or {}).get("birth_region", "us"),
            "citizenship": (record or {}).get("citizenship", "born_us"),
            "entry_year": (record or {}).get("entry_year"),
            "first_name": (record or {}).get("first_name", ""),
            "surname": (record or {}).get("surname", ""),
        }
    return people


def load_lines(devices):
    """Each person's subscription and the platform of the handset behind it.

    Both facts are needed and they come from different tables: the number is
    the handle every phone-anchored account uses, and the platform is what
    decides iMessage. A person with no line gets no accounts at all, which is
    correct — every platform here is bootstrapped from a phone number.
    """
    handsets = {}
    for rows in devices["devices"].values():
        for row in rows:
            handsets[row["imei"]] = row

    lines = {}
    for person, rows in devices["subscriptions"].items():
        person = int(person)
        for row in rows:
            if person in lines and not row.get("primary"):
                continue
            handset = handsets.get(row["handset"])
            lines[person] = {
                "msisdn": row["msisdn"],
                "platform": (handset or {}).get("platform", "android"),
            }
    return lines


# ---------------------------------------------------------------------------
# Adoption
# ---------------------------------------------------------------------------

def age_base(curve, age):
    for upper, share in curve:
        if age <= upper:
            return share
    return curve[-1][1]


def score(platform, person):
    """Log-odds of adoption before the intercept and before contagion."""
    total = logit(age_base(platform["age"], person["age"]))
    odds = platform["odds"]
    foreign = person["citizenship"] != "born_us" or person["region"] != "us"

    def apply(key, condition):
        if condition and key in odds:
            return math.log(odds[key])
        return 0.0

    total += apply("female", person["sex"] == 2)
    total += apply("male", person["sex"] == 1)
    total += apply("hispanic", person["ethnicity"] == "hispanic")
    total += apply("nh_black", person["ethnicity"] == "nh_black")
    total += apply("nh_asian", person["ethnicity"] == "nh_asian")
    total += apply("foreign_born", foreign)
    total += apply("recent_arrival",
                   bool(person["entry_year"])
                   and registries.REFERENCE_YEAR - person["entry_year"] <= RECENT_YEARS)
    total += apply(person["region"], True)
    total += apply("degree", person["education"] >= DEGREE)
    total += apply("high_income", person["income"] >= HIGH_INCOME)
    occupation = person["occupation"]
    code = int(occupation) if occupation and occupation.isdigit() else -1
    total += apply("tech", TECH_OCCUPATIONS[0] <= code <= TECH_OCCUPATIONS[1])
    return total


def solve_intercept(scores, target):
    """Bisect for the shift that puts the mean predicted share on target.

    Monotone in the intercept, so bisection converges in forty iterations and
    needs no derivative. Solving for the *mean probability* rather than for
    the realised count is deliberate: the draw is keyed per person and adding
    a platform must not change any other platform's draws, which it would if
    the intercept were fitted to a sampled outcome.
    """
    low, high = -25.0, 25.0
    for _ in range(60):
        middle = (low + high) / 2
        mean = sum(sigmoid(s + middle) for s in scores) / max(len(scores), 1)
        if mean < target:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def adopt(people, lines, edges, seed):
    """Who is on what, in three passes.

    The contagion pass re-solves each intercept afterwards. Without that step
    it would lift every platform's share above its target — the boost is
    one-sided — and the published reach figures would stop holding.
    """
    ids = [i for i in people if i in lines]
    breadth = {i: stream(seed, i, LAYER_BREADTH).gauss(0, BREADTH_SD) for i in ids}

    neighbours = defaultdict(list)
    for a, b, affinity in edges:
        if a in people and b in people:
            neighbours[a].append((b, affinity))
            neighbours[b].append((a, affinity))

    intercepts = {}
    held = {}
    for index, platform in enumerate(PLATFORMS):
        name = platform["name"]
        raw = {i: score(platform, people[i]) + breadth[i] for i in ids}
        intercepts[name] = solve_intercept(list(raw.values()), platform["target"])

        first = set()
        for i in ids:
            if stream(seed, i, LAYER_ADOPT, index).bool(sigmoid(raw[i] + intercepts[name])):
                first.add(i)

        # Contagion. Weighted by affinity, so the people you actually talk to
        # decide this and not the twelve colleagues you are merely near.
        pull = {}
        for i in ids:
            mine = neighbours.get(i)
            if not mine:
                pull[i] = 0.0
                continue
            total = sum(affinity for _, affinity in mine)
            on = sum(affinity for other, affinity in mine if other in first)
            pull[i] = on / total if total else 0.0

        adjusted = {i: raw[i] + CONTAGION * pull[i] for i in ids}
        intercepts[name] = solve_intercept(list(adjusted.values()), platform["target"])
        final = set()
        for i in ids:
            if stream(seed, i, LAYER_ADOPT, index, 1).bool(sigmoid(adjusted[i] + intercepts[name])):
                final.add(i)
        held[name] = final

    return held, intercepts


# ---------------------------------------------------------------------------
# Handles and display names
# ---------------------------------------------------------------------------

def e164(msisdn):
    digits = "".join(c for c in msisdn if c.isdigit())
    return f"+1{digits}"


def invented_handle(rng, person):
    word = rng.pick(HANDLE_WORDS)
    other = rng.pick(HANDLE_WORDS)
    shape = rng.next()
    if shape < 0.26:
        return f"{word}{other}{rng.int(1, 999)}"
    if shape < 0.40:
        return f"{word}_{other}"
    if shape < 0.52:
        return f"{word}.{other}{rng.int(1, 99)}"
    if shape < 0.72:
        first = (person["first_name"] or "x").lower()
        return f"{first}{rng.int(1, 9999)}"
    if shape < 0.84:
        first = (person["first_name"] or "x").lower()
        return f"{first}_{word}{rng.int(1, 99)}"
    initial = (person["first_name"] or "x")[:1].lower()
    return f"{initial}{(person['surname'] or 'x').lower()}{rng.int(1, 999)}"


# Handles that are a phone number. Unique by construction, one number per line,
# so the uniqueness pass leaves them alone.
NUMBER_HANDLES = {"sms", "whatsapp", "signal"}


def unique_handle(row, taken, seed, person_id):
    """Make `row`'s handle unique on its platform, in place.

    A username, an Apple ID and a numeric platform id each identify one account
    on one platform. A clash is resolved from a separate keyed stream so it
    does not shift the person's other draws: a username or Apple ID gets a
    numeric suffix, a numeric id is redrawn in its own range.
    """
    channel, handle = row["channel"], row["handle"]
    seen = taken[channel]
    if channel in NUMBER_HANDLES or handle.startswith("+"):
        seen.add(handle)
        return
    attempt = 0
    candidate = handle
    while candidate in seen:
        rng = stream(seed, person_id, LAYER_UNIQUE, attempt)
        attempt += 1
        # Wider suffixes as attempts accumulate, so the loop always ends.
        width = 10 ** min(9, 2 + attempt // 4)
        if handle.isdigit():
            candidate = str(rng.int(10 ** (len(handle) - 1),
                                    10 ** len(handle) - 1))
        elif "@" in handle and not handle.startswith("@"):
            local, domain = handle.split("@", 1)
            candidate = f"{local}{rng.int(1, width - 1)}@{domain}"
        else:
            candidate = f"{handle}{rng.int(1, width - 1)}"
    seen.add(candidate)
    if candidate != handle:
        if row["display_name"] == handle.lstrip("@"):
            row["display_name"] = candidate.lstrip("@")
        row["handle"] = candidate


def account_for(name, person, line, rng, created):
    """One account row, with the identifier that platform actually uses."""
    real = f"{person['first_name']} {person['surname']}".strip()
    pseudo = rng.bool(PSEUDONYMOUS.get(name, 0.0))
    handle_name = invented_handle(rng, person)

    if name == "whatsapp" or name == "signal":
        handle = e164(line["msisdn"])
    elif name == "imessage":
        # Either the number or an Apple ID, and which one it is decides
        # whether a lookup finds anything.
        handle = e164(line["msisdn"]) if rng.bool(0.72) else \
            f"{(person['first_name'] or 'x').lower()}.{(person['surname'] or 'x').lower()}@icloud.com"
    elif name == "telegram":
        # A numeric user id always; a public @username only sometimes. The id
        # is what the platform joins on and is not something a correspondent
        # ever sees, which is exactly the difficulty.
        handle = f"@{handle_name}" if rng.bool(TELEGRAM_USERNAME) else str(rng.int(100_000_000, 799_999_999))
    elif name == "messenger":
        handle = str(rng.int(100_000_000_000_000, 999_999_999_999_999))
    elif name == "snapchat":
        handle = handle_name
    else:
        handle = e164(line["msisdn"])

    display = handle_name if pseudo else real
    return {
        "channel": name,
        "handle": handle,
        "display_name": display,
        "line": line["msisdn"],
        "created": created,
    }


def draw_date(rng, start):
    """A day drawn uniformly between `start` and today, as yyyymmdd.

    Nothing this stage writes may be dated after the day the file describes,
    and the only way to guarantee that is to draw the day rather than the year
    — a year drawn as 2026 and a month drawn inside it is in the future half
    the time, because today is the first of July.
    """
    if start > TODAY:
        start = TODAY
    day = date.fromordinal(rng.int(start.toordinal(), TODAY.toordinal()))
    return day.year * 10000 + day.month * 100 + day.day


def created_date(rng, person, earliest):
    """When the account was opened.

    Three bounds, and the draw runs over the days between them rather than
    picking a year and then a month inside it. The old draw picked the year
    first and could only clamp it at the reference year, which put every
    account opened in 2026 uniformly across twelve months of a year that is
    half over — three per cent of the city held an account opened after the
    day the file describes, some of them in 2028.

    Old enough to open one means thirteen, which is what the platforms ask
    for. The holders between MIN_AGE and thirteen could not clear that bar at
    all and were the source of the dates furthest in the future: they are on a
    parent's word rather than the platform's, so their floor is MIN_AGE and
    their accounts are all recent.
    """
    born = registries.REFERENCE_YEAR - person["age"]
    eligible = born + (13 if born + 13 <= registries.REFERENCE_YEAR else MIN_AGE)
    return draw_date(rng, date(max(earliest, eligible), 1, 1))


# Year each platform became available to an ordinary person in this country.
# An account older than its platform is the kind of detail a consumer checks.
LAUNCHED = {
    "sms": 2003, "imessage": 2011, "messenger": 2011, "whatsapp": 2010,
    "telegram": 2014, "signal": 2015, "snapchat": 2012,
}


def build_accounts(people, lines, held, seed):
    accounts = defaultdict(list)
    # Usernames already issued, per platform. People are taken in id order so
    # which of two clashing accounts keeps the bare name does not depend on the
    # order the device file lists lines in.
    taken = defaultdict(set)

    def add(person_id, row):
        unique_handle(row, taken, seed, person_id)
        accounts[person_id].append(row)

    for person_id, line in sorted(lines.items()):
        person = people.get(person_id)
        if person is None:
            continue
        rng = stream(seed, person_id, LAYER_HANDLE)

        # The carrier identity: one account, because SMS, MMS and voice are
        # one identity on the network and that identity is the number.
        add(person_id,
            account_for("sms", person, line, rng, created_date(rng, person, LAUNCHED["sms"])))

        # iMessage is not adopted, it is inherited from the hardware.
        if line["platform"] == "ios":
            add(person_id,
                account_for("imessage", person, line, rng,
                            created_date(rng, person, LAUNCHED["imessage"])))

        for platform in PLATFORMS:
            name = platform["name"]
            if person_id not in held[name]:
                continue
            add(person_id,
                account_for(name, person, line, rng,
                            created_date(rng, person, LAUNCHED[name])))
    return accounts


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------

def candidate_groups(population, affiliations, kinship, people):
    """The structures that could plausibly have a thread, before any draw.

    Read off the objects that already exist rather than clustered out of the
    tie graph. A household is a household; a work unit is the twelve people on
    one shift at one site. Both are real groupings whose members have a reason
    to be in a thread together, and neither has to be inferred.
    """
    groups = []

    members = defaultdict(list)
    for row in population["person_records"]:
        if row["id"] in people:
            members[row["household"]].append(row["id"])
    for household, ids in members.items():
        if len(ids) >= MIN_GROUP:
            groups.append(("household", f"hh:{household}", sorted(ids)))

    # Extended family: a household's members plus their parents and children
    # living elsewhere, which is what a family thread actually spans.
    parents = kinship.get("parents") or {}
    family = defaultdict(set)
    for child, rows in parents.items():
        child = int(child)
        if child not in people:
            continue
        for row in rows:
            parent = row.get("id") if isinstance(row, dict) else row
            if parent is None or parent not in people:
                continue
            key = min(child, parent)
            family[key].add(child)
            family[key].add(parent)
    for key, ids in family.items():
        if len(ids) >= MIN_GROUP:
            groups.append(("kin", f"kin:{key}", sorted(ids)))

    units = defaultdict(list)
    classes = {}
    for row in affiliations["affiliation_records"]:
        if row["person"] not in people:
            continue
        key = (row["org"], row["unit"])
        units[key].append(row["person"])
        classes[key] = row["class"]
    for key, ids in units.items():
        if len(ids) < MIN_GROUP:
            continue
        groups.append((classes[key], f"u:{key[0]}/{key[1]}", sorted(set(ids))))

    return groups


def build_groups(candidates, accounts, seed):
    """Turn candidate structures into conversations on a channel they share.

    The channel is the constraint that does the work. A group exists only if
    enough of its members are on one platform, and the platform it lands on is
    whichever the membership actually shares — which is why the family thread
    of a recently arrived household is on WhatsApp and the work unit at the
    warehouse is a group MMS.
    """
    on = {}
    for person, rows in accounts.items():
        on[person] = {row["channel"] for row in rows}

    conversations = []
    for focus, key, ids in candidates:
        rng = stream(seed, mix(*(i & 0xFFFF for i in ids[:8])), LAYER_GROUP)
        if not rng.bool(GROUP_RATE.get(focus, 0.35)):
            continue

        counts = Counter()
        for person in ids:
            counts.update(on.get(person, ()))
        if not counts:
            continue

        # Which platform the thread runs on, and this is the one decision here
        # that cannot be made on coverage alone. Everybody has a number, so SMS
        # always covers the whole group and always wins a straight count —
        # which would put every family and every work crew in this city on
        # group MMS, a thing almost nobody actually uses.
        #
        # What really happens is that a group forms on the app most of it
        # already has and the remainder are simply left out. So an alternative
        # only has to cover most of the membership to take it, and the people
        # without that app are not in the thread. SMS is the floor for a group
        # with no shared app rather than the default for a group with one.
        alternatives = [(count, name) for name, count in counts.items() if name != "sms"]
        best = "sms"
        if alternatives:
            count, name = max(alternatives)
            if count >= ALTERNATIVE_SHARE * len(ids) and count >= MIN_GROUP:
                best = name
        members = [person for person in ids if best in on.get(person, ())]
        if len(members) < MIN_GROUP:
            continue

        # An oversized unit is not one thread. Above the broadcast bound it is
        # a notice board; between the group cap and there it is split into
        # threads of a workable size, which is what a large workplace has.
        if len(members) > BROADCAST_ABOVE:
            conversations.append(conversation(focus, key, best, members[:400], "broadcast", rng))
            continue
        for start in range(0, len(members), MAX_GROUP):
            chunk = members[start:start + MAX_GROUP]
            if len(chunk) < MIN_GROUP:
                break
            suffix = "" if start == 0 else f"#{start // MAX_GROUP + 1}"
            conversations.append(conversation(focus, key + suffix, best, chunk, "group", rng))
    return conversations


GROUP_TITLES = {
    "household": ("Home", "House", "The {surname}s", "Family"),
    "kin": ("Family", "The {surname}s", "Fam", "Family chat"),
    "work": ("Shift", "Crew", "Team", "Work", "Rota"),
    "school": ("Class", "Homework", "Year group"),
    "worship": ("Fellowship", "Prayer", "Group"),
    "sports": ("Team", "Squad", "Match day"),
    "gym": ("Training", "Gym"),
    "civic": ("Committee", "Volunteers"),
    "fraternal": ("Lodge", "Chapter"),
    "union": ("Local", "Members"),
    "youth": ("Troop", "Club"),
}


def conversation(focus, key, channel, members, kind, rng):
    titles = GROUP_TITLES.get(focus, ("Group",))
    return {
        "kind": kind,
        "channel": channel,
        "focus": focus,
        "external_id": key,
        "title": rng.pick(titles),
        "participants": members,
        "created": draw_date(rng, date(registries.REFERENCE_YEAR - 8, 1, 1)),
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def report(people, accounts, conversations, held, intercepts):
    total = len(accounts)
    print(f"{total:,} people with at least one account, "
          f"{sum(len(v) for v in accounts.values()):,} accounts\n")

    print("platform reach vs target")
    for platform in PLATFORMS:
        name = platform["name"]
        ids = held[name]
        share = len(ids) / max(total, 1)
        print(f"  {name:<10} {share * 100:5.1f}%  target {platform['target'] * 100:4.1f}%  "
              f"intercept {intercepts[name]:+.2f}")

    bands = ((10, 17), (18, 29), (30, 49), (50, 64), (65, 200))
    labels = [f"{a}-{b}" if b < 200 else f"{a}+" for a, b in bands]
    print("\nby age")
    print("  " + "".ljust(12) + "".join(label.rjust(9) for label in labels))
    for platform in PLATFORMS:
        name = platform["name"]
        row = f"  {name:<10}"
        for low, high in bands:
            cohort = [i for i, p in people.items() if low <= p["age"] <= high]
            if not cohort:
                row += f"{'-':>9}"
                continue
            share = sum(1 for i in cohort if i in held[name]) / len(cohort)
            row += f"{share * 100:8.1f}%"
        print(row)

    print("\nWhatsApp by nativity")
    for label, test in (("US-born", lambda p: p["citizenship"] == "born_us"),
                        ("foreign-born", lambda p: p["citizenship"] != "born_us")):
        cohort = [i for i, p in people.items() if test(p)]
        if not cohort:
            continue
        share = sum(1 for i in cohort if i in held["whatsapp"]) / len(cohort)
        print(f"  {label:<14} {share * 100:5.1f}%  ({len(cohort):,} people)")

    counts = Counter(len(rows) for rows in accounts.values())
    print("\naccounts per person")
    for n in sorted(counts):
        print(f"  {n}  {counts[n]:>7,}  {'#' * round(counts[n] / max(counts.values()) * 40)}")

    print(f"\n{len(conversations):,} group conversations")
    by_channel = Counter(c["channel"] for c in conversations)
    for channel, count in by_channel.most_common():
        print(f"  {channel:<10} {count:>6,}")
    sizes = sorted(len(c["participants"]) for c in conversations)
    if sizes:
        print(f"  size: median {sizes[len(sizes) // 2]}, "
              f"p90 {sizes[int(len(sizes) * 0.9)]}, max {sizes[-1]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()

    for path in (POPULATION, IDENTITY, DEVICES, AFFILIATIONS, KINSHIP, TIES):
        if not path.exists():
            raise SystemExit(f"{path.name} is missing — run the earlier stages first")

    population = json.loads(POPULATION.read_text())
    identity = json.loads(IDENTITY.read_text())
    devices = json.loads(DEVICES.read_text())
    affiliations = json.loads(AFFILIATIONS.read_text())
    kinship = json.loads(KINSHIP.read_text())
    edges, _ = read_ties()

    people = load_people(population, identity)
    lines = load_lines(devices)
    lines = {person: line for person, line in lines.items() if person in people}
    held, intercepts = adopt(people, lines, edges, args.seed)
    accounts = build_accounts(people, lines, held, args.seed)
    candidates = candidate_groups(population, affiliations, kinship, people)
    conversations = build_groups(candidates, accounts, args.seed)

    args.out.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": registries.REFERENCE_YEAR,
        "today": TODAY.isoformat(),
        "people": len(accounts),
        "accounts": sum(len(v) for v in accounts.values()),
        "conversations": len(conversations),
        # Nothing here is surveyed. No dataset in the extract knows what
        # anybody's messaging apps are; the reach and age gradients are
        # published national figures and the rest is modelled.
        "surveyed": [],
        "modelled": ["channel", "handle", "display_name", "created",
                     "conversation", "title"],
        "targets": {p["name"]: p["target"] for p in PLATFORMS},
        "intercepts": {k: round(v, 4) for k, v in intercepts.items()},
        "contagion": CONTAGION,
        "breadth_sd": BREADTH_SD,
        "account_records": {str(k): v for k, v in accounts.items()},
        "conversation_records": conversations,
    }, separators=(",", ":")))

    print(f"accounts.json ({args.out.stat().st_size / 1e6:.1f} MB)\n")
    report(people, accounts, conversations, held, intercepts)


if __name__ == "__main__":
    main()
