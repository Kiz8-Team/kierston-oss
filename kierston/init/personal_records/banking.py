"""What people are paid, when it arrives, and what they are holding.

holdings.py used to answer "does this person have a bank account" and stop
there. That is enough to say somebody banks at Embassy and not enough to buy
anything: an account with no balance cannot be spent from, and an income with
no schedule cannot refill it. This module supplies both, and the pair is what
turns a list of institutions into a financial position.

Three things get modelled, in the order they depend on each other.

  income streams   what a person is paid for, how often, on which day, and by
                   what method. A stream is not a salary figure — it is a
                   schedule. "Every other Friday" is meaningless without a
                   phase, so every stream carries a dated anchor: the last time
                   this person was actually paid.
  accounts         a deposit account now carries a purpose and a balance. The
                   purpose is what stops a grocery run coming out of a savings
                   account, and it is expressed as flags rather than as a
                   string for the API to compare against.
  cash             carried money, as a row in the same table. It is not a bank
                   account and says so, but it debits through the same path,
                   which is the only way an unbanked person paid in cash has a
                   spendable position at all.

Payday belongs to the employer, not to the person. Everyone at the same
warehouse is paid on the same Friday, so the cycle is drawn once per site id
and every employee there inherits it — which is free, because assign_work.py
has already put people at sites. The people with no employer are the ones with
the most regular dates of all: Social Security pays on the second, third or
fourth Wednesday of the month selected by the recipient's own birth day, SSI
pays on the 1st, and both of those are real rules applied to birth dates the
identity stage already drew.

MONEY IN THIS MODULE IS DOLLARS, as a float rounded to the cent. Every amount
is put through `money()` rather than assigned raw, which is what keeps a
balance from drifting: a float accumulates representation error as it is added
to and subtracted from, and rounding at each step stops that error compounding
into something visible after a day of transactions. Read a balance back and
it is the number it looks like.

The fields are packed as f64 and not f32. A rate can live in f32; money
cannot, because f32 carries about seven significant digits and a balance of
$440,365.12 has eight — it would arrive back with its cents rounded off.

Nothing here does I/O or owns an RNG. Every function takes the stream it should
draw from, which is what lets holdings.py key each person's banking draw
independently of their licence draw — see `keyed` in registries.py.
"""

import math
from datetime import date, timedelta

import registries
import jurisdiction as legal

MONEY = legal.state_module("money")


# The city's clock, the profile's [locale] reference_date by way of
# registries.py. identity.py works to the same day, and the anchors below are
# all "the most recent payday on or before this", so a stream read on any
# later date can project forward from a real dated payment.
REFERENCE_DATE = registries.REFERENCE_DATE

def money(value):
    """An amount as dollars, rounded to the cent.

    Every amount in this module goes through here. Rounding at each step is
    what keeps repeated arithmetic from drifting — a float balance added to and
    taken from all day accumulates representation error otherwise, and a
    balance that reads $84.11999999999999 is a balance nothing can compare
    against cleanly.
    """
    return round(float(value), 2)


def graded(table, value):
    """First entry in an ascending (bound, value) table whose bound covers `value`."""
    return next(result for bound, result in table if value <= bound)


def lognormal(rng, median, sigma):
    """A draw whose median is `median` and whose mean is median * exp(sigma^2/2).

    Money is log-normal or it is wrong. Deposit balances, in particular, have a
    mean several times their median, and no symmetric distribution produces
    both a $12 account and a $90,000 one from the same parameters.
    """
    return median * math.exp(rng.gauss(0.0, sigma))


# ---------------------------------------------------------------------------
# What is left after withholding
# ---------------------------------------------------------------------------

# Share of gross that reaches the account, by gross. State and local income
# taxes make it state-specific.
KEEP_WAGES = MONEY.KEEP_WAGES

# The self-employed pay both halves of FICA and get no withholding at all,
# which is two separate facts: they keep less, and what they are holding in
# July includes money they will owe in April. The second one is handled in the
# balance model, not here.
SELF_EMPLOYMENT_PENALTY = 0.93

# Social Security, SSI and unemployment are largely untaxed at these amounts.
KEEP_BENEFIT = 0.97


def keep_rate(source, gross):
    if source in ("social_security", "ssi", "public_assistance", "pension"):
        return KEEP_BENEFIT
    rate = graded(KEEP_WAGES, gross)
    if source in ("self_employment", "gig"):
        rate *= SELF_EMPLOYMENT_PENALTY
    return rate


# ---------------------------------------------------------------------------
# Pay cycles
# ---------------------------------------------------------------------------

