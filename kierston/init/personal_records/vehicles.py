"""Every registered vehicle in Kierston, keyed by VIN.

This is a registry, not a list of things people own, and the difference is the
whole reason it is its own stage and its own file. A vehicle outlives its owner,
changes hands, carries a lien from one bank and insurance from another, and gets
looked up from a plate by somebody who does not yet know whose it is. Modelled
as a row hanging off a person — which is how it started life, inside holdings.py
— none of that is expressible: there is no vehicle without an owner, no way to
ask a plate who it belongs to without scanning every resident, and no place to
put a car the city owns rather than a person.

So the VIN is the primary key and the owner is a field. That inverts the join
the rest of the personal records use, and it is the correct way round: the VIN
is the only identifier here that is globally unique by construction, stamped on
the vehicle, and stable across every transfer the vehicle will ever see. Plates
are unique at any instant but reissued over time; owners change.

What a row is made of, and how far each part can be trusted:

    make, body, age    surveyed — NHTS 2022, conditioned on household income
    model              catalogued — a real model that make sold that year
    colour             curated — Axalta North America shares by body type
    price, value       estimated — tier x body table and a depreciation curve
    VIN, plate, title  conventional — real formats, real check digits, real
                       sequence positions, from registries.py

See vehicle_market.py for why the first four work the way they do. The short
version is that income does not buy a price band, it buys a *kind of car of a
certain age*, and the survey knows the joint distribution far better than any
rule anyone could write.

Ordering: this runs after holdings.py because a vehicle is registered to a
licensed driver, and who holds a current licence is decided there against the
suspensions in the court record. It runs before pack_records.py, which reads
vehicles.json into vehicles.bin.

One thing this stage deliberately corrects rather than reproduces. The old
in-holdings version gave the household's whole VEH count to the householder and
then again to their partner, so a two-adult household with two cars produced
four, and the city carried 79,569 vehicles against a surveyed 63,131 — 26% too
many. VEH is a *household* count. It is allocated across the household's
licensed drivers here, which is both the right total and the right owners.

Legal-entity vehicles are registered here too. `fleet.py` runs afterwards and
references them by VIN for depot, pool and driver operations; it never creates
a second vehicle row.
"""

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Stages live in sibling folders, and only this script's own folder is on
# sys.path when it runs as __main__.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from population import pums
import fleet
import registries
from registries import keyed
from vehicle_market import market
import jurisdiction as legal

LAW = legal.load()
MONEY = legal.state_module("money")


from paths import SIM_DATA
POPULATION = SIM_DATA / "population.json"
HOLDINGS = SIM_DATA / "holdings.json"
ENROLLMENT = SIM_DATA / "enrollment.json"
EMPLOYMENT = SIM_DATA / "employment.json"
WORKPLACES = SIM_DATA / "workplaces.json"
IDENTITY = SIM_DATA / "identity.json"
OUT = SIM_DATA / "vehicles.json"

TODAY = registries.REFERENCE_YEAR
DEFAULT_SEED = 20260728

# Physical fleet specifications live with the registry. Operational ownership,
# depots and driver pools are emitted later by fleet.py.
ROUTE_BUSES_PER_1000 = {"district": 4.8, "contractor": 33.5}
SPARES = 1.15
BUS_TYPES = (("C", 71, 0.62), ("D", 84, 0.13), ("A", 24, 0.25))
BUS_MAKES = {
    "C": (("Blue Bird", "1BA", 40), ("Thomas Built", "4UZ", 33),
          ("IC Bus", "4DR", 27)),
    "D": (("Blue Bird", "1BA", 35), ("Thomas Built", "4UZ", 35),
          ("IC Bus", "4DR", 30)),
    "A": (("Ford", "1FD", 55), ("Chevrolet", "1GB", 45)),
}
SERVICE_LIFE = 15
OLD_TAIL = 0.08
OLD_TAIL_MAX = 22
BUS_COLOUR = "school bus yellow"

# The marked patrol fleet.
#
# Four vehicles cover almost the whole American police market, and the shares
# below are the current shape of it: the Explorer-based Interceptor Utility
# took the segment when the Crown Victoria went out of production and the
# Charger left it in 2023, so a fleet bought over the last eight years is
# mostly utilities with an ageing tail of sedans.
#
# Model names are the pursuit variants and not the civilian ones, because that
# is what is on the title. A "Police Interceptor Utility" is a distinct
# ordering code, not an Explorer with a light bar.
CRUISER_MODELS = (
    ("Ford", "1FM", "Police Interceptor Utility", "suv", 55, 46_000),
    ("Dodge", "2C3", "Charger Pursuit", "car", 20, 41_000),
    ("Chevrolet", "1GN", "Tahoe PPV", "suv", 15, 55_000),
    ("Ford", "1FT", "F-150 Police Responder", "pickup", 10, 49_000),
)

# A patrol car is worked three shifts a day and is retired on hours rather than
# on years. Six to eight is the usual replacement point; the tail is the spare
# nobody has got round to auctioning.
CRUISER_LIFE = 8
CRUISER_OLD_TAIL = 0.12
CRUISER_OLD_TAIL_MAX = 13

# Marked units only — see `add_cruisers`. The reference city's are white with
# blue and gold markings, and the livery is not a registry fact; the paint is.
CRUISER_COLOUR = "white"

# The ambulances: Type I and III boxes, which is what a municipal 911 service runs.
AMBULANCE_MODELS = (
    ("Ford", "1FD", "E-450 Type III Ambulance", "ambulance", 55, 240_000),
    ("Ford", "1FD", "F-450 Type I Ambulance", "ambulance", 25, 265_000),
    ("Chevrolet", "1GB", "Express 4500 Type III Ambulance", "ambulance", 20, 230_000),
)
AMBULANCE_LIFE = 10
AMBULANCE_COLOUR = "white"

