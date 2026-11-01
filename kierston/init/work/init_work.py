"""Fill Kierston's primary-class occupations and give each holder a base.

Primary class means a job the simulation plays out in detail rather than as a
dwell time at an address: police, EMS, taxi and school bus so far. They are
handled here together because they share a problem — the synthetic population
does not contain the right people for them — but they need opposite treatment,
and the `target` field is what separates the two cases.

The synthetic population has no police officers and no paramedics. Not few —
none. OCCP 3870 and 3402 are absent from all 115,343 people, and the 21
emergency medical technicians it does carry are a third of what the city runs.
That is a sampling artifact, not a fact about the reference city: the PUMA contains
these workers, and a 1,391-household draw expanded 33× either catches an
occupation or misses it entirely. Rare-but-essential occupations are exactly
the ones it misses, and they are exactly the ones a simulation needs, because
a police officer generates far more observable behaviour than the 33 clones of
a warehouse picker standing in for them.

So this stage fills the establishment directly, from a declared headcount
rather than from the sample. 210 sworn officers and 48 EMS personnel, the
numbers the city actually employs.

Taxi is the same problem wearing different clothes. The sample carries 145
drivers, which is the right number, but they descend from four surveyed
households — so the count is taken from the sample and the people are not.
A role can also declare `target: None` to accept the sample wholesale, which
is sound only when it holds enough distinct records to be a distribution;
nothing in this table currently qualifies.

School bus is the taxi case again, and this time the count is wrong as well.
The sample carries 218 people in OCCP 9121 from five surveyed households, of
whom 118 are employed — and `school_travel.py` builds routes that need 144
drivers on the road, so a sixth of the city's school buses were leaving the
yard with nobody in the seat. Neither number was evidence: 118 is five people
wearing 118 faces, and what the city needs is decided by the manifests, not by
what a 1,391-household draw happened to catch. So the headcount comes from the
routes and the people are recruited. See SCHOOL_BUS_DRIVERS.

Recruit, do not mint
--------------------
Every new officer is an existing employed person whose occupation is rewritten.
Nobody is added to the population.

That is the whole reason this runs where it does. Minting 258 people after
`assign_dwellings` has already run would leave them with no household and no
address, and putting them in one would mean either inventing 258 households —
changing the household count, the size distribution and the vacancy rate that
stage was written to control — or inserting them into existing households,
changing composition. Recruitment costs none of that. It moves 258 of 53,308
employed people between occupations, 0.48%, which is well inside the noise the
expansion already carries.

The invariants that survive: household composition, every address, every age,
and the relation between a household's income and its members' — a recruit's
pay change is absorbed by their household exactly as `jitter.py` absorbs its
own, so HINCP keeps tracking its PINCPs.

What changes on a recruit: occupation, SOC, industry, income and education.
Education is allocated across the whole recruit set rather than drawn per
person — see `educate` — so each grade comes out with the attainment profile
it was configured with instead of a floor it drifts above, and the college
places go to the recruits who arrived holding one.

Who gets recruited
------------------
Candidates are employed people inside the role's service-age band, weighted by
three things: how close their current occupation is to the role, how deep the
occupation they are leaving is, and how near they are to the role's typical
career age. Draining 100 people from a 2,769-strong bucket is invisible;
draining them from a 21-strong one would delete an occupation from the city.

People already holding the job are preferred over recruits, but only up to
RETAIN_PER_SOURCE of them per PUMS record they were cloned from. That cap is
not fussiness. All 21 EMTs in the population descend from one surveyed
household — a single 24-year-old man with a bachelor's earning $34k — so
retaining the lot would staff a third of the city's ambulances with one person
copied 21 times, identical in age, sex, education and pay. Capping at two per
source keeps the genuinely surveyed people without letting the expansion's
duplication become the service's demographics, and it needs no tuning: an
occupation drawn from twenty distinct records is retained almost wholesale.

Holders left over do not become phantoms. Each one swaps into a job a recruit
vacated, so an occupation that is both recruited into and already held ends
the stage at exactly its establishment rather than at establishment plus
however many clones the expansion happened to make. Every other occupation in
the city keeps the count it started with — the swap moves people between
jobs, never the number of jobs. See `release`.

Where they are posted
---------------------
See facilities.py for what the extracts actually contain. Two consequences
shape the postings here:

  Police concentrates. Two buildings hold the force; the substation and the
  narcotics bureau are detachments, sized by role rather than by floor area,
  because a substation is a desk and a report-writing room. Patrol districts
  are logical and belong to the behaviour module, not to a posting.

  EMS lives in fire houses. There is no ambulance station in the extract
  because the reference city has none — its medic units run from the fire stations.
  Crews are posted in pairs, one EMT and one paramedic, because an ambulance
  is a two-person unit and an establishment that does not divide into crews
  cannot be put on the road. Only the six stations inside the city line are
  used; the three outlying volunteer companies are not the city's to staff.

Platoons are assigned but rotas are not. Each person gets the shift they
belong to and nothing finer — when a given ambulance rolls is a question for
the behaviour module, which is what this roster exists to feed.

Not here: the other 52,900 workers. They are filler-class jobs needing a
workplace and a dwell time, which is a different problem — capacity-limited
matching against every commercial site in the city — and a different stage.
"""