# Length of pay period, by INDP sector prefix. The national mix is roughly
# a third weekly and two fifths biweekly, but the variation between sectors is
# larger than the average is informative: construction and food service run on
# weekly cheques, public administration essentially never does, and finance
# leans semimonthly. The sector is the best predictor available without
# inventing an HR policy per firm.
PAY_PERIOD = {
    "AGR": (("weekly", 55), ("biweekly", 30), ("semimonthly", 10), ("monthly", 5)),
    "CON": (("weekly", 58), ("biweekly", 32), ("semimonthly", 8), ("monthly", 2)),
    "EXT": (("weekly", 30), ("biweekly", 52), ("semimonthly", 14), ("monthly", 4)),
    "MFG": (("weekly", 34), ("biweekly", 52), ("semimonthly", 11), ("monthly", 3)),
    "WHL": (("weekly", 28), ("biweekly", 52), ("semimonthly", 16), ("monthly", 4)),
    "RET": (("weekly", 30), ("biweekly", 54), ("semimonthly", 13), ("monthly", 3)),
    "TRN": (("weekly", 30), ("biweekly", 55), ("semimonthly", 12), ("monthly", 3)),
    "UTL": (("weekly", 10), ("biweekly", 62), ("semimonthly", 22), ("monthly", 6)),
    "INF": (("weekly", 8), ("biweekly", 50), ("semimonthly", 34), ("monthly", 8)),
    "FIN": (("weekly", 5), ("biweekly", 38), ("semimonthly", 46), ("monthly", 11)),
    "PRF": (("weekly", 12), ("biweekly", 44), ("semimonthly", 36), ("monthly", 8)),
    "EDU": (("weekly", 3), ("biweekly", 60), ("semimonthly", 27), ("monthly", 10)),
    "MED": (("weekly", 10), ("biweekly", 64), ("semimonthly", 21), ("monthly", 5)),
    "SCA": (("weekly", 22), ("biweekly", 52), ("semimonthly", 20), ("monthly", 6)),
    "ENT": (("weekly", 44), ("biweekly", 40), ("semimonthly", 12), ("monthly", 4)),
    "SRV": (("weekly", 46), ("biweekly", 38), ("semimonthly", 12), ("monthly", 4)),
    "ADM": (("weekly", 1), ("biweekly", 62), ("semimonthly", 28), ("monthly", 9)),
    "MIL": (("weekly", 0), ("biweekly", 0), ("semimonthly", 100), ("monthly", 0)),
    None: (("weekly", 26), ("biweekly", 45), ("semimonthly", 22), ("monthly", 7)),
}

# Which weekday the weekly and biweekly cheques land on. Friday dominates and
# Thursday is the common alternative, because a Friday payday means the bank
# has to have cleared the file on Thursday.
PAY_WEEKDAY = ((4, 72), (3, 18), (2, 6), (0, 4))
WEEKDAY_NAME = {0: "monday", 2: "wednesday", 3: "thursday", 4: "friday"}

# Semimonthly and monthly land on calendar dates, and these are the standard
# ones: the 1st, the 15th, and the last day of the month.
SEMIMONTHLY = (("15th_and_last", 62), ("1st_and_15th", 38))
MONTHLY = (("last_day", 55), ("1st", 45))

NOMINAL_INTERVAL = {"weekly": 7, "biweekly": 14, "semimonthly": 15,
                    "monthly": 30, "irregular": 0}


def weighted(table, rng):
    return rng.choices([k for k, _ in table], weights=[w for _, w in table])[0]


def employer_cycle(sector, rng):
    """(frequency, payday) for one employer. Drawn per site, not per employee.

    Everybody at the same site inherits this, which is what makes a payday a
    fact about a workplace rather than a coincidence between colleagues. The
    biweekly phase is part of it: two employers both paying "every other
    Friday" pay on alternate ones half the time.
    """
    frequency = weighted(PAY_PERIOD.get(sector, PAY_PERIOD[None]), rng)
    if frequency in ("weekly", "biweekly"):
        payday = WEEKDAY_NAME[weighted(PAY_WEEKDAY, rng)]
    elif frequency == "semimonthly":
        payday = weighted(SEMIMONTHLY, rng)
    else:
        payday = weighted(MONTHLY, rng)
    # Which of the two alternating weeks this employer is on.
    phase = rng.randrange(2) if frequency == "biweekly" else 0
    return frequency, payday, phase


# ---------------------------------------------------------------------------
# Turning a payday rule into a date
# ---------------------------------------------------------------------------

WEEKDAY_NUMBER = {name: number for number, name in WEEKDAY_NAME.items()}


def month_end(when):
    return (when.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)


def previous_month_end(when):
    return when.replace(day=1) - timedelta(days=1)


def nth_weekday(year, month, weekday, n):
    """The nth given weekday of a month — the Social Security payment rule."""
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def last_payday(payday, phase, reference, rng):
    """The most recent payday on or before `reference`, as a date.

    This is the anchor every stream carries. A frequency alone cannot say when
    the next payment falls — "biweekly" describes a spacing, not a calendar —
    and a rule plus one real dated payment can project in either direction
    forever, which is what the runtime needs.
    """
    if payday in WEEKDAY_NUMBER:
        weekday = WEEKDAY_NUMBER[payday]
        back = (reference.weekday() - weekday) % 7
        when = reference - timedelta(days=back)
        return when - timedelta(weeks=phase)

    if payday == "1st":
        return reference.replace(day=1)

    if payday == "3rd":
        return (reference.replace(day=3) if reference.day >= 3
                else previous_month_end(reference).replace(day=3))

    if payday == "last_day":
        end = month_end(reference)
        return end if reference.day >= end.day else previous_month_end(reference)

    if payday == "1st_and_15th":
        return reference.replace(day=15 if reference.day >= 15 else 1)

    if payday == "15th_and_last":
        end = month_end(reference)
        if reference.day >= end.day:
            return end
        if reference.day >= 15:
            return reference.replace(day=15)
        return previous_month_end(reference)

    if payday.startswith("ss_wednesday_"):
        n = int(payday.rsplit("_", 1)[1])
        when = nth_weekday(reference.year, reference.month, 2, n)
        if when <= reference:
            return when
        earlier = previous_month_end(reference)
        return nth_weekday(earlier.year, earlier.month, 2, n)

    # Irregular. There is no rule, so the anchor is simply the last time money
    # turned up, drawn from the spacing this person's work actually has.
    return reference - timedelta(days=rng.randrange(1, 46))


# ---------------------------------------------------------------------------
# Where the money comes from
# ---------------------------------------------------------------------------

# COW, class of worker. 6 is self-employed in an unincorporated business, 7 is
# self-employed in one they incorporated, 8 is unpaid work in a family
# business — which is a real answer and not an income.
SELF_EMPLOYED = ("6", "7")
UNPAID_FAMILY = "8"
GOVERNMENT = ("3", "4", "5")