# Municipal and school fleets insure through state pools.
MUNICIPAL_INSURERS = MONEY.MUNICIPAL_INSURERS
FLEET_INSURERS = MONEY.FLEET_INSURERS
TAXI_INSURERS = (
    ("Philadelphia Indemnity Insurance Company", 35),
    ("Progressive Commercial", 30),
    ("National Interstate Insurance Company", 20),
    ("Old Republic Insurance Company", 15),
)

# VEH is a household count with its own not-applicable code; group quarters and
# vacant units carry it and mean "no answer", not "no car".
VEH_NA = -1

# RELSHIPP codes for the householder and their spouse or partner. A vehicle is
# registered to one of these where possible — not because other adults do not
# drive, but because registration follows the lease or the loan, and those
# follow the household head.
HEAD_RELATIONSHIPS = (20, 21, 22, 23, 24)

# Pennsylvania registration is annual and renews by month, staggered across the
# year. Insurance is compulsory and the uninsured rate runs around 6-7%, which
# is a consequential record rather than a missing one: driving uninsured is a
# separate offence and a licence suspension.
UNINSURED = 0.068

# Personalized plates. Around 2% of US registrations carry one; the rate varies
# enormously by state (Virginia is an outlier near 16%) and PA sits close to the
# national figure. The state DMV charges a one-time fee on top of registration, so the
# rate is scaled by household income across the bands below.
VANITY_RATE = 0.026
VANITY_BY_INCOME = ((30_000, 0.35), (60_000, 0.75), (100_000, 1.0),
                    (175_000, 1.6), (10 ** 9, 2.2))

# A leased car goes back in three years and the plate does not follow it, so
# fewer people pay to personalize one.
VANITY_LEASED = 0.4

# What people actually put on them. Roughly: most personalized plates are the
# owner's name or initials, a good share are an interest or an allegiance, and
# the rest are wordplay. The first group is the one that matters here — a plate
# that spells its owner's name is a different object, for anything reading it,
# from one that does not.
VANITY_FROM_NAME = 0.62

VANITY_POOL = (
    "EAGLES", "GOBIRDS", "STEELER", "PHILLY", "LEHIGH", "PENNST", "NITTANY",
    "FLYERS", "PHILS", "KEYSTNE", "POCONOS", "ALLENTN",
    "FISHIN", "GOLFER", "HIKER", "CAMPER", "BIKER", "RUNNER", "SKIER",
    "TEACHER", "NURSE", "MEDIC", "CHEF", "FARMER", "TRUCKER", "COACH",
    "GRANDMA", "GRANDPA", "MOMTAXI", "DADSRIG", "MRSJ", "PAPPY",
    "BLESSED", "GRATFUL", "SUNSHNE", "DREAMER", "WANDER", "ROADTRP",
    "RETIRED", "WEEKEND", "MYTOY", "TOYBOX", "FASTONE", "NOTSLOW",
    "QUILTER", "BOOKS", "GARDNER", "BAKER", "PIANO", "GUITAR", "SINGER",
    "ANGLER", "HUNTER", "ARCHER", "SAILOR", "PADDLER", "CLIMBER", "YOGA",
    "VET", "DOCTOR", "DENTIST", "LAWYER", "REALTOR", "BARBER", "PLUMBER",
    "WELDER", "MASON", "ROOFER", "PAINTER", "CODER", "PILOT", "USAF",
    "USMC", "ARMYVET", "NAVYVET", "VETERAN", "K9UNIT", "FIREMAN",
    "DOGMOM", "CATLADY", "PUPPY", "HORSES", "BEEKPR", "CHICKNS",
    "COFFEE", "TACOS", "PIZZA", "BBQ", "VEGAN", "FOODIE",
    "SNOWBRD", "SURFER", "DIVER", "RIDER", "CRUISER", "TOURING",
    "LUCKY", "HAPPY", "SUNNY", "STORMY", "QUIET", "OUTLAW", "REBEL",
    "IOWA", "OHIO", "JERSEY", "SHORE", "UPSTATE", "DOWNTWN",
    "ONEMORE", "WHYNOT", "SOONER", "LATER", "MAYBE", "NOPE", "OKFINE",
)

VANITY_BY_MAKE = {
    "Jeep": ("JEEPIN", "OFFRD", "TRAILS", "MUDDY"),
    "Ford": ("BLUOVAL", "STANG", "F150"),
    "Chevrolet": ("BOWTIE", "VETTE", "SILVRDO"),
    "Subaru": ("SUBIE", "AWD4ME", "BOXER"),
    "Tesla": ("NOGAS", "AMPED", "WATTS", "SILENT"),
    "Toyota": ("TACO", "4RUNNR", "PRIUS1"),
    "Harley-Davidson": ("HOGLIFE", "2WHEELS"),
    "Porsche": ("911GUY", "FLAT6"),
    "BMW": ("BIMMER", "M3TIME"),
    "Dodge": ("MOPAR", "HEMI"),
}

INSURERS = (
    ("State Farm Mutual Automobile Insurance Company", 130),
    ("Erie Insurance Exchange", 120),
    ("GEICO Casualty Company", 115),
    ("Progressive Advanced Insurance Company", 110),
    ("Allstate Insurance Company", 85),
    ("Nationwide Mutual Insurance Company", 60),
    ("Travelers Personal Insurance Company", 45),
    ("Liberty Mutual Insurance Company", 40),
    ("USAA General Indemnity Company", 25),
    ("Root Insurance Company", 15),
)

# Title status for a vehicle the household owns outright or is paying off. A
# lease is not drawn here — NHTS reports it (VEHOWNED), so it comes through the
# market draw with the rest of the surveyed facts.
#
# Both of these were flat draws before and both were badly wrong for it. A lien
# is not a property of a car, it is a property of a car's *age*: nearly every
# new vehicle is financed and almost no fifteen-year-old one still is, because
# the loan outlived neither the term nor the owner's interest in paying it. A
# flat 2-in-11 draw put liens on cars from 1998.
LIEN_BY_AGE = ((2, 0.72), (4, 0.58), (6, 0.42), (8, 0.28),
               (11, 0.15), (15, 0.06), (99, 0.02))