import argparse
import json
import math
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import facilities  # noqa: E402
import shifts  # noqa: E402
from paths import OCCUPATIONS, SIM_DATA  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
POPULATION = SIM_DATA / "population.json"
OUTPUT = SIM_DATA / "employment.json"

DEFAULT_SEED = 20260728

# ESR: 1 is at work, 2 is employed but absent. Both hold a job and are the pool
# to recruit from. 3 (unemployed) and 6 (not in labour force) are not.
EMPLOYED = (1, 2)

# How strongly to prefer recruits already doing adjacent work, as a multiplier
# on their selection weight. Protective service feeds policing; healthcare
# support and practice feed EMS. Set high enough to bias the draw visibly, low
# enough that these groups are not emptied — the report prints where recruits
# actually came from, which is the check on this number.
FEEDER_BOOST = 25

# Selection weight also falls off with distance from the role's typical
# service age, as a Gaussian of this width in years. Without it the draw
# inherits the pool's age profile and staffs the force with 60-year-olds in
# proportion to how many the city has.
AGE_SPREAD = 12

# How many existing holders of an occupation may be posted from any one PUMS
# record they were cloned from. See the module docstring: this is what stops a
# single surveyed EMT from becoming the entire ambulance service.
RETAIN_PER_SOURCE = 2

# What the school bus routes need, which is the one establishment in this table
# that another stage decides.
#
# A driver is attached to a shift and not to a vehicle — the morning and the
# afternoon are separately staffed, which is what a split shift is — so the
# requirement is the busiest single half of the day and not the sum of the two.
# `school_travel.py` reports it directly, under "drivers required by the
# routes": 129 bus-shifts in the morning against 144 in the afternoon, so 144.
#
# The afternoon is the bigger half because the two directions do not chain the
# same way. A morning run ends at the bell and an afternoon run starts at it,
# and with the bells 30 and 45 minutes apart and a measured run taking 44 to 51,
# a bus that has just done the high school route cannot be back for the middle
# school one. Almost no vehicle covers two tiers in the afternoon, so the
# afternoon needs nearly a bus — and a driver — per run.
#
# Circular in the same way fleet.py's ratios are, and broken the same way: this
# stage runs long before the manifests exist, so the number is declared here and
# re-derived downstream, where `school_travel.py` prints it next to the roster
# it was given. A stale constant shows up there as runs with a bus and no
# driver, and the report says what to change this to.
#
# The margin over 144 is why it is not simply 144. Recruiting a driver takes
# them out of the pool of parents who could drive their own children to school
# — a bus driver is at work at both bells, which is the one shift that rules a
# lift out entirely — so the establishment moves the manifests it was sized on,
# and the requirement it comes back with is not quite the one it went in with.
# Six is enough to absorb that, and doubles as the relief pool a district keeps
# for the mornings somebody is ill. What it costs is six people coded into a
# job the routes never call on: they fall through to the WKHP day their PUMS
# record describes, which is the same day they would have had anyway.
SCHOOL_BUS_DRIVERS = 150