# ESR. 1 and 2 are employed, 4 and 5 are armed forces, 3 is unemployed, 6 is
# not in the labour force.
EMPLOYED = (1, 2, 4, 5)
UNEMPLOYED = 3

# Sectors where an unincorporated sole trader is doing gig work rather than
# running a business — driving, delivery, personal services. Gig platforms pay
# weekly and on a fixed day, which makes them irregular in amount but not in
# timing, and that is a distinction worth keeping.
GIG_SECTORS = ("TRN", "SRV", "ENT")
GIG_SHARE = 0.42

# Being paid in actual currency. Concentrated in the trades, agriculture and
# personal services, and much higher among people who cannot open an account.
CASH_PAY_BY_SECTOR = {"AGR": 0.30, "CON": 0.22, "SRV": 0.18, "ENT": 0.12,
                      "RET": 0.05, "SCA": 0.06, "MED": 0.04, "TRN": 0.05,
                      "EDU": 0.01, "FIN": 0.005, "ADM": 0.0, "MIL": 0.0}
CASH_PAY_DEFAULT = 0.03
CASH_PAY_SELF_EMPLOYED = 2.2
CASH_PAY_NO_SSN = 3.4
CASH_PAY_CAP = 0.72

# Direct deposit is close to universal among people with somewhere to deposit
# to. The rest is a paper cheque, and for the unbanked a payroll card.
DIRECT_DEPOSIT = 0.93
PAYROLL_CARD_IF_UNBANKED = 0.40

# Social Security pays by birth day of month: 1st-10th on the second
# Wednesday, 11th-20th on the third, 21st-31st on the fourth. Anyone entitled
# before May 1997 is paid on the 3rd instead, which today means the very old.
SS_LEGACY_AGE = 91
SS_ELIGIBLE_AGE = 62

# Roughly what share of a retiree's income is Social Security rather than a
# pension or a drawdown, graded by how much there is in total.
SS_SHARE = ((15_000, 0.95), (30_000, 0.72), (60_000, 0.45), (10 ** 9, 0.22))


def cash_pay_chance(sector, worker_class, has_ssn):
    chance = CASH_PAY_BY_SECTOR.get(sector, CASH_PAY_DEFAULT)
    if worker_class in SELF_EMPLOYED:
        chance *= CASH_PAY_SELF_EMPLOYED
    if not has_ssn:
        chance *= CASH_PAY_NO_SSN
    return min(CASH_PAY_CAP, chance)


def earned_stream(person, sector, cycles, employer, has_ssn, rng):
    """The stream a person's work pays them through, or None if they have none."""
    worker_class = person.get("worker_class")
    if person.get("employment") not in EMPLOYED or worker_class == UNPAID_FAMILY:
        return None

    gross = person.get("income") or 0
    if worker_class in SELF_EMPLOYED:
        gig = (worker_class == "6" and sector in GIG_SECTORS
               and rng.random() < GIG_SHARE)
        source = "gig" if gig else "self_employment"
        if gig:
            # Platforms pay out weekly on a fixed day. The amount moves; the
            # date does not, which makes gig work irregular in the one way
            # that does not affect the calendar.
            frequency, payday, phase = "weekly", "wednesday", 0
        elif worker_class == "7":
            # An incorporated owner runs themselves through their own payroll,
            # which means a real and usually calendar-dated cycle.
            frequency = weighted((("semimonthly", 44), ("monthly", 36),
                                  ("biweekly", 20)), rng)
            payday = (weighted(SEMIMONTHLY, rng) if frequency == "semimonthly"
                      else weighted(MONTHLY, rng) if frequency == "monthly"
                      else "friday")
            phase = rng.randrange(2) if frequency == "biweekly" else 0
        else:
            # A sole trader is paid when the client pays, which is the one
            # genuinely irregular schedule in the city.
            frequency, payday, phase = "irregular", "irregular", 0
    else:
        source = "wages"
        frequency, payday, phase = cycles(employer, sector)

    return build_stream(source, gross, frequency, payday, phase, employer,
                        person, sector, has_ssn, rng)


def benefit_stream(person, identity, rng):
    """Social Security, SSI, a pension or unemployment — the calendar-dated money."""
    age = person["age"]
    gross = person.get("income") or 0
    employment = person.get("employment")

    if employment == UNEMPLOYED and gross > 0:
        # Paid on the state's schedule. It lands on a state debit card as
        # often as in an account.
        return build_stream("unemployment", min(gross, 26_000),
                            MONEY.UNEMPLOYMENT_CADENCE,
                            MONEY.UNEMPLOYMENT_WEEKDAY, rng.randrange(2), None, person,
                            None, True, rng)

    if employment in EMPLOYED or gross <= 0:
        return None

    if age >= SS_ELIGIBLE_AGE:
        share = graded(SS_SHARE, gross)
        birth_day = int(identity["birth_date"][8:10])
        if age >= SS_LEGACY_AGE:
            payday = "3rd"
        elif birth_day <= 10:
            payday = "ss_wednesday_2"
        elif birth_day <= 20:
            payday = "ss_wednesday_3"
        else:
            payday = "ss_wednesday_4"
        return build_stream("social_security", int(gross * share), "monthly",
                            payday, 0, None, person, None, True, rng)

    # Working age, out of the labour force, with an income. SSI is the one
    # that pays on the 1st; everything else here is assistance of some kind.
    source = "ssi" if gross < 12_000 else "public_assistance"
    return build_stream(source, gross, "monthly", "1st", 0, None, person,
                        None, True, rng)