# Branded titles are rarer than an even split suggests: around 2% of vehicles on
# the road carry one, weighted toward older cars, since a write-off is a
# function of repair cost against a falling value rather than of damage. The
# flat tuple this replaces produced 16%, which would have made Kierston the
# salvage capital of Pennsylvania.
BRANDED_BASE = 0.012
BRANDED_PER_YEAR = 0.0016


def title_status(age, rng):
    """Clear, lien, salvage or reconstructed, for a vehicle the household owns."""
    branded = min(0.06, BRANDED_BASE + BRANDED_PER_YEAR * age)
    if rng.random() < branded:
        # Reconstructed means it was rebuilt and re-inspected, which is the
        # less common outcome — most write-offs are simply sold as salvage.
        return "reconstructed" if rng.random() < 0.4 else "salvage"
    for ceiling, rate in LIEN_BY_AGE:
        if age <= ceiling:
            return "lien" if rng.random() < rate else "clear"
    return "clear"

# World manufacturer identifiers by make. The first three VIN characters encode
# who built the vehicle and where, so once the market draw has named a make,
# the VIN is no longer free to disagree with it — a Subaru whose VIN begins 1FT
# decodes to a Ford truck under any real decoder, which is exactly the kind of
# incoherence this simulation exists to avoid.
#
# Several WMIs per make, because manufacturers hold one per plant and body
# family. These are real assignments; where a make has more listed than it has
# entries here, the omission costs nothing but variety.
MAKE_WMI = {
    "Ford": ("1FA", "1FM", "1FT", "2FM", "3FA"),
    "Lincoln": ("1LN", "5LM"),
    "Mercury": ("1ME", "4M2"),
    "Chevrolet": ("1G1", "1GC", "1GN", "2G1", "3GN"),
    "GMC": ("1GT", "1GK"),
    "Buick": ("1G4", "LRB"),
    "Cadillac": ("1G6", "1GY"),
    "Pontiac": ("1G2", "2G2"),
    "Oldsmobile": ("1G3",),
    "Saturn": ("1G8",),
    "Chrysler": ("1C3", "2C3"),
    "Dodge": ("1B3", "2B3", "3D7"),
    "Jeep": ("1J4", "1C4"),
    "Plymouth": ("1P3", "2P4"),
    "Toyota": ("4T1", "5TD", "JTD", "JTM", "2T1"),
    "Lexus": ("JTH", "JTJ", "2T2"),
    "Scion": ("JTK",),
    "Honda": ("1HG", "2HG", "5FN", "JHM", "SHH"),
    "Acura": ("19U", "JH4", "5J8"),
    "Nissan": ("1N4", "3N1", "JN1", "5N1"),
    "Infiniti": ("JNK", "5N3"),
    "Subaru": ("4S3", "4S4", "JF1", "JF2"),
    "Mazda": ("JM1", "JM3", "4F2"),
    "Mitsubishi": ("JA4", "4A3"),
    "Suzuki": ("JS2", "2S3"),
    "Isuzu": ("JAA", "4S2"),
    "Hyundai": ("5NP", "KMH", "KM8"),
    "Kia": ("KNA", "KND", "5XY"),
    "Volkswagen": ("3VW", "WVW", "1VW"),
    "Audi": ("WAU", "TRU"),
    "BMW": ("WBA", "WBS", "5UX", "4US"),
    "Mercedes-Benz": ("WDD", "WDC", "4JG"),
    "Porsche": ("WP0", "WP1"),
    "Smart": ("WME",),
    "Volvo": ("YV1", "YV4"),
    "Jaguar": ("SAJ",),
    "Land Rover": ("SAL",),
    "FIAT": ("3C3", "ZFB"),
    "Tesla": ("5YJ", "7SA", "LRW"),
    "Ram": ("1C6", "3C6", "3C7"),
    "Genesis": ("KMT",),
    "MINI": ("WMW", "WMZ"),
    "Saab": ("YS3",),
    "Alfa Romeo": ("ZAR", "ZAS"),
    "Maserati": ("ZAM", "ZN6"),
    "Geo": ("1Y1", "2C1", "JG1"),
    "Daewoo": ("KLA",),
    "AM General": ("137",),
    "American Motors": ("1AM",),
    "Hummer": ("5GR",),
    "Eagle": ("1E3", "2E3"),
    "Merkur": ("WF0",),
    "Sterling": ("SAX",),
    "Daihatsu": ("JDA",),
    "Yugo": ("VX1",),
    "Peugeot": ("VF3",),
    "Renault": ("VF1",),
    "Polestar": ("LPS", "YSM"),
    "Rivian": ("7PD",),
    "Lucid": ("50E",),
    "Ferrari": ("ZFF",),
    "Lamborghini": ("ZHW",),
    "Bentley": ("SCB",),
    "Rolls-Royce": ("SCA",),
    "Aston Martin": ("SCF",),
    "Lotus": ("SCC",),
    "McLaren Automotive": ("SBM",),
    "Bugatti": ("VF9",),
    "BMW Alpina": ("WBA",),
    "SRT": ("2C3",),
    "Shelby": ("1FA",),
}

# The market data spells a few makes two ways (FIAT and Fiat, MINI and Mini,
# Smart and smart), so the lookup ignores case.
_WMI_BY_KEY = {make.casefold(): codes for make, codes in MAKE_WMI.items()}