ESTABLISHMENT = (
    {
        "key": "police_officer",
        "occupation": "3870",
        # INDP 9470, justice, public order and safety activities.
        "industry": "9470",
        "facility": "police",
        "target": 210,
        "ages": (21, 60),
        "peak_age": 38,
        # Detailed occupation group 12, protective service.
        "feeders": ("12",),
        # SCHL. The reference city requires a diploma; a good half of a modern force
        # carries college credit and a quarter a degree, so the mass sits on
        # 16-19 with a real tail into 21.
        "education": ((16, 26), (17, 4), (18, 14), (19, 16), (20, 14),
                      (21, 22), (22, 4)),
        # Base pay at appointment, and the annual step. A 30-year officer lands
        # near $92k, which is the top of the reference city's sworn scale.
        "pay": (62000, 1000),
        "male_share": 0.82,
        # Sworn strength splits across three watches; nights run leaner.
        "platoons": (("day", 40), ("evening", 35), ("night", 25)),
    },
    {
        "key": "paramedic",
        "occupation": "3402",
        # 9470 too, not health care: the city employs its medics through the
        # fire department, so public safety is the industry they work in.
        "industry": "9470",
        "facility": "fire",
        "target": 24,
        "ages": (22, 60),
        "peak_age": 36,
        # Group 11, healthcare support — aides and assistants, who do take the
        # licence. Not group 10: it is where registered nurses sit, and
        # boosting it recruited four of them onto ambulances at a pay cut.
        # Nurses do not become paramedics; EMTs and aides do.
        "feeders": ("11",),
        # 42% with some college (SCHL 18+), a fifth of them holding a degree.
        # A paramedic licence is 1,200-1,800 instructional hours but it is a
        # licence, not a degree: the majority route is a certificate on top of
        # a diploma, and only the minority who go the associate-degree way
        # come out with college behind them.
        "education": ((16, 45), (17, 13), (18, 8), (19, 12), (20, 16),
                      (21, 5), (22, 1)),
        "pay": (46000, 800),
        "male_share": 0.65,
        # Equal thirds, exactly. A 24-hour rotation splits evenly by
        # construction, and unequal weights here would not express a real
        # preference — they would just hand every rounding remainder in the
        # city to whichever watch was written down as fractionally larger.
        "platoons": (("a", 1), ("b", 1), ("c", 1)),
    },
    {
        "key": "emt",
        "occupation": "3401",
        # 9470 too, not health care: the city employs its medics through the
        # fire department, so public safety is the industry they work in.
        "industry": "9470",
        "facility": "fire",
        "target": 24,
        "ages": (21, 60),
        "peak_age": 32,
        # Support only, not group 10. An EMT-Basic certificate is a step up
        # from aide work and a step sideways from nothing; registered nurses
        # and pharmacy technicians do not take it, and boosting the group they
        # sit in was pulling degree-holders onto the ambulances.
        "feeders": ("11",),
        # 32% with some college, below the paramedic grade and deliberately so.
        # EMT-Basic is a ~150-hour certificate on top of a diploma — putting
        # every EMT through college would misstate both the pay and the
        # pipeline, and would make the two grades indistinguishable when the
        # difference between them is the entire reason an ambulance carries
        # one of each.
        "education": ((16, 52), (17, 16), (18, 14), (19, 10), (20, 7),
                      (21, 1)),
        "pay": (34000, 550),
        "male_share": 0.65,
        # Equal thirds, exactly. A 24-hour rotation splits evenly by
        # construction, and unequal weights here would not express a real
        # preference — they would just hand every rounding remainder in the
        # city to whichever watch was written down as fractionally larger.
        "platoons": (("a", 1), ("b", 1), ("c", 1)),
    },
    {
        "key": "taxi_driver",
        "occupation": "9142",
        # INDP 6190, the industry all 145 surveyed drivers already carry.
        "industry": "6190",
        # No premises: a cab fleet this size has no depot to report to, so a
        # driver's own dwelling is where their shift starts and ends.
        "facility": None,
        # The fleet size is the sample's, 146 — the PUMA weights are the only
        # evidence of how many drivers the city has and there is nothing to
        # improve on them. Declaring it rather than counting holders also
        # makes the fleet independent of this table's order: the sworn roles
        # run first and recruit from the same driver-heavy pool, so counting
        # would silently hand the police whatever they took.
        #
        # What the sample cannot supply is the drivers themselves. All 146
        # descend from four surveyed households — four people wearing 146
        # faces. One record held 51% of the fleet at ages 30-37 on a median
        # $4,789, another put 26 men aged 76-81 in full-time work, and the age
        # distribution came out as four spikes with a median of 36: a decade
        # younger than the trade really is, behind a mean of 47.5 that only
        # looked right because the octogenarians offset the bulk.
        #
        # So the count is kept and the people are recruited. Two drivers per
        # surveyed record stay; the rest swap into the jobs the recruits
        # vacate, leaving the occupation at 146 and every other occupation
        # where it was. See `release`.
        "target": 146,
        # Wide, and old at the peak. Driving is a second career and a late one
        # — entered after another trade rather than out of school — and it has
        # no fitness standard or mandatory retirement to bound it the way the
        # sworn roles do.
        "ages": (25, 75),
        "peak_age": 52,
        # Group 22, transportation and material moving: 9,597 people, and the
        # genuinely adjacent trades. Truck and delivery drivers, shuttle
        # drivers and vehicle operators move into cab work and back out of it.
        "feeders": ("22",),
        # Bimodal by construction, and that is the trade. A long tail below a
        # diploma sits alongside a real bachelor's share, because cab driving
        # is one of the few jobs open to someone whose degree was earned in
        # another country and is not recognised here.
        "education": ((13, 4), (15, 8), (16, 34), (17, 8), (18, 12), (19, 14),
                      (20, 8), (21, 10), (22, 2)),
        # Thin and nearly flat. A cab is leased by the shift and the step
        # buys little: seniority means knowing the city, not a pay scale.
        "pay": (26000, 350),
        "male_share": 0.88,
        # Not a rota. For police and EMS a platoon is an assignment; a cab
        # driver is self-scheduling, so this is a habitual working pattern and
        # the behaviour module should treat it as a tendency rather than a
        # shift it is obliged to fill.
        #
        # Overwhelmingly daytime, with a real but small night tail. The classic
        # day-man/night-man lease split — which exists because an idle cab is
        # idle capital — has largely gone with rideshare self-scheduling, and
        # 145 drivers in a city of 125,000 is not a trade running three full
        # watches. What keeps nights non-zero is that the reference city turns its two
        # hospital campuses over at 7 and 19, closes its bars downtown, and
        # sits next to an airport with early departures. Fourteen drivers
        # covering that is plausible; zero would mean the city has no way home
        # after midnight.
        "platoons": (("day", 60), ("evening", 30), ("night", 10)),
    },
    {
        "key": "school_bus_driver",
        "occupation": "9121",
        # INDP 7860, elementary and secondary schools — not 6180, bus service
        # and urban transit. Most of these drivers are on the district's own
        # payroll and are school employees who happen to drive; the forty-odd
        # who turn out for the contractor are the exception, and splitting the
        # occupation across two industries to capture them would put a fact in
        # the population that nothing downstream reads. `school_travel.py` knows
        # which operator each driver drives for, because it assigns the shift.
        "industry": "7860",
        # No premises in the extract. The yard is a lot, and OSM records it — if
        # at all — as an unnamed car park, which is why school_travel.py places
        # each operator's depot at the centroid of the schools it serves. That
        # depot is where the runs start, and the runtime takes it from there
        # rather than from this posting.
        "facility": None,
        "target": SCHOOL_BUS_DRIVERS,
        # 21 is the federal floor for a CDL with the passenger and school bus
        # endorsements, but nobody enters this trade at 21. It is a second job
        # and often a third — worked around a pension, a farm, a parent's own
        # school day — and the age profile is the oldest of any driving
        # occupation in the country. There is no mandatory retirement.
        "ages": (25, 74),
        "peak_age": 54,
        # Group 22, transportation and material moving. Transit and shuttle
        # drivers, delivery drivers, anyone already holding a commercial licence
        # or a class of it — the endorsement is weeks of training on top, not a
        # career change.
        "feeders": ("22",),
        # A diploma trade with a real sub-diploma tail and a genuine college
        # minority, and the minority is not noise: the split shift suits people
        # whose day is already broken in half — parents of school-age children,
        # retirees from other work — so the grade catches degree-holders doing
        # it for the hours and the benefits rather than for the pay.
        "education": ((13, 3), (15, 5), (16, 48), (17, 12), (18, 12),
                      (19, 10), (20, 6), (21, 4)),
        # Low, and low because it is part time. Two blocks of four hours with
        # the middle of the day unpaid is 25-30 hours a week, and the hourly
        # rate behind $21k is not far off the city's median — the annual figure
        # is short because the job is. The step is real but shallow; districts
        # pay for seniority and for keeping a route.
        "pay": (21000, 400),
        # The one majority-woman role in this table, and by a wide margin
        # nationally. The split shift is the reason usually given.
        "male_share": 0.42,
        # Not a watch. A driver works both halves of the day where the roster
        # allows it and one half where it does not, and which half is a question
        # about routes that only school_travel.py can answer — it assigns the
        # shift per (bus, direction) once the manifests exist. One platoon here
        # says the job is a split shift; it does not pretend to say whose.
        "platoons": (("split", 1),),
    },
)