def build_stream(source, gross, frequency, payday, phase, employer, person,
                 sector, has_ssn, rng):
    """Assemble one stream: schedule, method, and what lands each time."""
    periods = {"weekly": 52, "biweekly": 26, "semimonthly": 24,
               "monthly": 12}.get(frequency)
    if frequency == "irregular":
        # A sole trader is paid on completion, and the spacing is the thing
        # that varies rather than the rate. Somewhere between a fortnight and
        # a couple of months between payments.
        interval = rng.randrange(12, 62)
        periods = 365 / interval
    else:
        interval = NOMINAL_INTERVAL[frequency]

    if source in ("wages", "self_employment", "gig"):
        cash = rng.random() < cash_pay_chance(sector, person.get("worker_class"),
                                              has_ssn)
    else:
        cash = False

    net = gross * keep_rate(source, gross)
    anchor = last_payday(payday, phase, REFERENCE_DATE, rng)
    return {
        "holding": "income_stream",
        "source": source,
        "employer": employer,
        "frequency": frequency,
        "payday": payday,
        # A dated payment, so the schedule can be projected in either
        # direction. See last_payday for why a frequency alone cannot.
        "anchor": anchor.isoformat(),
        "interval_days": interval,
        # Filled in by accounts(), which is the stage that knows whether this
        # person has anywhere for it to land.
        "method": "cash" if cash else None,
        "account": None,
        "gross_annual": money(gross),
        "gross_per_period": money(gross / periods),
        "net_per_period": money(net / periods),
    }


# ---------------------------------------------------------------------------
# Balances
# ---------------------------------------------------------------------------

# Median total deposits held across every account a person has, by the income
# the holding tracks. Anchored on the Survey of Consumer Finances' transaction
# account medians by income percentile and shifted down for a city whose median
# household income is well under the national one.
#
# The bounds are upper edges — `graded` returns the first row the value fits
# under — so the bands have to be fine enough that the step between two of them
# is not itself a large error. Coarse bands here put every six-figure earner in
# the city on the top rung and tripled the median deposit of everyone above
# $85,000.
DEPOSIT_MEDIAN = ((10_000, 200), (20_000, 600), (30_000, 1_500),
                  (45_000, 2_400), (60_000, 3_500), (85_000, 6_500),
                  (110_000, 12_000), (160_000, 22_000), (10 ** 9, 40_000))

# Deposits accumulate over a working life and are drawn down after it.
AGE_DEPOSITS = ((24, 0.45), (34, 0.70), (44, 1.00), (54, 1.40), (64, 1.90),
                (74, 2.20), (200, 1.90))

# The mean/median gap in real deposit data is a factor of several, but that gap
# is not equally available at every age. A young person's balance can still be
# an inheritance or a windfall; it is merely much less likely to sit hundreds
# of times above the median than an older person's balance. The median already
# rises through AGE_DEPOSITS. This second age curve controls the width of the
# upper tail, approaching the old 1.35 calibration with age. It does not exceed
# the old width: older people already receive larger balances through
# AGE_DEPOSITS, so compounding both the median and the tail would create more
# town-wide outliers than the age-blind model did.
DEPOSIT_SIGMA_BY_AGE = ((24, 1.12), (34, 1.22), (44, 1.28), (54, 1.32),
                        (64, 1.35), (74, 1.35), (200, 1.35))

# What fraction of the last packet has not been spent yet. This is where the
# pay cycle reaches the balance: on identical annual income, somebody paid
# monthly is carrying far more on an average day than somebody paid weekly,
# and low earners run the packet down much closer to zero.
FLOAT_FRACTION = ((20_000, 0.22), (40_000, 0.32), (75_000, 0.45),
                  (10 ** 9, 0.60))

# Cash wages do not sit in a bank, and money owed to the IRS in April is
# sitting in an account in July.
CASH_PAID_DEPOSITS = 0.35
SELF_EMPLOYED_DEPOSITS = 1.25

# Overdrawn accounts are real and are the reason a decline can happen at all.
OVERDRAWN_INCOME = 30_000
OVERDRAWN_SHARE = 0.06
OVERDRAWN_MAX = 400

# The second-institution account — a money market or a certificate — is not
# part of the everyday position and is drawn on its own. Its tail is more
# tightly age-graded because it has no payroll float or household allocation
# behind it. At ages 25–34, sigma 0.90 makes a $535k draw about eight times less
# likely than the former age-blind sigma 1.0, while keeping such a windfall
# possible. The distribution widens progressively with age and reaches, but
# does not exceed, the former width in later life.
RESERVE_MEDIAN = 9_000
RESERVE_SIGMA_BY_AGE = ((24, 0.82), (34, 0.90), (44, 0.94), (54, 0.97),
                        (64, 1.00), (74, 1.00), (200, 1.00))

# Carried currency. A median of about $40 for people with a card in their
# pocket; for the cash-paid it is a real fraction of the last packet, and for
# the unbanked it is everything they have.
CASH_MEDIAN = 40
CASH_SIGMA = 0.75
# Log-normal has no upper bound and carried currency very much does. Without a
# cap the tail hands somebody $34,000 in their pocket, which is not a rare
# event worth keeping — it is the distribution being used outside its range.
# Set high enough that it is not reached by the people it would distort: a
# cash-paid worker legitimately sits on most of a fortnight's wages, and a cap
# that clipped them would put a spike at its own value.
CASH_CAP = 6_000
CASH_PAID_SHARE = 0.45
UNBANKED_SHARE = 0.35
UNBANKED_FLOOR = 120

# Under-15s hold no account and no card, which is right, but leaving them with
# no row at all means a child cannot buy anything — every payment for them
# declines with no position. They carry pocket money instead: a cash row and
# nothing else, so the same API answers for them without a special case.
POCKET_MONEY_AGE = 15
POCKET_MONEY_MEDIAN = 6
POCKET_MONEY_SIGMA = 1.0
POCKET_MONEY_CAP = 120