def wmi_for(make, rng):
    """A world manufacturer identifier consistent with the make.

    Makes with no assignment here are the pre-1981 ones (MG, Triumph) that
    predate the 17-character VIN in the US market, and low-volume makes whose
    WMI is not listed. They get None, and
    registries.vin falls back to its own weighted draw — a 1978 MG with a
    modern VIN is already an anachronism, and picking someone else's WMI for it
    would not make it less of one.
    """
    codes = _WMI_BY_KEY.get(str(make or "").casefold())
    return rng.choice(codes) if codes else None


def vanity_share(income, leased):
    """How likely this household is to pay for a personalized plate."""
    share = VANITY_RATE
    for ceiling, factor in VANITY_BY_INCOME:
        if income < ceiling:
            share *= factor
            break
    return share * (VANITY_LEASED if leased else 1.0)


def name_plates(identity, rng):
    """Plate strings built out of the owner's own name."""
    if not identity:
        return []
    letters = lambda text: "".join(
        c for c in str(text or "").upper() if c.isalpha())
    first, last = letters(identity.get("first_name")), letters(identity.get("surname"))
    if not first or not last:
        return []
    born = str(identity.get("birth_date") or "")[:4]
    yy = born[2:] if len(born) == 4 else ""
    initial = (first[:1] + letters(identity.get("middle_name"))[:1] + last[:1])

    out = [first, last, first + last[:1], first[:1] + last,
           initial, initial + yy, first + yy, last + yy,
           first[:5] + " " + last[:1], first[:1] + " " + last[:5],
           first[:3] + last[:3], "MRS" + last[:4], "MR" + last[:5]]
    if yy:
        out.append(initial + born)
    return [text for text in out if text]


def vanity_plate(identity, drawn, rng, plates):
    """A personalized plate nobody else holds, or None if nothing fits."""
    pool = list(VANITY_POOL) + list(VANITY_BY_MAKE.get(drawn["make"], ()))
    rng.shuffle(pool)
    names = name_plates(identity, rng)
    groups = ((names, pool) if names and rng.random() < VANITY_FROM_NAME
              else (pool, names))

    # Each group is exhausted with numeric suffixes before the other is tried,
    # so somebody who wanted a word does not silently end up with their own
    # surname because the words ran out.
    for group in groups:
        for suffix in ("", str(rng.randrange(10)), str(rng.randrange(10, 100)),
                       str(rng.randrange(100, 1000))):
            for text in group:
                candidate = registries.personalized_plate(text + suffix)
                if candidate and candidate not in plates:
                    return candidate
    return None


# A resident cannot register a car before the year they turn 16, the
# junior-licence age, and cannot sign a loan before 18.
REGISTRATION_AGE = 16
LOAN_AGE = 18


def registration(drawn, rng, plates, identity=None, earliest=None):
    """The registration facts: when, what plate, what title, insured or not.

    `plates` is the set already issued. The state does not issue a plate twice,
    and these come from a dated position in the sequence rather than a strict
    allocator, so collisions are possible and have to be rejected — a duplicate
    plate would break every lookup that treats one as a key, which is now every
    lookup this file exists to serve.

    `earliest` is the first year this owner could hold a registration (the
    year they turn 16). The registration year is never before it or before the
    model year, and never after the reference year.
    """
    model_year = drawn["model_year"]
    age = max(0, TODAY - model_year)
    # Registered when this owner acquired it, not when it was built. A leased
    # vehicle is nearly always registered new or near-new, which is most of
    # what makes leases visible in the data.
    held = rng.randrange(0, 4) if drawn["leased"] else rng.randrange(0, age + 1)
    registered = model_year + min(age, held)
    if earliest is not None:
        registered = max(registered, earliest)
    registered = min(TODAY, registered)

    plate = None
    plate_type = "passenger"
    if identity is not None and rng.random() < vanity_share(
            identity.get("income", 0), drawn["leased"]):
        plate = vanity_plate(identity, drawn, rng, plates)
        if plate:
            plate_type = "personalized"

    if not plate:
        for _ in range(12):
            plate = registries.plate(registries.plate_index(registered, rng))
            if plate not in plates:
                break
    plates.add(plate)

    if drawn["leased"]:
        title = "leased"
    else:
        title = title_status(age, rng)
        # A salvage title destroys most of the value, and the market table has
        # no way to know that — it prices a clean car of that age.
        if title in ("salvage", "reconstructed"):
            drawn = {**drawn, "value": max(market.scrap_floor,
                                           int(drawn["value"] * 0.45))}

    return {
        "plate": plate,
        # School buses use their own series in add_buses below.
        "plate_type": plate_type,
        "registered": registered,
        "registration_expires":
            f"{TODAY + (0 if rng.random() < 0.5 else 1):04d}-"
            f"{rng.randint(1, 12):02d}-28",
        "issuer": LAW.licensing.issuer,
        "title_status": title,
        "title_number": f"{rng.randrange(10 ** 8):08d}",
        "insurer": None if rng.random() < UNINSURED else rng.choices(
            [i for i, _ in INSURERS], weights=[w for _, w in INSURERS])[0],
        "policy": f"{rng.randrange(10 ** 9):09d}",
        "value": drawn["value"],
    }