# Establishment share by facility role, relative to what floor area implies.
# A substation is a desk and a report-writing room, and an investigations
# bureau is a specialist unit whose size has nothing to do with its premises;
# neither scales the way a headquarters does. Applied only to police, because
# fire stations are all the same kind of thing.
ROLE_FACTOR = {"station": 1.0, "substation": 0.12, "bureau": 0.15}

DUTY = {"station": "patrol", "substation": "patrol", "bureau": "investigations"}


def largest_remainder(weights, total):
    """Split `total` across `weights` in proportion, as whole numbers summing
    exactly to it. Remainders go to the largest fractions, in order."""
    if not total or not sum(weights):
        return [0] * len(weights)
    scale = total / sum(weights)
    exact = [w * scale for w in weights]
    counts = [int(e) for e in exact]
    order = sorted(range(len(weights)), key=lambda i: exact[i] - counts[i],
                   reverse=True)
    for i in order[:total - sum(counts)]:
        counts[i] += 1
    return counts


def posts(group, kind, total):
    """Distribute `total` posts across a facility group. Returns [(facility, n)].

    Police weight on floor area: headquarters is a multi-storey office building
    and the establishment scales with the offices in it. Fire weights on
    footprint instead, because what a fire station holds is apparatus bays —
    they are ground-floor by construction, and Central is the only one in the
    extract with a level count at all, so weighting its floor would triple its
    crew on a data artifact rather than on a fact about the building.
    """
    if kind == "fire":
        # Only the six stations inside the city line. The outlying volunteer
        # companies are in the extract but are not the city's to staff.
        group = [f for f in group if f["city"]]
        weights = [f["footprint"] or f["floor"] for f in group]
    else:
        weights = [f["floor"] * ROLE_FACTOR[f["role"]] for f in group]
    return list(zip(group, largest_remainder(weights, total)))


def candidates(persons, role, held, rng):
    """Weighted-random employed people eligible for `role`, best first.

    Weight combines occupational adjacency, the depth of the bucket a recruit
    would be taken from, and nearness to the role's typical service age. The
    depth term is what stops a draw of 210 from emptying a 21-person
    occupation: weighting by bucket size makes a recruit's cost to their old
    occupation roughly constant.
    """
    low, high = role["ages"]
    groups = json.loads(OCCUPATIONS.read_text())["occupations"]
    depth = Counter(p["occupation"] for p in persons
                    if p["employment"] in EMPLOYED and p["occupation"])

    pool = []
    for person in persons:
        if person["employment"] not in EMPLOYED or not person["occupation"]:
            continue
        if not low <= person["age"] <= high or person["id"] in held:
            continue
        group = groups.get(person["occupation"], {}).get("detailed_group")
        weight = depth[person["occupation"]]
        if group in role["feeders"]:
            weight *= FEEDER_BOOST
        weight *= math.exp(-(((person["age"] - role["peak_age"])
                              / AGE_SPREAD) ** 2))
        pool.append((person, weight))

    # One weighted pass without replacement. rng.choices would repeat people.
    people = [p for p, _ in pool]
    keys = [rng.random() ** (1 / w) if w else 0.0 for _, w in pool]
    return sorted(range(len(people)), key=lambda i: -keys[i]), people