def income_basis(person, household):
    """The income a person's balance tracks, which is not always their own.

    A spouse with no earnings in a comfortable household is not broke, and
    reading PINCP alone says they are. The household income is divided by the
    square root of its size — the standard equivalence scale — and the larger
    of the two is what the balance is drawn against.
    """
    own = person.get("income") or 0
    size = max(1, household.get("size", 1))
    shared = (household.get("income") or 0) / math.sqrt(size) * 0.6
    return max(own, shared)


def deposit_total(person, household, streams, rng):
    """Total cents across every deposit account this person holds."""
    basis = income_basis(person, household)
    median = graded(DEPOSIT_MEDIAN, basis) * graded(AGE_DEPOSITS, person["age"])
    sigma = graded(DEPOSIT_SIGMA_BY_AGE, person["age"])
    total = lognormal(rng, median, sigma)
    if any(s["method"] == "cash" for s in streams):
        total *= CASH_PAID_DEPOSITS
    if any(s["source"] in ("self_employment", "gig") for s in streams):
        total *= SELF_EMPLOYED_DEPOSITS
    return money(total)


def payroll_float(streams, person, rng):
    """Cents of the last packet still unspent, which the everyday account holds."""
    if not streams:
        return 0
    net = max(s["net_per_period"] for s in streams)
    mean = graded(FLOAT_FRACTION, person.get("income") or 0)
    fraction = min(1.0, abs(rng.gauss(mean, mean * 0.55)))
    return money(net * fraction)


# The housing floor: what the everyday account has to be holding against the
# month's rent or mortgage.
#
# This is the correction for something the model above cannot see. Every
# balance here is drawn from SCF medians by income and age, and those are good
# numbers for "what is in the account" — but they are drawn against a household
# with no stated obligations, on a reference date that happens to be the 1st,
# which is the day the rent leaves. Simulate that day without this and 57% of
# the city's renters decline their own rent: not because Kierston is poor, but
# because nobody drawing the balances knew what would be asked of them the same
# morning.
#
# The floor is the whole month's housing and not a fraction of it, which was
# the first thing tried and is obviously wrong on second look — a floor at 75%
# of the rent is a floor that cannot pay the rent, and it moved the decline
# rate by a percentage point. It binds only where the draw came in under it and
# takes no draw of its own, so every balance in the city is the number it was
# before this existed unless it was too small to cover the housing.
#
# It goes to the two adults most likely to be the one paying, by the same
# ranking `recurring_spending.py` picks a payer with — not divided between
# them, because whichever of the two is billed needs the whole amount and the
# schedule moves it between them month to month. Beyond two it stops: a house
# of five adults is not five rents.
HOUSING_FLOAT_ADULT = 18
HOUSING_FLOAT_PAYERS = 2
# The extract is in 2023 dollars once ADJHSG has been applied and the city runs
# in 2026. Defined here and imported by recurring_spending.py rather than the
# other way round, because a floor and the bill it is a floor against must be
# quoted at one price level or the floor is quietly the wrong size.
HOUSING_INFLATION = 1.11


def ranked_adults(members):
    """The adults of a household, likeliest bill-payer first.

    Ranked by income rather than by relationship, because the account the rent
    leaves is the account with money in it; the householder wins ties for the
    same reason. A household with no adult at all — the extract does contain
    them — falls back to its eldest member, since somebody is paying the power.

    Lives here rather than in `recurring_spending.py`, which is its other
    caller, so that the balance model and the bill agree about who is expected
    to pay. Two copies of this ranking would put the float on one person and
    the rent on another.
    """
    adults = [m for m in members if m["age"] >= HOUSING_FLOAT_ADULT]
    if not adults:
        adults = sorted(members, key=lambda m: -m["age"])[:1]
    return sorted(adults, key=lambda m: (
        -(m.get("income") or 0), 0 if m["relationship"] == 20 else 1, m["id"]))


def housing_floor(row, household, person):
    """What this person's everyday account should hold against the housing.

    Built from the debits `recurring_spending.py` emits, through its own
    helpers, so the floor is never below the amount that leaves the account.
    Rent, the mortgage payment, the second mortgage, the condo fee and the
    mobile home lot fee. Not the utilities: they are an order of magnitude
    smaller and fall on scattered days rather than all on the 1st.

    Two inputs of the rent debit are not known here and are taken at their
    upper bound. The lease jitter is drawn under recurring_spending's own seed,
    so the floor uses 1 + RENT_JITTER. The hedonic factor depends on whichever
    of the two payers is billed that month, and rises with that payer's income;
    a member's income does not exceed the household's, so the floor prices the
    factor at the larger of the household income and this person's own.
    """
    if person["id"] not in household.get("payers", ()):
        return 0

    # Imported here because recurring_spending imports this module at load.
    import recurring_spending as bills

    def amount(field):
        value = row.get(field, "")
        return int(value) if str(value).lstrip("-").isdigit() else 0

    monthly = 0.0
    if row.get("TEN") == "3":
        rent = bills._dollars(row, "RNTP", 1)
        if rent:
            rent = money(rent * (1 + bills.RENT_JITTER))
            building = _dwellings().get(household.get("dwelling"))
            if building is None:
                factor = bills.MAX_RENT_FACTOR
            else:
                income = max(household.get("income") or 0,
                             person.get("income") or 0)
                factor = bills.rent_factor(household, {"income": income},
                                           building)
            monthly += money(rent * factor)
    else:
        # The mortgage debit is the holdings record's monthly_payment, which
        # is MRGP as surveyed with no ADJHSG or inflation applied. The other
        # deed charges go through recurring_spending's _dollars.
        if row.get("TEN") == "1":
            monthly += max(0, amount("MRGP"))
        monthly += bills._dollars(row, "SMP", 1) or 0
    monthly += bills._dollars(row, "CONP", 1) or 0
    monthly += money((bills._dollars(row, "MHP", 1) or 0) / 12)
    if monthly <= 0:
        return 0
    return money(monthly)