def auto_loan(vehicle, birth_year, rng):
    """The loan the lien on the title is the counterpart of.

    The old version drew a principal from a log-normal with no reference to the
    car, so a 2004 Corolla could carry a $40,000 note. The vehicle now knows
    roughly what it was worth when this owner bought it, and the loan is written
    against that — which is the point of having a value at all.
    """
    if vehicle["title_status"] != "lien":
        return None
    # Originated when the car was registered to this owner, and only to an
    # adult.
    if vehicle["registered"] - birth_year < LOAN_AGE:
        return None
    age_at_purchase = max(0, vehicle["registered"] - vehicle["model_year"])
    at_purchase = market.value(vehicle["make"], vehicle["body"], age_at_purchase)
    # Financed amount is the price less a deposit, and subprime borrowers roll
    # negative equity forward, so the ratio runs past 1 often enough to matter.
    principal = int(at_purchase * rng.uniform(0.55, 1.15) // 100 * 100)
    if principal < 1_000:
        return None
    term = rng.choice((48, 60, 60, 72, 84))
    elapsed = max(0, TODAY - vehicle["registered"]) * 12
    return {
        "vin": vehicle["vin"],
        "person": vehicle["owner"],
        "originated": vehicle["registered"],
        "term_months": term,
        "principal": principal,
        "rate": round(rng.uniform(3.9, 21.5), 2),
        "balance": max(0, int(principal * max(0.0, 1 - elapsed / term))),
    }


def licensed_drivers(holdings_path):
    """{person id: True} for everyone holding a driver licence that can be used.

    holdings.json is 161 MB and all this needs from it is one boolean per
    person, so the parsed structure is dropped as soon as it has been reduced.
    Keeping it alongside the population is what pushes this stage into swap.
    """
    data = json.loads(holdings_path.read_text())
    drivers = set()
    for person, records in data["records"].items():
        for record in records:
            if record["holding"] == "driver_licence" \
                    and record["status"] != "suspended":
                drivers.add(int(person))
                break
    del data
    return drivers


def allocate(members, drivers):
    """(owners, licensed): who the household's vehicles are registered to.

    Preference order: the head and their partner if they drive, then any
    licensed adult in the household. Only licensed people are ever returned
    with `licensed` True, and only those are treated as drivers downstream.

    A household with a surveyed car and no licensed member still registers it,
    to the oldest adult head (or the oldest member), with `licensed` False. A
    car registered to someone with no licence is real; the flag lands on each
    vehicle as `owner_licensed` so school_travel.py and anything else that
    needs a driver does not nominate that owner.
    """
    # Someone in custody is not driving anything, whatever their licence says.
    # dockets.py writes `incarcerated` onto the person record.
    free = [m for m in members if not m.get("incarcerated")]
    heads = [m for m in free
             if m["relationship"] in HEAD_RELATIONSHIPS and m["id"] in drivers]
    if heads:
        return heads, True
    licensed = [m for m in free if m["id"] in drivers]
    if licensed:
        return licensed, True
    heads = [m for m in members if m["relationship"] in HEAD_RELATIONSHIPS]
    return heads or [max(members, key=lambda m: (m["age"], -m["id"]))], False


def build(population, survey, drivers, identities, seed):
    """Every vehicle in the city, keyed by VIN."""
    members = defaultdict(list)
    for person in population["person_records"]:
        members[person["household"]].append(person)

    vehicles, loans, plates = {}, {}, set()
    collisions = 0

    for household in population["household_records"]:
        people = members.get(household["id"])
        if not people:
            continue
        row = survey[(people[0]["serialno"], people[0]["sporder"])]
        count = row.get("VEH")
        count = int(count) if count and count.lstrip("-").isdigit() else 0
        if count <= 0 or count == VEH_NA:
            continue

        owners, licensed = allocate(people, drivers)
        rng = keyed(seed, household["id"], "vehicles")
        for index in range(count):
            owner = owners[index % len(owners)]
            drawn = market.draw(household["income"], rng, TODAY)
            identity = identities.get(str(owner["id"]))
            if identity is not None:
                identity = {**identity, "income": household["income"]}
            birth_year = TODAY - owner["age"]
            record = registration(drawn, rng, plates, identity,
                                  earliest=birth_year + REGISTRATION_AGE)

            # The VIN has to survive a collision check for the same reason the
            # plate does: it is the primary key. Unlike the plate it is drawn
            # from a 17-character space with a check digit, so a collision here
            # is a genuine surprise worth counting rather than absorbing.
            for _ in range(8):
                vin = registries.vin(drawn["model_year"], rng,
                                     wmi=wmi_for(drawn["make"], rng))
                if vin not in vehicles:
                    break
                collisions += 1

            vehicle = {
                "vin": vin,
                "owner": owner["id"],
                "owner_type": "person",
                "household": household["id"],
                "make": drawn["make"],
                "model": drawn["model"],
                "body": drawn["body"],
                "bus_type": None,
                "seats": None,
                "model_year": drawn["model_year"],
                "colour": drawn["colour"],
                "price_new": drawn["price_new"],
                "commercial_use": drawn["commercial"],
                "service_class": None,
                "owner_licensed": licensed,
                **record,
            }
            vehicles[vin] = vehicle
            if vehicle["title_status"] == "lien" \
                    and vehicle["registered"] - birth_year < LOAN_AGE:
                # Nobody under 18 signs a car loan, so a car registered to a
                # minor carries no lien.
                vehicle["title_status"] = "clear"
            loan = auto_loan(vehicle, birth_year, rng)
            if loan:
                loans[vin] = loan

    return vehicles, loans, plates, collisions


def _new_vin(drawn, rng, vehicles):
    collisions = 0
    for _ in range(8):
        vin = registries.vin(drawn["model_year"], rng,
                             wmi=wmi_for(drawn["make"], rng))
        if vin not in vehicles:
            return vin, collisions
        collisions += 1
    raise RuntimeError("could not allocate a unique VIN")


def add_taxis(vehicles, loans, plates, population, employment, workplaces, seed,
              drivers=frozenset()):
    """Mark owner-driver cars and register the two LLC pools."""
    household_cars = defaultdict(list)
    for row in vehicles.values():
        if row["household"] is not None:
            household_cars[row["household"]].append(row)
    affiliations, _ = fleet.taxi_affiliations(
        population, employment, workplaces, set(household_cars))
    people = {p["id"]: p for p in population["person_records"]}
    collisions = 0

    for affiliation in affiliations:
        person = people[affiliation["person"]]
        operator = affiliation["operator"]
        if operator is None:
            candidates = household_cars[person["household"]]
            candidates.sort(key=lambda row: (
                row["owner"] != person["id"],
                row["body"] not in ("car", "suv", "van"),
                -row["model_year"], row["vin"]))
            taxi = candidates[0]
            taxi["owner"] = person["id"]
            taxi["owner_type"] = "person"
            taxi["commercial_use"] = True
            taxi["service_class"] = "taxi"
            # Cab drivers hold a licence by construction in holdings.py, unless
            # a conviction has suspended it.
            taxi["owner_licensed"] = person["id"] in drivers
            if taxi["vin"] in loans:
                loans[taxi["vin"]]["person"] = person["id"]
            continue

        rng = keyed(seed, person["id"], "taxi_vehicle")
        drawn = market.draw_commercial(rng, TODAY)
        record = registration(drawn, rng, plates)
        record.update({
            "title_status": "clear",
            "insurer": rng.choices([i for i, _ in TAXI_INSURERS],
                                   weights=[w for _, w in TAXI_INSURERS])[0],
        })
        vin, hit = _new_vin(drawn, rng, vehicles)
        collisions += hit
        vehicles[vin] = {
            "vin": vin, "owner": operator, "owner_type": "organization",
            "household": None, "make": drawn["make"], "model": drawn["model"],
            "body": drawn["body"], "bus_type": None, "seats": None,
            "model_year": drawn["model_year"], "colour": drawn["colour"],
            "price_new": drawn["price_new"], "commercial_use": True,
            "service_class": "taxi", **record,
        }
    return collisions


def _bus_count(operator, counts):
    served = sum(counts.get(sector, 0) for sector in operator["sectors"])
    route = served * ROUTE_BUSES_PER_1000[operator["kind"]] / 1000 * SPARES
    capable = sum(weight for kind, _, weight in BUS_TYPES if kind != "A")
    return math.ceil(route / capable)


def add_buses(vehicles, enrollment, seed):
    """Register every school bus; fleet.py will only reference these VINs."""
    counts = Counter(row["sector"] for row in enrollment["assignments"]
                     if row["mode"] == "enrolled" and row["band"] in fleet.BUSED_BANDS)
    plates = registries.Series(registries.SCHOOL_BUS_SERIES_START)
    buses = {}
    collisions = 0
    for operator in fleet.SCHOOL_OPERATORS:
        rng = keyed(seed, operator["id"], "fleet")
        for _ in range(_bus_count(operator, counts)):
            kind = rng.choices([t for t, _, _ in BUS_TYPES],
                               weights=[w for _, _, w in BUS_TYPES])[0]
            seats = next(s for t, s, _ in BUS_TYPES if t == kind)
            make, wmi, _ = rng.choices(
                BUS_MAKES[kind], weights=[w for _, _, w in BUS_MAKES[kind]])[0]
            age = (rng.randint(SERVICE_LIFE, OLD_TAIL_MAX)
                   if rng.random() < OLD_TAIL else rng.randrange(SERVICE_LIFE))
            year = TODAY - age
            for _ in range(8):
                vin = registries.vin(year, rng, wmi=wmi)
                if vin not in vehicles:
                    break
                collisions += 1
            else:
                raise RuntimeError("could not allocate a unique bus VIN")
            row = {
                "vin": vin, "owner": operator["id"],
                "owner_type": "organization", "household": None,
                "make": make, "model": None, "body": "bus",
                "bus_type": kind, "seats": seats, "model_year": year,
                "colour": BUS_COLOUR, "price_new": None,
                "commercial_use": True, "service_class": "school_bus",
                "plate": registries.school_bus_plate(plates.next(rng, jitter=2)),
                "plate_type": "school_bus", "registered": year,
                "registration_expires": f"{TODAY + 1:04d}-06-30",
                "issuer": LAW.licensing.issuer,
                "title_status": "clear",
                "title_number": f"{rng.randrange(10 ** 8):08d}",
                "insurer": rng.choices([i for i, _ in FLEET_INSURERS],
                                       weights=[w for _, w in FLEET_INSURERS])[0],
                "policy": f"{rng.randrange(10 ** 9):09d}", "value": None,
            }
            vehicles[vin] = row
            buses[vin] = row
    return buses, collisions


def add_cruisers(vehicles, employment, seed):
    """Register the city's marked patrol cars; fleet.py bases and pools them.

    Marked units only, and deliberately: every vehicle in here is one the
    simulation puts on the road. A department this size also runs unmarked
    detective cars, a traffic unit's motorcycles and a van or two, and none of
    them are registered because nothing drives them — a row nobody moves is a
    plate a reader can never see and a vehicle whose day is a lie by omission.
    Adding them is the right change on the day the bureau's officers leave
    their building.

    The count is `fleet.patrol_fleet_size`, which sizes the fleet on the
    busiest watch's units. That keeps the two stages from disagreeing: fleet.py
    allocates exactly the same number of posts across the stations, and raises
    if the registry hands it a different number of cars.
    """
    plates = registries.Series(registries.MUNICIPAL_SERIES_START)
    rng = keyed(seed, fleet.POLICE_OPERATOR["id"], "police_fleet")
    collisions = 0
    cruisers = {}

    for _ in range(fleet.patrol_fleet_size(employment)):
        make, wmi, model, body, _, price = rng.choices(
            CRUISER_MODELS, weights=[w for *_, w, _ in CRUISER_MODELS])[0]
        age = (rng.randint(CRUISER_LIFE, CRUISER_OLD_TAIL_MAX)
               if rng.random() < CRUISER_OLD_TAIL else rng.randrange(CRUISER_LIFE))
        year = TODAY - age
        for _ in range(8):
            vin = registries.vin(year, rng, wmi=wmi)
            if vin not in vehicles:
                break
            collisions += 1
        else:
            raise RuntimeError("could not allocate a unique cruiser VIN")
        row = {
            "vin": vin, "owner": fleet.POLICE_OPERATOR["id"],
            "owner_type": "organization", "household": None,
            "make": make, "model": model, "body": body,
            "bus_type": None, "seats": None, "model_year": year,
            "colour": CRUISER_COLOUR, "price_new": price,
            "commercial_use": True, "service_class": "police",
            "plate": registries.municipal_plate(plates.next(rng, jitter=2)),
            "plate_type": "municipal", "registered": year,
            # Municipal registrations do not expire on the owner's birth month
            # the way a passenger plate does; the city renews its fleet on the
            # fiscal year, in one batch.
            "registration_expires": f"{TODAY + 1:04d}-06-30",
            "issuer": LAW.licensing.issuer,
            "title_status": "clear",
            "title_number": f"{rng.randrange(10 ** 8):08d}",
            "insurer": rng.choices([i for i, _ in MUNICIPAL_INSURERS],
                                   weights=[w for _, w in MUNICIPAL_INSURERS])[0],
            "policy": f"{rng.randrange(10 ** 9):09d}", "value": None,
        }
        vehicles[vin] = row
        cruisers[vin] = row
    return cruisers, collisions


def add_ambulances(vehicles, employment, seed):
    """Register the ambulances; fleet.py bases them at the fire houses."""
    plates = registries.Series(registries.MUNICIPAL_SERIES_START + 400)
    rng = keyed(seed, fleet.EMS_OPERATOR["id"], "ems_fleet")
    collisions = 0
    ambulances = {}

    for _ in range(fleet.ambulance_fleet_size(employment)):
        make, wmi, model, body, _, price = rng.choices(
            AMBULANCE_MODELS, weights=[w for *_, w, _ in AMBULANCE_MODELS])[0]
        year = TODAY - rng.randrange(AMBULANCE_LIFE)
        for _ in range(8):
            vin = registries.vin(year, rng, wmi=wmi)
            if vin not in vehicles:
                break
            collisions += 1
        else:
            raise RuntimeError("could not allocate a unique ambulance VIN")
        row = {
            "vin": vin, "owner": fleet.EMS_OPERATOR["id"],
            "owner_type": "organization", "household": None,
            "make": make, "model": model, "body": body,
            "bus_type": None, "seats": None, "model_year": year,
            "colour": AMBULANCE_COLOUR, "price_new": price,
            "commercial_use": True, "service_class": "ems",
            "plate": registries.municipal_plate(plates.next(rng, jitter=2)),
            "plate_type": "municipal", "registered": year,
            "registration_expires": f"{TODAY + 1:04d}-06-30",
            "issuer": LAW.licensing.issuer,
            "title_status": "clear",
            "title_number": f"{rng.randrange(10 ** 8):08d}",
            "insurer": rng.choices([i for i, _ in MUNICIPAL_INSURERS],
                                   weights=[w for _, w in MUNICIPAL_INSURERS])[0],
            "policy": f"{rng.randrange(10 ** 9):09d}", "value": None,
        }
        vehicles[vin] = row
        ambulances[vin] = row
    return ambulances, collisions


def identity_in_plate(row, identities):
    """Whether a plate carries its owner's own name or initials."""
    identity = identities.get(str(row["owner"]))
    if not identity:
        return False
    text = "".join(c for c in row["plate"] if c.isalnum())
    letters = lambda value: "".join(
        c for c in str(value or "").upper() if c.isalpha())
    first, last = letters(identity.get("first_name")), letters(identity.get("surname"))
    for name in (first, last):
        if len(name) >= 3 and name[:4] in text:
            return True
    initials = first[:1] + letters(identity.get("middle_name"))[:1] + last[:1]
    return len(initials) >= 2 and text.startswith(initials)


def report(vehicles, loans, survey, population, identities, collisions):
    # Every statistic below is about what residents drive, so the fleet is
    # excluded from all of them. Mixing it in would break the check this report
    # exists for — the registry total against the surveyed VEH count — and
    # would quietly answer "what is a vehicle in Kierston worth" with a
    # population that includes 130 buses carrying no value at all.
    rows = [r for r in vehicles.values() if r["household"] is not None]
    total = len(rows)

    surveyed = 0
    members = defaultdict(list)
    for person in population["person_records"]:
        members[person["household"]].append(person)
    for household in population["household_records"]:
        people = members.get(household["id"])
        if not people:
            continue
        count = survey[(people[0]["serialno"], people[0]["sporder"])].get("VEH")
        count = int(count) if count and count.lstrip("-").isdigit() else 0
        if count > 0 and count != VEH_NA:
            surveyed += count

    print(f"{total:,} vehicles registered to {len({r['owner'] for r in rows}):,} "
          f"residents in {len({r['household'] for r in rows}):,} households")
    # Duplicate-key checks run over the whole file, fleet included, because a
    # collision between a bus and a car is exactly the kind this would miss.
    print(f"  {len(vehicles) - total:,} more owned by operators, "
          f"{len(vehicles):,} in the registry")
    print(f"  surveyed VEH total {surveyed:,} — "
          f"{'matches' if total == surveyed else f'off by {total - surveyed:+,}'}")

    # The keys have to be keys. A duplicate in either would silently merge two
    # vehicles into one on every lookup that uses them.
    every = list(vehicles.values())
    plates = [r["plate"] for r in every]
    print(f"  {len(plates) - len(set(plates)):,} duplicate plates, "
          f"{collisions:,} VIN collisions resolved")
    bad = sum(1 for r in every if registries.vin_check(r["vin"]) != r["vin"][8])
    print(f"  {bad:,} VINs fail their check digit")

    vanity = [r for r in every if r["plate_type"] == "personalized"]
    named = sum(1 for r in vanity if identity_in_plate(r, identities))
    print(f"\n  {len(vanity):,} personalized plates "
          f"({100 * len(vanity) / len(every):.1f}% of the registry)")
    print(f"  {named:,} of them ({100 * named / max(1, len(vanity)):.0f}%) "
          f"contain the owner's own name or initials")
    print("  " + ", ".join(r["plate"] for r in vanity[:12]))

    years = sorted(r["model_year"] for r in rows)
    values = sorted(r["value"] for r in rows)
    print(f"  median model year {years[total // 2]}, "
          f"median value ${values[total // 2]:,}")

    body = Counter(r["body"] for r in rows)
    print("  bodies: " + ", ".join(
        f"{b} {100 * c / total:.0f}%" for b, c in body.most_common()))
    colour = Counter(r["colour"] for r in rows)
    print("  colors: " + ", ".join(
        f"{c} {100 * n / total:.0f}%" for c, n in colour.most_common(5)))

    title = Counter(r["title_status"] for r in rows)
    print("  titles: " + ", ".join(
        f"{t} {100 * c / total:.0f}%" for t, c in title.most_common()))
    uninsured = sum(1 for r in rows if not r["insurer"])
    print(f"  {uninsured:,} uninsured ({100 * uninsured / total:.1f}%), "
          f"{len(loans):,} carrying a lien")

    print("\n  most common vehicles")
    common = Counter(f"{r['make']} {r['model']}" for r in rows)
    for name, count in common.most_common(8):
        print(f"    {100 * count / total:5.2f}%  {name}")

    # The check the whole income conditioning exists to pass. If this is flat,
    # the market table is not doing its job and nothing downstream will show it.
    print("\n  median value by household income")
    incomes = {h["id"]: h["income"] for h in population["household_records"]}
    bands = ((0, 25_000), (25_000, 50_000), (50_000, 100_000),
             (100_000, 200_000), (200_000, 10 ** 9))
    for low, high in bands:
        band = sorted(r["value"] for r in rows
                      if low <= incomes.get(r["household"], 0) < high)
        if band:
            ages = sorted(TODAY - r["model_year"] for r in rows
                          if low <= incomes.get(r["household"], 0) < high)
            print(f"    ${low:>7,}-{high if high < 10 ** 9 else 0:>9,}  "
                  f"{len(band):>7,} vehicles  median ${band[len(band) // 2]:>7,}"
                          f"  median age {ages[len(ages) // 2]:>2}y")


def validate(vehicles):
    rows = list(vehicles.values())
    plates = [row["plate"] for row in rows]
    if len(plates) != len(set(plates)):
        raise RuntimeError("vehicle registry contains duplicate plates")
    for row in rows:
        entity = row["owner_type"] == "organization"
        if entity != (row["household"] is None):
            raise RuntimeError(f"owner/household mismatch on {row['vin']}")
        if row["service_class"] in ("taxi", "school_bus", "police", "ems") and not row["commercial_use"]:
            raise RuntimeError(f"service vehicle is not commercial: {row['vin']}")
        if registries.vin_check(row["vin"]) != row["vin"][8]:
            raise RuntimeError(f"invalid VIN check digit: {row['vin']}")
        if row["plate_type"] == "personalized":
            if not registries.personalized_valid(row["plate"]):
                raise RuntimeError(f"unissuable vanity plate: {row['plate']}")
        elif row["plate_type"] == "passenger":
            if set(row["plate"][:3]) - set(registries.PLATE_LETTERS):
                raise RuntimeError(f"sequential plate uses a skipped letter: "
                                   f"{row['plate']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    for path in (POPULATION, HOLDINGS, ENROLLMENT, EMPLOYMENT, WORKPLACES,
                 IDENTITY):
        if not path.exists():
            raise SystemExit(
                f"{path.name} is missing — run the earlier stages first")

    population = json.loads(POPULATION.read_text())
    survey = pums.rows_by_person()
    drivers = licensed_drivers(HOLDINGS)
    identities = json.loads(IDENTITY.read_text())["identities"]

    vehicles, loans, plates, collisions = build(
        population, survey, drivers, identities, args.seed)

    # The fleet is sized from enrolment, so it needs assign_school to have run;
    # init_sim already orders it well before this stage. It is built second and
    # handed the VINs already issued, because the resident registry is the one
    # whose keys are drawn rather than allocated and so is the one that must not
    # be perturbed by anything added beside it.
    enrollment = json.loads(ENROLLMENT.read_text())
    employment = json.loads(EMPLOYMENT.read_text())
    workplaces = json.loads(WORKPLACES.read_text())
    collisions += add_taxis(
        vehicles, loans, plates, population, employment, workplaces, args.seed,
        drivers)
    buses, bus_collisions = add_buses(vehicles, enrollment, args.seed)
    collisions += bus_collisions
    cruisers, police_collisions = add_cruisers(vehicles, employment, args.seed)
    collisions += police_collisions
    _, ems_collisions = add_ambulances(vehicles, employment, args.seed)
    collisions += ems_collisions
    validate(vehicles)

    args.out.write_text(json.dumps({
        "seed": args.seed,
        "reference_year": TODAY,
        "persons": len(population["person_records"]),
        "surveyed": ["make", "body", "model_year", "leased", "commercial_use"],
        "modelled": ["model", "colour", "price_new", "value", "plate",
                     "plate_type", "vin", "title_status", "insurer",
                     "owner_type", "service_class"],
        "vehicles": vehicles,
        "auto_loans": loans,
    }, separators=(",", ":")))

    print(f"vehicles.json ({args.out.stat().st_size / 1e6:.0f} MB)\n")
    report(vehicles, loans, survey, population, identities, collisions)
    services = Counter(row["service_class"] for row in vehicles.values()
                       if row["service_class"] is not None)
    print("\nservice vehicles: " + ", ".join(
        f"{kind} {count:,}" for kind, count in sorted(services.items())))


if __name__ == "__main__":
    main()