def educate(recruits, role):
    """Give the recruit set the role's attainment distribution, exactly.

    Drawing each recruit's education independently and keeping the higher of
    that and what they already had cannot hit a target share, only exceed it:
    the rule ratchets one way, so two independent 30% chances of a degree
    compound into 50% of the grade holding one. Asking for 42% of paramedics
    to have been to college and getting 50% is not a rounding difference, it
    is the model saying something the configuration did not.

    So the distribution is allocated as counts rather than sampled, and the
    highest levels go to the recruits who already held them. That hits the
    share exactly and still puts the degrees on the people who came in with
    degrees; a recruit is only written down when the grade has fewer college
    places than college-educated applicants, which is a fact about the job
    rather than something lost from their record.
    """
    levels, shares = zip(*role["education"])
    counts = largest_remainder(shares, len(recruits))
    # Best-attained recruit takes the highest place available, and so down.
    ranked = sorted(recruits, key=lambda p: -p["education"])
    places = [level for level, n in sorted(zip(levels, counts), reverse=True)
              for _ in range(n)]
    for person, level in zip(ranked, places):
        person["education"] = level


def enlist(person, role, soc, rng):
    """Rewrite `person` into `role`. Returns (income delta, the job they left).

    The vacated job is returned rather than discarded because a surplus holder
    of the role's own occupation is about to need one; see `release`.

    Education is not set here — it is allocated across the whole recruit set
    at once, by `educate`, because a distribution cannot be hit one draw at a
    time.
    """
    vacancy = {field: person[field]
               for field in ("occupation", "soc", "industry", "income")}

    person["occupation"] = role["occupation"]
    person["soc"] = soc
    person["industry"] = role["industry"]

    base, step = role["pay"]
    years = min(max(person["age"] - role["ages"][0], 0), 30)
    # 6% lognormal around the step scale, the same shape jitter.py uses on
    # income, so two officers of the same age are not paid to the dollar.
    pay = round((base + step * years) * rng.lognormvariate(-0.0018, 0.06))
    delta = pay - (person["income"] or 0)
    person["income"] = pay
    return delta, vacancy


def release(surplus, vacancies, by_household):
    """Move surplus holders into the jobs the recruits left behind.

    Without this, an occupation that is recruited into but also already held
    ends up with more people in it than the establishment has posts, and the
    extras are phantoms: coded as taxi drivers, counted as taxi drivers by
    anything reading the population, and on no roster. For the 19 spare EMTs
    that was tolerable and even true to life. For taxi drivers it is not —
    capping four cloned records at two apiece leaves 137 surplus, so the
    occupation would come out at 282 people against a surveyed 145 and a fleet
    of 145.

    Swapping fixes it exactly. Each recruit vacates a job and each surplus
    holder takes one, so every occupation in the city ends the stage with the
    count it started with and the roster is the whole of its occupation. What
    changed is who holds which job, which is the one thing this stage is
    entitled to change.

    Returns however many surplus holders found no vacancy — nonzero only when
    a role has more spare holders than it recruits, and they keep the
    occupation as before.
    """
    for person, job in zip(surplus, vacancies):
        delta = (job["income"] or 0) - (person["income"] or 0)
        person.update(job)
        by_household[person["household"]]["income"] += delta
    return max(len(surplus) - len(vacancies), 0)


def retained(persons, households, role, held, rng):
    """Existing holders of the role's occupation who get posted, and how many
    were passed over.

    Capped at RETAIN_PER_SOURCE per PUMS record. Which of a record's clones is
    kept is arbitrary — they are identical apart from jitter — so a shuffle
    decides it rather than file order, which would otherwise make the choice a
    function of the synthesis loop.
    """
    holders = [p for p in persons if p["occupation"] == role["occupation"]
               and p["employment"] in EMPLOYED and p["id"] not in held]
    rng.shuffle(holders)

    seen, keep, surplus = Counter(), [], []
    for person in holders:
        source = households[person["household"]]["source"]
        if seen[source] < RETAIN_PER_SOURCE and len(keep) < role["target"]:
            seen[source] += 1
            keep.append(person)
        else:
            surplus.append(person)
    return keep, surplus