_DWELLING_CACHE = {}


def _dwellings():
    """{building id: building} from dwellings.json, read once per process."""
    if not _DWELLING_CACHE:
        import json
        from paths import SIM_DATA
        stock = json.loads((SIM_DATA / "dwellings.json").read_text())
        _DWELLING_CACHE.update({b["id"]: b for b in stock["dwellings"]})
    return _DWELLING_CACHE


def cash_balance(streams, banked, rng):
    """Carried currency, in cents."""
    median = CASH_MEDIAN
    if streams:
        net = max(s["net_per_period"] for s in streams)
        if any(s["method"] == "cash" for s in streams):
            median = max(median, net * CASH_PAID_SHARE)
        elif not banked:
            median = max(UNBANKED_FLOOR, net * UNBANKED_SHARE)
    elif not banked:
        median = UNBANKED_FLOOR
    return money(min(CASH_CAP, lognormal(rng, median, CASH_SIGMA)))


# ---------------------------------------------------------------------------
# How somebody pays
# ---------------------------------------------------------------------------

# The API is a pure function of its arguments and holds no seed, so anything
# about a person that persists across transactions has to be a record. These
# two are it: how readily somebody reaches for currency, and how readily they
# reach for credit. Both are traits, not coin flips — a person who pays cash at
# the bar does it every week.
# Calibrated against the Fed's Diary of Consumer Payment Choice: cash is about
# 16% of payments overall and roughly a third of the ones under $10. These are
# the base rates before routing.ts multiplies them up at the categories that
# genuinely run on notes, so they sit below the headline figure on purpose.
CASH_PREFERENCE = ((15_000, 0.30), (30_000, 0.19), (60_000, 0.11),
                   (10 ** 9, 0.06))
CASH_PREFERENCE_PAID_IN_CASH = 0.62
CASH_PREFERENCE_UNBANKED = 0.88
CASH_PREFERENCE_OLD = 0.08
OLD_AGE = 70

CREDIT_PREFERENCE = ((25_000, 0.18), (50_000, 0.34), (90_000, 0.52),
                     (10 ** 9, 0.68))


def _payment_profile(person, streams, has_account, cards, rng):
    cash = graded(CASH_PREFERENCE, person.get("income") or 0)
    if any(s["method"] == "cash" for s in streams):
        cash = max(cash, CASH_PREFERENCE_PAID_IN_CASH)
    if not has_account:
        cash = max(cash, CASH_PREFERENCE_UNBANKED)
    if person["age"] >= OLD_AGE:
        cash += CASH_PREFERENCE_OLD
    credit = (graded(CREDIT_PREFERENCE, person.get("income") or 0)
              if cards else 0.0)
    return {
        "holding": "payment_profile",
        # Jittered so two people on the same income are not identical, and
        # clamped because a probability outside [0, 1] is not one.
        "cash_preference": round(min(1.0, max(0.0, rng.gauss(cash, 0.08))), 3),
        "credit_preference": round(min(1.0, max(0.0, rng.gauss(credit, 0.10))), 3),
        "contactless": rng.random() < 0.74,
    }


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------

# The unbanked. Nationally around 4.5% of households, but strongly graded by
# income and by immigration status, and much higher in a city like this one:
# no SSN means no account at most institutions, which is why this reads the
# taxpayer id rather than income alone.
UNBANKED_BY_INCOME = ((0, 0.34), (15_000, 0.24), (30_000, 0.12),
                      (60_000, 0.045), (10 ** 9, 0.012))
UNBANKED_NO_SSN = 0.62
# Being paid in currency and having nowhere to deposit it are the same
# situation seen from two sides, so one raises the odds of the other.
UNBANKED_CASH_PAID = 1.8

# An unbanked person is not necessarily without any account: a prepaid or
# neobank app is what fills the gap, and it is a different kind of record with
# no branch behind it.
NEOBANK_IF_UNBANKED = 0.44

SAVINGS_ALONGSIDE = 0.66
# Banks want a minimum to keep a savings account open, so one that exists is
# never at exactly zero. Without this, anybody whose unspent pay exceeded their
# whole deposit draw — which is most of the people living to the packet — ended
# up holding a savings account with nothing whatsoever in it.
SAVINGS_FLOOR = 25
SAVINGS_FLOOR_SIGMA = 0.8
SEPARATE_SALARY_ACCOUNT = 0.22
SEPARATE_SALARY_INCOME = 40_000
RESERVE_ACCOUNT = 0.28
RESERVE_INCOME = 45_000

DEBIT_CARD_ISSUED = 0.94
DEBIT_NETWORKS = (("Visa", 62), ("Mastercard", 34), ("Discover", 4))

# Revolving credit. Count and limit both track income closely.
CARD_COUNTS = (0, 1, 2, 3, 5)
CARD_WEIGHTS = ((25_000, (30, 34, 20, 11, 5)),
                (70_000, (8, 20, 28, 26, 18)),
                (10 ** 9, (3, 10, 22, 30, 35)))
CREDIT_NETWORKS = (("Visa", 48), ("Mastercard", 36), ("Discover", 9),
                   ("American Express", 7))