def watches(platoons, count, rng):
    """`count` platoon names in the configured proportions, shuffled.

    The rotation is shuffled before the split, not only after. A station of
    four medics divides 2/1/1 across three watches and largest_remainder
    always hands that spare to the first platoon in the list; over six
    stations that compounds into an A watch half again the size of C, on
    shares that were meant to be equal.
    """
    rotation = list(platoons)
    rng.shuffle(rotation)
    names, shares = zip(*rotation)
    watch = [n for n, k in zip(names, largest_remainder(shares, count))
             for _ in range(k)]
    rng.shuffle(watch)
    return watch


# How much of the watch draw is chronotype and how much is everything else.
#
# Evening types select into night work and morning types leave it, but the
# effect is a tendency and not a rule — plenty of larks work nights because the
# job was there. Sorting on chronotype alone would put every morning person in
# the city on days and separate the watches by more than two standard
# deviations, which is far past what is measured. The noise term is about twice
# the individual spread in chronotype, and on a 210-officer force that comes out
# as a night watch whose mid-sleep runs 67 minutes later than the day watch's —
# 1.07 standard deviations of the force, at the top of the range the shift-work
# literature reports. Raise it to weaken the sorting; the platoon shares the
# establishment declares are untouched either way.
WATCH_NOISE = 110

# Watch names that mean a time of day, and how late each one is.
#
# Only these can be selected into. Fire and EMS run a/b/c platoons that each
# rotate through the whole clock, so there is no night watch to prefer and
# their pairing stays random — which is the honest answer rather than an
# oversight.
EVENINGNESS = {"day": 0, "evening": 1, "night": 2}


def posting(people, platoons, rng):
    """Pair people with watch slots, by chronotype where the watch has a clock.

    The slot counts come from `watches` and are not touched: the establishment
    says what share of the force is on nights and that is not this function's
    to move. All that changes is which people fill them.
    """
    slots = watches(platoons, len(people), rng)
    if not all(slot in EVENINGNESS for slot in slots):
        return list(zip(people, slots))

    ordered = sorted(people, key=lambda p: (p.get("chronotype") or 0)
                     + rng.gauss(0, WATCH_NOISE))
    slots.sort(key=lambda slot: EVENINGNESS[slot])
    return list(zip(ordered, slots))


def staff(persons, households, groups, rng):
    """Fill the establishment and post it. Returns the roster."""
    mapping = json.loads(OCCUPATIONS.read_text())["occupations"]
    by_id = {p["id"]: p for p in persons}
    by_household = {h["id"]: h for h in households}
    roster, held, provenance = [], set(), defaultdict(Counter)
    unposted = {}

    for role in ESTABLISHMENT:
        soc = mapping[role["occupation"]]["soc"].replace("-", "")
        recruits = []

        if role["target"] is None:
            # Establishment is whatever the sample carries, so every holder is
            # posted and the per-source cap does not apply — there is no
            # headcount for a cloned record to crowd anyone out of.
            serving = [p for p in persons
                       if p["occupation"] == role["occupation"]
                       and p["employment"] in EMPLOYED and p["id"] not in held]
            unposted[role["key"]] = 0
        else:
            serving, surplus = retained(
                persons, by_household, role, held, rng)

            # Sex is a quota, not another weight. Weighting the draw cannot
            # hold a ratio when FEEDER_BOOST is 25× and the feeders are
            # lopsided: the occupations that supply paramedics are ~85% women,
            # so a 1.9× nudge towards men loses to a 25× nudge towards aides
            # and the service comes out inverted. A quota holds regardless of
            # what the pool looks like, and still never rewrites anyone's sex
            # — it only decides who is asked.
            wanted = round(role["target"] * role["male_share"])
            quota = {1: wanted, 2: role["target"] - wanted}
            for person in serving:
                quota[person["sex"]] -= 1

            # Surplus holders are candidates for nothing — they already hold
            # the occupation — so they are excluded from the draw and then
            # given the recruits' vacated jobs below.
            order, pool = candidates(persons, role,
                                     held | {p["id"] for p in surplus}, rng)
            vacancies = []
            for index in order:
                if len(serving) + len(recruits) >= role["target"]:
                    break
                person = pool[index]
                # A quota can go negative when retained holders overshoot it;
                # then the other sex simply takes the remaining posts.
                if quota[person["sex"]] <= 0:
                    continue
                quota[person["sex"]] -= 1
                provenance[role["key"]][person["occupation"]] += 1
                delta, vacancy = enlist(person, role, soc, rng)
                # The invariant jitter.py establishes: a household's income is
                # the sum it always was of its members'. Absorb the change
                # rather than leaving HINCP describing a job the person no
                # longer has.
                by_household[person["household"]]["income"] += delta
                recruits.append(person)
                vacancies.append(vacancy)

            # Recruits only. People already serving keep the attainment their
            # PUMS record carries — a surveyed fact, not something to allocate.
            educate(recruits, role)
            unposted[role["key"]] = release(surplus, vacancies, by_household)

        filled = serving + recruits
        held.update(p["id"] for p in filled)
        rng.shuffle(filled)

        if role["facility"] is None:
            # Home-based. The driver's own dwelling is the base of operations,
            # which keeps `site` meaning the same thing for every role: where
            # this person's shift starts. `mode` is what says the shift does
            # not stay there — the same distinction assign_work.py draws for
            # couriers and home health aides, who are filler-class but no more
            # sited than a cab is.
            for person, platoon in posting(filled, role["platoons"], rng):
                roster.append({
                    "person": person["id"],
                    "role": role["key"],
                    "class": "primary",
                    "occupation": role["occupation"],
                    "site": by_household[person["household"]]["dwelling"],
                    "mode": "itinerant",
                    "platoon": platoon,
                    "duty": "mobile",
                    "recruited": person in recruits,
                })
            continue

        # Facilities take their share, then the shift split runs within each
        # one so no station is left staffed on a single watch.
        cursor = 0
        for facility, count in posts(groups[role["facility"]], role["facility"],
                                     len(filled)):
            here = filled[cursor:cursor + count]
            cursor += count
            for person, platoon in posting(here, role["platoons"], rng):
                roster.append({
                    "person": person["id"],
                    "role": role["key"],
                    "class": "primary",
                    "occupation": role["occupation"],
                    "site": facility["key"],
                    "mode": "sited",
                    "platoon": platoon,
                    "duty": DUTY.get(facility.get("role"), "response"),
                    "recruited": person in recruits,
                })

    crew(roster, rng)
    # After crewing, never before: crew() reassigns a medic's platoon to match
    # their partner's, and a schedule derived from the pre-crew platoon would
    # send half of every ambulance to work on the wrong day.
    shifted = shifts.apply(roster, by_id, rng.randrange(2 ** 32))
    return roster, provenance, by_id, unposted, shifted


def crew(roster, rng):
    """Pair each EMT with a paramedic and put the pair on a watch together.

    An ambulance is a two-person unit and the roster has to divide into them:
    a station with three medics and one EMT can put one full crew on the road,
    not two. Pairing here rather than in the behaviour module means the
    shortfall shows up in this stage's report, where it can be fixed by moving
    the establishment, instead of at run time as an ambulance that never rolls.

    Crews are formed first and rostered onto a watch second, which is the only
    order that works. Splitting each grade across the watches independently
    lets a station of four medics and four EMTs land 2/1/1 and 1/2/1 — the
    counts are right, every watch is staffed, and two of the three cannot crew
    an ambulance. Assigning the pair means the pairing cannot be broken by the
    rounding, and a crew shares a shift the way a real one does.
    """
    grades = ("paramedic", "emt")
    stations = defaultdict(lambda: defaultdict(list))
    for entry in roster:
        if entry["role"] in grades:
            stations[entry["site"]][entry["role"]].append(entry)
    platoons = next(r["platoons"] for r in ESTABLISHMENT
                    if r["key"] == "paramedic")

    units = 0
    for station in stations.values():
        medics, techs = station["paramedic"], station["emt"]
        rng.shuffle(medics)
        rng.shuffle(techs)
        pairs = list(zip(medics, techs))

        for (medic, tech), platoon in zip(pairs,
                                          watches(platoons, len(pairs), rng)):
            units += 1
            medic["crew"] = tech["crew"] = f"medic{units}"
            medic["platoon"] = tech["platoon"] = platoon

        # Whoever is left has no partner and no vehicle. Say so rather than
        # inventing a one-person ambulance; they keep the watch the facility
        # split gave them and show up in the report as unpaired.
        for spare in medics[len(techs):] + techs[len(medics):]:
            spare["crew"] = None