def _account(kind, purpose, institution, routing, number, opened, *,
             spendable, debitable, receives_deposits, spend_rank,
             neobank=False, balance=0):
    """One deposit row.

    The three booleans are the whole point of the record. A purpose string
    would need the API to compare against a vocabulary and get it right every
    time; flags let it filter. `spendable` says money can leave this account at
    all, `debitable` says a card can be the thing that takes it, and
    `spend_rank` orders the accounts the API will try when the caller has not
    named one. Savings is spendable=False, so no amount of routing logic can
    put a grocery shop through it.
    """
    return {
        "holding": "bank_account",
        "institution": institution,
        "routing": routing,
        "number": number,
        "type": kind,
        "purpose": purpose,
        "opened": opened,
        "neobank": neobank,
        "balance": balance,
        "spendable": spendable,
        "debitable": debitable,
        "receives_deposits": receives_deposits,
        "spend_rank": spend_rank,
    }


def cash_account(balance):
    """Carried currency, as a row in the deposit table.

    Not a bank account, and it says so in every field that would name one: no
    institution, no routing number, no account number, and `neobank` is false
    because it is not an account at all. It lives here so the payments API
    debits currency down the same path as a card, which is the only way an
    unbanked person paid in cash has a spendable position rather than an empty
    list. It cannot be debited — no card exists for it — but it can be spent.
    """
    return _account("cash", "cash", None, None, None, None,
                    spendable=True, debitable=False, receives_deposits=True,
                    spend_rank=2, balance=balance)


def allocate(total, unspent, has_salary, has_savings):
    """Split total deposits across the accounts that hold them.

    The everyday account carries the unspent part of the last packet plus a
    small working cushion; whatever is left over is what the savings account is
    for. A separate salary account holds the part of the packet that has not
    been swept across yet, which is why it is a fraction of the float rather
    than a fraction of the total.
    """
    balances = {}
    if has_salary:
        balances["salary"] = money(min(total, unspent * 0.40))
        unspent -= balances["salary"]
    room = total - sum(balances.values())
    balances["everyday"] = money(max(0, min(room, unspent + total * 0.15)))
    left = total - sum(balances.values())
    if has_savings:
        balances["savings"] = money(max(0, left))
    else:
        balances["everyday"] = money(balances["everyday"] + max(0, left))
    return balances


def savings_floor(rng):
    """What sits in a savings account that is otherwise empty."""
    return money(lognormal(rng, SAVINGS_FLOOR, SAVINGS_FLOOR_SIGMA))


def deposit_accounts(person, identity, household, streams, registry, rng,
                     floor=0):
    """Every deposit row this person holds, cash included, with balances set.

    Returns (accounts, has_account). The flag is false only for someone whose
    single row is the cash one. A neobank customer counts as true: the survey
    calls them unbanked and the payments API cannot, because they have
    somewhere for money to land and a card to spend it with.
    """
    income = person.get("income") or 0
    cash_paid = any(s["method"] == "cash" for s in streams)

    unbanked = graded(UNBANKED_BY_INCOME, income)
    if not identity["taxpayer_id"] or identity["taxpayer_id_kind"] == "itin":
        unbanked = UNBANKED_NO_SSN
    if cash_paid:
        unbanked = min(0.9, unbanked * UNBANKED_CASH_PAID)

    if rng.random() < unbanked:
        if rng.random() < NEOBANK_IF_UNBANKED:
            name, routing = registry.bank(rng, neobank=True)
            account = _account(
                "checking", "everyday", name, routing,
                registry.next_account_number(rng, 10), REFERENCE_DATE.year - rng.randrange(0, 6),
                spendable=True, debitable=True, receives_deposits=True,
                spend_rank=0, neobank=True)
            # A neobank account is a thin one. It holds what is needed to get
            # to the end of the week, not a position.
            account["balance"] = max(money(lognormal(rng, 180, 1.2)), floor)
            return [account, cash_account(cash_balance(streams, True, rng))], True
        # No account at all, so the housing float is carried as notes — which
        # is how it is really carried, and how the money order that pays the
        # rent is really bought. Leave it off and every unbanked tenant in the
        # city declines their own rent on the 1st.
        return [cash_account(max(cash_balance(streams, False, rng), floor))], False

    opened = max(int(identity["birth_date"][:4]) + 16,
                 REFERENCE_DATE.year - rng.randrange(0, 30))
    opened = min(opened, REFERENCE_DATE.year)
    name, routing = registry.bank(rng)

    has_salary = (income >= SEPARATE_SALARY_INCOME
                  and rng.random() < SEPARATE_SALARY_ACCOUNT)
    has_savings = rng.random() < SAVINGS_ALONGSIDE

    total = deposit_total(person, household, streams, rng)
    balances = allocate(total, payroll_float(streams, person, rng),
                        has_salary, has_savings)

    # The housing floor lands on whichever account the money would actually be
    # sitting in, which is the salary account where there is one — that is what
    # `receives_deposits` means and where the payday lands.
    accounts = [_account(
        "checking", "everyday", name, routing, registry.next_account_number(rng),
        opened, spendable=True, debitable=True,
        receives_deposits=not has_salary, spend_rank=0,
        balance=balances["everyday"] if has_salary
        else max(balances["everyday"], floor))]

    # A small share of low-income everyday accounts are overdrawn, which is
    # both true and the reason a decline can ever happen.
    if income < OVERDRAWN_INCOME and rng.random() < OVERDRAWN_SHARE:
        accounts[0]["balance"] = money(-rng.randrange(5, OVERDRAWN_MAX)
                                       - rng.random())

    if has_salary:
        accounts.append(_account(
            "checking", "salary", name, routing, registry.next_account_number(rng),
            opened, spendable=True, debitable=True, receives_deposits=True,
            spend_rank=1, balance=max(balances["salary"], floor)))

    if has_savings:
        accounts.append(_account(
            "savings", "savings", name, routing, registry.next_account_number(rng),
            opened, spendable=False, debitable=False, receives_deposits=False,
            spend_rank=None,
            balance=max(balances["savings"], savings_floor(rng))))

    if income > RESERVE_INCOME and rng.random() < RESERVE_ACCOUNT:
        other, other_routing = registry.bank(rng)
        accounts.append(_account(
            rng.choice(("savings", "money_market", "certificate")), "reserve",
            other, other_routing, registry.next_account_number(rng),
            REFERENCE_DATE.year - rng.randrange(0, 15),
            spendable=False, debitable=False, receives_deposits=False,
            spend_rank=None,
            balance=money(lognormal(
                rng, RESERVE_MEDIAN,
                graded(RESERVE_SIGMA_BY_AGE, person["age"])))))

    accounts.append(cash_account(cash_balance(streams, True, rng)))
    return accounts, True