def report(roster, provenance, by_id, by_household, groups, mapping, unposted):
    print()
    facilities.report(groups)

    # Home-based roles are one row, not one row per driveway.
    homed = {r["key"] for r in ESTABLISHMENT if r["facility"] is None}
    posted = defaultdict(Counter)
    for entry in roster:
        key = "(home)" if entry["role"] in homed else entry["site"]
        posted[key][entry["role"]] += 1
    names = {f["key"]: f["name"] for group in groups.values() for f in group}
    names["(home)"] = "(no premises — based at home)"
    order = [f["key"] for group in groups.values() for f in group
             if f["key"] in posted] + ["(home)" for _ in range(1) if homed]

    print(f"\n\033[1mestablishment\033[0m  {len(roster)} posts")
    roles = [r["key"] for r in ESTABLISHMENT]
    width = max(len(names[k]) for k in posted)
    print(f"  {'':<{width}}  " + "  ".join(f"{r:>13}" for r in roles))
    for key in order:
        print(f"  {names[key]:<{width}}  "
              + "  ".join(f"{posted[key][r]:>13,}" for r in roles))
    totals = Counter()
    for counts in posted.values():
        totals.update(counts)
    print(f"  {'total':<{width}}  " + "  ".join(f"{totals[r]:>13,}" for r in roles))

    print("\n\033[1mwatches\033[0m")
    for role in ESTABLISHMENT:
        split = Counter(e["platoon"] for e in roster if e["role"] == role["key"])
        print(f"  {role['key']:<15} " + "  ".join(
            f"{name} {split[name]:>4} ({split[name] / sum(split.values()) * 100:.0f}%)"
            for name, _ in role["platoons"]))

    crewed = Counter(e["role"] for e in roster if e.get("crew"))
    unpaired = sum(1 for e in roster
                   if e["role"] in ("emt", "paramedic") and not e.get("crew"))
    print(f"\n{crewed['emt']} ambulance crews of two on the roster"
          + (f", {unpaired} medics unpaired" if unpaired else ""))

    print("\n\033[1mrecruited from\033[0m")
    for role, sources in provenance.items():
        taken = sum(sources.values())
        kept = sum(1 for e in roster
                   if e["role"] == role and not e["recruited"])
        spare = unposted[role]
        print(f"  {role}  {taken} recruits, {kept} already serving"
              + (f", {spare} surplus holders kept the occupation with no post"
                 if spare else ""))
        for occupation, count in sources.most_common(5):
            label = mapping.get(occupation, {}).get("label", "?")
            print(f"    {count:>4}  {label[:56]}")

    print("\n\033[1mrecruits\033[0m")
    for role in ESTABLISHMENT:
        people = [by_id[e["person"]] for e in roster if e["role"] == role["key"]]
        if not people:
            continue
        ages = sorted(p["age"] for p in people)
        pay = sorted(p["income"] for p in people)
        # SCHL 18 is the first code meaning any college at all, 21 a
        # bachelor's. Both are printed because the grades are meant to differ
        # on the first and barely on the second.
        college = sum(1 for p in people if p["education"] >= 18) / len(people)
        degree = sum(1 for p in people if p["education"] >= 21) / len(people)
        male = sum(1 for p in people if p["sex"] == 1) / len(people)
        # How many distinct surveyed households this grade descends from. It
        # is the number that says how far any of the others can be trusted:
        # a grade built from four records has four ages wearing 145 faces, and
        # its mean and median describe the draw rather than the occupation.
        seeds = len({by_household[p["household"]]["source"] for p in people})
        print(f"  {role['key']:<15} {len(people):>4}  "
              f"age {ages[0]}-{ages[-1]} "
              f"mean {sum(ages) / len(ages):.1f} med {ages[len(ages) // 2]}  "
              f"pay ${pay[len(pay) // 2]:,} (${pay[0]:,}-${pay[-1]:,})  "
              f"{college * 100:.0f}% college  {degree * 100:.0f}% degree  "
              f"{male * 100:.0f}% male  from {seeds} PUMS records")


def check(persons, households):
    """Household income must still be the sum it was of its members'."""
    members = defaultdict(list)
    for person in persons:
        if person["income"] is not None:
            members[person["household"]].append(person["income"])
    drift = sum(1 for h in households
                if h["income"] != sum(members[h["id"]]) and members[h["id"]])
    return drift


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED,
                        help="recruitment seed; recorded in the output")
    parser.add_argument("--force", action="store_true",
                        help="staff a population that has already been staffed")
    args = parser.parse_args()

    population = json.loads(POPULATION.read_text())
    persons = population["person_records"]
    households = population["household_records"]

    # Recruitment overwrites the occupation it drew from, so it cannot be
    # undone and running it twice recruits on top of its own output — the
    # second pass sees 210 officers, retains what it can and refills the rest
    # from a population already missing the people the first pass took. Rebuild
    # from synthesis instead, which is cheap and gives the same result every
    # time for a given seed.
    if "work_seed" in population and not args.force:
        raise SystemExit(
            f"{POPULATION.name} is already staffed "
            f"(work_seed {population['work_seed']}); rebuild with "
            f"`init_sim.py --from population`, or pass --force to staff it again")

    groups = facilities.load()
    rng = random.Random(args.seed)

    # Household income tracks its members before this runs; whether it still
    # does afterwards is the one thing recruitment could quietly break.
    before = check(persons, households)

    roster, provenance, by_id, unposted, shifted = staff(
        persons, households, groups, rng)

    population["work_seed"] = args.seed
    population["establishment"] = {r["key"]: r["target"] for r in ESTABLISHMENT}
    POPULATION.write_text(json.dumps(population, separators=(",", ":")))

    OUTPUT.write_text(json.dumps({
        "source": POPULATION.name,
        "seed": args.seed,
        "facility_source": [facilities.POIS.name, facilities.GEOMETRY.name],
        # Only the primary-class occupations so far. Filler jobs — the other
        # 53,050 workers — are a separate stage and will extend this file.
        "roles": {r["key"]: {"occupation": r["occupation"],
                             "target": r["target"], "class": "primary"}
                  for r in ESTABLISHMENT},
        "facilities": [f for group in groups.values() for f in group],
        "posts": len(roster),
        "assignments": roster,
    }, separators=(",", ":")))

    mapping = json.loads(OCCUPATIONS.read_text())["occupations"]
    report(roster, provenance, by_id, {h['id']: h for h in households},
           groups, mapping, unposted)
    shifts.report(roster, by_id, shifted)

    after = check(persons, households)
    print(f"\nhouseholds with income not equal to members' sum: "
          f"{after} (before recruitment: {before})")
    print(f"\nWrote {OUTPUT} ({OUTPUT.stat().st_size / 1e3:.0f} kB)")
    print(f"Wrote {POPULATION} ({POPULATION.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