def debit_cards(accounts, rng):
    """A card for each account one can be issued against."""
    out = []
    for account in accounts:
        if not account["debitable"] or rng.random() >= DEBIT_CARD_ISSUED:
            continue
        expires = REFERENCE_DATE.year + rng.randint(0, 4)
        out.append({
            "holding": "debit_card",
            "account": account["number"],
            "issuer": account["institution"],
            "network": weighted(DEBIT_NETWORKS, rng),
            # Never a full number. A PAN with a valid check digit is a payment
            # credential and nothing here needs one — see the credit card
            # record, which has made the same choice since it was written.
            "last_four": f"{rng.randrange(10_000):04d}",
            "issued": REFERENCE_DATE.year - rng.randrange(0, 5),
            "expires": f"{expires:04d}-{rng.randint(1, 12):02d}-01",
            "contactless": rng.random() < 0.74,
        })
    return out


def credit_cards(person, identity, registry, rng):
    """Revolving credit, in cents like everything else the API can debit.

    Deposit accounts exist from age 15 in this model, but a minor is not the
    primary holder of a revolving-credit account. For adults, the opening year
    is bounded by their eighteenth birthday; drawing account age independently
    used to give young adults cards opened before they were born.
    """
    birth_year = int(identity["birth_date"][:4])
    first_eligible = birth_year + 18
    if first_eligible > REFERENCE_DATE.year:
        return []

    income = person.get("income") or 0
    count = rng.choices(CARD_COUNTS, weights=graded(CARD_WEIGHTS, income))[0]
    out = []
    for _ in range(count):
        issuer, _routing = registry.bank(rng)
        # Median limit around $6,000 with a long right tail, which is what the
        # real distribution looks like. Drawn log-normally because a normal
        # draw cannot produce both a $500 subprime card and a $35,000 one.
        limit = int(max(300, min(40_000, rng.lognormvariate(
            8.5 + min(income, 150_000) / 120_000, 0.75))) // 100 * 100)
        expires = REFERENCE_DATE.year + rng.randint(0, 4)
        out.append({
            "holding": "credit_card",
            "issuer": issuer,
            "last_four": f"{rng.randrange(10_000):04d}",
            "network": weighted(CREDIT_NETWORKS, rng),
            "opened": rng.randint(
                max(first_eligible, REFERENCE_DATE.year - 21),
                REFERENCE_DATE.year),
            "expires": f"{expires:04d}-{rng.randint(1, 12):02d}-01",
            "limit": money(limit),
            "balance": money(limit * min(1.0, abs(rng.gauss(0.28, 0.3)))),
        })
    return out


def deposit_target(accounts):
    """Where a payment or a transfer lands: the account set up to receive one."""
    candidates = [a for a in accounts if a["receives_deposits"]
                  and a["type"] != "cash"]
    if not candidates:
        return None
    return min(candidates, key=lambda a: a["spend_rank"] if a["spend_rank"]
               is not None else 99)


def position(person, identity, household, sector, employer, cycles, registry,
             rng, row=None):
    """Everything financial about one person: streams, accounts, cards, profile.

    The order is a dependency chain and not a preference. The streams decide
    whether somebody is paid in currency, which moves the odds they are
    unbanked, which decides what accounts exist, which decides where the
    streams can be told to land. Run it the other way round and cash wages get
    deposited into an account the person does not have.
    """
    if person["age"] < POCKET_MONEY_AGE:
        # No account, no card, no income — but not nothing. A child with money
        # in their pocket buys things, and giving them the cash row means the
        # payments API answers for them through the same path as everyone else
        # rather than declining every purchase as "no position".
        pocket = money(min(POCKET_MONEY_CAP,
                           lognormal(rng, POCKET_MONEY_MEDIAN,
                                     POCKET_MONEY_SIGMA)))
        return [cash_account(pocket),
                _payment_profile(person, [], False, [], rng)]

    has_ssn = bool(identity["taxpayer_id"]) and \
        identity["taxpayer_id_kind"] != "itin"

    streams = [s for s in (earned_stream(person, sector, cycles, employer,
                                         has_ssn, rng),
                           benefit_stream(person, identity, rng)) if s]

    accounts, has_account = deposit_accounts(
        person, identity, household, streams, registry, rng,
        floor=housing_floor(row, household, person) if row else 0)
    cards = credit_cards(person, identity, registry, rng) if has_account else []

    # Now that the accounts exist, the streams can say where they land.
    target = deposit_target(accounts)
    for stream in streams:
        if stream["method"] == "cash":
            continue
        if target is None:
            stream["method"] = ("payroll_card"
                                if rng.random() < PAYROLL_CARD_IF_UNBANKED
                                else "paper_check")
        elif rng.random() < DIRECT_DEPOSIT:
            stream["method"] = "direct_deposit"
            stream["account"] = target["number"]
        else:
            stream["method"] = "paper_check"

    return (streams + accounts + debit_cards(accounts, rng) + cards
            + [_payment_profile(person, streams, has_account, cards, rng)])
